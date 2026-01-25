// endpoints
const express = require("express");
const multer = require("multer");
const router = express.Router();
const controller = require("../controllers/convert.controller");
const CONSTANTS = require("../config/constants");

// Setup Multer
const upload = multer({ dest: CONSTANTS.DIRS.UPLOAD });

// Define Routes
router.post("/convert", upload.single("zipfile"), controller.startConversion);
router.post("/convert/github", express.json(), controller.startGithubConversion);
router.get("/progress/:jobId", controller.streamProgress);

module.exports = router;
