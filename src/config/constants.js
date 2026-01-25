// Central place for settings.

const path = require("path");

module.exports = {
  PORT: process.env.PORT || 3999,
  DIRS: {
    ROOT: path.resolve(__dirname, "../../"),
    UPLOAD: path.resolve(__dirname, "../../uploads"),
    TEMP: path.resolve(__dirname, "../../temp_extracted"),
    PUBLIC: path.resolve(__dirname, "../../public"),
  },
  LIMITS: {
    MAX_FILE_READ_BYTES: 100000, // 100KB Limit
    JOB_RETENTION_MS: 10 * 60 * 1000, // 10 Minutes
    CLEANUP_INTERVAL_MS: 30 * 60 * 1000, // 30 Minutes
    FILE_AGE_LIMIT_MS: 60 * 60 * 1000, // 1 Hour
  },
  PDF: {
    LINES_PER_PAGE: 35,
    MARGIN: 40,
    INDEX_Y_START: 50,
  },
};
