import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import { randomUUID } from "crypto";

/**
 * Validates a parsed question and copies its images to the assets directory.
 *
 * ASSETS_DIR was previously read as an undeclared global — it is now passed
 * explicitly so this module is usable from both processor.js (worker process)
 * and any future context without relying on ambient state.
 *
 * @param {object} question     - Raw question from docxParser
 * @param {string} jobId        - Upload job ID
 * @param {string} assetsDir    - Absolute path to the assets output directory
 */
export async function validateAndPrepareQuestion(question, jobId, assetsDir) {
  const errors = [];
  const warnings = [];
  const seenKeys = new Set();
  const preparedImages = [];

  const clean = (value) => (value || "").trim();

  if (!clean(question.questionText)) {
    errors.push({
      questionIndex: question.questionIndex,
      type: "EMPTY_QUESTION_TEXT",
      message: "Normalized question text is empty after parsing",
      field: "question_text"
    });
  }

  if (!clean(question.correctAnswer)) {
    errors.push({
      questionIndex: question.questionIndex,
      type: "MISSING_CORRECT_ANSWER",
      message: "Correct answer is missing",
      field: "correct_answer"
    });
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
      const destination = path.join(assetsDir, assetName);   // ← was: ASSETS_DIR (undefined)
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
      correctAnswer: clean(question.correctAnswer),
      hintText: clean(question.hintText),
      hasImages: preparedImages.length > 0,
      ingestionStatus: "VALID",
      images: preparedImages
    },
    errors,
    warnings
  };
}