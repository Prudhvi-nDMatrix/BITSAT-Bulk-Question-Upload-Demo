import fs from "fs/promises";
import path from "path";

function now() {
  return new Date().toISOString();
}

function storePath(dataDir) {
  return path.join(dataDir, "store.json");
}

async function readStore(dataDir) {
  const raw = await fs.readFile(storePath(dataDir), "utf8");
  return JSON.parse(raw);
}

async function writeStore(dataDir, store) {
  await fs.writeFile(storePath(dataDir), JSON.stringify(store, null, 2));
}

export async function createStore(dataDir) {
  const target = storePath(dataDir);
  try {
    await fs.access(target);
  } catch {
    await fs.writeFile(
      target,
      JSON.stringify({ uploadJobs: [], questions: [], questionImages: [] }, null, 2)
    );
  }
}

export async function createUploadJob(dataDir, job) {
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
}

export async function setJobStatus(dataDir, jobId, status) {
  const store = await readStore(dataDir);
  const job = store.uploadJobs.find((entry) => entry.id === jobId);
  if (!job) return;
  job.status = status;
  job.updatedAt = now();
  job.errorReportJson.status = status;
  await writeStore(dataDir, store);
}

export async function finalizeJob(dataDir, report) {
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
}

export async function persistQuestion(dataDir, jobId, question) {
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
    hintText: question.hintText,
    hasImages: question.hasImages,
    ingestionStatus: question.ingestionStatus
  });

  store.questionImages ||= [];
  for (const image of question.images) {
    store.questionImages.push({
      ...image,
      questionId: question.id
    });
  }

  await writeStore(dataDir, store);
}

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
