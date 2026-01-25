# 🚀 Zenith Converter (Enterprise Edition)

**Zenith Converter** is a robust, enterprise-grade Node.js application that converts entire codebases (ZIP archives) into professional, readable PDF reports. It features smart indexing, syntax-friendly formatting, and a non-blocking architecture optimized for cloud deployment.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node->=18-green.svg)
![Status](https://img.shields.io/badge/status-stable-brightgreen.svg)

## ✨ Key Features

- **🛡️ Enterprise Architecture:** Built on a modular MVC pattern (Separation of Concerns).
- **⚡ Non-Blocking I/O:** Fully async file processing pipeline optimized for low-latency UI updates.
- **📉 Low Memory Footprint:** Stream-based processing designed to run on limited-resource environments (e.g., Render Free Tier).
- **🎨 Professional Reports:** Generates "Dark Mode" cover pages, Table of Contents, and paginated code blocks automatically.
- **🧹 Self-Healing:** Automated background services periodically clean up old uploads and temporary files to prevent disk overflow.
- **🐳 Docker Ready:** Production-ready `Dockerfile` included.

## 📂 Project Structure

```text
zenith-converter/
├── public/                 # Static Frontend Assets
├── uploads/                # Temporary Upload Storage
├── temp_extracted/         # Extraction Workspace
├── src/
│   ├── config/             # Constants & Logger Configuration
│   ├── controllers/        # HTTP Request Handlers
│   ├── services/           # Business Logic (PDF Engine, Job Manager, Cleanup)
│   ├── utils/              # Helper Functions (Sanitization, Helpers)
│   └── routes/             # API Route Definitions
├── app.js                  # Application Entry Point
├── Dockerfile
└── package.json            # Dependencies
```

## 🛠️ Installation & Setup

### Prerequisites

- Node.js v18+
- NPM

### Local Development

1. **Clone the repository:**

```bash
git clone [https://github.com/your-username/zenith-converter.git](https://github.com/your-username/zenith-converter.git)
cd zenith-converter

```

2. **Install Dependencies:**

```bash
npm install

```

3. **Start the Server:**

```bash
node app.js

```

The server will start on `http://localhost:3000`.

## 🐳 Docker Deployment

Build and run the containerized application:

1. **Build Image:**

```bash
docker build -t zenith-converter .

```

2. **Run Container:**

```bash
docker run -p 3000:3000 zenith-converter

```

## 📡 API Endpoints

### 1. Health Check

Used by load balancers and uptime monitors.

- **URL:** `/health`
- **Method:** `GET`
- **Response:** `200 OK`

### 2. Convert ZIP

Upload a project ZIP file to start conversion.

- **URL:** `/convert`
- **Method:** `POST`
- **Body:** `form-data` (`zipfile`: File, `exclusions`: JSON String)
- **Response:** `{ "jobId": "1731..." }`

### 3. Progress Stream

Real-time Server-Sent Events (SSE) for progress tracking.

- **URL:** `/progress/:jobId`
- **Method:** `GET`
- **Response:** Stream of JSON objects `{ "status": "processing", "percent": 45, ... }`

---

## ⚙️ Configuration

System settings can be tweaked in `src/config/constants.js`:

| Constant                     | Default   | Description                                         |
| ---------------------------- | --------- | --------------------------------------------------- |
| `LIMITS.MAX_FILE_READ_BYTES` | `100KB`   | Max size of a single source file to include in PDF. |
| `LIMITS.JOB_RETENTION_MS`    | `10 Mins` | How long job status is kept in memory.              |
| `LIMITS.CLEANUP_INTERVAL_MS` | `30 Mins` | How often the background cleaner runs.              |
| `LIMITS.FILE_AGE_LIMIT_MS`   | `1 Hour`  | Max age of temporary files before deletion.         |

---

## 🛡️ Best Practices Implemented

- **Modularization:** Business logic is isolated from HTTP transport layers.
- **Singleton Pattern:** Used for `JobManager` state management.
- **Async/Await Pattern:** Used for filesystem operations to prevent Event Loop blocking.
- **Structured Logging:** Uses `winston` for timestamped, leveled logs.

---

## 📄 License

This project is licensed under the MIT License.

---
