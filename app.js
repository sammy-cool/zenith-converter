const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("fs-extra");
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
app.use(express.json()); // Essential for parsing JSON body

const jobs = {};

// SSE Endpoint
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

        // FIX: Clear memory after 10 minutes to allow user download, then delete
        setTimeout(() => {
          if (jobs[req.params.jobId]) {
            delete jobs[req.params.jobId];
            console.log(`[Memory] Cleared data for Job ${req.params.jobId}`);
          }
        }, 600000); // 10 minutes
      }
    }
  }, 500);
});

// --- 2. CONVERSION ENDPOINT ---
app.post("/convert", upload.single("zipfile"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const jobId = Date.now().toString();
  const zipPath = req.file.path;

  // Parse Exclusions (Received from Frontend Analysis)
  let userExclusions = { extensions: [], folders: [] };
  try {
    if (req.body.exclusions) {
      userExclusions = JSON.parse(req.body.exclusions);
    }
  } catch (e) {
    logger.error("Failed to parse exclusions: " + e.message);
  }

  logger.info(`Job ${jobId} started.`);
  jobs[jobId] = {
    status: "processing",
    percent: 0,
    message: "Initializing Engine...",
  };

  res.json({ jobId });

  processZipV6(jobId, zipPath, userExclusions);
});

