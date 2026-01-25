// Central place for settings.

const path = require("path");

module.exports = {
  PORT: process.env.PORT || 3999,
  DIRS: {
    ROOT: path.resolve(__dirname, "../../"),
    UPLOAD: path.resolve(__dirname, "../../uploads"),
    TEMP: path.resolve(__dirname, "../../temp_extracted"),
    PUBLIC: path.resolve(__dirname, "../../public"),

    // Dedicated folder for generated PDFs
    DOWNLOADS: path.resolve(__dirname, "../../public/downloads"),
    LOG_FILE: path.resolve(__dirname, "../../zenith.log"),
  },
  LIMITS: {
    MAX_FILE_READ_BYTES: 100000, // 100KB Limit
    JOB_RETENTION_MS: 10 * 60 * 1000, // 10 Minutes
    CLEANUP_INTERVAL_MS: 30 * 60 * 1000, // 30 Minutes
    FILE_AGE_LIMIT_MS: 60 * 60 * 1000, // 1 Hour

    // Delete log if larger than 1MB
    MAX_LOG_SIZE_BYTES: 1 * 1024 * 1024,
  },
  PDF: {
    LINES_PER_PAGE: 35,
    MARGIN: 40,
    INDEX_Y_START: 50,
  },
};
