# BITSAT Bulk Question Upload Demo

Node.js backend plus React frontend for the bulk DOCX question-ingestion demo.

## Supported ingestion behavior

- Approach 2 only
- parse `word/document.xml` directly
- preserve equations/diagrams as visual assets
- auto-generate placeholders like `[[img:auto_1]]`
- async job processing with immediate `202 Accepted`
- partial success support
- structured error reporting

## Real DOCX format supported

The current parser handles the BITSAT question-bank format you tested:

- questions like `Q1.` / `Q36.`
- options like `(A)`, `(B)`, `(C)`, `(D)`
- section headers such as `SECTION 1: PHYSICS`
- interstitial labels like `English Proficiency` and `Logical Reasoning`
- trailing `ANSWER KEY` / `Preparation Tips` content without polluting the last question

## Run locally

Install dependencies:

```bash
bun install
```

Start backend and frontend:

```bash
npm run dev
```

Or run them separately:

```bash
npm run dev:api
npm run dev:web
```

## Local URLs

- React app: [http://127.0.0.1:5173](http://127.0.0.1:5173)
- Node API: [http://127.0.0.1:5001/api/health](http://127.0.0.1:5001/api/health)
