import { createLogger, logInfo } from "@thor/common";
import { createAdminApp } from "./app.js";
import { loadAdminConfig } from "./env.js";

const log = createLogger("admin");

const config = loadAdminConfig();

const app = createAdminApp({ configPath: config.configPath, auditLogPath: config.auditLogPath });

app.listen(config.port, () => {
  logInfo(log, "admin_started", {
    port: config.port,
    configPath: config.configPath,
    auditLogPath: config.auditLogPath,
  });
});
