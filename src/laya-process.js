import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYA_URL } from "./laya.js";
import { MODEL } from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
let child = null;

function pythonCommand() {
  if (process.env.LAYA_PYTHON) return process.env.LAYA_PYTHON;
  const local = process.platform === "win32"
    ? path.join(projectRoot, ".venv", "Scripts", "python.exe")
    : path.join(projectRoot, ".venv", "bin", "python");
  if (existsSync(local)) return local;
  return process.platform === "win32" ? "python" : "python3";
}

async function healthy(timeoutMs = 1000) {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(new URL("/health", LAYA_URL), { signal });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.status === "ok" && body?.backend === "laya-browser" && Array.isArray(body?.loaded);
  } catch {
    return false;
  }
}

function canAutoStart(url) {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export async function ensureLayaServer() {
  if (await healthy()) return { managed: false, url: LAYA_URL };
  if (process.env.LAYA_AUTO_START === "0" || !canAutoStart(LAYA_URL)) {
    throw new Error(`Laya is not reachable at ${LAYA_URL}. Start laya-serve there or enable local auto-start.`);
  }
  if (child && child.exitCode == null) return { managed: true, url: LAYA_URL };

  const url = new URL(LAYA_URL);
  const python = pythonCommand();
  const stderr = [];
  child = spawn(python, [path.join(projectRoot, "scripts", "laya-browser-server.py")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      LAYA_HOST: url.hostname === "localhost" ? "127.0.0.1" : url.hostname,
      LAYA_PORT: url.port || "8001",
      LAYA_MODEL: process.env.LAYA_MODEL || MODEL,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (buf) => process.stdout.write(`[laya] ${buf}`));
  child.stderr?.on("data", (buf) => {
    const text = String(buf);
    stderr.push(text);
    if (stderr.length > 20) stderr.shift();
    process.stderr.write(`[laya] ${text}`);
  });

  const deadline = Date.now() + (Number(process.env.LAYA_START_TIMEOUT_MS) || 300_000);
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    if (await healthy(750)) {
      console.log(`local laya-browser ready at ${LAYA_URL} (model: ${MODEL})`);
      return { managed: true, url: LAYA_URL };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const detail = stderr.join("").trim();
  child = null;
  throw new Error(
    `Could not start local laya-browser with ${python}. Run npm run setup:laya first.${detail ? `\n${detail}` : ""}`,
  );
}

export async function stopLayaServer() {
  if (!child || child.exitCode != null) {
    child = null;
    return;
  }
  const proc = child;
  child = null;
  proc.kill();
  const exited = await Promise.race([
    new Promise((resolve) => proc.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!exited && process.platform === "win32" && proc.pid) {
    // Last-resort Windows cleanup if Python ignored/was stuck during termination.
    const { spawnSync } = await import("node:child_process");
    spawnSync("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
  }
}
