import fs from "fs/promises";
import path from "path";
import { Mutex } from "async-mutex";

// ---------------------------------------------------------------------------
// One mutex per dataDir prevents concurrent workers from interleaving reads
// and writes to the same store.json file.  Without this, three parallel
// BullMQ jobs (concurrency: 3) can each read the same stale snapshot, make
// their own edits, and then overwrite each other — silently losing data.
// ---------------------------------------------------------------------------
const mutexRegistry = new Map();

function getMutex(dataDir) {
  if (!mutexRegistry.has(dataDir)) {
    mutexRegistry.set(dataDir, new Mutex());
  }
  return mutexRegistry.get(dataDir);
}

function now() {
  return new Date().toISOString();
}

function storePath(dataDir) {
  return path.join(dataDir, "store.json");
}

const EMPTY_STORE = () => ({ uploadJobs: [], questions: [], questionImages: [] });

async function readStore(dataDir) {
  let raw;
  try {
    raw = await fs.readFile(storePath(dataDir), "utf8");
  } catch {
    // File doesn't exist yet — return a blank store; the next writeStore will create it
    return EMPTY_STORE();
  }

  // Empty file — happens when a previous process crashed mid-write
  if (!raw || !raw.trim()) {
    console.warn("[store] store.json is empty, recovering with blank store");
    return EMPTY_STORE();
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt JSON — back up the bad file and start fresh rather than crashing
    const backup = storePath(dataDir) + `.corrupt-${Date.now()}`;
    await fs.rename(storePath(dataDir), backup).catch(() => {});
    console.error(`[store] store.json was corrupt — backed up to ${path.basename(backup)}, resetting`);
    return EMPTY_STORE();
  }
}

// Atomic write: write to a temp file first, then rename over the target.
// A rename is atomic on every OS we care about, so a crash mid-write will
// never leave store.json empty or half-written again.
async function writeStore(dataDir, store) {
  const target = storePath(dataDir);
  const tmp    = target + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/**
 * Runs `fn` inside an exclusive lock for `dataDir`.
 * All store mutations must go through this so concurrent workers
 * never see a torn write.
 */
async function withLock(dataDir, fn) {
  const mutex = getMutex(dataDir);
  return mutex.runExclusive(fn);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createStore(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const target = storePath(dataDir);

  // Check if the file already exists AND has valid JSON — if either is false, (re)create it.
  // This handles three cases:
  //   1. File doesn't exist   -> create it
  //   2. File is empty        -> overwrite it
  //   3. File has valid JSON  -> leave it alone (preserves existing data)
  try {
    const raw = await fs.readFile(target, "utf8");
    if (raw && raw.trim()) {
      JSON.parse(raw); // throws if corrupt — caught below
      return;          // file is fine, nothing to do
    }
  } catch {
    // Missing, empty, or corrupt — fall through and write a fresh store
  }

  await fs.writeFile(
    target,
    JSON.stringify(EMPTY_STORE(), null, 2),
    "utf8"
  );
}

export async function createUploadJob(dataDir, job) {
  await withLock(dataDir, async () => {
    const store = await readStore(dataDir);
    const timestamp = now();
    store.uploadJobs.push({
      id: job.id,
      uploadedBy: job.uploadedBy,
      sourceFileName: job.sourceFileName,
      sourceBlobUrl: job.sourceBlobUrl,
      status: "PENDING",
      totalQuestionsDetected: 0,
      successCount: 0,
      failureCount: 0,
      errorReportJson: {
        jobId: job.id,
        status: "PENDING",
        totalQuestionsDetected: 0,
        successCount: 0,
        failureCount: 0,
        errors: [],
        warnings: []
      },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await writeStore(dataDir, store);
  });
}

export async function setJobStatus(dataDir, jobId, status) {
  await withLock(dataDir, async () => {
    const store = await readStore(dataDir);
    const job = store.uploadJobs.find((entry) => entry.id === jobId);
    if (!job) return;
    job.status = status;
    job.updatedAt = now();
    job.errorReportJson.status = status;
    await writeStore(dataDir, store);
  });
}

export async function finalizeJob(dataDir, report) {
  await withLock(dataDir, async () => {
    const store = await readStore(dataDir);
    const job = store.uploadJobs.find((entry) => entry.id === report.jobId);
    if (!job) return;
    job.status = report.status;
    job.totalQuestionsDetected = report.totalQuestionsDetected;
    job.successCount = report.successCount;
    job.failureCount = report.failureCount;
    job.updatedAt = now();
    job.errorReportJson = {
      jobId: report.jobId,
      status: report.status,
      totalQuestionsDetected: report.totalQuestionsDetected,
      successCount: report.successCount,
      failureCount: report.failureCount,
      errors: report.errors,
      warnings: report.warnings
    };
    await writeStore(dataDir, store);
  });
}

export async function persistQuestion(dataDir, jobId, question) {
  await withLock(dataDir, async () => {
    const store = await readStore(dataDir);

    store.questions ||= [];
    store.questions.push({
      id: question.id,
      uploadJobId: jobId,
      questionIndex: question.questionIndex,
      questionText: question.questionText,
      optionAText: question.optionAText,
      optionBText: question.optionBText,
      optionCText: question.optionCText,
      optionDText: question.optionDText,
      solutionText: question.solutionText,
      correctAnswer: question.correctAnswer,
      hintText: question.hintText,
      hasImages: question.hasImages,
      ingestionStatus: question.ingestionStatus
    });

    store.questionImages ||= [];
    for (const image of question.images) {
      store.questionImages.push({ ...image, questionId: question.id });
    }

    await writeStore(dataDir, store);
  });
}

// Read-only helpers do NOT need a lock — they are snapshot reads and the
// worst case is reading data that is one write behind, which is acceptable
// for status polling.

export async function getJobById(dataDir, jobId) {
  const store = await readStore(dataDir);
  return store.uploadJobs.find((entry) => entry.id === jobId) || null;
}

export async function listQuestionsByJobId(dataDir, jobId) {
  const store = await readStore(dataDir);
  const questions = store.questions || [];
  const images = store.questionImages || [];

  return questions
    .filter((question) => question.uploadJobId === jobId)
    .sort((a, b) => a.questionIndex - b.questionIndex)
    .map((question) => ({
      ...question,
      images: images
        .filter((image) => image.questionId === question.id)
        .sort((a, b) => a.sequenceOrder - b.sequenceOrder)
    }));
}