const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("node:path");
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

        // Clear memory after 10 mins
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

// --- V6 ENGINE (Enterprise Grade) ---
async function processZipV6(jobId, zipPath, exclusions) {
  const workDir = path.join(__dirname, "temp_extracted", jobId);
  const pdfName = `Zenith_Export_${jobId}.pdf`;
  const finalPdfPath = path.join(__dirname, "public", pdfName);

  try {
    jobs[jobId].message = "Extracting Archive...";
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);

    // SCAN FILES
    const getFiles = (dir) => {
      let results = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const relPath = path.relative(workDir, fullPath).replace(/\\/g, "/");
        const ext = path.extname(file).toLowerCase();

        // Dynamic Exclusion Logic
        if (
          exclusions.folders.some(
            (ex) => relPath.startsWith(ex) || relPath === ex,
          )
        )
          continue;
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

    // GENERATE PDF
    const doc = new PDFDocument({
      autoFirstPage: false,
      bufferPages: true,
      margin: 40,
    });

    const writeStream = fs.createWriteStream(finalPdfPath);
    doc.pipe(writeStream);

    // STEP 1: RESERVE PAGES FOR INDEX
    jobs[jobId].message = "Analyzing Structure...";
    doc.addPage();
    const indexStartPage = 0;
    doc.fontSize(24).text("Generating Index...", { align: "center" });
    doc.addPage();

    // STEP 2: RENDER CONTENT
    const tocEntries = [];

    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      const relPath = path.relative(workDir, filePath).replace(/\\/g, "/");
      const safeId = `dest_${i}`;

      // Start new page & Capture Page Number
      doc.addPage();
      const currentPageNum = doc.bufferedPageRange().count; // [FEATURE] Page Number
      doc.addNamedDestination(safeId);

      // Save for Index
      tocEntries.push({ title: relPath, dest: safeId, page: currentPageNum });

      // HEADER
      doc.rect(40, 40, 530, 25).fill("#e6f0ff").stroke();
      doc
        .fillColor("#0052cc")
        .fontSize(12)
        .font("Helvetica-Bold")
        .text(relPath, 50, 48, { underline: false });

      doc.moveDown(2);

      // CONTENT RENDERER (With Line Numbers & Binary Check)
      try {
        const buffer = fs.readFileSync(filePath);
        // Binary Check (First 1000 bytes for nulls)
        const isBinary = buffer.slice(0, 1000).includes(0);

        if (isBinary) {
          doc
            .fillColor("#cc0000")
            .fontSize(10)
            .font("Helvetica-Oblique")
            .text("[Binary File Detected: Omitted]", { width: 530 });
        } else {
          // Safe to convert
          let content = buffer.toString("utf8").slice(0, 100000); // 100KB Limit
          content = content.replace(
            /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g,
            "",
          ); // Sanitize

          const lines = content.split(/\r?\n/);
          doc.fontSize(9).font("Courier");

          // Line Number Loop
          for (let j = 0; j < lines.length; j++) {
            const line = lines[j];
            const lineNum = (j + 1).toString();
            const codeWidth = 480;
            const lineHeight = doc.heightOfString(line, { width: codeWidth });
            const rowHeight = Math.max(lineHeight, 12);

            // Pagination Check
            if (doc.y + rowHeight > doc.page.height - 50) {
              doc.addPage();
            }

            const currentY = doc.y;

            // Gutter
            doc.rect(40, currentY, 35, rowHeight).fillColor("#f5f5f5").fill();

            // Line Num
            doc.fillColor("#999999").text(lineNum, 42, currentY + 2, {
              width: 30,
              align: "right",
              lineBreak: false,
            });

            // Code
            doc.fillColor("#000000").text(line, 85, currentY + 2, {
              width: codeWidth,
              align: "left",
            });

            doc.x = 40; // Reset X
          }
        }
      } catch (err) {
        doc.fillColor("#cc0000").text(`[Error reading file: ${err.message}]`);
      }

      // Progress Update
      if (i % 10 === 0) {
        const p = Math.floor((i / allFiles.length) * 80);
        jobs[jobId].percent = p;
        jobs[jobId].message = `Rendering: ${relPath}`;
        if (global.gc) global.gc();
      }
    }

    // STEP 3: WRITE INDEX
    jobs[jobId].message = "Writing Interactive Index...";
    doc.switchToPage(indexStartPage);
    doc.rect(0, 0, 600, 800).fill("white"); // Clear placeholder

    doc
      .fillColor("#000000")
      .fontSize(20)
      .font("Helvetica-Bold")
      .text("PROJECT INDEX", 50, 50, { align: "center" });
    doc.moveDown();
    doc.fontSize(10).font("Helvetica");

    for (const entry of tocEntries) {
      if (doc.y > 700) {
        doc.addPage();
        doc.switchToPage(doc.bufferedPageRange().count - 1);
      }

      // File Name (Left)
      doc.fillColor("#0052cc").text(entry.title, {
        goTo: entry.dest,
        indent: 20,
        width: 450,
        continued: true,
        underline: true,
      });

      // Page Num (Right)
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
    jobs[jobId].message = "Success! Report Generated.";
  } catch (error) {
    logger.error(`Job ${jobId} failed: ${error.message}`);
    jobs[jobId].status = "failed";
    jobs[jobId].message = "Error: " + error.message;
  } finally {
    // Cleanup ALL temporary files
    try {
      if (await fs.pathExists(workDir)) await fs.remove(workDir);
      if (await fs.pathExists(zipPath)) {
        await fs.unlink(zipPath);
        logger.info(`[Cleanup] Deleted ZIP for Job ${jobId}`);
      }
    } catch (e) {
      logger.error(`Cleanup failed: ${e.message}`);
    }
  }
}

app.get("/health", (req, res) => {
  const timestamp = new Date().toISOString();
  const additionalText = "Zenith is UP!";
  const responseText = `OK - ${timestamp} - ${additionalText}`;
  res.send(responseText);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Zenith V6 Enterprise running on ${PORT}`));
