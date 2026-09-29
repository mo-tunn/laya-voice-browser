import { test } from "node:test";
import assert from "node:assert/strict";
import { compactElements, detectSite, findSearchBox, approxTokens } from "../../src/snapshot.js";
import { buildRequest, encodeElement } from "../../src/laya.js";
import { MAX_ELEMENTS } from "../../src/constants.js";

const raw = (i, over = {}) => ({
  id: `e${String(i).padStart(2, "0")}`,
  tag: "a",
  role: "link",
  text: `Link number ${i}`,
  placeholder: "",
  href: `example.com/${i}`,
  type: "",
  inputName: "",
  inViewport: i % 2 === 0,
  top: i * 20,
  left: 0,
  ...over,
});

test("compactElements: viewport-visible first, then by position", () => {
  const els = [raw(1, { inViewport: false, top: 10 }), raw(2, { inViewport: true, top: 500 }), raw(3, { inViewport: true, top: 100 })];
  const out = compactElements(els);
  assert.deepEqual(
    out.map((e) => e.id),
    ["e03", "e02", "e01"],
  );
  assert.equal(out[2].below_fold, true);
  assert.equal(out[0].below_fold, undefined);
});

test("compactElements: dedupes identical (role, text, href) and drops nameless non-inputs", () => {
  const els = [raw(1), raw(2, { text: "Link number 1", href: "example.com/1" }), raw(3, { text: "", href: "" }), raw(4, { role: "textbox", tag: "input", text: "", placeholder: "" })];
  const out = compactElements(els);
  assert.deepEqual(
    out.map((e) => e.id),
    ["e02", "e04"], // in-viewport (even ids) first, by position; e01 duplicates e02 (seen first); e03 nameless link removed
  );
});

test("compactElements: truncates long text and caps count", () => {
  const els = Array.from({ length: 400 }, (_, i) => raw(i + 1, { text: "x".repeat(300) + i }));
  const out = compactElements(els);
  assert.ok(out.length <= MAX_ELEMENTS);
  assert.ok(out.every((e) => e.text.length <= 60));
});

test("compactElements: state size guard keeps the serialized list under budget", () => {
  const els = Array.from({ length: 250 }, (_, i) => raw(i + 1, { text: `Unique headline ${i} ` + "lorem ipsum dolor ".repeat(3), href: `site${i}.example.com/path/${i}` }));
  const out = compactElements(els, { maxChars: 3000 });
  assert.ok(JSON.stringify(out).length <= 3000, "shrunk to fit");
  assert.ok(out.length >= 5);
});

test("buildRequest: laya-browser observation stays bounded with the max element list", () => {
  const els = Array.from({ length: 400 }, (_, i) => raw(i + 1, { text: `Some fairly long link label number ${i} about a topic`, href: `news.example.com/story/${i}` }));
  const snapshot = { url: "https://news.example.com/", title: "News", site: "generic", elements: compactElements(els) };
  const { state, page } = buildRequest({ transcript: "click the first story", snapshot });
  assert.ok(approxTokens(state) < 8000, `state ~${approxTokens(state)} tokens`);
  assert.ok(page.actions.length <= MAX_ELEMENTS);
  assert.equal(page.actions.length, snapshot.elements.length);
  assert.equal(page.actions[0].id, "e02");
  assert.ok(page.text.length <= 1200);
});

test("buildRequest: text / URL candidates remain verbatim and deterministic", () => {
  const snapshot = { url: "about:blank", title: "", site: "blank", elements: [] };
  const a = buildRequest({ transcript: "scroll down", snapshot });
  assert.deepEqual(a.candidates.url, []);
  const b = buildRequest({ transcript: "type hello world into the search box", snapshot });
  assert.equal(b.candidates.text[0], "hello world");
  const c = buildRequest({ transcript: "open example dot com", snapshot });
  assert.equal(c.candidates.url[0], "example.com");
});

test("buildRequest: select options occupy distinct model action indexes but map to one DOM id", () => {
  const snapshot = {
    url: "https://example.com/form",
    title: "Form",
    elements: [
      { id: "e01", role: "select", text: "Language" },
      { id: "e02", role: "button", text: "Continue" },
    ],
    rawById: {
      e01: { role: "select", value: "en", options: [{ label: "English", value: "en" }, { label: "Turkish", value: "tr" }] },
      e02: { role: "button" },
    },
  };
  const req = buildRequest({ transcript: "select Turkish from the language dropdown", snapshot });
  assert.equal(req.page.actions.length, 3);
  assert.equal(req.indexToId["1"], "e01");
  assert.equal(req.indexToId["2"], "e01");
  assert.equal(req.indexToId["3"], "e02");
  assert.equal(req.page.actions[1].label, "Turkish");
});

test("encodeElement: compact line with host only when it differs from the page", () => {
  assert.equal(encodeElement({ id: "e09", role: "link", text: "GitHub", href: "github.com/x" }, "duckduckgo.com"), 'e09 link "GitHub" → github.com');
  assert.equal(encodeElement({ id: "e03", role: "link", text: "new", href: "news.ycombinator.com/newest" }, "news.ycombinator.com"), 'e03 link "new"');
  assert.equal(encodeElement({ id: "e02", role: "textbox", text: "", placeholder: "Search Wikipedia" }), "e02 textbox (placeholder: Search Wikipedia)");
});

test("detectSite", () => {
  assert.equal(detectSite("https://en.wikipedia.org/wiki/Main_Page"), "wikipedia");
  assert.equal(detectSite("https://news.ycombinator.com/newest"), "hacker_news");
  assert.equal(detectSite("https://www.google.com/search?q=x"), "google");
  assert.equal(detectSite("https://example.com/"), "example_com");
  assert.equal(detectSite("https://foo.bar.baz/"), "generic");
  assert.equal(detectSite("about:blank"), "blank");
});

test("findSearchBox prefers role=searchbox / search-ish names", () => {
  const els = [
    raw(1, { role: "textbox", tag: "input", inputName: "username", text: "", placeholder: "Username" }),
    raw(2, { role: "textbox", tag: "input", inputName: "search", text: "", placeholder: "Search Wikipedia" }),
    raw(3, { role: "link" }),
  ];
  assert.equal(findSearchBox(els), "e02");
  assert.equal(findSearchBox([raw(3)]), null);
});