// --- 3. V6 ENGINE (Buffered Pages Strategy) ---
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
        const relPath = path.relative(workDir, fullPath).replace(/\\/g, "/"); // Normalize
        const parentFolder = relPath.split("/")[0]; // Top level folder
        const ext = path.extname(file).toLowerCase();

        // --- DYNAMIC EXCLUSION LOGIC ---
        // 1. Check Folder Exclusions (e.g., "node_modules")
        if (
          exclusions.folders.some(
            (ex) => relPath.startsWith(ex) || relPath === ex,
          )
        )
          continue;

        // 2. Check Extension Exclusions (e.g., ".png")
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

    // C. GENERATE PDF
    // 'bufferPages: true' allows us to go back and write the Index later
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 40,
      bufferPages: true,
    });
    const writeStream = fs.createWriteStream(finalPdfPath);
    doc.pipe(writeStream);

    // --- STEP 1: RESERVE PAGES FOR INDEX ---
    // We guess 2 pages for Index. If it needs more, PDFKit handles flow, but we start content after.
    jobs[jobId].message = "Analyzing Structure...";
    doc.addPage();
    const indexStartPage = 0; // 0-based index for PDFKit switching

    // Write a temporary placeholder title
    doc.fontSize(24).text("Generating Index...", { align: "center" });
    doc.addPage(); // Buffer another page just in case

    // --- STEP 2: RENDER CONTENT ---
    const tocEntries = []; // Store { title, dest }

    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      const relPath = path.relative(workDir, filePath).replace(/\\/g, "/");
      const safeId = `dest_${i}`; // Unique Internal Anchor ID

      // Start new page for file
      doc.addPage();

      // [ENTERPRISE FIX] Capture current page number
      const currentPageNum = doc.bufferedPageRange().count;

      // Add Anchor Point
      doc.addNamedDestination(safeId);

      // Save title, destination AND page number
      tocEntries.push({
        title: relPath,
        dest: safeId,
        page: currentPageNum,
      });

      // HEADER (High Visibility Blue)
      doc.rect(40, 40, 530, 25).fill("#e6f0ff").stroke(); // Light blue box
      doc
        .fillColor("#0052cc")
        .fontSize(12)
        .font("Helvetica-Bold")
        .text(relPath, 50, 48, { underline: false });

      doc.moveDown(2);

      // CONTENT (High Contrast Black with Line Numbers)
      try {
        // 1. Read as Buffer to check for binary (Priority Fix #2)
        const buffer = fs.readFileSync(filePath);
        const isBinary = buffer.slice(0, 1000).includes(0);

        if (isBinary) {
          doc
            .fillColor("#cc0000")
            .font("Helvetica-Oblique")
            .text("[Binary File: Content Omitted]", { width: 530 });
          doc.moveDown();
        } else {
          // 2. Prepare Code Content
          let content = buffer.toString("utf8").slice(0, 100000);
          // Remove control characters that break PDFKit
          content = content.replace(
            /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g,
            "",
          );

          const lines = content.split(/\r?\n/);
          doc.fontSize(9).font("Courier"); // Smaller font for code

          // 3. Render Loop
          for (let j = 0; j < lines.length; j++) {
            const line = lines[j];
            const lineNum = (j + 1).toString();

            // Calculate height of this line (in case code wraps)
            const codeWidth = 480;
            const lineHeight = doc.heightOfString(line, { width: codeWidth });
            const rowHeight = Math.max(lineHeight, 12); // Minimum height

            // Check for Page Break
            if (doc.y + rowHeight > doc.page.height - 50) {
              doc.addPage();
            }

            const currentY = doc.y;

            // Draw Gutter (Gray Sidebar)
            doc
              .rect(40, currentY, 35, rowHeight) // x=40, width=35
              .fillColor("#f5f5f5")
              .fill();

            // Draw Line Number
            doc.fillColor("#999999").text(lineNum, 42, currentY + 2, {
              width: 30,
              align: "right",
              lineBreak: false, // Numbers shouldn't wrap
            });

            // Draw Code Line
            doc.fillColor("#000000").text(line, 85, currentY + 2, {
              width: codeWidth,
              align: "left",
            });

            // Explicitly move down for next loop iteration
            // (We reset X to margin because PDFKit remembers the last text X)
            doc.x = 40;
          }
        }
      } catch (err) {
        doc.fillColor("#cc0000").text(`[Error reading file: ${err.message}]`);
      }

      // Progress & GC
      if (i % 10 === 0) {
        const p = Math.floor((i / allFiles.length) * 80);
        jobs[jobId].percent = p;
        jobs[jobId].message = `Rendering: ${relPath}`;
        if (global.gc) global.gc();
      }
    }

    // --- STEP 3: GO BACK AND WRITE INDEX ---
    jobs[jobId].message = "Writing Interactive Index...";

    // Switch to the very first page we reserved
    doc.switchToPage(indexStartPage);

    // Clear the "Generating..." placeholder by drawing a white box over it
    doc.rect(0, 0, 600, 800).fill("white");

    doc
      .fillColor("#000000")
      .fontSize(20)
      .font("Helvetica-Bold")
      .text("PROJECT INDEX", 50, 50, { align: "center" });
    doc.moveDown();

    doc.fontSize(10).font("Helvetica");

    // Write Index Entries
    for (const entry of tocEntries) {
      // Check if we need a new page for the Index itself
      if (doc.y > 700) {
        doc.addPage();
        doc.switchToPage(doc.bufferedPageRange().count - 1); // Switch to the new index page
      }

      // 1. Write the File Name (Left Aligned)
      doc.fillColor("#0052cc").text(entry.title, {
        goTo: entry.dest,
        indent: 20,
        width: 450, // Leave room for the page number
        continued: true, // Keep cursor on the same line
        underline: true,
      });

      // 2. Write the Page Number (Right Aligned)
      doc.fillColor("#000000").text(entry.page.toString(), {
        align: "right",
        underline: false,
      });

      doc.moveDown(0.4);
    }

    doc.end();
    await new Promise((resolve) => writeStream.on("finish", resolve));

    // Cleanup
    await fs.remove(workDir);

    jobs[jobId].status = "completed";
    jobs[jobId].percent = 100;
    jobs[jobId].downloadUrl = `/${pdfName}`;
    jobs[jobId].message = "PDF Generated Success! Index generated on Page 1.";
  } catch (error) {
    logger.error(`Job ${jobId} failed: ${error.message}`);
    jobs[jobId].status = "failed";
    jobs[jobId].message = "Error: " + error.message;
  } finally {
    //Cleanup BOTH the extracted folder AND the original ZIP file
    try {
      if (await fs.pathExists(workDir)) {
        await fs.remove(workDir);
      }
      if (await fs.pathExists(zipPath)) {
        await fs.unlink(zipPath); // Deletes the uploaded ZIP
        logger.info(`[Cleanup] Deleted temp files for Job ${jobId}`);
      }
    } catch (error) {
      logger.error(`Cleanup failed for Job ${jobId}: ${error.message}`);
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Zenith V6 Engine running on ${PORT}`));
