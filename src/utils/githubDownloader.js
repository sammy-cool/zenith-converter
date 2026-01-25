const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const CONSTANTS = require("../config/constants");
const logger = require("../config/logger");

const GithubDownloader = {
  /**
   * Converts a Repo URL to a Download Stream and saves as ZIP
   */
  async downloadRepo(repoUrl, jobId) {
    // 1. Parse URL to get clean name
    // Input: https://github.com/sammy-cool/zenith-converter
    // Output: zenith-converter
    const cleanName = repoUrl.split("/").pop().replace(".git", "");
    const zipName = `github_${jobId}.zip`;
    const destPath = path.join(CONSTANTS.DIRS.UPLOAD, zipName);

    // 2. Construct Archive URL (Uses HEAD to get latest default branch)
    // Format: https://github.com/user/repo/archive/HEAD.zip
    const archiveUrl = `${repoUrl.replace(/\/$/, "")}/archive/HEAD.zip`;

    logger.info(`[GitHub] Downloading from: ${archiveUrl}`);

    // 3. Download Stream
    const writer = fs.createWriteStream(destPath);

    try {
      const response = await axios({
        url: archiveUrl,
        method: "GET",
        responseType: "stream",
      });

      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on("finish", () =>
          resolve({ zipPath: destPath, originalName: cleanName }),
        );
        writer.on("error", reject);
      });
    } catch (error) {
      // Handle 404 (Repo not found/Private)
      if (error.response && error.response.status === 404) {
        throw new Error("Repository not found or private. Check URL.");
      }
      throw error;
    }
  },
};

module.exports = GithubDownloader;
