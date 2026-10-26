// Token budgeting for reasoning models.
//
// Reasoning models (Muse Spark, MiMo, Nemotron, LongCat, ...) emit
// chain-of-thought tokens that count against the SAME output budget as the
// visible answer. When a client asks for a small max_tokens — a probe, a
// title, a one-word reply — the model spends the whole budget thinking and
// returns finish_reason: "length" with empty content. The failure is silent:
// no error, no content, tokens still billed.
//
// OpenRouter documents the behaviour ("reasoning tokens count against
// max_tokens ... set max_tokens well above the expected reasoning length"),
// and the accepted fix in the wider ecosystem is an ADDITIVE budget:
//
//   max_tokens = answer_budget + thinking_budget
//
// (see goose#11142, which adopts the pi coding agent's formula). This module
// applies that here, so a short request still returns a visible answer.
//
// Tuning notes, from measurements against the live OpenCode Zen gateway:
//   - max_tokens  50 -> empty for Muse
//   - max_tokens 100 -> empty for Muse and cat-jam
//   - max_tokens 256 -> empty for big-pickle; longcat finished exactly on the cap
//   - max_tokens 512 -> content returned, but truncated on long answers
//   - max_tokens 2048 + thinking headroom -> complete answers
//
// Hence MIN_ANSWER_TOKENS = 1024 (matching pi and Anthropic's reservation)
// and THINKING_BUDGET = 4096, which covers the ~100-800 reasoning tokens
// observed here with room to spare.

const MIN_ANSWER_TOKENS = 1024;
const THINKING_BUDGET = 4096;
const MAX_OUTPUT_TOKENS = 131072;
// Non-reasoning models still get a floor, so a tiny client value cannot
// truncate a normal answer mid-sentence.
const MIN_PLAIN_TOKENS = 512;

// Models that think before answering. The provider catalog states this
// outright (`reasoning: true` on every live free model), and the catalog is
// cached on disk after its first fetch, so the bridge asks it instead of
// maintaining a hand-written substring list.
const REASONING_MODEL_HINTS = Object.freeze([]);

function isReasoningModel(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (!id) return false;
  try {
    const facts = require("./identity").getModelFacts(id);
    if (facts && typeof facts.reasoning === "boolean") return facts.reasoning;
  } catch {
    // identity unavailable: fall through.
  }
  return false;
}

// A request counts as reasoning-bound when it targets a known thinking model,
// or when the client explicitly asked for reasoning effort.
function isReasoningRequest(body, modelId) {
  if (isReasoningModel(modelId)) return true;
  const effort = body && body.reasoning_effort;
  return Boolean(effort) && effort !== "none";
}

// Clamp the client's requested budget into a range that always leaves room for
// a visible answer. The client's value is never lowered — only raised when it
// is too small to survive the model's reasoning phase.
function parseRequestedTokens(requested) {
  if (requested === undefined || requested === null || typeof requested === "boolean") {
    return MAX_OUTPUT_TOKENS;
  }
  if (typeof requested === "string" && requested.trim() === "") {
    return MAX_OUTPUT_TOKENS;
  }
  const raw = Number(requested);
  if (!Number.isFinite(raw) || raw < 0) {
    return MAX_OUTPUT_TOKENS;
  }
  return Math.floor(raw);
}

function effectiveMaxTokens(requested, modelId, body) {
  const wanted = parseRequestedTokens(requested);

  const effective = isReasoningRequest(body, modelId)
    ? Math.max(wanted, MIN_ANSWER_TOKENS) + THINKING_BUDGET
    : Math.max(wanted, MIN_PLAIN_TOKENS);

  // The catalog states each model's output ceiling (`limit.output`). Asking for
  // more than a model can emit is rejected or silently truncated upstream, so
  // the cap follows the model rather than a single global constant.
  let ceiling = MAX_OUTPUT_TOKENS;
  try {
    const facts = require("./identity").getModelFacts(modelId);
    if (facts && facts.maxOutput > 0) ceiling = Math.min(ceiling, facts.maxOutput);
  } catch {}
  return Math.min(effective, ceiling);
}

module.exports = {
  MIN_ANSWER_TOKENS,
  THINKING_BUDGET,
  MAX_OUTPUT_TOKENS,
  MIN_PLAIN_TOKENS,
  REASONING_MODEL_HINTS,
  isReasoningModel,
  isReasoningRequest,
  effectiveMaxTokens,
};
