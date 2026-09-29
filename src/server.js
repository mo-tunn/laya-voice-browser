/**
 * Node server: serves the control page and bridges WebSocket <-> Controller.
 *
 *   node src/server.js [--port 8787] [--host 127.0.0.1] [--headless] [--cdp ws://127.0.0.1:9222/devtools/browser/...] [--start-url https://...]
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { BrowserManager } from "./browser.js";
import { Controller } from "./controller.js";
import { ensureLayaServer, stopLayaServer } from "./laya-process.js";
import { MODEL, T } from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || 8787,
    // Bind to loopback only by default: anyone who can reach this port can drive the browser.
    // Use --host 0.0.0.0 deliberately if you need LAN access.
    host: process.env.HOST || "127.0.0.1",
    headless: false,
    cdp: null,
    startUrl: "https://example.com/",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--headless") out.headless = true;
    else if (a === "--cdp") out.cdp = argv[++i];
    else if (a === "--start-url") out.startUrl = argv[++i];
  }
  return out;
}

export async function startServer(opts = {}) {
  await ensureLayaServer();
  const browser = new BrowserManager();
  await browser.launch({ headless: opts.headless, cdp: opts.cdp, startUrl: opts.startUrl });
  const controller = new Controller({ browser });
  await controller.start();

  const app = express();
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/api/state", (_req, res) => res.json(controller.uiState()));
  app.get("/api/questions", (_req, res) => res.json({
    model: MODEL,
    thresholds: T,
    architecture: {
      deterministic: ["navigate/search", "history/tabs", "scroll", "confirmation", "verbatim text/URL extraction", "explicit ordinal/exact targets"],
      model: "page-local operation + ambiguous element selection via cklxx/laya-browser",
      modelInput: "page.actions + visible page text + goal + recent action history",
    },
  }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const broadcast = (type, payload) => {
    const msg = JSON.stringify({ type, payload });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };

  controller.on("transcript", (p) => broadcast("transcript", p));
  controller.on("decision", (p) => broadcast("decision", p));
  controller.on("action", (p) => broadcast("action", { ...p, ui: controller.uiState() }));
  controller.on("snapshot", () => broadcast("snapshot", controller.uiState().snapshot));
  controller.on("log", (p) => broadcast("log", p));
  controller.on("candidates", (p) => broadcast("candidates", p));
  controller.on("pending", (p) => broadcast("pending", p));
  controller.on("tabs", (p) => broadcast("tabs", p));

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case "transcript":
          controller.handleTranscript({ text: msg.text, final: Boolean(msg.final), utteranceId: msg.utteranceId });
          break;
        case "command":
          controller.handleCommand(msg.text);
          break;
        case "undo":
          controller.undo();
          break;
        case "snapshot":
          controller.refreshSnapshot();
          break;
        case "state":
          ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
          break;
        default:
          break;
      }
    });
  });

  const host = opts.host || "127.0.0.1";
  await new Promise((resolve) => server.listen(opts.port, host, resolve));
  const url = `http://localhost:${opts.port}`;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(`WARNING: listening on ${host} — anyone who can reach this port can control the browser.`);
  }
  console.log(`\nvoice-browser ready → open ${url} in Chrome (mic needs Chrome/Edge)`);
  console.log(`model ${MODEL} · controlled window: ${opts.cdp ? "attached via CDP" : opts.headless ? "headless" : "headed Chromium"}\n`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nshutting down voice-browser...");
    await controller.close();
    await browser.close();
    await stopLayaServer();
    await new Promise((resolve) => server.close(resolve));
    process.exitCode = 0;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { app, server, controller, browser, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
