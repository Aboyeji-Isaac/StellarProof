import cron from "node-cron";
import { storageProviderRegistry } from "../services/storage.service";
import logger from "../utils/logger";

/**
 * Keeps the storage provider ranking warm so uploads rarely have to wait on
 * an inline health check.
 */
export const startStorageHealthJob = () => {
  // Run every minute
  cron.schedule("* * * * *", async () => {
    try {
      const providers = await storageProviderRegistry.refresh();
      const unhealthy = providers.filter((p) => p.status === "unhealthy").map((p) => p.provider);
      if (unhealthy.length > 0) {
        logger.warn("Storage providers unhealthy", { unhealthy });
      }
    } catch (error) {
      logger.error("Storage provider health job failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
