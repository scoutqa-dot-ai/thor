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

/** Install remote coding tools, explicitly discovered skills, memory and active actor instructions. */
export function installPiRunnerTools(registry: Registry, config: PiRunnerConfig): void {
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
          "thor",
          () =>
            "You are Thor, a concise engineering teammate. Use tools for facts. Repositories under /workspace/repos are read-only; create edits in /workspace/worktrees. Use sandbox wrappers for project build/test commands. Do not replay an uncertain write or an approved side effect. Read a relevant skill before using its integration. External tool access follows server-side policy.",
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
        section("tool-instructions", (input) => buildToolInstructions(input.agent.cwd ?? "")),
      ],
    }),
  );
}
