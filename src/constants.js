/**
 * ONE reviewable place for runtime limits, policy thresholds and deterministic site maps.
 *
 * Runtime page-local decisions use the browser-specialized cklxx/laya-browser checkpoint.
 * Code owns global commands, verbatim payload extraction, safety gates and explicit targets.
 */

export const MODEL = process.env.LAYA_MODEL || "cklxx/laya-browser";

// ---------------------------------------------------------------------------
// Perception limits (state size hurts accuracy + latency; keep it small)
// ---------------------------------------------------------------------------
export const MAX_ELEMENTS = 40; // keep target options + state small enough for Laya's typed checkpoint
export const MAX_ELEMENT_TEXT = 50; // chars per element label
export const MAX_STATE_CHARS = 3_200; // roughly <=800 state tokens before per-question prompt overhead
export const MAX_TRANSCRIPT_CHARS = 400;
// Conversation context sent with every request: the page before the last navigation and the
// last few executed actions (what was said, what was done, what happened). Lets Laya resolve
// "go back to the results", "the other one", "no, not that one", "open the documentation" (of the
// thing I just opened). Small on purpose â€” irrelevant state costs accuracy.
export const MAX_CONTEXT_ACTIONS = 3;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
export const DEBOUNCE_MS = 200; // wait this long after the last transcript update before asking Laya
export const MAX_INFLIGHT = 2; // overlapping Laya requests allowed; older ones are cancelled with AbortSignal
export const SILENCE_COMPLETE_MS = 900; // no new words for this long => treat command as complete
// Intents that carry free text (a query or text to type) cannot be acted on mid-sentence â€” "search
// for alan" is a complete-sounding command but the payload may still be growing. They wait for the
// recognizer's final result or this much silence.
export const PAYLOAD_SILENCE_MS = 600;
export const PAYLOAD_INTENTS = new Set(["search_web", "type_into_field", "select_option"]);
export const HIGHLIGHT_MS = 600; // element flash on the controlled page
export const CANDIDATE_TTL_MS = 8000; // numbered overlays stay this long

// ---------------------------------------------------------------------------
// Execution policy thresholds (the "why did it act / wait" numbers shown in the UI)
// ---------------------------------------------------------------------------
export const T = {
  intentConfidence: 0.55, // `intent` Choice confidence needed to act at all
  complete: 0.6, // `complete` Noul: user has finished the command (bypassed after SILENCE_COMPLETE_MS)
  isCommand: 0.5, // `is_command` Noul: user is addressing the browser at all
  destructive: 0.5, // `destructive` Noul above this => needs confirmation ...
  destructiveIntentConfidence: 0.9, // ... unless intent confidence is this high AND the user already said "confirm"
  targetConfidence: 0.45, // `target` Choice below this => show numbered candidate overlays instead of clicking
  targetTopProb: 0.35, // and the winning element must have at least this probability
  spanConfidence: 0.35, // `text_span` / `url_span` picks below this fall back to the heuristic candidate
  candidateCount: 3, // how many candidates to overlay when target is ambiguous
  correction: 0.6, // `is_correction` Noul: user is undoing / redirecting the previous action ("no, not that one")
};

export const TARGET_INTENTS = new Set(["click_element", "type_into_field", "select_option"]);

// ---------------------------------------------------------------------------
// Sites (code owns URLs; Laya only picks the name)
// ---------------------------------------------------------------------------
export const SITE_HOME = {
  google: "https://www.google.com/",
  duckduckgo: "https://duckduckgo.com/",
  youtube: "https://www.youtube.com/",
  wikipedia: "https://en.wikipedia.org/wiki/Main_Page",
  github: "https://github.com/",
  amazon: "https://www.amazon.com/",
  reddit: "https://www.reddit.com/",
  twitter_x: "https://x.com/",
  hacker_news: "https://news.ycombinator.com/",
  example_com: "https://example.com/",
};

// Search URL templates; `%s` is replaced with the URL-encoded query.
export const SITE_SEARCH = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  the_web: "https://duckduckgo.com/?q=%s",
  youtube: "https://www.youtube.com/results?search_query=%s",
  wikipedia: "https://en.wikipedia.org/w/index.php?search=%s",
  github: "https://github.com/search?q=%s&type=repositories",
  amazon: "https://www.amazon.com/s?k=%s",
  reddit: "https://www.reddit.com/search/?q=%s",
  twitter_x: "https://x.com/search?q=%s",
  hacker_news: "https://hn.algolia.com/?q=%s",
};

export const DEFAULT_SEARCH_ENGINE = "duckduckgo";

// ---------------------------------------------------------------------------
// Legacy typed-question descriptions retained for the control-room diagnostics and policy tests.
// Runtime page-local decisions now use the browser-specialized checkpoint's native decide()
// format; global navigation/search/history commands are deterministic in src/laya.js.
