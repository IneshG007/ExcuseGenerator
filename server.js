/*
 * Excuse Report Card: backend
 * ===========================
 * Enter a situation and some settings, get a generated excuse plus a funny
 * report card rating it. The API is defined in shared/contract.md, and the
 * allowed setting values are in shared/options.json.
 *
 * Uses Google's Gemini API, which has a free tier.
 *
 * How to run
 * ----------
 *   1. npm install
 *   2. Get a free key at https://aistudio.google.com/apikey
 *   3. cp .env.example .env   then set GEMINI_API_KEY in .env
 *      (or export GEMINI_API_KEY=... in your shell)
 *   4. npm start              then open http://localhost:3000
 *
 * Optional env vars: PORT (default 3000), MODEL (default gemini-flash-latest).
 *
 * Endpoints
 * ---------
 *   GET  /api/health  -> { "ok": true }
 *   POST /api/excuse  -> { excuse, report: { overall_believability, ratings[5], verdict } }
 *   Any error         -> { "error": "..." } with a non-200 status
 *
 * Try it:
 *   curl -X POST http://localhost:3000/api/excuse -H "Content-Type: application/json" \
 *     -d '{"situation":"I did not finish my homework","settings":{"escalation":8,"audience":"Professor","style":"Formal Email","truth":20}}'
 */

import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt, computeBelievability, MAX_EXCUSE_WORDS } from "./prompt.js";

// Load .env if present (built into Node 20.12+). Real env vars take precedence.
try {
  process.loadEnvFile();
} catch {
  // no .env file, rely on the environment
}

const here = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS = JSON.parse(readFileSync(path.join(here, "shared", "options.json"), "utf8"));

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.MODEL || "gemini-flash-latest";
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const MAX_SITUATION_CHARS = 500;
const MAX_ATTEMPTS = 2; // first try + one retry on unusable output

// True when a key is configured. The .env.example placeholder doesn't count.
function hasApiKey() {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key) && key !== "your-gemini-key-here";
}

const DEFAULTS = {
  escalation: Math.floor((OPTIONS.escalation.min + OPTIONS.escalation.max) / 2),
  truth: Math.floor((OPTIONS.truth.min + OPTIONS.truth.max) / 2),
  audience: OPTIONS.audiences[0],
  style: OPTIONS.styles[0],
};

// ---------------------------------------------------------------------------
// Input validation: clamp numbers, fall back to defaults for unknown values.
// ---------------------------------------------------------------------------

function clampInt(value, { min, max }, fallback) {
  let n = NaN;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function pickOption(value, allowed, fallback) {
  if (typeof value !== "string") return fallback;
  const wanted = value.trim().toLowerCase();
  return allowed.find((option) => option.toLowerCase() === wanted) ?? fallback;
}

function normalizeRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }
  const situation = typeof body.situation === "string" ? body.situation.trim() : "";
  if (!situation) {
    return { error: "situation is required and must be a non-empty string." };
  }
  const s =
    body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
      ? body.settings
      : {};
  return {
    situation: situation.slice(0, MAX_SITUATION_CHARS),
    settings: {
      escalation: clampInt(s.escalation, OPTIONS.escalation, DEFAULTS.escalation),
      audience: pickOption(s.audience, OPTIONS.audiences, DEFAULTS.audience),
      style: pickOption(s.style, OPTIONS.styles, DEFAULTS.style),
      truth: clampInt(s.truth, OPTIONS.truth, DEFAULTS.truth),
    },
  };
}

// ---------------------------------------------------------------------------
// Model output parsing
// ---------------------------------------------------------------------------

class UnusableOutputError extends Error {}
class RefusalError extends Error {}
class UpstreamError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

function extractJson(text) {
  let t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through: try the outermost {...} in case there is stray text around it
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      // unusable
    }
  }
  return undefined;
}

const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const countWords = (s) => (s.match(/\S+/g) || []).length;

