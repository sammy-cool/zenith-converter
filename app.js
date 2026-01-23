const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const AdmZip = require("adm-zip");
const winston = require("winston");
const PDFDocument = require("pdfkit");

// --- 1. ENTERPRISE LOGGER ---
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `[${timestamp}] ${level.toUpperCase()}: ${message}`,
    ),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "zenith.log" }),
  ],
});

const app = express();
// Preserve original file name to use it later
const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));
app.use(express.json());

const jobs = {};

// --- SSE ENDPOINT ---
app.get("/progress/:jobId", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const checkInterval = setInterval(() => {
    const job = jobs[req.params.jobId];
    if (job) {
      res.write(`data: ${JSON.stringify(job)}\n\n`);

      if (job.status === "completed" || job.status === "failed") {
        clearInterval(checkInterval);
        res.end();
        setTimeout(() => {
          if (jobs[req.params.jobId]) {
            delete jobs[req.params.jobId];
          }
        }, 600000);
      }
    }
  }, 500);
});

// --- CONVERSION ENDPOINT ---
app.post("/convert", upload.single("zipfile"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const jobId = Date.now().toString();
  const zipPath = req.file.path;

  // Capture Original Filename (Remove .zip extension)
  let originalName = req.file.originalname || "Project_Export";
  originalName = originalName
    .replace(/\.zip$/i, "")
    .replace(/[^a-zA-Z0-9_\-\.]/g, "_");

  let userExclusions = { extensions: [], folders: [] };
  try {
    if (req.body.exclusions) {
      userExclusions = JSON.parse(req.body.exclusions);
    }
  } catch (e) {
    logger.error("Failed to parse exclusions: " + e);
  }

  jobs[jobId] = {
    status: "processing",
    percent: 0,
    message: "Initializing Engine...",
    pdfName: `${originalName}.pdf`, // Store name for client
  };

  logger.info(`Job ${jobId} started for file: ${originalName}`);
  res.json({ jobId });

  processZipV6(jobId, zipPath, userExclusions, originalName);
});

