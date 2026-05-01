import { createEnvLoader } from "@thor/common";

export interface RunnerConfig {
  port: number;
  opencodeUrl: string;
  opencodeConnectTimeout: number;
  abortTimeout: number;
  sessionErrorGraceMs: number;
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const loader = createEnvLoader(env);
  return {
    port: loader.int("PORT", { defaultValue: 3000 }),
    opencodeUrl: loader.string("OPENCODE_URL", {
      defaultValue: "http://127.0.0.1:4096",
      normalizeTrailingSlash: true,
    }),
    opencodeConnectTimeout: loader.int("OPENCODE_CONNECT_TIMEOUT", { defaultValue: 15000 }),
    abortTimeout: loader.int("ABORT_TIMEOUT", { defaultValue: 10000 }),
    sessionErrorGraceMs: loader.int("SESSION_ERROR_GRACE_MS", { defaultValue: 10000 }),
  };
}
