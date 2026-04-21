import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { makeRedisConnection, jobChannel } from "./lib/redis.js";
import { questionQueue } from "./lib/queue.js";
import {
  createStore,
  createUploadJob,
  getJobById,
  listQuestionsByJobId
} from "./lib/store.js";

// ---------------------------------------------------------------------------
// DATA_DIR
// Both index.js (API) and worker.js (via processor.js) must point at the
// same directory. Set DATA_DIR in your environment so there is no ambiguity.
//
// Quickest way — inline when starting:
//   $env:DATA_DIR="C:\...\apps\storage\demo"; node apps/api/src/index.js
//
// Or add to a .env file and load with --env-file or dotenv.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.resolve(__dirname, "../../..");
const DATA_DIR   = path.join(ROOT_DIR, "storage", "demo");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const ASSETS_DIR  = path.join(DATA_DIR, "assets");
const SCRATCH_DIR = path.join(DATA_DIR, "scratch");

console.log("[index] DATA_DIR →", DATA_DIR);

// Ensure all storage directories exist and store.json is initialised.
// This must happen BEFORE any request handler tries to read the store.
await fs.mkdir(UPLOADS_DIR, { recursive: true });
await fs.mkdir(ASSETS_DIR,  { recursive: true });
await fs.mkdir(SCRATCH_DIR, { recursive: true });
await createStore(DATA_DIR);

// ---------------------------------------------------------------------------
// Redis pub/sub subscriber — receives job-state signals from the worker
// process and forwards them to waiting SSE clients via jobEvents.
//
// WHY a dedicated connection?
//   Once you call .psubscribe() on an IORedis instance it enters subscriber
//   mode and can no longer issue regular commands (queue.add, etc.) on the
//   same socket. Every concern — Queue, Worker, Publisher, Subscriber — needs
//   its own connection.
// ---------------------------------------------------------------------------
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0); // unlimited listeners (one per concurrent SSE client)

const subscriber = makeRedisConnection();
await subscriber.psubscribe("job-updates:*");

subscriber.on("pmessage", (_pattern, channel, message) => {
  const jobId = channel.slice("job-updates:".length);
  try {
    const payload = JSON.parse(message);
    jobEvents.emit(`job-${jobId}-updated`, payload);
    console.log(`[index] pub/sub received for job ${jobId}, status: ${payload.status}`);
  } catch {
    console.warn("[index] Received malformed pub/sub message on", channel);
  }
});

subscriber.on("error", (err) => {
  console.error("[index] Redis subscriber error:", err.message);
});

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const upload = multer({ dest: UPLOADS_DIR });
const app    = express();
app.use(express.json());
app.use("/assets", express.static(ASSETS_DIR));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function enqueue(jobId) {
  await questionQueue.add(
    "process-docx",
    { jobId },
    { attempts: 3, backoff: { type: "exponential", delay: 2000 } }
  );
}

