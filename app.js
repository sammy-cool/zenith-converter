const express = require("express");
const fs = require("fs-extra");
const CONSTANTS = require("./src/config/constants");
const logger = require("./src/config/logger");
const apiRoutes = require("./src/routes/api.routes");
const CleanupService = require("./src/services/cleanup");

const app = express();

// 1. Create Required Directories
Object.values(CONSTANTS.DIRS).forEach((dir) => fs.ensureDirSync(dir));

// 2. Middleware
app.use(express.static(CONSTANTS.DIRS.PUBLIC));
app.use(express.json());

// 3. Initialize Background Services
CleanupService.init();

// 4. Routes
app.use("/", apiRoutes);

// --- HEALTH ROUTE ---
// Used for uptime monitoring by services like Render/AWS
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// 5. Global Error Handler (Full Proof)
app.use((err, req, res, next) => {
  logger.error(`Unhandled Error: ${err.message}`);
  res
    .status(500)
    .json({ error: "Internal Server Error", details: err.message });
});

// 6. Start Server
app.listen(CONSTANTS.PORT, () => {
  logger.info(`Zenith V12 Enterprise running on port ${CONSTANTS.PORT}`);
});
