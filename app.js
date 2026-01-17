const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs-extra");
const AdmZip = require("adm-zip");
const winston = require("winston");
const PDFDocument = require("pdfkit");
const { PDFDocument: PDFLibDoc } = require("pdf-lib");

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
      }
    }
  }, 500);
});

// --- 2. CONVERSION ENDPOINT ---
app.post("/convert", upload.single("zipfile"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const jobId = Date.now().toString();
  const zipPath = req.file.path;

  // Parse dynamic exclusions sent from frontend
  let exclusions = [];
  if (req.body.exclusions) {
    try {
      exclusions = JSON.parse(req.body.exclusions);
    } catch (e) {}
  }

  logger.info(`Job ${jobId} started. Exclusions: ${exclusions.join(", ")}`);

  jobs[jobId] = {
    status: "processing",
    percent: 0,
    message: "Initializing V5 Engine...",
  };
  res.json({ jobId });

  processZipV5(jobId, zipPath, exclusions);
});

// --- 3. V5 ENGINE (Stitching Architecture) ---
async function processZipV5(jobId, zipPath, exclusions) {
  const workDir = path.join(__dirname, "temp_extracted", jobId);
  const contentPdfPath = path.join(workDir, "content_temp.pdf");
  const tocPdfPath = path.join(workDir, "toc_temp.pdf");
  const finalPdfPath = path.join(
    __dirname,
    "public",
    `Zenith_Export_${jobId}.pdf`,
  );

  // ToC Data Tracker
  const tocData = []; // [{ title: "src/app.js", page: 5, destId: "loc_5" }]

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
        const relPath = path.relative(workDir, fullPath).replace(/\\/g, "/"); // Normalize path

        // CHECK EXCLUSIONS (Dynamic)
        // 1. Check exact folder match (e.g., "node_modules")
        if (exclusions.some((ex) => relPath.startsWith(ex) || relPath === ex))
          continue;

        // 2. Check extension match (e.g., ".png")
        const ext = path.extname(file).toLowerCase();
        if (exclusions.includes(ext)) continue;

        if (fs.statSync(fullPath).isDirectory()) {
          results = results.concat(getFiles(fullPath));
        } else {
          results.push(fullPath);
        }
      }
      return results;
    };

    const allFiles = getFiles(workDir);

    // C. GENERATE CONTENT PDF (Streamed)
    jobs[jobId].message = "Rendering Content...";
    const doc = new PDFDocument({ autoFirstPage: false, margin: 40 });
    const contentStream = fs.createWriteStream(contentPdfPath);
    doc.pipe(contentStream);

    let pageCounter = 0; // Track pages relative to content PDF

    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      const relPath = path.relative(workDir, filePath).replace(/\\/g, "/");
      const safeId = `dest_${i}`; // Stable Anchor ID

      doc.addPage();
      pageCounter++; // PDFKit adds page, we count it

      // Store ToC Entry (We will adjust page number later after merging)
      tocData.push({ title: relPath, pageCount: pageCounter, id: safeId });

      // Add Destination Anchor
      doc.addNamedDestination(safeId);

      // Header
      doc
        .fontSize(12)
        .fillColor("#58a6ff")
        .font("Courier-Bold")
        .text(`FILE: ${relPath}`, { underline: true });
      doc.moveDown(0.5);

      // Read & Format Content
      try {
        const content = fs.readFileSync(filePath, "utf8").slice(0, 100000); // 100KB Cap
        // Remove null bytes that crash PDFKit
        const cleanContent = content.replace(/\u0000/g, "");

        doc
          .fontSize(9)
          .fillColor("#c9d1d9")
          .font("Courier") // Dark Mode Text
          .text(cleanContent);
      } catch (e) {
        doc.fillColor("red").text(`[Binary or Unreadable File]`);
      }

      // Progress Update
      if (i % 10 === 0) {
        const p = Math.floor((i / allFiles.length) * 70);
        jobs[jobId].percent = p;
        jobs[jobId].message = `Processing: ${relPath}`;
        if (global.gc) global.gc();
      }
    }
    doc.end();
    await new Promise((r) => contentStream.on("finish", r));

    // D. GENERATE INDEX PDF
    jobs[jobId].message = "Generating Index...";
    const tocDoc = new PDFDocument({ margin: 40 });
    const tocStream = fs.createWriteStream(tocPdfPath);
    tocDoc.pipe(tocStream);

    tocDoc
      .fontSize(18)
      .fillColor("black")
      .font("Helvetica-Bold")
      .text("INDEX", { align: "center" });
    tocDoc.moveDown();

    // Calculate Page Offset. ToC usually takes 1-2 pages.
    // We can't know exactly, but PDF-Lib handles merging beautifully.
    // For clickable links to work across docs, we rely on Named Destinations.

    tocDoc.fontSize(10).font("Helvetica");

    tocData.forEach((entry, idx) => {
      // Link to the Named Destination we created in Content PDF
      tocDoc.fillColor("#0052cc").text(entry.title, {
        link: entry.id, // Links to "dest_X"
        underline: false,
      });
    });

    tocDoc.end();
    await new Promise((r) => tocStream.on("finish", r));

    // E. STITCHING (The Magic Step)
    jobs[jobId].message = "Stitching Final Document...";
    const pdfDoc = await PDFLibDoc.create();

    // Load ToC
    const tocBytes = fs.readFileSync(tocPdfPath);
    const tocPdf = await PDFLibDoc.load(tocBytes);
    const tocPages = await pdfDoc.copyPages(tocPdf, tocPdf.getPageIndices());
    tocPages.forEach((page) => pdfDoc.addPage(page));

    // Load Content
    const contentBytes = fs.readFileSync(contentPdfPath);
    const contentPdf = await PDFLibDoc.load(contentBytes);
    const contentPages = await pdfDoc.copyPages(
      contentPdf,
      contentPdf.getPageIndices(),
    );
    contentPages.forEach((page) => pdfDoc.addPage(page));

    // Save
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(finalPdfPath, pdfBytes);

    // Cleanup
    await fs.remove(workDir);

    jobs[jobId].status = "completed";
    jobs[jobId].percent = 100;
    jobs[jobId].downloadUrl = `/${path.basename(finalPdfPath)}`;
    jobs[jobId].message = "Done! Index created on Page 1.";
  } catch (error) {
    logger.error(error);
    jobs[jobId].status = "failed";
    jobs[jobId].message = "Error: " + error.message;
    await fs.remove(workDir);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Zenith V5 running on ${PORT}`));
