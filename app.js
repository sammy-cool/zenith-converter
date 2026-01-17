const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs-extra");
const AdmZip = require("adm-zip");
const winston = require("winston"); // Enterprise Logger
const PDFDocument = require("pdfkit");

// --- 1. ENTERPRISE LOGGER SETUP ---
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
    new winston.transports.File({
      filename: "zenith-error.log",
      level: "error",
    }),
  ],
});

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));
app.use(express.json());

const jobs = {};

// SSE Endpoint for Real-time Progress
app.get("/progress/:jobId", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const checkProgress = setInterval(() => {
    const job = jobs[req.params.jobId];
    if (job) {
      res.write(`data: ${JSON.stringify(job)}\n\n`);
      if (job.status === "completed" || job.status === "failed") {
        clearInterval(checkProgress);
        res.end();
      }
    }
  }, 500);
});

// --- 2. CONVERSION ENDPOINT ---
app.post("/convert", upload.single("zipfile"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const zipPath = req.file.path;
  const jobId = Date.now().toString();

  // Parse options sent from Frontend
  let options = {};
  try {
    options = JSON.parse(req.body.options || "{}");
  } catch (e) {
    options = {};
  }

  logger.info(`Job ${jobId} started. Options: ${JSON.stringify(options)}`);

  jobs[jobId] = {
    status: "processing",
    percent: 0,
    message: "Initializing Zenith Engine...",
    downloadUrl: null,
  };

  res.json({ jobId });

  // Start Background Process
  processZip(jobId, zipPath, options);
});

// --- 3. BACKGROUND WORKER ---
async function processZip(jobId, zipPath, options) {
  const workDir = path.join(__dirname, "temp_extracted", jobId);
  const pdfName = `Zenith_Export_${jobId}.pdf`;
  const pdfPath = path.join(__dirname, "public", pdfName);

  // Track Table of Contents
  const tocEntries = [];

  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);

    const getAllFiles = (dir, files = []) => {
      const dirFiles = fs.readdirSync(dir);
      for (const file of dirFiles) {
        const fullPath = path.join(dir, file);
        const relPath = path.relative(workDir, fullPath);

        // 1. FILTER: Vendor/System Folders
        if (
          options.excludeVendor &&
          (file === "node_modules" ||
            file === ".git" ||
            file === "dist" ||
            file === "build" ||
            file === ".next")
        ) {
          continue;
        }

        if (fs.statSync(fullPath).isDirectory()) {
          getAllFiles(fullPath, files);
        } else {
          // 2. FILTER: File Types
          const ext = path.extname(file).toLowerCase();

          // Binary Filter
          if (
            options.excludeBin &&
            [".exe", ".dll", ".so", ".bin"].includes(ext)
          )
            continue;
          // Image Filter
          if (
            options.excludeImages &&
            [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"].includes(
              ext,
            )
          )
            continue;
          // Video/Audio Filter
          if (
            options.excludeMedia &&
            [".mp4", ".mp3", ".mov", ".avi"].includes(ext)
          )
            continue;
          // Archive Filter
          if ([".zip", ".tar", ".gz", ".rar"].includes(ext)) continue;

          files.push(fullPath);
        }
      }
      return files;
    };

    const allFiles = getAllFiles(workDir);
    logger.info(`Job ${jobId}: Found ${allFiles.length} files to process.`);

    // Start PDF Stream
    const doc = new PDFDocument({
      autoFirstPage: false,
      bufferPages: false,
      margin: 50,
    });
    const writeStream = fs.createWriteStream(pdfPath);
    doc.pipe(writeStream);

    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      const relPath = path.relative(workDir, filePath);

      // Update Progress
      if (i % 5 === 0) {
        const pct = Math.floor((i / allFiles.length) * 90);
        jobs[jobId].percent = pct;
        jobs[jobId].message = `Processing: ${relPath}`;
      }

      // --- ADD PAGE & ANCHOR ---
      doc.addPage();

      // Create a unique destination ID for links
      const destId = `file_${i}`;
      doc.addNamedDestination(destId);

      // Save for Index
      tocEntries.push({ name: relPath, dest: destId });

      // Header
      doc
        .fontSize(12)
        .fillColor("#0052cc")
        .font("Courier-Bold")
        .text(`FILE: ${relPath}`, { underline: true });
      doc.moveDown(0.5);

      try {
        const ext = path.extname(filePath).toLowerCase();

        // Handle Images specially if not excluded
        if ([".png", ".jpg", ".jpeg"].includes(ext)) {
          try {
            doc.image(filePath, { fit: [500, 400], align: "center" });
          } catch (imgErr) {
            doc.fillColor("red").text(`[Image Corrupt or Unsupported]`);
          }
        } else {
          // Handle Text/Code
          // Cap file read at 100KB for memory safety
          const content = fs.readFileSync(filePath, "utf8").slice(0, 100000);
          // We strip non-printable chars to avoid PDFKit crash
          const safeContent = content.replace(
            /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g,
            "",
          );

          doc.fontSize(10).fillColor("black").font("Courier").text(safeContent);
        }
      } catch (readErr) {
        doc.fillColor("red").text(`[Error reading file: ${readErr.message}]`);
      }

      // Memory cleanup hint
      if (global.gc && i % 20 === 0) global.gc();
    }

    // --- GENERATE CLICKABLE INDEX AT END ---
    if (tocEntries.length > 0) {
      jobs[jobId].message = "Generating Searchable Index...";
      doc.addPage();
      doc
        .fontSize(18)
        .fillColor("black")
        .font("Helvetica-Bold")
        .text("INDEX / TABLE OF CONTENTS", { align: "center" });
      doc.moveDown();

      doc.fontSize(10).font("Courier");

      for (const entry of tocEntries) {
        doc.fillColor("#0052cc").text(entry.name, {
          link: entry.dest, // Internal Link
          underline: false,
        });
      }
    }

    doc.end();
    await new Promise((resolve) => writeStream.on("finish", resolve));

    // Cleanup
    await fs.remove(workDir);

    jobs[jobId].status = "completed";
    jobs[jobId].percent = 100;
    jobs[jobId].downloadUrl = `/${pdfName}`;
    jobs[jobId].message = "Conversion Complete! Downloading...";

    logger.info(`Job ${jobId} completed successfully.`);

    // Auto-delete PDF after 15 mins
    setTimeout(
      () => {
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      },
      15 * 60 * 1000,
    );
  } catch (error) {
    logger.error(`Job ${jobId} failed: ${error.message}`);
    jobs[jobId].status = "failed";
    jobs[jobId].message = "Error: " + error.message;
    await fs.remove(workDir); // Ensure cleanup on fail
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  logger.info(`Zenith V4 Enterprise running on port ${PORT}`),
);
