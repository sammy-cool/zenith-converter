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
    logger.info("[Maintenance] Scanning for old files...");
    const folders = [CONSTANTS.DIRS.UPLOAD, CONSTANTS.DIRS.TEMP];
    const now = Date.now();

    for (const folder of folders) {
      if (!(await fs.pathExists(folder))) continue;

      try {
        const files = await fs.readdir(folder);
        for (const file of files) {
          const filePath = path.join(folder, file);
          const stats = await fs.stat(filePath);

          if (now - stats.mtimeMs > CONSTANTS.LIMITS.FILE_AGE_LIMIT_MS) {
            await fs.remove(filePath);
            logger.info(`[Maintenance] Deleted: ${file}`);
          }
        }
      } catch (err) {
        logger.error(`[Maintenance] Error: ${err.message}`);
      }
    }
  },

  // Immediate cleanup after a specific job
  async cleanJob(jobId, zipPath) {
    const workDir = path.join(CONSTANTS.DIRS.TEMP, jobId);
    try {
      if (await fs.pathExists(workDir)) await fs.remove(workDir);
      if (zipPath && (await fs.pathExists(zipPath))) await fs.unlink(zipPath);
      logger.info(`[Cleanup] Removed artifacts for Job ${jobId}`);
    } catch (e) {
      logger.error(`[Cleanup] Failed: ${e.message}`);
    }
  },
};

module.exports = CleanupService;
