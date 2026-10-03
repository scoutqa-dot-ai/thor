import { withContextValue } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type Registry } from "@earendil-works/pi-durable";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";
import {
  createConfigLoader,
  extractRepoFromCwd,
  findUserByGithub,
  findUserBySlack,
  WORKSPACE_CONFIG_PATH,
} from "@thor/common";
import { piShellAttributionKey } from "./pi-execution-env.js";
import { piConversationMetadataDoc } from "./pi-runner-state.js";
import { buildToolInstructions } from "./tool-instructions.js";
import type { PiRunnerConfig } from "./pi-runner-config.js";
import type { IGoogleWorkspaceConnectionStatusClient } from "./google-workspace-connection-status.js";
import { createPiReadImageTool } from "./pi-read-image.js";

/** Install remote coding tools, explicitly discovered skills, memory and active actor instructions. */
export function installPiRunnerTools(
  registry: Registry,
  config: PiRunnerConfig,
  googleWorkspaceStatus: IGoogleWorkspaceConnectionStatusClient,
): void {
  const loader = createConfigLoader(WORKSPACE_CONFIG_PATH);
  const bash = createBashTool({
    prepare: (execution, _api, context) => {
      // This inherits only the executor's reduced environment, never runner process.env.
      execution.inheritEnv = true;
      execution.env = context.value(piShellAttributionKey) ?? {};
    },
  });
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "thor-pi",
      tools: [
        createPiReadImageTool(config.modelSupportsImages),
        defineTool({
          ...bash,
          replay: "unsafe",
          execute: async (args, api, context) => {
            const metadata = await api.snapshot(
              piConversationMetadataDoc,
              api.conversationId,
              context,
            );
            const attributed = withContextValue(
              piShellAttributionKey,
              {
                THOR_OPENCODE_SESSION_ID: `pi-${metadata?.anchorId ?? "unavailable"}`,
                THOR_OPENCODE_DIRECTORY: metadata?.directory ?? api.env?.cwd ?? "/workspace",
                THOR_OPENCODE_CALL_ID: api.callId,
              },
              context,
            );
            return bash.execute(args, api, attributed);
          },
        }),
        defineTool({
          name: "load_skill",
          description: "Read a skill from the explicitly listed skill catalog by directory name.",
          parameters: Type.Object({ name: Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }) }),
          replay: "safe",
          execute: async (args, api, context) => {
            const result = await api.env?.readTextFile(
              `${config.skillsDir}/${args.name}/SKILL.md`,
              context,
            );
            return result?.ok
              ? { content: [{ type: "text", text: result.value }] }
              : { isError: true, content: [{ type: "text", text: "Skill unavailable" }] };
          },
        }),
      ],
      sections: [
        section(
          "neo",
          () =>
            "You are Neo, a concise engineering teammate. Your current name is Neo; earlier product-name references in memory or history are legacy branding. Use tools for facts. Repositories under /workspace/repos are read-only; create edits in /workspace/worktrees. Use sandbox wrappers for project build/test commands. Do not replay an uncertain write or an approved side effect. Read a relevant skill before using its integration. External tool access follows server-side policy.",
        ),
        section("image-reading", () =>
          config.modelSupportsImages
            ? "Use read_image(path) for local PNG, JPEG, WebP or static GIF image files, including screenshots downloaded with the Slack skill. Text read does not read images. The image tool takes a filesystem path, not a URL; download needed Slack files using the existing skill first. Report image tool failures without claiming to have seen the image."
            : "The selected model cannot inspect images. Do not claim visual access; ask for a text description or an image-capable model.",
        ),
        section("skills", async (input, context) => {
          const result = await input.env?.listDir(config.skillsDir, context);
          if (!result?.ok) return "Skill catalog unavailable.";
          const catalog: string[] = [];
          for (const entry of result.value) {
            if (!/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
            const skill = await input.env?.readTextFile(
              `${config.skillsDir}/${entry.name}/SKILL.md`,
              context,
            );
            if (skill?.ok) {
              const description =
                /^description:\s*(.+)$/m.exec(skill.value)?.[1] ?? "Read instructions before use";
              catalog.push(`${entry.name}: ${description}`);
            }
          }
          return `Use load_skill(name) to read these skills. Resolve relative skill paths against ${config.skillsDir}/<name>.\n${catalog.join("\n")}`;
        }),
        section("memory", async (input, context) => {
          const repo = extractRepoFromCwd(input.agent.cwd ?? "");
          const paths = [
            "/workspace/AGENTS.md",
            `${config.memoryDir}/README.md`,
            ...(repo ? [`${config.memoryDir}/${repo}/README.md`] : []),
            ...(input.agent.cwd ? [`${input.agent.cwd}/AGENTS.md`] : []),
          ];
          const blocks: string[] = [];
          for (const path of paths) {
            const read = await input.env?.readTextFile(path, context);
            if (read?.ok && read.value.trim()) blocks.push(`${path}\n${read.value}`);
          }
          return blocks.join("\n\n") || undefined;
        }),
        section("correlation-key", async (input, context) => {
          const metadata = await input.read.snapshot(
            piConversationMetadataDoc,
            input.conversationId,
            context,
          );
          const request = metadata?.receipts.find(
            (item) => item.requestId === metadata.activeRequestId,
          )?.request;
          return request?.correlationKey ?? metadata?.correlationKey;
        }),
        section("slack-reply", async (input, context) => {
          const metadata = await input.read.snapshot(
            piConversationMetadataDoc,
            input.conversationId,
            context,
          );
          const request = metadata?.receipts.find(
            (item) => item.requestId === metadata.activeRequestId,
          )?.request;
          const target = /^slack:thread:([^/]+)\/(.+)$/.exec(
            request?.correlationKey ?? metadata?.correlationKey ?? "",
          );
          if (!target) return undefined;
          return `Slack reply target: channel ${target[1]}, thread_ts ${target[2]}. Read the Slack skill and use its posting workflow for the substantive user-facing reply before ending. Final assistant text stays in the conversation and is not automatically posted to Slack.`;
        }),
        section("triggering-user", async (input, context) => {
          const metadata = await input.read.snapshot(
            piConversationMetadataDoc,
            input.conversationId,
            context,
          );
          const actor = metadata?.receipts.find(
            (item) => item.requestId === metadata.activeRequestId,
          )?.request;
          if (!actor?.triggerSlackId && !actor?.triggerGithubLogin) return undefined;
          let user;
          try {
            const workspace = loader();
            user =
              (actor.triggerSlackId
                ? findUserBySlack(workspace, actor.triggerSlackId)
                : undefined) ??
              (actor.triggerGithubLogin
                ? findUserByGithub(workspace, actor.triggerGithubLogin)
                : undefined);
          } catch {
            /* Optional user directory does not block admission. */
          }
          return user
            ? `Run triggered by ${user.name} <${user.email}>.`
            : `Run triggered by ${actor.triggerSlackId ? `slack: ${actor.triggerSlackId}` : `github: ${actor.triggerGithubLogin}`}.`;
        }),
        section("google-workspace-connection", async (input, context) => {
          const metadata = await input.read.snapshot(
            piConversationMetadataDoc,
            input.conversationId,
            context,
          );
          const requester = metadata?.receipts.find(
            (item) => item.requestId === metadata.activeRequestId,
          )?.request.triggerSlackId;
          if (!requester) return undefined;
          const status = await googleWorkspaceStatus.forSlackUser(requester);
          if (status === "connected")
            return `Current Google Workspace status for Slack requester ${requester}: a stored connection is present, freshly checked for this turn. Earlier connection-required tool results are historical, not current status. If the user's command previously stopped before approval because connection was missing, submit that blocked command through gws now to request owner approval. A stored connection does not prove document permission or successful execution; report the new tool result. Never replay an already-approved or uncertain side effect.`;
          if (status === "missing")
            return `Current Google Workspace status for Slack requester ${requester}: no stored connection was found. A sign-in or user statement alone is not evidence of completed connection. Use gws for the current result and private onboarding instructions; do not claim the connection is ready.`;
          return `Current Google Workspace connection status for Slack requester ${requester} could not be verified. Do not infer connected/disconnected from old tool results or user claims. Use gws to check the current request; preserve owner approval and never replay an uncertain effect.`;
        }),
        section("tool-instructions", (input) => buildToolInstructions(input.agent.cwd ?? "")),
      ],
    }),
  );
}
