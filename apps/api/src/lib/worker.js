import { Worker } from "bullmq";
import { makeRedisConnection } from "./redis.js";
import { processJob } from "./processor.js";

// BullMQ requires its own dedicated connection — do not share with queue.js
// or the publisher in processor.js.
const worker = new Worker(
  "question-upload-queue",
  async (job) => {
    const { jobId } = job.data;
    await processJob(jobId);
  },
  {
    connection: makeRedisConnection(),
    concurrency: 3
  }
);

worker.on("completed", (job) => {
  console.log(`[worker] BullMQ job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] BullMQ job ${job.id} failed:`, err.message);
});

worker.on("error", (err) => {
  // Catches connection-level errors so they don't crash the process silently
  console.error("[worker] Worker error:", err.message);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — let in-flight jobs finish before the process exits.
// Without this, SIGTERM from Docker / PM2 / systemd would kill the worker
// mid-job, leaving jobs stuck in "active" state in Redis forever.
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  console.log(`[worker] Received ${signal}, closing worker gracefully…`);
  await worker.close();
  console.log("[worker] Worker closed. Exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));