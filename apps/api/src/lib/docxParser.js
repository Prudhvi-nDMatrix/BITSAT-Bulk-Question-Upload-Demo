import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const QUESTION_RE = /^(?:Q(?:uestion)?\s*)(\d+)\s*[:.)-]?\s*(.*)$/i;
// const OPTION_RE = /^(?:\(\s*([A-D])\s*\)|([A-D])\s*[:.)-])\s*(.*)$/i;
const OPTION_RE = /^(?:\(\s*([A-D])\s*\)|([A-D])\s*[:.)-]?)\s*(.*)$/i;
const SOLUTION_RE = /^(?:solution|answer)\s*[:.-]?\s*(.*)$/i;
const HINT_RE = /^hint\s*[:.-]?\s*(.*)$/i;
const NON_CONTENT_HEADING_RE = /^(?:SECTION\s+\d+\s*:.*|English Proficiency|Logical Reasoning|ANSWER KEY|Preparation Tips|Note:.*|Q\.\s*No\.|Answer|Topic\s*\/\s*Concept)$/i;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: true,
  preserveOrder: true,
  trimValues: false
});

export async function parseDocxUpload({ docxPath, scratchDir }) {
  const fileBuffer = await fs.readFile(docxPath);
  const zip = await JSZip.loadAsync(fileBuffer);
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) {
    throw new DocxIngestionError("INVALID_DOCX", "word/document.xml is missing from the DOCX");
  }

  await fs.rm(scratchDir, { recursive: true, force: true });
  await fs.mkdir(path.join(scratchDir, "media"), { recursive: true });

  const relMap = await parseRelationships(zip);
  const mediaMap = await extractMediaFiles(zip, relMap, path.join(scratchDir, "media"));
  const documentXml = await documentEntry.async("string");
  await fs.writeFile(path.join(scratchDir, "document.xml"), documentXml);
  const root = xmlParser.parse(documentXml);
  const body = findNode(root, "w:body");
  if (!body) {
    throw new DocxIngestionError("INVALID_DOCX_XML", "word/document.xml does not contain a document body");
  }

  const questions = [];
  let current = null;
  let currentField = "questionText";
  const imageCounter = { count: 1 };

  for (const entry of body) {
    const [tag, value] = Object.entries(entry)[0] || [];
    if (tag === "w:p") {
      const paragraph = parseParagraph(value, mediaMap, imageCounter);
      if (paragraph.kind === "questionStart") {
        if (current) questions.push(finalizeQuestion(current));
        current = newQuestion(Number(paragraph.questionIndex));
        currentField = "questionText";
        appendText(current, currentField, paragraph.text);
        appendImages(current, currentField, paragraph.images);
        current.unresolvedRelationships.push(...paragraph.unresolvedRelationships);
      } else {
        if (!current) continue;
        if (shouldIgnoreParagraph(paragraph.text, current)) continue;

        const detectedField = detectField(paragraph.text);
        if (detectedField) {
          currentField = detectedField.fieldName;
          appendText(current, currentField, detectedField.cleanedText);
        } else {
          appendText(current, currentField, paragraph.text);
        }
        appendImages(current, currentField, paragraph.images);
        current.unresolvedRelationships.push(...paragraph.unresolvedRelationships);
      }
    } else if (tag === "w:tbl") {
      continue;
    }
  }

  if (current) questions.push(finalizeQuestion(current));
  if (!questions.length) {
    throw new DocxIngestionError("NO_QUESTIONS_FOUND", "No question markers like 'Q1:' or 'Question 1:' were found in the DOCX");
  }

  return { questions };
}

async function parseRelationships(zip) {
  const relFile = zip.file("word/_rels/document.xml.rels");
  if (!relFile) return new Map();
  const xml = await relFile.async("string");
  const parsed = xmlParser.parse(xml);
  const relationshipsNode = firstNodeValue(parsed, "Relationships");
  const rels = new Map();
  for (const entry of relationshipsNode || []) {
    const [tag, value] = Object.entries(entry)[0] || [];
    if (tag !== "Relationship") continue;
    const attrs = entry[":@"] || value?.[":@"] || {};
    if (attrs.Id && attrs.Target) {
      rels.set(attrs.Id, String(attrs.Target).replace(/^\/+/, ""));
    }
  }
  return rels;
}

async function extractMediaFiles(zip, relMap, mediaDir) {
  const mediaMap = new Map();
  for (const [relId, target] of relMap.entries()) {
    if (!target.startsWith("media/")) continue;
    const file = zip.file(`word/${target}`);
    if (!file) continue;
    const buffer = await file.async("nodebuffer");
    const destination = path.join(mediaDir, path.basename(target));
    await fs.writeFile(destination, buffer);
    mediaMap.set(relId, destination);
  }
  return mediaMap;
}

function parseParagraph(paragraphNode, mediaMap, imageCounter = { count: 1 }) {
  const textParts = [];
  const images = [];
  const unresolvedRelationships = [];

  for (const entry of toArray(paragraphNode)) {
    const [tag, value] = Object.entries(entry)[0] || [];
    if (tag !== "w:r") continue;

    const texts = findAllText(value, "w:t");
    if (texts.length) textParts.push(texts.join(""));

    const imageRefs = extractImageRefs(value);
    for (const relId of imageRefs) {
      if (!mediaMap.has(relId)) {
        unresolvedRelationships.push(relId);
        continue;
      }
      const imageKey = `auto_${imageCounter.count++}`;
      textParts.push(` [[img:${imageKey}]] `);
      images.push({
        imageKey,
        sourcePath: mediaMap.get(relId),
        sourceDocxRelId: relId,
        sequenceOrder: images.length + 1,
        contentType: contentTypeForPath(mediaMap.get(relId))
      });
    }
  }

  const text = normalizeWhitespace(textParts.join(""));
  const questionMatch = text.match(QUESTION_RE);
  if (questionMatch) {
    return {
      kind: "questionStart",
      questionIndex: questionMatch[1],
      text: questionMatch[2].trim(),
      images,
      unresolvedRelationships
    };
  }

  return {
    kind: "content",
    text,
    images,
    unresolvedRelationships
  };
}

