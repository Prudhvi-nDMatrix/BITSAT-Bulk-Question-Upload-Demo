import path from "path";
import { fileURLToPath } from "url";
import { makeRedisConnection, jobChannel } from "./redis.js";
import {
  getJobById,
  setJobStatus,
  persistQuestion,
  finalizeJob
} from "./store.js";
import { parseDocxUpload } from "./docxParser.js";
import { validateAndPrepareQuestion } from "./validator.js";

// ---------------------------------------------------------------------------
// DATA_DIR — if the env var is not set, fall back to __dirname arithmetic
// so the worker still works when started without an env var.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "../../..", "storage", "demo");
// __dirname = apps/api/src/lib
// ../../..  = apps/api/src/lib -> apps/api/src -> apps/api -> apps
// then join "storage/demo"     = apps/storage/demo  ✓

const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const ASSETS_DIR  = path.join(DATA_DIR, "assets");
const SCRATCH_DIR = path.join(DATA_DIR, "scratch");

console.log("[processor] DATA_DIR →", DATA_DIR);

// ---------------------------------------------------------------------------
// Redis publisher — needs its own connection, separate from the BullMQ
// worker connection, because subscribe/publish can't share a socket.
// ---------------------------------------------------------------------------
const publisher = makeRedisConnection();

publisher.on("error", (err) => {
  console.error("[processor] Redis publisher error:", err.message);
});

// Log when publisher connects so we can confirm Redis is reachable
publisher.on("connect", () => {
  console.log("[processor] Redis publisher connected");
});

async function publishJobUpdate(jobId, payload) {
  try {
    const receivers = await publisher.publish(jobChannel(jobId), JSON.stringify(payload));
    console.log(`[processor] Published "${payload.status}" for job ${jobId} → ${receivers} subscriber(s) received it`);
  } catch (err) {
    console.error(`[processor] PUBLISH failed for job ${jobId}:`, err.message);
  }
}

export async function processJob(jobId) {
  console.log(`[processor] processJob START — jobId: ${jobId}`);

  const job = await getJobById(DATA_DIR, jobId);
  if (!job) {
    console.warn(`[processor] Job ${jobId} not found in store — was it created by index.js?`);
    console.warn(`[processor] DATA_DIR being read: ${DATA_DIR}`);
    return;
  }

  console.log(`[processor] Job ${jobId} found, status: ${job.status}`);

  await setJobStatus(DATA_DIR, jobId, "PROCESSING");
  await publishJobUpdate(jobId, { jobId, status: "PROCESSING" });

  const errors   = [];
  const warnings = [];
  let successCount   = 0;
  let failureCount   = 0;
  let totalQuestions = 0;

  try {
    console.log(`[processor] Parsing DOCX for job ${jobId}`);
    const parsed = await parseDocxUpload({
      docxPath:   path.join(UPLOADS_DIR, `${jobId}.docx`),
      scratchDir: path.join(SCRATCH_DIR, jobId)
    });

    totalQuestions = parsed.questions.length;
    console.log(`[processor] Parsed ${totalQuestions} questions for job ${jobId}`);

    for (const question of parsed.questions) {
      const result = await validateAndPrepareQuestion(question, jobId, ASSETS_DIR);
      warnings.push(...result.warnings);

      if (!result.validQuestion) {
        errors.push(...result.errors);
        failureCount += 1;
        continue;
      }

      await persistQuestion(DATA_DIR, jobId, result.validQuestion);
      successCount += 1;
    }

    const status =
      successCount === 0 && failureCount > 0
        ? "FAILED"
        : failureCount > 0
          ? "COMPLETED_WITH_ERRORS"
          : "COMPLETED";

    console.log(`[processor] Job ${jobId} done — status: ${status}, success: ${successCount}, failed: ${failureCount}`);

    const report = {
      jobId, status,
      totalQuestionsDetected: totalQuestions,
      successCount, failureCount, errors, warnings
    };

    await finalizeJob(DATA_DIR, report);
    await publishJobUpdate(jobId, report);

  } catch (error) {
    console.error(`[processor] Unexpected error for job ${jobId}:`, error.message);
    console.error(error.stack);

    errors.push({
      questionIndex: 0,
      type:    error?.errorType || "UNEXPECTED_ERROR",
      message: error?.message   || String(error)
    });

    const report = {
      jobId,
      status: "FAILED",
      totalQuestionsDetected: totalQuestions,
      successCount,
      failureCount: failureCount || 1,
      errors,
      warnings
    };

    await finalizeJob(DATA_DIR, report);
    await publishJobUpdate(jobId, report);
  }
}