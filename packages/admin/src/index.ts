import { createLogger, loadAdminEnv, logInfo } from "@thor/common";
import { createAdminApp } from "./app.ts";

const log = createLogger("admin");

const config = loadAdminEnv();

const app = createAdminApp({
  configPath: config.configPath,
  auditLogPath: config.auditLogPath,
  internalSecret: config.thorInternalSecret,
});

app.listen(config.port, () => {
  logInfo(log, "admin_started", {
    port: config.port,
    configPath: config.configPath,
    auditLogPath: config.auditLogPath,
  });
});
