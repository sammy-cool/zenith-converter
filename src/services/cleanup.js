// The Janitor = Periodically deletes old files to prevent disk full errors.

const fs = require("fs-extra");
const path = require("path");
const logger = require("../config/logger");
const CONSTANTS = require("../config/constants");

const CleanupService = {
  init() {
    logger.info("Cleanup Service: Started");
    // Run periodically
    setInterval(this.runMaintenance, CONSTANTS.LIMITS.CLEANUP_INTERVAL_MS);
  },

  // Periodic Maintenance
  async runMaintenance() {
    logger.info("[Maintenance] Starting cleanup routine...");
    const now = Date.now();

    // 1. CLEANUP FOLDERS
    const foldersToClean = [
      CONSTANTS.DIRS.UPLOAD,
      CONSTANTS.DIRS.TEMP,
      CONSTANTS.DIRS.DOWNLOADS,
    ];

    for (const folder of foldersToClean) {
      if (!(await fs.pathExists(folder))) continue;

      try {
        const files = await fs.readdir(folder);
        for (const file of files) {
          const filePath = path.join(folder, file);
          const stats = await fs.stat(filePath);

          logger.info("[Maintenance] Scanning for files...");

          if (now - stats.mtimeMs > CONSTANTS.LIMITS.FILE_AGE_LIMIT_MS) {
            await fs.remove(filePath);
            logger.info(`[Maintenance] Deleted: ${file}`);
          }
        }
      } catch (err) {
        logger.error(
          `[Maintenance] Error in ${path.basename(folder)}: ${err.message}`,
        );
      }
    }

    // 2. CLEANUP LOG FILE
    await CleanupService.rotateLogs();
  },

  async rotateLogs() {
    try {
      if (await fs.pathExists(CONSTANTS.DIRS.LOG_FILE)) {
        const stats = await fs.stat(CONSTANTS.DIRS.LOG_FILE);

        // If log file is bigger than 1MB, clear it
        if (stats.size > CONSTANTS.LIMITS.MAX_LOG_SIZE_BYTES) {
          // As of now we are going to Delete it (Winston will recreate it on next log)
          await fs.unlink(CONSTANTS.DIRS.LOG_FILE);
          logger.info(
            "[Maintenance] Log file was too large and has been reset.",
          );

          // Later we will create a backup and Rename it to zenith.log.old accordingly
          // await fs.move(CONSTANTS.DIRS.LOG_FILE, `${CONSTANTS.DIRS.LOG_FILE}.old`, { overwrite: true });
        }
      }
    } catch (e) {
      console.error("Log cleanup failed:", e);
    }
  },

  // Immediate cleanup after a specific job and We only delete the ZIP if it exists
  async cleanJob(jobId, zipPath) {
    const workDir = path.join(CONSTANTS.DIRS.TEMP, jobId);
    try {
      if (await fs.pathExists(workDir)) await fs.remove(workDir);
      if (zipPath && (await fs.pathExists(zipPath))) await fs.unlink(zipPath);
      logger.info(`[Cleanup] Removed artifacts for Job ${jobId}`);
    } catch (e) {
      logger.error(`[Cleanup] Failed job artifacts: ${e.message}`);
    }
  },
};

module.exports = CleanupService;
