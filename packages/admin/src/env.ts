import { dirname, join } from "node:path";
import { createEnvLoader, WORKSPACE_CONFIG_PATH } from "@thor/common";

export interface AdminConfig {
  port: number;
  configPath: string;
  auditLogPath: string;
}

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const loader = createEnvLoader(env);
  const configPath = loader.string("CONFIG_PATH", { defaultValue: WORKSPACE_CONFIG_PATH });
  return {
    port: loader.legacyInt("PORT", { defaultValue: 3005 }),
    configPath,
    auditLogPath: loader.string("AUDIT_LOG_PATH", {
      defaultValue: join(dirname(configPath), "config.audit.log"),
    }),
  };
}
