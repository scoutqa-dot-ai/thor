import { createLogger, logInfo, WORKSPACE_CONFIG_PATH } from "@thor/common";
import { createAdminApp } from "./app.js";

const log = createLogger("admin");

const PORT = parseInt(process.env.PORT || "3005", 10);
const CONFIG_PATH = process.env.CONFIG_PATH || WORKSPACE_CONFIG_PATH;

const app = createAdminApp({ configPath: CONFIG_PATH });

app.listen(PORT, () => {
  logInfo(log, "admin_started", { port: PORT, configPath: CONFIG_PATH });
});
