import { readFileSync } from "node:fs";
import { z } from "zod";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  configure,
  defineTool,
  section,
  type Tx,
  type ConversationId,
  type AgentState,
  type ToolRegistration,
  type PromptSection,
} from "@earendil-works/pi-durable";
import {
  WORKSPACE_CONFIG_PATH,
  WorkspaceConfigSchema,
  type ConfigLoader,
  type PiModelRoutingPool,
  type PiModelSelection,
} from "@thor/common";
import {
  decidePiModelEscalation,
  parsePiModelSelection,
  resolvePiModelRoutingPool,
  PiModelRoutingError,
  type PiModelRoutingResult,
} from "./pi-model-routing-policy.js";
import {
  piConversationMetadataDoc,
  piConversationMetadataSchema,
  type PiAdmissionReceipt,
} from "./pi-runner-state.js";
import type { PiRunnerConfig } from "./pi-runner-config.js";

const escalationMemoSchema = z.strictObject({ text: z.string(), isError: z.boolean() });

const escalationParameters = Type.Object({
  profile: Type.Union([Type.Literal("balanced"), Type.Literal("strong")]),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});

/** Read the optional routing pool once; only ENOENT means absent, and no diagnostic contains file contents. */
export function loadPiModelRoutingPool(
  config: PiRunnerConfig,
  loader?: ConfigLoader,
): PiModelRoutingResult<PiModelRoutingPool> {
  try {
    let workspace;
    if (loader) workspace = loader();
    else {
      let raw;
      try {
        raw = readFileSync(WORKSPACE_CONFIG_PATH, "utf8");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return resolvePiModelRoutingPool(config);
        return { ok: false, error: new PiModelRoutingError("configuration_invalid") };
      }
      workspace = WorkspaceConfigSchema.parse(JSON.parse(raw));
    }
    return resolvePiModelRoutingPool(config, workspace.pi?.modelRouting);
  } catch {
    return { ok: false, error: new PiModelRoutingError("configuration_invalid") };
  }
}

/** Frozen model routing and native configuration share one transaction; no credential or tool authority changes. */
export class PiModelRoutingRuntime {
  /** Startup pool remains fixed until restart, including the legacy model resource. */
  constructor(
    readonly pool: PiModelRoutingPool,
    private readonly legacyModelId: string,
  ) {}

  /** Distinct registered model IDs inherit exactly the same capability contract. */
  modelIds(): string[] {
    return [
      ...new Set([
        this.legacyModelId,
        ...Object.values(this.pool.profiles).map((entry) => entry.modelId),
      ]),
    ];
  }

  /** Saved pool choices must all remain supported; never replace invalid or obsolete evidence. */
  supported(input: unknown): PiModelRoutingResult<PiModelSelection> {
    const selection = parsePiModelSelection(input);
    if (!selection.ok) return selection;
    const saved = selection.value.pool;
    if (
      saved.provider !== this.pool.provider ||
      saved.modelContextWindow !== this.pool.modelContextWindow ||
      saved.modelSupportsImages !== this.pool.modelSupportsImages ||
      Object.values(saved.profiles).some((entry) => !this.modelIds().includes(entry.modelId))
    )
      return { ok: false, error: new PiModelRoutingError("selection_invalid") };
    return selection;
  }

  /** Recovery validates native choices before any scheduler starts, including legacy admissions. */
  nativeMatches(receipt: PiAdmissionReceipt, agent: Readonly<AgentState> | undefined): boolean {
    if (
      !agent ||
      agent.model?.provider !== "codex-lb" ||
      !this.modelIds().includes(agent.model.modelId) ||
      !["off", "minimal", "low", "medium", "high"].includes(agent.thinkingLevel ?? "off")
    )
      return false;
    if (!receipt.modelSelection) return true;
    const selected = this.supported(receipt.modelSelection);
    return (
      selected.ok &&
      agent.model.modelId === selected.value.modelId &&
      agent.thinkingLevel === selected.value.thinkingLevel
    );
  }

  /** Configure saved choices at admission only; retry preserves prepared native requests. */
  async configureReceipt(
    tx: Tx,
    id: ConversationId,
    receipt: PiAdmissionReceipt,
  ): Promise<boolean> {
    if (receipt.modelSelection !== undefined) {
      const selected = this.supported(receipt.modelSelection);
      if (!selected.ok) return false;
      await configure(tx, id, {
        model: { provider: "codex-lb", modelId: selected.value.modelId },
        thinkingLevel: selected.value.thinkingLevel,
      });
      return true;
    }
    return this.nativeMatches(receipt, await tx.doc(AgentDoc, id));
  }

