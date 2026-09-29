/**
 * Hybrid browser decision adapter.
 *
 * Global browser commands (navigation/search/history/tabs/scroll/confirmation) stay
 * deterministic. Page-local operation + element selection is delegated to the
 * browser-specialized cklxx/laya-browser checkpoint through the local Python bridge.
 *
 * The adapter still returns the legacy typed-answer shape consumed by policy.js, so
 * controller/executor/confirmation logic remains unchanged.
 */
import {
  MODEL,
  MAX_TRANSCRIPT_CHARS,
  MAX_CONTEXT_ACTIONS,
  MAX_ELEMENTS,
} from "./constants.js";
import {
  cleanTranscript,
  extractTextCandidates,
  extractUrlCandidates,
} from "./spans.js";

export const LAYA_URL = (process.env.LAYA_URL || "http://127.0.0.1:8001").replace(/\/$/, "");

export function costUsd() {
  return 0;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

function choice(choice, probabilities = null, confidence = null) {
  const probs = probabilities || { [choice]: 1 };
  const p = confidence ?? probs?.[choice] ?? 1;
  return { type: "choice", choice, probabilities: probs, confidence: clamp01(p) };
}

function noul(value) {
  const v = clamp01(value);
  return { type: "noul", noul: v, confidence: Math.max(v, 1 - v) };
}

function score(value) {
  return { type: "score", score: Number(value) || 0, confidence: 1 };
}

/** Human-readable element label used both by the model and UI diagnostics. */
export function encodeElement(el, pageHost = "") {
  let s = `${el.id} ${el.role}`;
  const text = el.text || "";
  if (text) s += ` "${text}"`;
  if (el.placeholder && el.placeholder !== text) s += ` (placeholder: ${el.placeholder})`;
  if (el.href) {
    const host = el.href.split("/")[0];
    if (host && host !== pageHost) s += ` → ${host}`;
  }
  if (el.below_fold) s += " [below fold]";
  return s;
}

export function encodeContext(context) {
  if (!context) return null;
  const out = {};
  if (context.previousPage?.url) {
    out.previous_page = {
      url: String(context.previousPage.url).slice(0, 200),
      title: String(context.previousPage.title || "").slice(0, 120),
    };
  }
  const actions = (context.recentActions || []).slice(-MAX_CONTEXT_ACTIONS).reverse();
  if (actions.length) {
    const now = Date.now();
    out.recent_actions = actions.map((a) => ({
      said: String(a.said || "").slice(0, 120),
      action: a.type,
      target: a.targetLabel ? String(a.targetLabel).slice(0, 80) : null,
      text: a.text ? String(a.text).slice(0, 80) : null,
      url: a.url ? String(a.url).slice(0, 200) : null,
      outcome: a.outcome || (a.ok === false ? "failed" : "done"),
      seconds_ago: a.at ? Math.max(0, Math.round((now - a.at) / 1000)) : undefined,
    }));
  }
  return Object.keys(out).length ? out : null;
}

const SITE_PATTERNS = [
  ["google", /\bgoogle\b/i],
  ["duckduckgo", /\bduck\s*duck\s*go\b|\bduckduckgo\b/i],
  ["youtube", /\byou\s*tube\b|\byoutube\b/i],
  ["wikipedia", /\bwikipedia\b/i],
  ["github", /\bgithub\b/i],
  ["amazon", /\bamazon\b/i],
  ["reddit", /\breddit\b/i],
  ["twitter_x", /\btwitter\b|(?:^|\s)x(?:\s|$)/i],
  ["hacker_news", /\bhacker\s+news\b|\bnews\.ycombinator\.com\b/i],
  ["example_com", /\bexample(?:\s+dot|\.)\s*com\b/i],
];

function siteFromTranscript(text) {
  for (const [site, re] of SITE_PATTERNS) if (re.test(text)) return site;
  return "none";
}

function startsWithCommand(text) {
  return /^(?:(?:please|hey)\s+)?(?:(?:can|could|would)\s+you\s+)?(?:go\b|open\b|visit\b|take\s+me\b|search\b|look\s+up\b|google\b|find\b|click\b|tap\b|press\b|choose\b|select\b|type\b|enter\b|write\b|put\b|fill\b|scroll\b|page\s+(?:up|down)\b|back\b|forward\b|reload\b|refresh\b|new\s+tab\b|close\b|switch\b|next\s+tab\b|previous\s+tab\b|confirm\b|cancel\b|undo\b|yes\b|no\b|wrong\b)/i.test(text);
}

function isCorrectionText(text) {
  return /^(?:no\b|wrong\b|undo\b|not\s+that\b|that(?:'s| is)\s+wrong\b|i\s+meant\b)/i.test(text)
    || /\b(?:not that one|other one|wrong link|undo that)\b/i.test(text);
}

function isCompleteText(text) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (!t) return false;
  if (/\b(?:go to|visit|take me to|search for|look up|search on|click the|press the|open the|type|enter|write|fill|choose|select|scroll)\s*$/.test(t)) return false;
  if (/^(?:open\s+(?:a\s+)?new|open\s+a|close\s+(?:this|current)|click\s+on(?:\s+(?:a|the))?|switch\s+(?:to\s+)?(?:the)?|go\s+to\s+.+\s+dot)\s*$/.test(t)) return false;
  if (/^(?:go|open|click|press|search|type|enter|select|choose|scroll)$/.test(t)) return false;
  return true;
}

function scrollAmount(text) {
  if (/\b(?:all the way|bottom|very bottom|top|very top|end)\b/i.test(text)) return 2;
  if (/\b(?:a bit|little|slightly|a little|few lines)\b/i.test(text)) return 0;
  return 1;
}

function normalizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const ORDINAL = { first: 0, "1st": 0, one: 0, second: 1, "2nd": 1, two: 1, third: 2, "3rd": 2, three: 2, fourth: 3, four: 3 };

function ordinalResultTarget(text, snapshot) {
  if (!/\bresult\b/i.test(text)) return null;
  const words = normalizeWords(text);
  const ordinalWord = words.find((w) => w in ORDINAL);
  if (!ordinalWord) return null;
  const n = ORDINAL[ordinalWord];
  const pageHost = (() => { try { return new URL(snapshot?.url || "").hostname.replace(/^www\./, ""); } catch { return ""; } })();
  const results = (snapshot?.elements || []).filter((el) => {
    if (el.role !== "link" || el.below_fold) return false;
    const label = String(el.text || "").trim();
    if (!label || /^(all|images|videos|news|settings|privacy policy|duckduckgo home)$/i.test(label)) return false;
    if (/^[a-z0-9.-]+\.(?:com|org|net|io|ai|dev)$/i.test(label)) return false;
    const hrefHost = String(el.href || "").split("/")[0];
    return hrefHost && hrefHost !== pageHost && label.length >= 8;
  });
  return results[n]?.id || null;
}

function clickPhrase(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/^(?:please\s+)?(?:click|tap|press|open)\s+(?:the\s+)?/, "")
    .replace(/\b(?:link|button|tab|item)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lexicalClickTarget(text, snapshot) {
  const ordinal = ordinalResultTarget(text, snapshot);
  if (ordinal) return { id: ordinal, strong: true };
  const phrase = clickPhrase(text);
  if (!phrase || /\bresult\b/.test(phrase)) return null;
  const phraseWords = normalizeWords(phrase).filter((w) => !["the", "a", "an", "one"].includes(w));
  if (!phraseWords.length) return null;

  let best = null;
  for (const el of snapshot?.elements || []) {
    if (!["link", "button", "tab", "menuitem", "clickable"].includes(el.role)) continue;
    const label = String(el.text || el.placeholder || "").toLowerCase();
    const href = String(el.href || "").toLowerCase();
    const normalized = normalizeWords(label).join(" ");
    const labelWords = new Set(normalizeWords(label));
    let score = 0;
    if (normalized === phraseWords.join(" ")) score += 12;
    if (normalized.includes(phraseWords.join(" "))) score += 7;
    for (const w of phraseWords) {
      if (labelWords.has(w)) score += 3;
      else if (href.includes(w)) score += 1.5;
    }
    // Speech often says "more information" for a visible "Learn more" link.
    if (/more information/.test(phrase) && /learn more|more info/.test(label)) score += 10;
    // Prefer descriptive result titles over naked host/domain links.
    if (/^[a-z0-9.-]+\.(?:com|org|net|io|ai|dev)$/i.test(label.trim())) score -= 3;
    if (!best || score > best.score) best = { id: el.id, score };
  }
  if (!best || best.score < 3) return null;
  return { id: best.id, strong: best.score >= 7 };
}

function tabDirection(text) {
  if (/\b(?:previous|last|before)\s+tab\b/i.test(text)) return "previous";
  if (/\bfirst\s+tab\b/i.test(text)) return "first";
  return "next";
}

function deterministicIntent(text, { pendingConfirmation = null } = {}) {
  const t = text.trim();
  if (pendingConfirmation) {
    if (/^(?:yes|confirm|do it|go ahead|proceed)\b/i.test(t)) return "confirm";
    if (/^(?:cancel|never mind|stop|no cancel)\b/i.test(t)) return "cancel";
  }
  if (/\b(?:go back|previous page|back to the|undo navigation)\b/i.test(t) || /^back$/i.test(t)) return "go_back";
  if (/\bgo forward\b|^forward$/i.test(t)) return "go_forward";
  if (/\b(?:reload|refresh)(?:\s+the)?(?:\s+page)?\b/i.test(t)) return "reload";
  if (/\b(?:open\s+)?(?:a\s+)?new tab\b/i.test(t)) return "open_new_tab";
  if (/\bclose (?:this |current )?tab\b/i.test(t)) return "close_tab";
  if (/\b(?:switch|next|previous|first|other)\s+(?:to\s+)?(?:the\s+)?tab\b|\bswitch tab\b/i.test(t)) return "switch_tab";
  if (/\b(?:press|hit)\s+(?:the\s+)?(?:enter|return)\b|^submit$/i.test(t)) return "press_enter";
  if (/\b(?:scroll|page)\s+down\b|\bgo to the bottom\b/i.test(t)) return "scroll_down";
  if (/\bscroll\b.*\b(?:bottom|end)\b/i.test(t)) return "scroll_down";
  if (/\b(?:scroll|page)\s+up\b|\bback to the top\b/i.test(t)) return "scroll_up";

  const urls = extractUrlCandidates(t);
  const site = siteFromTranscript(t);
  const navVerb = /^(?:(?:please\s+)?)(?:go\s+to|visit|open|take\s+me\s+to)\b/i.test(t);
  if (navVerb && (urls.length || site !== "none")) return "navigate_url";
  if (/^(?:(?:please\s+)?)(?:search(?:\s+on)?|look\s+up|google)\b/i.test(t)) return "search_web";
  if (/^(?:(?:please\s+)?)(?:type|enter|write|put|fill)\b/i.test(t)) return "type_into_field";
  if (/^(?:(?:please\s+)?)(?:select|choose)\b/i.test(t) && /\b(?:dropdown|menu|option|from)\b/i.test(t)) return "select_option";
  if (/^(?:(?:please\s+)?)(?:click|tap|press)\b/i.test(t)) return "click_element";
  if (isCorrectionText(t) && /\bother one\b/i.test(t)) return "click_element";
  return null;
}

function destructiveProbability(transcript, targetEl) {
  const label = `${transcript} ${targetEl?.text || ""} ${targetEl?.placeholder || ""}`.toLowerCase();
  if (/\b(?:search|find|apply filter)\b/.test(label) && !/\b(?:buy|order|pay|delete|send|post|publish)\b/.test(label)) return 0.02;
  return /\b(?:place order|buy(?: now)?|purchase|pay(?: now)?|checkout|delete|remove account|send(?: message)?|post|publish|book(?: now)?|reserve|log ?out|sign ?out)\b/.test(label) ? 0.98 : 0.02;
}

function historyForBrowser(context) {
  return (context?.recentActions || []).slice(-10).map((a) => ({
    action: a.targetLabel || a.label || a.type || "",
    kind: a.type || "",
    text: a.text || null,
    page_changed: Boolean(a.url || String(a.outcome || "").startsWith("navigated to")),
  }));
}

function actionLabel(el) {
  const main = el.text || el.placeholder || el.id;
  return el.href ? `${main} → ${el.href}` : main;
}

export function buildBrowserPage(snapshot) {
  const elements = (snapshot?.elements || []).slice(0, MAX_ELEMENTS);
  const actions = [];
  const indexToId = {};
  const pushAction = (action) => {
    actions.push(action);
    indexToId[String(actions.length)] = action.id;
  };
  for (const el of elements) {
    const raw = snapshot?.rawById?.[el.id] || {};
    const role = el.role || raw.role || "";
    const label = actionLabel({ ...raw, ...el });
    const common = { id: el.id, node: el.id, label, role };
    for (const key of ["checked", "selected", "expanded"]) if (raw[key] != null) common[key] = raw[key];
    if (role === "select") {
      const options = Array.isArray(raw.options) ? raw.options : [];
      if (options.length) {
        for (const opt of options.slice(0, 30)) {
          pushAction({ ...common, kind: "select", label: String(opt.label || opt.text || opt.value || ""), value: String(opt.value ?? opt.label ?? ""), current_value: String(raw.value ?? "") });
        }
      } else pushAction({ ...common, kind: "click" });
    } else if (["textbox", "searchbox", "combobox"].includes(role)) {
      pushAction({ ...common, kind: "fill", value: String(raw.value ?? ""), current_value: String(raw.value ?? "") });
    } else pushAction({ ...common, kind: "click" });
  }
  const fallbackText = elements.map((e) => `${e.text || e.placeholder || ""}`).filter(Boolean).join("\n");
  return { page: { url: snapshot?.url || "about:blank", title: snapshot?.title || "", text: String(snapshot?.text || fallbackText).slice(0, 1200), actions }, indexToId };
}

function mapTargetAnswer(raw, indexToId, fallbackId = "none") {
  if (!raw || typeof raw !== "object") return choice(fallbackId, { [fallbackId]: 1 }, 1);
  const probs = {};
  for (const [key, p] of Object.entries(raw.probabilities || {})) {
    const base = String(key).split(":")[0];
    const id = indexToId[base];
    if (id) probs[id] = (probs[id] || 0) + Number(p || 0);
  }
  let chosen = fallbackId;
  if (raw.choice != null) chosen = indexToId[String(raw.choice).split(":")[0]] || fallbackId;
  if (fallbackId !== "none") chosen = fallbackId;
  if (!(chosen in probs)) probs[chosen] = raw.probabilities?.[raw.choice] ?? 1;
  probs.none = probs.none ?? 0;
  return choice(chosen, probs, probs[chosen]);
}

function baseAnswers({ transcript, candidates, site, intentName, intentConfidence = 0.99, target = null, context = null, snapshot = null }) {
  const complete = isCompleteText(transcript) ? 0.98 : 0.02;
  const correction = isCorrectionText(transcript) && context?.recentActions?.length ? 0.98 : 0.02;
  const targetId = target?.choice && target.choice !== "none" ? target.choice : null;
  const targetEl = targetId ? snapshot?.elements?.find((e) => e.id === targetId) : null;
  const textPick = candidates.text?.[0] || "none";
  const urlPick = candidates.url?.[0] || "none";
  if (intentName === "search_web" && site === "none" && snapshot?.searchBoxId) {
    target = choice(snapshot.searchBoxId, { [snapshot.searchBoxId]: 1, none: 0 }, 1);
  }
  const answers = {
    intent: choice(intentName || "none", { [intentName || "none"]: intentName ? intentConfidence : 1 }, intentName ? intentConfidence : 1),
    target: target || choice("none", { none: 1 }, 1),
    site: choice(site, { [site]: 1 }, 1),
    complete: noul(complete),
    is_command: noul(startsWithCommand(transcript) || correction > 0.5 ? 0.99 : 0.01),
    destructive: noul(destructiveProbability(transcript, targetEl)),
    scroll_amount: score(scrollAmount(transcript)),
    tab_direction: choice(tabDirection(transcript), { [tabDirection(transcript)]: 1 }, 1),
  };
  if (candidates.text?.length) answers.text_span = choice(textPick, { [textPick]: 1 }, 1);
  if (candidates.url?.length) answers.url_span = choice(urlPick, { [urlPick]: 1 }, 1);
  if (context?.recentActions?.length) answers.is_correction = noul(correction);
  return answers;
}

export function buildRequest({ transcript, snapshot, pendingConfirmation = null, tabs = null, context = null }) {
  const text = cleanTranscript(String(transcript || "").slice(-MAX_TRANSCRIPT_CHARS));
  const candidates = { text: extractTextCandidates(text), url: extractUrlCandidates(text) };
  const { page, indexToId } = buildBrowserPage(snapshot);
  const history = historyForBrowser(context);
  const state = { transcript: text, page, history, pending_confirmation: pendingConfirmation || null, open_tabs: tabs?.length || 1 };
  const diagnosticContext = encodeContext(context);
  if (diagnosticContext) state.context = diagnosticContext;
  return { state, page, indexToId, history, candidates };
}

async function askBrowserModel({ page, history, goal }, signal) {
  const timeoutSignal = AbortSignal.timeout(Number(process.env.LAYA_TIMEOUT_MS) || 30_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${LAYA_URL}/v1/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page, goal, history }), signal: combinedSignal });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Laya browser request failed (${response.status}): ${detail || response.statusText}`);
  }
  return { data: await response.json(), response };
}

const OP_TO_INTENT = { CLICK: "click_element", TYPE_TEXT: "type_into_field", SELECT: "select_option", PRESS_ENTER: "press_enter", SCROLL_DOWN: "scroll_down", SCROLL_UP: "scroll_up" };

export async function decide(input, { signal } = {}) {
  const req = buildRequest(input);
  const transcript = req.state.transcript;
  const site = siteFromTranscript(transcript);
  const fixedIntent = deterministicIntent(transcript, input);
  const pageBound = ["click_element", "type_into_field", "select_option"].includes(fixedIntent);
  const needsModel = pageBound || (fixedIntent == null && isCompleteText(transcript) && startsWithCommand(transcript) && !isCorrectionText(transcript));
  const t0 = performance.now();
  let modelData = null;
  let requestId = null;
  let target = null;
  let intentName = fixedIntent;
  let intentConfidence = fixedIntent ? 0.99 : 0;
  if (needsModel) {
    const { data, response } = await askBrowserModel({ page: req.page, history: req.history, goal: transcript }, signal);
    modelData = data;
    requestId = response.headers.get("x-request-id");
    const op = String(data.operation || data.answers?.operation?.choice || "").toUpperCase();
    const modelIntent = OP_TO_INTENT[op] || null;
    if (!fixedIntent) intentName = modelIntent;
    const opAnswer = data.answers?.operation;
    if (opAnswer?.probabilities && opAnswer.choice != null) intentConfidence = clamp01(opAnswer.probabilities[opAnswer.choice]);
    else intentConfidence = clamp01(data.confidence ?? (modelIntent ? 0.8 : 0));
    if (["CLICK", "TYPE_TEXT", "SELECT"].includes(op)) {
      const rawTarget = data.answers?.[`${op.toLowerCase()}_target`];
      target = mapTargetAnswer(rawTarget, req.indexToId, data.action?.id || "none");
    }

    if ((fixedIntent === "click_element" || (!fixedIntent && modelIntent === "click_element")) && !/\bother one\b/i.test(transcript)) {
      const lexical = lexicalClickTarget(transcript, input.snapshot);
      if (lexical?.id && lexical.strong) {
        target = choice(lexical.id, { [lexical.id]: 0.99, none: 0.01 }, 0.99);
      } else {
        const chosenId = target?.choice;
        const chosenEl = chosenId && chosenId !== "none" ? input.snapshot?.elements?.find((e) => e.id === chosenId) : null;
        const phrase = clickPhrase(transcript);
        const overlap = chosenEl ? normalizeWords(phrase).some((w) => w.length > 2 && normalizeWords(`${chosenEl.text || ""} ${chosenEl.href || ""}`).includes(w)) : false;
        if (phrase && !overlap && !/\b(?:first|second|third|fourth)\s+result\b/i.test(transcript)) {
          target = choice("none", { none: 1 }, 1);
        }
      }
    }

    if (/\bother one\b/i.test(transcript) && input.context?.recentActions?.length && target?.probabilities) {
      const last = input.context.recentActions[input.context.recentActions.length - 1]?.targetId;
      const probs = Object.fromEntries(Object.entries(target.probabilities).filter(([id]) => id !== last && id !== "none"));
      const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
      if (ranked.length) {
        const [id, p] = ranked[0];
        probs.none = 0;
        target = choice(id, probs, p);
      }
    }
    if (fixedIntent && modelIntent && fixedIntent !== modelIntent) {
      intentName = fixedIntent;
      intentConfidence = 0.99;
    }
  }
  if (isCorrectionText(transcript) && input.context?.recentActions?.length && !fixedIntent) {
    intentName = "none";
    intentConfidence = 0;
  }
  const answers = baseAnswers({ transcript, candidates: req.candidates, site, intentName, intentConfidence, target, context: input.context, snapshot: input.snapshot });
  if (intentName === "select_option" && modelData?.action?.label) {
    const selected = String(modelData.action.label);
    answers.text_span = choice(selected, { [selected]: 1 }, 1);
  }
  const latencyMs = Math.round(performance.now() - t0);
  return { answers, latencyMs, usage: modelData?.usage || { input_tokens: 0, output_tokens: 0 }, costUsd: 0, model: modelData?.model || MODEL, requestId, candidates: req.candidates, state: req.state, questionCount: needsModel ? 1 : 0, raw: modelData };
}

export function isAbortError(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError";
}
