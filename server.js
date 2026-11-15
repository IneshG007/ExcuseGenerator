/*
 * Excuse Report Card: backend
 * ===========================
 * Enter a situation and some settings, get a generated excuse plus a funny
 * report card rating it. The API is defined in shared/contract.md, and the
 * allowed setting values are in shared/options.json.
 *
 * How to run
 * ----------
 *   1. npm install
 *   2. cp .env.example .env   then set ANTHROPIC_API_KEY in .env
 *      (or export ANTHROPIC_API_KEY=sk-ant-... in your shell)
 *   3. npm start              then open http://localhost:3000
 *
 * Optional env vars: PORT (default 3000), MODEL (default claude-sonnet-5-5),
 * EFFORT (low | medium | high, default low).
 *
 * Endpoints
 * ---------
 *   GET  /api/health  -> { "ok": true }
 *   POST /api/excuse  -> { excuse, report: { overall_believability, ratings[5], verdict } }
 *   Any error         -> { "error": "..." } with a non-200 status
 *
 * Try it:
 *   curl -X POST http://localhost:3000/api/excuse -H "Content-Type: application/json" \
 *     -d '{"situation":"I missed my best friend'\''s birthday dinner","settings":{"escalation":8,"audience":"Best Friend","style":"Voicemail","truth":20}}'
 */

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
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
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const EFFORT = parseEffort(process.env.EFFORT);
const MAX_SITUATION_CHARS = 500;
const MAX_ATTEMPTS = 2; // first try + one retry on unusable output

// True when a key is configured. The .env.example placeholder doesn't count.
function hasApiKey() {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return Boolean(key) && key !== "sk-ant-your-key-here";
}

// Models that accept server-side refusal fallbacks. If the model declines on a
// safety false-positive, the API reruns the request on a fallback model in the same call.
const FALLBACK_MODELS = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
]);

const DEFAULTS = {
  escalation: Math.floor((OPTIONS.escalation.min + OPTIONS.escalation.max) / 2),
  truth: Math.floor((OPTIONS.truth.min + OPTIONS.truth.max) / 2),
  audience: OPTIONS.audiences[0],
  style: OPTIONS.styles[0],
};

function parseEffort(value) {
  const v = (value || "low").trim().toLowerCase();
  if (v === "none" || v === "off") return null; // omit the parameter entirely
  return ["low", "medium", "high", "xhigh", "max"].includes(v) ? v : "low";
}

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
// Anthropic call
// ---------------------------------------------------------------------------

let client;
function getClient() {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });
  return client;
}

async function callModel(system, user) {
  const params = {
    model: MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (EFFORT) params.output_config = { effort: EFFORT };

  const response = FALLBACK_MODELS.has(MODEL)
    ? await getClient().beta.messages.create({
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
    : await getClient().messages.create(params);

  if (response.stop_reason === "refusal") {
    throw new RefusalError(response.stop_details?.category || "refusal");
  }
  // Adaptive thinking may add thinking blocks; only the text blocks carry the answer.
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
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
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return [500, "The server's Anthropic API key is invalid or lacks access."];
  }
  if (err instanceof Anthropic.NotFoundError) {
    return [500, `The configured model "${MODEL}" was not found. Check the MODEL setting.`];
  }
  if (err instanceof Anthropic.RateLimitError) {
    return [429, "Too many excuses at once. Wait a moment and try again."];
  }
  if (err instanceof Anthropic.BadRequestError) {
    return [500, "The AI service rejected the request. Check the server logs."];
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return [504, "The AI service took too long to answer. Please try again."];
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return [502, "Could not reach the AI service. Please try again."];
  }
  if (err instanceof Anthropic.APIError) {
    return [503, "The AI service is having trouble right now. Please try again shortly."];
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
      error: "The server is missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.",
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
  console.log(`Excuse Report Card running at http://localhost:${PORT} (model: ${MODEL}, effort: ${EFFORT ?? "default"})`);
  if (!hasApiKey()) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set (add it to .env), so POST /api/excuse will return an error.");
  }
});
