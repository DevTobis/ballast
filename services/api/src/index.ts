import "./bigint-json.js";
import { createLogger } from "@ballast/observability";
import { loadApiConfig } from "./config.js";
import { buildServer } from "./server.js";

const logger = createLogger("api");
const config = loadApiConfig();
const app = buildServer({ config });

app.addHook("onResponse", async (request, reply) => {
  logger.info(
    { method: request.method, url: request.url, statusCode: reply.statusCode },
    "request completed",
  );
});

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then((address) => logger.info({ address }, "services/api listening"))
  .catch((err) => {
    logger.error({ err }, "services/api failed to start");
    process.exit(1);
  });
