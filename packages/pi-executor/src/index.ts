import { z } from "zod";
import { createPiExecutorService } from "./executor-service.js";

// This is the only startup entrypoint. Importing service/protocol never reads the environment or listens.
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .safeParse(process.env.PORT ?? 3002);
if (!port.success) {
  console.error("Pi executor invalid port configuration");
  process.exitCode = 1;
} else {
  const service = createPiExecutorService({ shellEnvironment: process.env });
  service.server.listen(port.data, "0.0.0.0");
  service.server.on("error", () => {
    console.error("Pi executor HTTP service failed");
    process.exitCode = 1;
  });
  const shutdown = (): void => {
    service.server.close();
    void service
      .dispose()
      .then(() => service.server.closeAllConnections())
      .catch(() => {
        console.error("Pi executor shutdown failed");
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
