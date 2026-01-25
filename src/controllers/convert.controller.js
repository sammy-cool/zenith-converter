// Handles the HTTP request/response part.

const PDFEngine = require("../services/pdfEngine");
const JobManager = require("../services/jobManager");
const Helpers = require("../utils/helpers");

exports.startConversion = (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const jobId = Date.now().toString();
  const cleanName = Helpers.sanitizeName(req.file.originalname);
  
  let exclusions = { extensions: [], folders: [] };
  try {
    if (req.body.exclusions) exclusions = JSON.parse(req.body.exclusions);
  } catch (e) {}

  // 1. Create Job State
  JobManager.create(jobId);
  
  // 2. Respond immediately
  res.json({ jobId });

  // 3. Start Processing in Background
  PDFEngine.process(jobId, req.file.path, exclusions, cleanName);
};

exports.streamProgress = (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const interval = setInterval(() => {
    const job = JobManager.get(req.params.jobId);
    if (job) {
      res.write(`data: ${JSON.stringify(job)}\n\n`);
      if (job.status === "completed" || job.status === "failed") {
        clearInterval(interval);
        res.end();
      }
    } else {
      res.write(`data: ${JSON.stringify({ status: "failed", message: "Job Not Found" })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on('close', () => clearInterval(interval));
};