function detectField(text) {
  const optionMatch = text.match(OPTION_RE);
  if (optionMatch) {
    const optionKey = (optionMatch[1] || optionMatch[2]).toLowerCase();
    return {
      fieldName: `option${optionKey.toUpperCase()}Text`,
      cleanedText: stripOptionMarkers(optionMatch[3].trim())
    };
  }

  const solutionMatch = text.match(SOLUTION_RE);
  if (solutionMatch) {
    return { fieldName: "solutionText", cleanedText: solutionMatch[1].trim() };
  }

  const hintMatch = text.match(HINT_RE);
  if (hintMatch) {
    return { fieldName: "hintText", cleanedText: hintMatch[1].trim() };
  }

  return null;
}

function shouldIgnoreParagraph(text, current) {
  if (!text) return true;
  if (NON_CONTENT_HEADING_RE.test(text)) return true;
  if (text.startsWith("•")) return true;

  if (hasAllOptions(current)) {
    if (/^[A-Z][A-Za-z\s&/.\-]+$/.test(text)) return true;
    if (text.startsWith("Q") && text.includes("No")) return true;
  }

  return false;
}

function hasAllOptions(current) {
  return ["optionAText", "optionBText", "optionCText", "optionDText"].every((field) => current[field]);
}

function newQuestion(questionIndex) {
  return {
    questionIndex,
    questionText: "",
    optionAText: "",
    optionBText: "",
    optionCText: "",
    optionDText: "",
    solutionText: "",
    hintText: "",
    imagesByField: {},
    unresolvedRelationships: [],
    orphanAssets: []
  };
}

function appendText(question, fieldName, text) {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) return;
  question[fieldName] = question[fieldName]
    ? `${question[fieldName]} ${cleaned}`.trim()
    : cleaned;
}

function appendImages(question, fieldName, images) {
  if (!images.length) return;
  question.imagesByField[fieldName] ||= [];
  const base = question.imagesByField[fieldName].length;
  images.forEach((image, index) => {
    question.imagesByField[fieldName].push({
      ...image,
      sequenceOrder: base + index + 1
    });
  });
}

function finalizeQuestion(question) {
  return {
    ...question,
    questionText: normalizeWhitespace(question.questionText),
    optionAText: normalizeWhitespace(question.optionAText),
    optionBText: normalizeWhitespace(question.optionBText),
    optionCText: normalizeWhitespace(question.optionCText),
    optionDText: normalizeWhitespace(question.optionDText),
    solutionText: normalizeWhitespace(question.solutionText),
    hintText: normalizeWhitespace(question.hintText)
  };
}

function extractImageRefs(run) {
  const refs = [];
  walkNodes(run, (tag, value, attrs) => {
    if (tag === "a:blip" && attrs["r:embed"]) refs.push(attrs["r:embed"]);
    if (tag === "v:imagedata" && attrs["r:id"]) refs.push(attrs["r:id"]);
  });
  return refs;
}

function walkNodes(node, callback) {
  if (Array.isArray(node)) {
    node.forEach((entry) => {
      const [tag, value] = Object.entries(entry)[0] || [];
      if (!tag) return;
      callback(tag, value, entry[":@"] || value?.[":@"] || {});
      walkNodes(value, callback);
    });
  } else if (node && typeof node === "object") {
    Object.entries(node).forEach(([tag, value]) => {
      if (tag === "#text" || tag === ":@") return;
      callback(tag, value, value?.[":@"] || {});
      walkNodes(value, callback);
    });
  }
}

function findAllText(node, tagName) {
  const values = [];
  walkNodes(node, (tag, value) => {
    if (tag === tagName) {
      if (typeof value === "string" || typeof value === "number") values.push(String(value));
      else if (Array.isArray(value)) {
        value.forEach((child) => {
          if (child && (typeof child["#text"] === "string" || typeof child["#text"] === "number")) {
            values.push(String(child["#text"]));
          }
        });
      } else if (value && typeof value["#text"] === "string") {
        values.push(value["#text"]);
      } else if (value && typeof value["#text"] === "number") {
        values.push(String(value["#text"]));
      }
    }
  });
  return values;
}

function findNode(node, tagName) {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const [tag, value] = Object.entries(entry)[0] || [];
      if (tag === tagName) return value;
      const nested = findNode(value, tagName);
      if (nested) return nested;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const [tag, value] of Object.entries(node)) {
      if (tag === tagName) return value;
      const nested = findNode(value, tagName);
      if (nested) return nested;
    }
  }
  return null;
}

function firstNodeValue(node, tagName) {
  if (!Array.isArray(node)) return null;
  const match = node.find((entry) => Object.keys(entry)[0] === tagName);
  return match ? match[tagName] : null;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeWhitespace(value = "") {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function stripOptionMarkers(value) {
  return value.replace(/[ ✓✔]+$/u, "");
}

function contentTypeForPath(filePath) {
  const suffix = path.extname(filePath).toLowerCase();
  if (suffix === ".png") return "image/png";
  if (suffix === ".jpg" || suffix === ".jpeg") return "image/jpeg";
  if (suffix === ".gif") return "image/gif";
  if (suffix === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

export class DocxIngestionError extends Error {
  constructor(errorType, message) {
    super(message);
    this.errorType = errorType;
  }
}
