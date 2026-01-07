const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("fs-extra");
const AdmZip = require("adm-zip");
const puppeteer = require("puppeteer");
const hljs = require("highlight.js");
const { marked } = require("marked.cjs");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));

// Global Job Store
const jobs = {};

// SSE Endpoint for real-time progress
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

app.post("/convert", upload.single("zipfile"), async (req, res) => {
  const jobId = Date.now().toString();
  const zipPath = req.file.path;
  const filters = req.body.filters ? req.body.filters.split(",") : [];

  // Initialize Job
  jobs[jobId] = {
    status: "processing",
    percent: 0,
    message: "Warming up engine...",
    downloadUrl: null,
  };

  // Send jobId immediately to prevent UI freeze
  res.json({ jobId });

  // Run processing in background
  processZip(jobId, zipPath, filters);
});

async function processZip(jobId, zipPath, filters) {
  const workDir = path.join(__dirname, "temp_extracted", jobId);
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);

    const getAllFiles = (dir, files = []) => {
      fs.readdirSync(dir).forEach((file) => {
        const name = path.join(dir, file);
        if (filters.some((f) => file.includes(f))) return;
        if (fs.statSync(name).isDirectory()) getAllFiles(name, files);
        else files.push(name);
      });
      return files;
    };

    const allFiles = getAllFiles(workDir);

    // --- PASS 1: Generate Table of Contents HTML ---
    let tocHtml = `<div id="toc" style="padding: 40px; font-family: sans-serif;">
                        <h1 style="color: #58a6ff; border-bottom: 2px solid #30363d; padding-bottom: 10px;">Project Index</h1>
                        <ul style="list-style: none; padding: 0;">`;

    let contentHtml = "";

    for (let i = 0; i < allFiles.length; i++) {
      const relPath = path.relative(workDir, allFiles[i]);
      const fileId = `file_${i}`; // Unique ID for anchoring

      // Add to Table of Contents
      tocHtml += `<li style="margin: 8px 0;">
                            <a href="#${fileId}" style="color: #58a6ff; text-decoration: none; font-family: monospace;">
                                ${relPath}
                            </a>
                        </li>`;

      // Update Progress
      jobs[jobId].percent = 10 + Math.floor((i / allFiles.length) * 60);
      jobs[jobId].message = `Indexing & Highlighting: ${relPath}`;

      // --- PASS 2: Content Generation ---
      contentHtml += `<div class="divider" id="${fileId}">FILE: ${relPath}</div>`;
      const content = fs.readFileSync(allFiles[i]);
      const ext = path.extname(allFiles[i]).toLowerCase();

      if ([".jpg", ".png", ".jpeg"].includes(ext)) {
        contentHtml += `<img src="data:image/png;base64,${content.toString(
          "base64"
        )}" style="max-width:100%"/>`;
      } else if (ext === ".md") {
        contentHtml += `<div class="markdown-body">${marked(
          content.toString("utf8")
        )}</div>`;
      } else {
        try {
          const highlighted = hljs.highlightAuto(
            content.toString("utf8")
          ).value;
          contentHtml += `<pre><code>${highlighted}</code></pre>`;
        } catch (e) {
          contentHtml += `<pre><code>${content.toString("utf8")}</code></pre>`;
        }
      }
    }

    tocHtml += `</ul></div>`;

    const finalHtml = `<html><head><style>
            body { font-family: -apple-system, sans-serif; background: white; color: #1a1a1a; }
            .divider { page-break-before: always; border-bottom: 2px solid #58a6ff; margin: 30px 0; padding-bottom: 10px; font-weight: bold; color: #58a6ff; font-family: monospace; }
            pre { background: #0d1117; color: #c9d1d9; padding: 15px; border-radius: 5px; font-size: 11px; white-space: pre-wrap; overflow: hidden; }
            .markdown-body { line-height: 1.6; padding: 10px; }
            a { text-decoration: none; }
        </style><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/github-dark.min.css"></head>
        <body>${tocHtml}${contentHtml}</body></html>`;

    // PDF Generation logic (Infinite timeout settings as before)
    jobs[jobId].message = "Finalizing PDF Layout...";
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(0);
    await page.setContent(finalHtml, { waitUntil: "networkidle0", timeout: 0 });

    const pdfName = `Zenith_Export_${jobId}.pdf`;
    const pdfPath = path.join(__dirname, "public", pdfName);
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      timeout: 0,
    });
    await browser.close();

    jobs[jobId].status = "completed";
    setTimeout(() => {
      const filePath = path.join(__dirname, "public", pdfName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted expired PDF: ${pdfName}`);
      }
      delete jobs[jobId];
    }, 30 * 60 * 1000); // 30 Minutes
    jobs[jobId].percent = 100;
    jobs[jobId].downloadUrl = `/${pdfName}`;
  } catch (e) {
    console.error(e);
    jobs[jobId].status = "failed";
    jobs[jobId].message = "Error: " + e.message;
  } finally {
    await fs.remove(workDir);
    await fs.remove(zipPath);
  }
}

app.listen(3000, () => console.log("Zenith V3 Engine running on port 3000"));
