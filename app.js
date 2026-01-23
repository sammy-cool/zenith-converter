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
            logger.info(`[Memory] Cleared data for Job ${req.params.jobId}`);
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

  let userExclusions = { extensions: [], folders: [] };
  try {
    if (req.body.exclusions) {
      userExclusions = JSON.parse(req.body.exclusions);
    }
  } catch (e) {
    logger.error("Failed to parse exclusions: " + e.message);
  }

  jobs[jobId] = {
    status: "processing",
    percent: 0,
    message: "Initializing Engine...",
  };

  logger.info(`Job ${jobId} started.`);
  res.json({ jobId });

  processZipV6(jobId, zipPath, userExclusions);
});

// --- MAIN ENGINE ---
async function processZipV6(jobId, zipPath, exclusions) {
  const workDir = path.join(__dirname, "temp_extracted", jobId);
  const pdfName = `Zenith_Export_${jobId}.pdf`;
  const finalPdfPath = path.join(__dirname, "public", pdfName);

  try {
    // A. EXTRACT
    jobs[jobId].message = "Extracting Archive...";
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);

    // B. SCAN FILES
    const getFiles = (dir) => {
      let results = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const relPath = path.relative(workDir, fullPath).replace(/\\/g, "/");

        // Check if ANY part of the path matches an excluded folder
        const pathSegments = relPath.split("/");
        const isExcludedFolder = exclusions.folders.some(
          (exFolder) =>
            pathSegments.includes(exFolder) ||
            relPath.startsWith(exFolder + "/") ||
            relPath === exFolder,
        );

        if (isExcludedFolder) continue;

        // Check Extension
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
    logger.info(`Processing ${allFiles.length} files for Job ${jobId}`);

    // C. SETUP PDF
    const doc = new PDFDocument({
      autoFirstPage: false,
      bufferPages: true, // Essential for Indexing
      margin: 40,
    });

    const writeStream = fs.createWriteStream(finalPdfPath);
    doc.pipe(writeStream);

    // Calculate how many pages the Index will need roughly (35 entries per page)
    const filesPerPage = 35;
    const requiredIndexPages = Math.max(
      1,
      Math.ceil(allFiles.length / filesPerPage),
    );

    jobs[jobId].message = `Allocating ${requiredIndexPages} pages for Index...`;

    // Create Reserved Pages for Index
    for (let k = 0; k < requiredIndexPages; k++) {
      doc.addPage();
      // We will come back to these pages later
    }

    // Move to the next page to start writing code
    if (requiredIndexPages > 0) doc.addPage();

    // D. RENDER CONTENT
    const tocEntries = [];

    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      const relPath = path.relative(workDir, filePath).replace(/\\/g, "/");
      const safeId = `dest_${i}`;

      // Start new page for file content
      if (i > 0) doc.addPage(); // First file already has a page from line 155

      const currentPageNum = doc.bufferedPageRange().count;
      doc.addNamedDestination(safeId);

      // Add to TOC
      tocEntries.push({ title: relPath, dest: safeId, page: currentPageNum });

      // HEADER
      doc.rect(40, 40, 530, 25).fill("#e6f0ff").stroke();
      doc
        .fillColor("#0052cc")
        .fontSize(12)
        .font("Helvetica-Bold")
        .text(relPath, 50, 48, { underline: false });

      doc.moveDown(2);

      // CODE RENDERER
      try {
        const buffer = fs.readFileSync(filePath);
        // Binary Check
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
            const rowHeight = Math.max(
              doc.heightOfString(line, { width: 480 }),
              12,
            );

            if (doc.y + rowHeight > doc.page.height - 50) {
              doc.addPage();
            }

            const currentY = doc.y;
            // Gutter & Line Num
            doc.rect(40, currentY, 35, rowHeight).fillColor("#f5f5f5").fill();
            doc
              .fillColor("#999999")
              .text(lineNum, 42, currentY + 2, { width: 30, align: "right" });
            // Code
            doc
              .fillColor("#000000")
              .text(line, 85, currentY + 2, { width: 480, align: "left" });

            doc.x = 40;
          }
        }
      } catch (err) {
        doc.fillColor("#cc0000").text(`[Error: ${err.message}]`);
      }

      // Progress Update
      if (i % 5 === 0) {
        const p = Math.floor((i / allFiles.length) * 80);
        jobs[jobId].percent = p;
        jobs[jobId].message = `Rendering: ${relPath}`;
        if (global.gc) global.gc();
      }
    }

    // E. WRITE INDEX (Go back to start)
    jobs[jobId].message = "Finalizing Index...";

    // Switch to Page 0 (First Page)
    doc.switchToPage(0);

    // Index Header
    doc.rect(0, 0, 600, 800).fill("white"); // Clean slate
    doc
      .fillColor("#000000")
      .fontSize(24)
      .font("Helvetica-Bold")
      .text("PROJECT INDEX", { align: "center" });
    doc.moveDown();
    doc.fontSize(10).font("Helvetica");

    // Write Entries
    let pageIndex = 0; // Tracks which index page we are on

    for (const entry of tocEntries) {
      // If we hit the bottom of the current index page
      if (doc.y > 700) {
        pageIndex++;
        // Check if we reserved enough pages. If not, this is a fallback.
        // But since we calculated requiredIndexPages, this should match.
        if (pageIndex < requiredIndexPages) {
          doc.switchToPage(pageIndex);
          doc.rect(0, 0, 600, 800).fill("white"); // Clear background
          doc.moveDown(2); // Margin
        } else {
          // If calculation failed (rare), just add page at end (fallback)
          doc.addPage();
        }
      }

      // File Link
      doc.fillColor("#0052cc").text(entry.title, {
        goTo: entry.dest,
        indent: 20,
        width: 450,
        continued: true,
        underline: true,
      });

      // Page Number
      doc.fillColor("#000000").text(entry.page.toString(), {
        align: "right",
        underline: false,
      });

      doc.moveDown(0.4);
    }

    doc.end();
    await new Promise((resolve) => writeStream.on("finish", resolve));

    jobs[jobId].status = "completed";
    jobs[jobId].percent = 100;
    jobs[jobId].downloadUrl = `/${pdfName}`;
    jobs[jobId].message = "Success!";
  } catch (error) {
    logger.error(`Job failed: ${error.message}`);
    jobs[jobId].status = "failed";
    jobs[jobId].message = "Error: " + error.message;
  } finally {
    try {
      if (await fs.pathExists(workDir)) await fs.remove(workDir);
      if (await fs.pathExists(zipPath)) await fs.unlink(zipPath);
    } catch (e) {
      logger.error("Cleanup error");
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Zenith V6 Fixed running on ${PORT}`));
