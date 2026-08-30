import app from "./app";
import { logger } from "./lib/logger";
import { resumePendingSourceJobs } from "./lib/sourceAnalyzer";
import { syncModelRegistry } from "./lib/musicProviders";
import { startGenerationRecoveryScheduler } from "./lib/arrangementGeneration";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void syncModelRegistry()
    .then(() => {
      void resumePendingSourceJobs();
      const recoveryTimer = setInterval(() => {
        void resumePendingSourceJobs().catch((error: unknown) => {
          logger.error({ err: error }, "Failed to recover pending music analysis jobs");
        });
      }, 60_000);
      recoveryTimer.unref();
      startGenerationRecoveryScheduler(60_000, (error: unknown) => {
        logger.error({ err: error }, "Failed to recover pending generation jobs");
      });
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, "Failed to initialize music model registry and job recovery");
    });
});