// --- V6 ENGINE ---
async function processZipV6(jobId, zipPath, exclusions, originalName) {
  const workDir = path.join(__dirname, "temp_extracted", jobId);
  const pdfName = `${originalName}-${jobId}.pdf`;
  const finalPdfPath = path.join(__dirname, "public", pdfName);

  try {
    // A. EXTRACT
    jobs[jobId].message = "Extracting Archive...";
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);

    // B. SCAN FILES (Deep Exclusion Logic)
    const getFiles = (dir) => {
      let results = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        // Normalize path slashes for consistency
        const relPath = path.relative(workDir, fullPath).replace(/\\/g, "/");

        // Deep Folder Exclusion
        // Split path into parts: "src/node_modules/lib" -> ["src", "node_modules", "lib"]
        const pathSegments = relPath.split("/");

        // Check if ANY segment matches a blacklisted folder
        const isExcluded = pathSegments.some((segment) =>
          exclusions.folders.includes(segment),
        );

        if (isExcluded) continue;

        const ext = path.extname(file).toLowerCase();
        if (exclusions.extensions.includes(ext)) continue;

        if (fs.statSync(fullPath).isDirectory()) {
          results = results.concat(getFiles(fullPath));
        } else {
          results.push(fullPath);
        }
      }
      return results;
    };

    const allFiles = getFiles(workDir);
    logger.info(`Files to process: ${allFiles.length}`);

    // C. SETUP PDF
    const doc = new PDFDocument({
      autoFirstPage: false,
      bufferPages: true,
      margin: 40,
    });

    const writeStream = fs.createWriteStream(finalPdfPath);
    doc.pipe(writeStream);

    // Pre-allocate Index Pages
    // Calculate pages needed (approx 35 lines per page)
    const requiredIndexPages = Math.ceil(allFiles.length / 35) + 1; // +1 buffer
    jobs[jobId].message = `Allocating ${requiredIndexPages} pages for Index...`;

    for (let k = 0; k < requiredIndexPages; k++) {
      doc.addPage(); // Create blank pages 0, 1, 2...
    }

    // Move to next page for Content
    if (requiredIndexPages > 0) doc.addPage();

    // D. RENDER CONTENT
    const tocEntries = [];

    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      const relPath = path.relative(workDir, filePath).replace(/\\/g, "/");
      const safeId = `dest_${i}`;

      // New Page for File
      if (i > 0) doc.addPage();
      const currentPageNum = doc.bufferedPageRange().count;
      doc.addNamedDestination(safeId);

      tocEntries.push({ title: relPath, dest: safeId, page: currentPageNum });

      // Header
      doc.rect(40, 40, 530, 25).fill("#e6f0ff").stroke();
      doc
        .fillColor("#0052cc")
        .fontSize(12)
        .font("Helvetica-Bold")
        .text(relPath, 50, 48, { underline: false });
      doc.moveDown(2);

      // Code Content
      try {
        const buffer = fs.readFileSync(filePath);
        const isBinary = buffer.slice(0, 1000).includes(0);

        if (isBinary) {
          doc
            .fillColor("#cc0000")
            .fontSize(10)
            .font("Helvetica-Oblique")
            .text("[Binary File: Omitted]", { width: 530 });
        } else {
          let content = buffer.toString("utf8").slice(0, 100000);
          content = content.replace(
            /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g,
            "",
          );

          const lines = content.split(/\r?\n/);
          doc.fontSize(9).font("Courier");

          for (let j = 0; j < lines.length; j++) {
            const line = lines[j];
            const lineNum = (j + 1).toString();
            // Calculate height to check pagination
            const rowHeight = Math.max(
              doc.heightOfString(line, { width: 480 }),
              12,
            );

            if (doc.y + rowHeight > doc.page.height - 50) {
              doc.addPage();
            }

            const currentY = doc.y;
            // Gutter
            doc.rect(40, currentY, 35, rowHeight).fillColor("#f5f5f5").fill();
            doc
              .fillColor("#999999")
              .text(lineNum, 42, currentY + 2, { width: 30, align: "right" });
            // Code
            doc
              .fillColor("#000000")
              .text(line, 85, currentY + 2, { width: 480, align: "left" });

            doc.x = 40; // Reset X
          }
        }
      } catch (err) {
        logger.error(err);
      }

      if (i % 10 === 0) {
        jobs[jobId].percent = Math.floor((i / allFiles.length) * 80);
        jobs[jobId].message = `Rendering: ${relPath}`;
        if (global.gc) global.gc();
      }
    }

    // E. WRITE INDEX
    jobs[jobId].message = "Finalizing Index...";

    // Switch to First Page (Page 0)
    let indexPageIndex = 0;
    doc.switchToPage(indexPageIndex);
    doc.y = 50; // Force reset Top Margin

    // Title
    doc.rect(0, 0, 600, 800).fill("white");
    doc
      .fillColor("#000000")
      .fontSize(24)
      .font("Helvetica-Bold")
      .text("PROJECT INDEX", 50, 50, { align: "center" });
    doc.moveDown(2);
    doc.fontSize(10).font("Helvetica");

    for (const entry of tocEntries) {
      // Check bounds
      if (doc.y > 720) {
        indexPageIndex++;
        if (indexPageIndex < requiredIndexPages) {
          doc.switchToPage(indexPageIndex);
          doc.rect(0, 0, 600, 800).fill("white"); // Clean slate
          doc.y = 50; // Reset Cursor to Top
        } else {
          // Should not happen if calculation is right, but safe fallback
          doc.addPage();
          doc.y = 50;
        }
      }

      // Write Entry
      doc.fillColor("#0052cc").text(entry.title, {
        goTo: entry.dest,
        indent: 20,
        width: 450,
        continued: true,
        underline: true,
      });

      doc.fillColor("#000000").text(entry.page.toString(), {
        align: "right",
        underline: false,
      });

      doc.moveDown(0.5);
    }

    doc.end();
    await new Promise((resolve) => writeStream.on("finish", resolve));

    jobs[jobId].status = "completed";
    jobs[jobId].percent = 100;
    jobs[jobId].downloadUrl = `/${pdfName}`;
    jobs[jobId].message = "Success! Report Generated.";
  } catch (error) {
    logger.error(`Job failed: ${error.message}`);
    jobs[jobId].status = "failed";
    jobs[jobId].message = "Error: " + error.message;
  } finally {
    try {
      if (await fs.pathExists(workDir)) await fs.remove(workDir);
      if (await fs.pathExists(zipPath)) await fs.unlink(zipPath);
    } catch (e) {
      logger.error(e);
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Zenith V7 Enterprise running on ${PORT}`));
