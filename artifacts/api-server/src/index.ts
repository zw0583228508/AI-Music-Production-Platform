import app from "./app";
import { logger } from "./lib/logger";
import { syncModelRegistry } from "./lib/musicProviders";
import { startGenerationRecoveryScheduler } from "./lib/arrangementGeneration";
import { recoverInterruptedAnalyses } from "./lib/sourceAnalyzer";
import { startArtifactRetentionScheduler } from "./lib/artifactLifecycle";
import { recoverExportProductionJobs } from "./lib/exportJobs";

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

const recover = () => {
  void recoverInterruptedAnalyses().catch((error) => {
    logger.error({ err: error }, "music_analysis_recovery_failed");
  });
};

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void syncModelRegistry()
    .then(() => {
      recover();
      const recoveryTimer = setInterval(recover, 30_000);
      recoveryTimer.unref();
      startGenerationRecoveryScheduler(60_000, (error: unknown) => {
        logger.error({ err: error }, "Failed to recover pending generation jobs");
      });
      const exportRecoveryTimer = setInterval(() => {
        void recoverExportProductionJobs().catch((error) => {
          logger.error({ err: error }, "Failed to recover pending export jobs");
        });
      }, 30_000);
      exportRecoveryTimer.unref();
      void recoverExportProductionJobs().catch((error) => {
        logger.error({ err: error }, "Failed to recover pending export jobs");
      });
      startArtifactRetentionScheduler();
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, "Failed to initialize music model registry and job recovery");
    });
});
