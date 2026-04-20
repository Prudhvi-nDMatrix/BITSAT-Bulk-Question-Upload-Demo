import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { parseDocxUpload } from "./lib/docxParser.js";

const jobEvents = new EventEmitter();
import {
  createStore,
  createUploadJob,
  getJobById,
  listQuestionsByJobId,
  persistQuestion,
  finalizeJob,
  setJobStatus
} from "./lib/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../..");
const DATA_DIR = path.join(ROOT_DIR, "storage", "demo");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const ASSETS_DIR = path.join(DATA_DIR, "assets");
const SCRATCH_DIR = path.join(DATA_DIR, "scratch");

await fs.mkdir(UPLOADS_DIR, { recursive: true });
await fs.mkdir(ASSETS_DIR, { recursive: true });
await fs.mkdir(SCRATCH_DIR, { recursive: true });
await createStore(DATA_DIR);

const upload = multer({ dest: UPLOADS_DIR });
const app = express();
app.use(express.json());
app.use("/assets", express.static(ASSETS_DIR));

const queue = [];
let processing = false;

function enqueue(jobId) {
  queue.push(jobId);
  void drainQueue();
}

async function drainQueue() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const jobId = queue.shift();
    try {
      await processJob(jobId);
    } catch (error) {
      console.error("job failed", jobId, error);
    }
  }
  processing = false;
}