function asText(value) {
  if (typeof value === "string") return oneLine(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "";
}

// Values must be display-ready. A bare number like 96 or "96" is meant as a percentage.
function asRatingValue(value) {
  const text = asText(value);
  if (/^\d{1,3}(\.\d+)?$/.test(text) && Number(text) <= 100) return `${Math.round(Number(text))}%`;
  return text;
}

// Returns { value } with a contract-shaped object, or { problem } describing what was wrong.
function validateOutput(data, believability) {
  if (!data || typeof data !== "object") return { problem: "The reply was not valid JSON." };

  const excuse = typeof data.excuse === "string" ? data.excuse.trim() : "";
  if (!excuse) return { problem: 'The JSON had no "excuse" string.' };

  const report = data.report && typeof data.report === "object" ? data.report : data;
  const ratings = (Array.isArray(report.ratings) ? report.ratings : [])
    .map((r) => ({ label: asText(r?.label), value: asRatingValue(r?.value) }))
    .filter((r) => r.label && r.value);
  if (ratings.length < 5) {
    return { problem: `"report.ratings" needs exactly 5 items with "label" and "value"; got ${ratings.length}.` };
  }

  const verdict = asText(report.verdict);
  if (!verdict) return { problem: 'The JSON had no "report.verdict" string.' };

  return {
    value: {
      excuse,
      report: {
        overall_believability: believability,
        ratings: ratings.slice(0, 5),
        verdict,
      },
    },
  };
}

// Last resort if the model keeps running long: cut to the word limit, ending on
// a sentence boundary when one is reasonably close. Preserves line breaks.
function trimToWordLimit(text, maxWords) {
  const re = /\S+/g;
  let end = 0;
  for (let count = 0, m; count < maxWords && (m = re.exec(text)); count++) {
    end = m.index + m[0].length;
  }
  const cut = text.slice(0, end);
  let lastStop = -1;
  for (const m of cut.matchAll(/[.!?…]["')\]]*(?=\s|$)/g)) lastStop = m.index + m[0].length;
  if (lastStop > cut.length * 0.6) return cut.slice(0, lastStop).trim();
  return cut.replace(/[\s,;:–—-]+$/, "") + "…";
}

// ---------------------------------------------------------------------------
// Gemini call (REST: models/{model}:generateContent)
// ---------------------------------------------------------------------------

const BLOCKED_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

function readGeminiText(data) {
  if (data?.promptFeedback?.blockReason) throw new RefusalError(data.promptFeedback.blockReason);
  const candidate = data?.candidates?.[0];
  if (!candidate) throw new RefusalError("no candidates returned");
  if (BLOCKED_FINISH_REASONS.has(candidate.finishReason)) throw new RefusalError(candidate.finishReason);
  // Skip thought-summary parts; only the answer text matters.
  return (candidate.content?.parts || [])
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("");
}

async function callModel(system, user) {
  const url = `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { responseMimeType: "application/json" },
  });

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY.trim() },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return readGeminiText(data);
    // Free-tier servers are sometimes briefly overloaded; one quick retry helps.
    if (res.status >= 500 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    const reason = data?.error?.details?.find((d) => d?.reason)?.reason || data?.error?.status;
    throw new UpstreamError(res.status, data?.error?.message || res.statusText, reason);
  }
}

async function generateExcuse({ situation, settings }) {
  const believability = computeBelievability(settings);
  let retryNote;
  let overLimit; // a valid result whose excuse ran too long, kept as a fallback

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { system, user } = buildPrompt({ situation, settings, believability, retryNote });
    const text = await callModel(system, user);
    const { value, problem } = validateOutput(extractJson(text), believability);

    if (value) {
      const words = countWords(value.excuse);
      if (words < MAX_EXCUSE_WORDS) return value;
      overLimit = value;
      retryNote = `The excuse was ${words} words; it must be under ${MAX_EXCUSE_WORDS} words (aim for about 50).`;
    } else {
      retryNote = problem;
    }
    console.warn(`[excuse] attempt ${attempt} unusable: ${retryNote}`);
  }

  if (overLimit) {
    overLimit.excuse = trimToWordLimit(overLimit.excuse, MAX_EXCUSE_WORDS - 1);
    return overLimit;
  }
  throw new UnusableOutputError(retryNote);
}

// Map failures to a status and a message the frontend can show as-is.
function describeError(err) {
  if (err instanceof RefusalError) {
    return [422, "The excuse generator refused this one. Try rephrasing the situation."];
  }
  if (err instanceof UnusableOutputError) {
    return [500, "The excuse generator got its story mixed up. Please try again."];
  }
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return [504, "The AI service took too long to answer. Please try again."];
  }
  if (err instanceof UpstreamError) {
    if (err.reason === "API_KEY_INVALID" || err.status === 401 || err.status === 403) {
      return [500, "The server's Gemini API key is invalid. Check GEMINI_API_KEY in .env."];
    }
    if (err.status === 404) {
      return [500, `The configured model "${MODEL}" was not found. Check the MODEL setting.`];
    }
    if (err.status === 429) {
      return [429, "The free AI quota is used up for now. Wait a minute and try again."];
    }
    if (err.status === 400) {
      return [500, "The AI service rejected the request. Check the server logs."];
    }
    return [503, "The AI service is having trouble right now. Please try again shortly."];
  }
  if (err instanceof TypeError) {
    return [502, "Could not reach the AI service. Please try again."];
  }
  return [500, "Something went wrong generating your excuse."];
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(here, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/excuse", async (req, res) => {
  const input = normalizeRequest(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  if (!hasApiKey()) {
    return res.status(500).json({
      error: "The server is missing GEMINI_API_KEY. Get a free key at aistudio.google.com/apikey and add it to .env.",
    });
  }

  try {
    res.json(await generateExcuse(input));
  } catch (err) {
    const [status, message] = describeError(err);
    console.error(`[excuse] ${status}: ${err?.constructor?.name}: ${err?.message}`);
    res.status(status).json({ error: message });
  }
});

app.all("/api/excuse", (req, res) => res.status(405).json({ error: "Use POST /api/excuse." }));
app.all("/api/health", (req, res) => res.status(405).json({ error: "Use GET /api/health." }));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

// Body-parser and any other unhandled errors still answer in the contract's { error } shape.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }
  console.error("[server]", err);
  res.status(err.status || 500).json({ error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`Excuse Report Card running at http://localhost:${PORT} (model: ${MODEL})`);
  if (!hasApiKey()) {
    console.warn("Warning: GEMINI_API_KEY is not set (add it to .env), so POST /api/excuse will return an error.");
  }
});
