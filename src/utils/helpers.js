const path = require("path");

const Helpers = {
  // Sanitize filename to prevent security issues
  sanitizeName(name) {
    let clean = name.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9_\-\.]/g, "_");
    return clean || "Project_Export";
  },

  // Exclusion Logic
  shouldExclude(relPath, exclusions) {
    const segments = relPath.split("/");
    // Check if any folder in the path is excluded
    if (segments.some((seg) => exclusions.folders.includes(seg))) return true;

    // Check extension
    const ext = path.extname(relPath).toLowerCase();
    if (exclusions.extensions.includes(ext)) return true;

    return false;
  },

  // Non-blocking pause (Essential for Node Event Loop)
  async yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
  },
};

module.exports = Helpers;