async function processJob(jobId) {
  const job = await getJobById(DATA_DIR, jobId);
  if (!job) return;

  await setJobStatus(DATA_DIR, jobId, "PROCESSING");
  jobEvents.emit(`job-${jobId}-updated`);

  const errors = [];
  const warnings = [];
  let successCount = 0;
  let failureCount = 0;
  let totalQuestions = 0;

  try {
    const parsed = await parseDocxUpload({
      docxPath: path.join(UPLOADS_DIR, `${jobId}.docx`),
      scratchDir: path.join(SCRATCH_DIR, jobId)
    });

    totalQuestions = parsed.questions.length;

    for (const question of parsed.questions) {
      const result = await validateAndPrepareQuestion(question, jobId);
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

    await finalizeJob(DATA_DIR, {
      jobId,
      status,
      totalQuestionsDetected: totalQuestions,
      successCount,
      failureCount,
      errors,
      warnings
    });
    jobEvents.emit(`job-${jobId}-updated`);
  } catch (error) {
    errors.push({
      questionIndex: 0,
      type: error?.errorType || "UNEXPECTED_ERROR",
      message: error?.message || String(error)
    });

    await finalizeJob(DATA_DIR, {
      jobId,
      status: "FAILED",
      totalQuestionsDetected: totalQuestions,
      successCount,
      failureCount: failureCount || 1,
      errors,
      warnings
    });
    jobEvents.emit(`job-${jobId}-updated`);
  }
}

async function validateAndPrepareQuestion(question, jobId) {
  const errors = [];
  const warnings = [];
  const seenKeys = new Set();
  const preparedImages = [];

  const clean = (value) => (value || "").trim();
  const requiredOptions = ["optionAText", "optionBText", "optionCText", "optionDText"];

  if (!clean(question.questionText)) {
    errors.push({
      questionIndex: question.questionIndex,
      type: "EMPTY_QUESTION_TEXT",
      message: "Normalized question text is empty after parsing",
      field: "question_text"
    });
  }

  for (const field of requiredOptions) {
    if (!clean(question[field])) {
      errors.push({
        questionIndex: question.questionIndex,
        type: "MALFORMED_QUESTION_STRUCTURE",
        message: `Required option field ${camelToSnake(field)} is missing or empty`,
        field: camelToSnake(field)
      });
    }
  }

  for (const relId of question.unresolvedRelationships) {
    errors.push({
      questionIndex: question.questionIndex,
      type: "UNRESOLVED_DOCX_RELATIONSHIP",
      message: `Image relationship ${relId} could not be resolved`,
      field: "question_text"
    });
  }

  for (const [fieldName, images] of Object.entries(question.imagesByField)) {
    for (const image of images) {
      if (seenKeys.has(image.imageKey)) {
        errors.push({
          questionIndex: question.questionIndex,
          type: "DUPLICATE_IMAGE_KEY",
          message: `Duplicate generated image key ${image.imageKey} detected`,
          field: fieldName
        });
        continue;
      }
      seenKeys.add(image.imageKey);

      if (!existsSync(image.sourcePath)) {
        errors.push({
          questionIndex: question.questionIndex,
          type: "MISSING_IMAGE",
          message: `Generated placeholder [[img:${image.imageKey}]] could not be resolved to an extracted asset`,
          field: fieldName
        });
        continue;
      }

      const assetExt = path.extname(image.sourcePath);
      const assetName = `${randomUUID()}${assetExt}`;
      const destination = path.join(ASSETS_DIR, assetName);
      await fs.copyFile(image.sourcePath, destination);

      preparedImages.push({
        id: randomUUID(),
        fieldName,
        imageKey: image.imageKey,
        blobUrl: `/assets/${assetName}`,
        sequenceOrder: image.sequenceOrder,
        sourceDocxRelId: image.sourceDocxRelId,
        contentType: image.contentType,
        width: null,
        height: null
      });
    }
  }

  for (const orphan of question.orphanAssets) {
    warnings.push({
      questionIndex: question.questionIndex,
      type: "UNUSED_IMAGE",
      message: `Extracted image ${orphan} was not referenced after normalization`
    });
  }

  if (errors.length) {
    return { validQuestion: null, errors, warnings };
  }

  return {
    validQuestion: {
      id: randomUUID(),
      uploadJobId: jobId,
      questionIndex: question.questionIndex,
      questionText: clean(question.questionText),
      optionAText: clean(question.optionAText),
      optionBText: clean(question.optionBText),
      optionCText: clean(question.optionCText),
      optionDText: clean(question.optionDText),
      solutionText: clean(question.solutionText),
      hintText: clean(question.hintText),
      hasImages: preparedImages.length > 0,
      ingestionStatus: "VALID",
      images: preparedImages
    },
    errors,
    warnings
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/question-uploads", upload.single("file"), async (req, res) => {
  const file = req.file;
  const uploadedBy = req.body.uploadedBy || "faculty.demo";

  if (!file) {
    return res.status(400).json({ error: "A .docx file is required" });
  }

  if (!file.originalname.toLowerCase().endsWith(".docx")) {
    await fs.unlink(file.path).catch(() => {});
    return res.status(400).json({ error: "Only .docx files are supported in this demo" });
  }

  const jobId = randomUUID();
  const target = path.join(UPLOADS_DIR, `${jobId}.docx`);
  await fs.rename(file.path, target);

  await createUploadJob(DATA_DIR, {
    id: jobId,
    uploadedBy,
    sourceFileName: file.originalname,
    sourceBlobUrl: `/data/uploads/${jobId}.docx`
  });

  enqueue(jobId);

  return res.status(202).json({
    jobId,
    status: "PENDING",
    message: "Upload accepted for background processing",
    statusUrl: `/api/question-uploads/${jobId}`
  });
});

app.get("/api/question-uploads/:jobId", async (req, res) => {
  const job = await getJobById(DATA_DIR, req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  const questions = await listQuestionsByJobId(DATA_DIR, req.params.jobId);
  return res.json({
    jobId: job.id,
    uploadedBy: job.uploadedBy,
    sourceFileName: job.sourceFileName,
    status: job.status,
    totalQuestionsDetected: job.totalQuestionsDetected,
    successCount: job.successCount,
    failureCount: job.failureCount,
    hasErrors: job.failureCount > 0,
    questions,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  });
});

app.get("/api/question-uploads/:jobId/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  const sendUpdate = async () => {
    const job = await getJobById(DATA_DIR, req.params.jobId);
    if (!job) return;
    const questions = await listQuestionsByJobId(DATA_DIR, req.params.jobId);
    
    const payload = {
      jobId: job.id,
      uploadedBy: job.uploadedBy,
      sourceFileName: job.sourceFileName,
      status: job.status,
      totalQuestionsDetected: job.totalQuestionsDetected,
      successCount: job.successCount,
      failureCount: job.failureCount,
      hasErrors: job.failureCount > 0,
      questions,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
    
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const listener = () => {
    sendUpdate().catch(console.error);
  };

  jobEvents.on(`job-${req.params.jobId}-updated`, listener);

  req.on("close", () => {
    jobEvents.off(`job-${req.params.jobId}-updated`, listener);
  });

  sendUpdate().catch(console.error);
});

app.get("/api/question-uploads/:jobId/errors", async (req, res) => {
  const job = await getJobById(DATA_DIR, req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job.errorReportJson);
});

const port = Number(process.env.PORT || 5001);
app.listen(port, () => {
  console.log(`API listening on http://127.0.0.1:${port}`);
});

function camelToSnake(value) {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}