function buildJobPayload(job, questions) {
  return {
    jobId:                  job.id,
    uploadedBy:             job.uploadedBy,
    sourceFileName:         job.sourceFileName,
    status:                 job.status,
    totalQuestionsDetected: job.totalQuestionsDetected,
    successCount:           job.successCount,
    failureCount:           job.failureCount,
    hasErrors:              job.failureCount > 0,
    questions,
    createdAt:              job.createdAt,
    updatedAt:              job.updatedAt
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// POST /api/question-uploads
app.post("/api/question-uploads", upload.single("file"), async (req, res) => {
  const file       = req.file;
  const uploadedBy = req.body.uploadedBy || "faculty.demo";

  if (!file) {
    return res.status(400).json({ error: "A .docx file is required" });
  }
  if (!file.originalname.toLowerCase().endsWith(".docx")) {
    await fs.unlink(file.path).catch(() => {});
    return res.status(400).json({ error: "Only .docx files are supported" });
  }

  const jobId  = randomUUID();
  const target = path.join(UPLOADS_DIR, `${jobId}.docx`);
  await fs.rename(file.path, target);

  await createUploadJob(DATA_DIR, {
    id:             jobId,
    uploadedBy,
    sourceFileName: file.originalname,
    sourceBlobUrl:  `/data/uploads/${jobId}.docx`
  });

  enqueue(jobId).catch((err) =>
    console.error(`[index] Failed to enqueue job ${jobId}:`, err.message)
  );

  console.log(`[index] Job ${jobId} created and enqueued`);

  return res.status(202).json({
    jobId,
    status:    "PENDING",
    message:   "Upload accepted for background processing",
    statusUrl: `/api/question-uploads/${jobId}`
  });
});

// GET /api/debug/queue  — shows BullMQ job counts and recent jobs
// Remove this route before going to production.
app.get("/api/debug/queue", async (req, res) => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      questionQueue.getWaitingCount(),
      questionQueue.getActiveCount(),
      questionQueue.getCompletedCount(),
      questionQueue.getFailedCount(),
      questionQueue.getDelayedCount()
    ]);

    // Get the 10 most recent jobs of each type for inspection
    const [waitingJobs, activeJobs, failedJobs, completedJobs] = await Promise.all([
      questionQueue.getWaiting(0, 9),
      questionQueue.getActive(0, 9),
      questionQueue.getFailed(0, 9),
      questionQueue.getCompleted(0, 9)
    ]);

    res.json({
      counts: { waiting, active, completed, failed, delayed },
      waitingJobs: waitingJobs.map(j => ({
        bullId: j.id,
        jobId:  j.data.jobId,
        attempts: j.attemptsMade
      })),
      activeJobs: activeJobs.map(j => ({
        bullId: j.id,
        jobId:  j.data.jobId,
        attempts: j.attemptsMade
      })),
      failedJobs: failedJobs.map(j => ({
        bullId:     j.id,
        jobId:      j.data.jobId,
        attempts:   j.attemptsMade,
        failReason: j.failedReason
      })),
      completedJobs: completedJobs.map(j => ({
        bullId: j.id,
        jobId: j.data.jobId,
        attempts: j.attemptsMade
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/question-uploads/:jobId  — snapshot poll
app.get("/api/question-uploads/:jobId", async (req, res) => {
  const job = await getJobById(DATA_DIR, req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const questions = await listQuestionsByJobId(DATA_DIR, req.params.jobId);
  return res.json(buildJobPayload(job, questions));
});

// GET /api/question-uploads/:jobId/events  — SSE live updates
//
// Timeline:
//   1. Client connects → immediately send current snapshot (may already be COMPLETED)
//   2. Worker publishes to Redis → subscriber emits on jobEvents → sendSnapshot fires
//   3. sendSnapshot reads store for authoritative state and writes SSE frame
//   4. Once job is terminal, stream closes
//   5. If client disconnects early, listener is cleaned up to avoid memory leak
app.get("/api/question-uploads/:jobId/events", async (req, res) => {
  const { jobId } = req.params;

  res.writeHead(200, {
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no"   // prevent nginx from buffering SSE frames
  });
  // Flush headers immediately so the browser opens the stream
  res.flushHeaders();

  const TERMINAL = new Set(["COMPLETED", "FAILED", "COMPLETED_WITH_ERRORS"]);

  // Keep-alive so proxies and browsers don't close idle connections
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 20_000);

  let closed = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    jobEvents.off(`job-${jobId}-updated`, onJobUpdated);
  }

  async function sendSnapshot() {
    if (closed || res.writableEnded) return;
    try {
      const job = await getJobById(DATA_DIR, jobId);
      if (!job) {
        res.write(`data: ${JSON.stringify({ error: "Job not found" })}\n\n`);
        return;
      }
      const questions = await listQuestionsByJobId(DATA_DIR, jobId);
      const payload   = buildJobPayload(job, questions);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      console.log(`[index] SSE sent for job ${jobId}, status: ${payload.status}`);

      if (TERMINAL.has(job.status)) {
        cleanup();
        res.end();
      }
    } catch (err) {
      console.error(`[index] SSE snapshot error for job ${jobId}:`, err.message);
    }
  }

  function onJobUpdated() {
    sendSnapshot().catch(console.error);
  }

  jobEvents.on(`job-${jobId}-updated`, onJobUpdated);
  req.on("close", cleanup);

  // Step 1: send current state immediately on connect
  await sendSnapshot();
});

// GET /api/question-uploads/:jobId/errors
app.get("/api/question-uploads/:jobId/errors", async (req, res) => {
  const job = await getJobById(DATA_DIR, req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job.errorReportJson);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const port = Number(process.env.PORT || 5001);
app.listen(port, () => {
  console.log(`[index] API listening on http://127.0.0.1:${port}`);
});