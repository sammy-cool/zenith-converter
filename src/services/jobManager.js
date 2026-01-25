// Manages the "State" of the application. like mini-database
const logger = require("../config/logger");
const CONSTANTS = require("../config/constants");

class JobManager {
  constructor() {
    this.jobs = {};
  }

  create(jobId) {
    this.jobs[jobId] = {
      id: jobId,
      status: "pending",
      percent: 0,
      message: "Initializing...",
      startTime: Date.now(),
    };
    logger.info(`Job Created: ${jobId}`);
    return this.jobs[jobId];
  }

  get(jobId) {
    return this.jobs[jobId];
  }

  update(jobId, data) {
    if (this.jobs[jobId]) {
      this.jobs[jobId] = { ...this.jobs[jobId], ...data };
    }
  }

  fail(jobId, errorMsg) {
    logger.error(`Job ${jobId} Failed: ${errorMsg}`);
    this.update(jobId, { status: "failed", message: `Error: ${errorMsg}` });
  }

  complete(jobId, downloadUrl) {
    logger.info(`Job ${jobId} Completed.`);
    this.update(jobId, {
      status: "completed",
      percent: 100,
      message: "Done!",
      downloadUrl,
    });

    // Schedule removal from memory
    setTimeout(() => {
      if (this.jobs[jobId]) delete this.jobs[jobId];
    }, CONSTANTS.LIMITS.JOB_RETENTION_MS);
  }
}

// Export as Singleton (One instance for the whole app)
module.exports = new JobManager();
