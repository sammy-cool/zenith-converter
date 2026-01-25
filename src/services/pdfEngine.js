// The complex logic of PDF generation
const fs = require("fs-extra");
const path = require("path");
const AdmZip = require("adm-zip");
const PDFDocument = require("pdfkit");
const CONSTANTS = require("../config/constants");
const logger = require("../config/logger");
const Helpers = require("../utils/helpers");
const JobManager = require("./jobManager");
const CleanupService = require("./cleanup");

const PDFEngine = {
  async process(jobId, zipPath, exclusions, originalName) {
    const workDir = path.join(CONSTANTS.DIRS.TEMP, jobId);
    const pdfName = `${originalName}.pdf`;
    const finalPdfPath = path.join(CONSTANTS.DIRS.DOWNLOADS, pdfName);

    try {
      // 1. Extract
      JobManager.update(jobId, { message: "Extracting..." });
      await Helpers.yieldToEventLoop();

      const zip = new AdmZip(zipPath);
      zip.extractAllTo(workDir, true);

      // 2. Scan
      JobManager.update(jobId, { message: "Scanning..." });
      const allFiles = this.scanDirectory(workDir, workDir, exclusions);

      // 3. Setup PDF
      const doc = new PDFDocument({
        autoFirstPage: false,
        bufferPages: true,
        margin: CONSTANTS.PDF.MARGIN,
      });
      const writeStream = fs.createWriteStream(finalPdfPath);
      doc.pipe(writeStream);

      // Cover Page
      doc.addPage();
      this.drawCover(doc, originalName);

      // Pre-allocate Index
      const requiredIndexPages =
        Math.ceil(allFiles.length / CONSTANTS.PDF.LINES_PER_PAGE) + 1;
      for (let k = 0; k < requiredIndexPages; k++) doc.addPage();
      if (requiredIndexPages > 0) doc.addPage();

      // 4. Render Content (Async Loop)
      const tocEntries = [];
      for (let i = 0; i < allFiles.length; i++) {
        const filePath = allFiles[i];
        const relPath = path.relative(workDir, filePath).replace(/\\/g, "/");
        const safeId = `dest_${i}`;

        if (i > 0) doc.addPage();
        const currentPageNum = doc.bufferedPageRange().count;
        doc.addNamedDestination(safeId);
        tocEntries.push({ title: relPath, dest: safeId, page: currentPageNum });

        this.drawHeader(doc, relPath);

        try {
          // ASYNC READ (Crucial for performance)
          const buffer = await fs.readFile(filePath);
          const isBinary = buffer.slice(0, 1000).includes(0);

          if (isBinary) {
            doc.fillColor("#cc0000").fontSize(10).text("[Binary File Omitted]");
          } else {
            this.drawContent(doc, buffer.toString("utf8"));
          }
        } catch (e) {
          doc.fillColor("#cc0000").text("[Error Reading File]");
        }

        // Progress Update
        if (i % 5 === 0) {
          const p = Math.floor((i / allFiles.length) * 85);
          JobManager.update(jobId, {
            percent: p,
            message: `Processing: ${path.basename(relPath)}`,
          });
          await Helpers.yieldToEventLoop();
          if (global.gc) global.gc();
        }
      }

      // 5. Index
      JobManager.update(jobId, { message: "Indexing..." });
      this.drawIndex(doc, tocEntries, requiredIndexPages);

      doc.end();
      await new Promise((resolve) => writeStream.on("finish", resolve));

      JobManager.complete(jobId, `/downloads/${pdfName}`);
    } catch (error) {
      JobManager.fail(jobId, error.message);
    } finally {
      // Immediate Cleanup of ZIP and extracted folder
      await CleanupService.cleanJob(jobId, zipPath);
    }
  },

  scanDirectory(dir, rootDir, exclusions) {
    let results = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

      if (Helpers.shouldExclude(relPath, exclusions)) continue;

      if (fs.statSync(fullPath).isDirectory()) {
        results = results.concat(
          this.scanDirectory(fullPath, rootDir, exclusions),
        );
      } else {
        results.push(fullPath);
      }
    }
    return results;
  },

  drawCover(doc, title) {
    doc.rect(0, 0, 600, 900).fill("#0d1117");
    doc
      .fillColor("#ffffff")
      .fontSize(28)
      .font("Helvetica-Bold")
      .text(title, 50, 300, { align: "center", width: 500 });
    doc.addPage();
  },

  drawHeader(doc, text) {
    doc.rect(40, 40, 530, 25).fill("#e6f0ff").stroke();
    doc.fillColor("#0052cc").fontSize(12).text(text, 50, 48);
    doc.moveDown(2);
  },

  drawContent(doc, content) {
    const clean = content
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
      .slice(0, CONSTANTS.LIMITS.MAX_FILE_READ_BYTES);
    const lines = clean.split(/\r?\n/);
    doc.fontSize(9).font("Courier");

    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      const rowHeight = Math.max(doc.heightOfString(line, { width: 480 }), 12);

      if (doc.y + rowHeight > doc.page.height - 50) doc.addPage();

      const y = doc.y;
      doc.rect(40, y, 35, rowHeight).fillColor("#f5f5f5").fill();
      doc
        .fillColor("#999999")
        .text((j + 1).toString(), 42, y + 2, { width: 30, align: "right" });
      doc
        .fillColor("#000000")
        .text(line, 85, y + 2, { width: 480, align: "left" });
      doc.x = 40;
    }
  },

  drawIndex(doc, entries, maxPages) {
    let pageIdx = 1;
    doc.switchToPage(pageIdx);
    doc.y = CONSTANTS.PDF.INDEX_Y_START;

    doc.rect(0, 0, 600, 800).fill("white");
    doc.fillColor("#000000").fontSize(20).text("INDEX", { align: "center" });
    doc.moveDown();
    doc.fontSize(10);

    for (const entry of entries) {
      if (doc.y > 700) {
        pageIdx++;
        if (pageIdx <= maxPages) {
          doc.switchToPage(pageIdx);
          doc.rect(0, 0, 600, 800).fill("white");
          doc.y = CONSTANTS.PDF.INDEX_Y_START;
        } else {
          doc.addPage();
          doc.y = CONSTANTS.PDF.INDEX_Y_START;
        }
      }
      doc.fillColor("#0052cc").text(entry.title, {
        goTo: entry.dest,
        continued: true,
        underline: true,
      });
      doc
        .fillColor("#000000")
        .text(entry.page.toString(), { align: "right", underline: false });
    }
  },
};

module.exports = PDFEngine;