  /** Sequential escalation applies to the next prepared model request; committed task IDs deduplicate crash replay. */
  escalationTool(): ToolRegistration<typeof escalationParameters> {
    return defineTool({
      name: "escalate_model",
      description:
        "Promote an automatic task to the next allowed profile when more reasoning is needed. Takes profile and a concise reason. Explicit choices are locked; at most two upward promotions per task.",
      parameters: escalationParameters,
      executionMode: "sequential",
      replay: "safe",
      execute: async (args, api, context) => {
        const memo = await api.memo("pi-model-escalation", context);
        if (memo !== undefined) {
          const parsed = escalationMemoSchema.safeParse(memo);
          return parsed.success
            ? {
                isError: parsed.data.isError,
                content: [{ type: "text" as const, text: parsed.data.text }],
              }
            : {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: "Pi model escalation rejected: selection_invalid",
                  },
                ],
              };
        }
        let result = { text: "Pi model escalation rejected: selection_invalid", isError: true };
        await api.commit(async (tx) => {
          const raw = await tx.doc(piConversationMetadataDoc, api.conversationId);
          const parsed = piConversationMetadataSchema.safeParse(raw);
          if (!parsed.success) return;
          const receipt = raw.receipts.find((item) => item.requestId === raw.activeRequestId);
          if (!receipt?.modelSelection) return; // Legacy work retains its native choice.
          const saved = this.supported(receipt.modelSelection);
          if (!saved.ok) return;
          if (!this.nativeMatches(receipt, await tx.doc(AgentDoc, api.conversationId))) return;
          const committed = receipt.escalationCalls?.find(
            (call) => call.taskId === String(api.taskId),
          );
          if (committed) {
            result = {
              text: `Model profile promoted to ${committed.profile}, thinking ${committed.thinkingLevel}.`,
              isError: false,
            };
            return;
          }
          // Explicit thinking/profile/model choices and configured defaults are not automatic tasks.
          if (saved.value.source !== "automatic") {
            result = { text: "Pi model escalation rejected: escalation_locked", isError: true };
            return;
          }
          const next = decidePiModelEscalation(saved.value, args);
          if (!next.ok) {
            result = { text: next.error.message, isError: true };
            return;
          }
          receipt.modelSelection = { ...next.value, history: [...next.value.history] };
          receipt.escalationCalls = [
            ...(receipt.escalationCalls ?? []),
            {
              taskId: String(api.taskId),
              profile: next.value.profile,
              thinkingLevel: next.value.thinkingLevel,
            },
          ];
          await configure(tx, api.conversationId, {
            model: { provider: "codex-lb", modelId: next.value.modelId },
            thinkingLevel: next.value.thinkingLevel,
          });
          result = {
            text: `Model profile promoted to ${next.value.profile}, thinking ${next.value.thinkingLevel}.`,
            isError: false,
          };
        }, context);
        const winner = await api.memo("pi-model-escalation", result, context);
        return { isError: winner.isError, content: [{ type: "text" as const, text: winner.text }] };
      },
    });
  }

  /** Agent-facing model prompt reports observable choice and the next permitted promotion only. */
  modelSection(): PromptSection {
    return section("task-model-routing", async (input, context) => {
      const metadata = await input.read.snapshot(
        piConversationMetadataDoc,
        input.conversationId,
        context,
      );
      const parsed = piConversationMetadataSchema.safeParse(metadata);
      if (!parsed.success)
        return "Current model routing unavailable. Model escalation is unavailable for this task.";
      const selected = parsed.data.receipts.find(
        (item) => item.requestId === parsed.data.activeRequestId,
      )?.modelSelection;
      if (!selected)
        return `Current model ${input.agent.model?.modelId ?? "unavailable"}, thinking ${input.agent.thinkingLevel}. Model escalation is unavailable for this task.`;
      const next =
        selected.profile === "fast"
          ? "balanced"
          : selected.profile === "balanced"
            ? "strong"
            : undefined;
      const allowed =
        selected.source === "automatic" &&
        !selected.escalationLocked &&
        selected.promotions < 2 &&
        next;
      return `Current model profile ${selected.profile}, model ${selected.modelId}, thinking ${selected.thinkingLevel}. ${allowed ? `If this task needs deeper reasoning, use escalate_model with profile ${next} and a concise reason. The promotion applies to the next response.` : "Model escalation is unavailable for this task."}`;
    });
  }
}
