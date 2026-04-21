import { Fragment, useDeferredValue, useEffect, useRef, useState, useTransition } from "react";

const FINAL_STATUSES = new Set(["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"]);

export default function App() {
  const [uploadedBy, setUploadedBy] = useState("faculty.demo");
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [issues, setIssues] = useState(null);
  const [logLines, setLogLines] = useState(["Waiting for upload…"]);
  const [isPending, startTransition] = useTransition();
  const pollingRef = useRef(null);
  const deferredJob = useDeferredValue(job);

  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        if (pollingRef.current.close) pollingRef.current.close();
        else window.clearInterval(pollingRef.current);
      }
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!file) return;

    const payload = new FormData();
    payload.append("uploadedBy", uploadedBy);
    payload.append("file", file);

    setIssues(null);
    setJob(null);
    setLogLines(["Uploading DOCX and creating background job..."]);

    const response = await fetch("/api/question-uploads", {
      method: "POST",
      body: payload
    });
    const json = await response.json();

    if (!response.ok) {
      setLogLines([json.error || "Upload failed"]);
      return;
    }

    startTransition(() => {
      setLogLines([
        "POST /api/question-uploads -> 202 Accepted",
        `jobId: ${json.jobId}`,
        `statusUrl: ${json.statusUrl}`,
        "",
        "Polling background job..."
      ]);
    });

    beginPolling(json.jobId);
  }

  function beginPolling(jobId) {
    if (pollingRef.current) {
      if (pollingRef.current.close) pollingRef.current.close();
      else window.clearInterval(pollingRef.current);
    }

    const eventSource = new EventSource(`/api/question-uploads/${jobId}/events`);
    pollingRef.current = eventSource;

    eventSource.onmessage = async (e) => {
      const json = JSON.parse(e.data);

      startTransition(() => {
        setJob(json);
        setLogLines([
          `SSE PUSH /api/question-uploads/${jobId}/events`,
          `status: ${json.status}`,
          `detected: ${json.totalQuestionsDetected}`,
          `saved: ${json.successCount}`,
          `failed: ${json.failureCount}`,
          "",
          "Persisted questions:",
          ...json.questions.slice(0, 8).map((question) => `- Q${question.questionIndex}: ${question.questionText}`),
          ...(json.questions.length > 8 ? [`...and ${json.questions.length - 8} more`] : [])
        ]);
      });

      if (FINAL_STATUSES.has(json.status)) {
        eventSource.close();
        pollingRef.current = null;
        const issueResponse = await fetch(`/api/question-uploads/${jobId}/errors`);
        const issueJson = await issueResponse.json();
        startTransition(() => setIssues(issueJson));
      }
    };

    eventSource.onerror = () => {
      console.error("SSE connection lost");
      eventSource.close();
      pollingRef.current = null;
    };
  }

  const status = deferredJob?.status || "NO_JOB";
  const selectedQuestions = deferredJob?.questions ?? [];

  return (
    <div className="mx-auto w-[min(1440px,calc(100vw-20px))] pb-10 pt-5 md:w-[min(1440px,calc(100vw-40px))]">

      <main className="mt-5 grid gap-5 lg:grid-cols-[420px_minmax(0,1fr)]">
        <section className="glass-panel p-6 sticky top-5 h-[740px] overflow-y-auto">
          <div className="mb-5">
            <div className="field-label">Upload Console</div>
            <h2 className="mt-3 text-2xl font-semibold text-stone-900">Start ingestion</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              Supports real BITSAT-style question banks and inline diagrams or equation images.
            </p>
          </div>

          <form className="grid gap-4" onSubmit={handleSubmit}>
            <label className="grid gap-2">
              <span className="field-label">Uploaded By</span>
              <input
                className="rounded-2xl border border-white/60 bg-white/80 px-4 py-3 text-sm text-stone-900 outline-none ring-0 transition placeholder:text-stone-400 focus:border-orange-300"
                value={uploadedBy}
                onChange={(event) => setUploadedBy(event.target.value)}
              />
            </label>

            <label className="grid gap-2">
              <span className="field-label">DOCX File</span>
              <input
                className="rounded-2xl border border-white/60 bg-white/80 px-4 py-3 text-sm text-stone-900 outline-none ring-0 file:mr-4 file:rounded-full file:border-0 file:bg-orange-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:uppercase file:tracking-[0.18em] file:text-orange-700 focus:border-orange-300"
                type="file"
                accept=".docx"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
            </label>

            <button
              className="mt-2 rounded-2xl bg-gradient-to-r from-orange-700 via-orange-600 to-amber-500 px-5 py-4 text-sm font-bold uppercase tracking-[0.18em] text-white shadow-card transition hover:scale-[1.01] disabled:cursor-default disabled:opacity-60"
              type="submit"
              disabled={!file || isPending}
            >
              {isPending ? "Working..." : "Start Background Ingestion"}
            </button>
          </form>

          <div className="mt-6 rounded-[24px] border border-white/50 bg-white/60 p-4">
            <div className="field-label">Parsing Notes</div>
            <ul className="mt-3 space-y-3 text-sm leading-6 text-stone-700">
              <li>Recognizes <code>Q1.</code> / <code>Question 1</code> blocks.</li>
              <li>Recognizes options like <code>(A)</code> to <code>(D)</code>.</li>
              <li>Ignores section headers, answer-key tables, and trailing notes.</li>
              <li>Inline visuals are inserted as placeholders and rendered back in the preview.</li>
            </ul>
          </div>
        </section>

        <section className="glass-panel p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="field-label">Job State</div>
              <div className={`status-pill mt-3 ${statusClasses(status)}`}>{status.replaceAll("_", " ")}</div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Job" value={deferredJob ? deferredJob.jobId.slice(0, 8) : "-"} />
              <Metric label="Detected" value={deferredJob?.totalQuestionsDetected ?? 0} />
              <Metric label="Saved" value={deferredJob?.successCount ?? 0} />
              <Metric label="Failed" value={deferredJob?.failureCount ?? 0} />
            </div>
          </div>

          <section className="mt-6">
            <h3 className="text-lg font-semibold text-stone-900">Job Log</h3>
            <pre className="mt-3 overflow-auto rounded-[24px] bg-[#171310] p-5 text-[12px] leading-6 text-stone-100 shadow-inner">
              {logLines.join("\n")}
            </pre>
          </section>

          <section className="mt-7">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-stone-900">Persisted Questions</h3>
                <p className="mt-1 text-sm text-stone-600">
                  Question text and related fields are rendered with inline image replacement.
                </p>
              </div>
              {selectedQuestions.length ? (
                <div className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">
                  {selectedQuestions.length} visible
                </div>
              ) : null}
            </div>

            {!selectedQuestions.length ? (
              <p className="mt-4 text-sm text-stone-500">No valid questions persisted yet.</p>
            ) : (
              <div className="mt-4 grid gap-4">
                {selectedQuestions.map((question) => (
                  <article
                    className="overflow-hidden rounded-[28px] border border-white/60 bg-white/70 shadow-card"
                    key={question.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200/70 bg-gradient-to-r from-stone-950 to-stone-800 px-5 py-4 text-stone-50">
                      <div>
                        <div className="field-label text-stone-300">Question</div>
                        <div className="mt-1 text-xl font-semibold">Q{question.questionIndex}</div>
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.18em]">
                        <span className="rounded-full bg-white/10 px-3 py-2">
                          {question.hasImages ? "Inline Images" : "Text Only"}
                        </span>
                        <span className="rounded-full bg-white/10 px-3 py-2">
                          {(question.images || []).length} assets
                        </span>
                      </div>
                    </div>

                    <div className="grid gap-6 p-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(340px,0.9fr)]">
                      <div className="space-y-5">
                        <RichField
                          label="Question Body"
                          value={question.questionText}
                          images={question.images || []}
                          fieldName="questionText"
                        />
                        <div className="grid gap-3 md:grid-cols-2">
                          <RichField label="Option A" value={question.optionAText} images={question.images || []} fieldName="optionAText" compact />
                          <RichField label="Option B" value={question.optionBText} images={question.images || []} fieldName="optionBText" compact />
                          <RichField label="Option C" value={question.optionCText} images={question.images || []} fieldName="optionCText" compact />
                          <RichField label="Option D" value={question.optionDText} images={question.images || []} fieldName="optionDText" compact />
                        </div>
                      </div>

                      <div className="space-y-4">
                        <RichField label="Solution" value={question.solutionText} images={question.images || []} fieldName="solutionText" />
                        <RichField label="Hint" value={question.hintText} images={question.images || []} fieldName="hintText" />
                        <AssetRail images={question.images || []} />
                        <RichField label="Correct Answer" value={question.correctAnswer} images={question.images || []} fieldName="Correct Answer" compact />
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="mt-7">
            <h3 className="text-lg font-semibold text-stone-900">Errors and Warnings</h3>
            {!issues ? (
              <p className="mt-3 text-sm text-stone-500">No job report loaded yet.</p>
            ) : !issues.errors.length && !issues.warnings.length ? (
              <p className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
                No warnings or errors recorded.
              </p>
            ) : (
              <div className="mt-4 grid gap-3">
                {issues.errors.map((issue, index) => (
                  <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700" key={`error-${index}`}>
                    <strong>Error</strong> Q{issue.questionIndex || "-"} {issue.type}: {issue.message}
                  </p>
                ))}
                {issues.warnings.map((issue, index) => (
                  <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-700" key={`warning-${index}`}>
                    <strong>Warning</strong> Q{issue.questionIndex || "-"} {issue.type}: {issue.message}
                  </p>
                ))}
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}

function HeroFact({ label, value }) {
  return (
    <div className="rounded-2xl border border-white/45 bg-white/55 px-4 py-4 shadow-sm">
      <div className="field-label">{label}</div>
      <div className="mt-2 text-sm font-medium leading-6 text-stone-700">{value}</div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric-card min-w-[132px]">
      <span className="field-label block">{label}</span>
      <strong className="mt-2 block text-3xl font-semibold text-stone-950">{value}</strong>
    </div>
  );
}

function RichField({ label, value, images, fieldName, compact = false }) {
  const matchingImages = images.filter((image) => matchesField(image.fieldName, fieldName));
  const imageMap = new Map(matchingImages.map((image) => [image.imageKey, image]));
  const tokens = tokenizeRichText(value || "");
  const hasContent = tokens.length > 0;

  return (
    <div className={`rounded-[24px] border border-stone-200/70 bg-stone-50/80 ${compact ? "p-4" : "p-5"}`}>
      <div className="field-label">{label}</div>
      {!hasContent ? (
        <p className="mt-3 text-sm text-stone-400">No content.</p>
      ) : (
        <div className={`mt-3 flex flex-wrap gap-2 ${compact ? "text-sm leading-6" : "text-[15px] leading-7"} text-stone-800`}>
          {tokens.map((token, index) => {
            if (token.type === "text") {
              return (
                <span key={`${label}-text-${index}`} className="whitespace-pre-wrap">
                  {token.value}
                </span>
              );
            }

            const image = imageMap.get(token.key);
            if (!image) {
              return (
                <span
                  key={`${label}-missing-${index}`}
                  className="rounded-xl border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-600"
                >
                  [[img:{token.key}]]
                </span>
              );
            }

            return (
              <span
                key={`${label}-img-${index}`}
                className="inline-flex max-w-full flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm"
              >
                <img
                  src={image.blobUrl}
                  alt={`Inline asset ${image.imageKey}`}
                  className={`block w-auto object-contain ${compact ? "max-h-28" : "max-h-48"} max-w-[min(100%,20rem)] bg-stone-100`}
                />
                <span className="border-t border-stone-200 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                  {image.imageKey}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssetRail({ images }) {
  if (!images.length) {
    return (
      <div className="rounded-[24px] border border-dashed border-stone-300 bg-white/60 p-5">
        <div className="field-label">Extracted Assets</div>
        <p className="mt-3 text-sm text-stone-500">No inline images were found for this question.</p>
      </div>
    );
  }

  return (
    <div className="rounded-[24px] border border-stone-200/70 bg-white/70 p-5">
      <div className="field-label">Extracted Assets</div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {images.map((image) => (
          <div className="overflow-hidden rounded-2xl border border-stone-200 bg-stone-50" key={image.id || image.imageKey}>
            <img src={image.blobUrl} alt={image.imageKey} className="h-28 w-full object-contain bg-white" />
            <div className="space-y-1 border-t border-stone-200 px-3 py-3 text-xs text-stone-600">
              <div className="font-semibold uppercase tracking-[0.18em] text-stone-500">{image.imageKey}</div>
              <div>Field: {image.fieldName}</div>
              <div>Order: {image.sequenceOrder}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function tokenizeRichText(input) {
  if (!input) return [];
  const parts = [];
  const regex = /\[\[img:([^\]]+)\]\]/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: input.slice(lastIndex, match.index) });
    }
    parts.push({ type: "image", key: match[1] });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < input.length) {
    parts.push({ type: "text", value: input.slice(lastIndex) });
  }

  return parts.filter((part) => part.type === "image" || part.value.trim().length > 0);
}

function matchesField(imageField, uiField) {
  const normalized = imageField?.toLowerCase();
  const target = uiField?.toLowerCase();
  if (!normalized || !target) return false;

  const aliases = {
    questiontext: ["questiontext", "question_text"],
    optionatext: ["optionatext", "option_a", "option_a_text"],
    optionbtext: ["optionbtext", "option_b", "option_b_text"],
    optionctext: ["optionctext", "option_c", "option_c_text"],
    optiondtext: ["optiondtext", "option_d", "option_d_text"],
    solutiontext: ["solutiontext", "solution", "solution_text"],
    correctAnswer:["correct_answer", "correctAnswer"],
    hinttext: ["hinttext", "hint", "hint_text"]
  };

  return (aliases[target] || [target]).includes(normalized);
}

function statusClasses(status) {
  if (status === "COMPLETED") {
    return "bg-emerald-100 text-emerald-700";
  }
  if (status === "FAILED" || status === "COMPLETED_WITH_ERRORS") {
    return "bg-red-100 text-red-700";
  }
  return "bg-orange-100 text-orange-700";
}
