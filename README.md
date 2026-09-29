# Laya Voice Browser

Voice-controlled Chromium automation with a local browser-specialized Laya model and Playwright.

This project started from [moritzkremb/jev-voice-browser](https://github.com/moritzkremb/jev-voice-browser) and has since been substantially reworked. The current version removes the hosted TypeSafe/JEV dependency, uses the local [cklxx/laya-browser](https://huggingface.co/cklxx/laya-browser) checkpoint for page-local semantic decisions, and keeps deterministic browser control logic in code.

## Architecture

```text
Chrome / Edge microphone
        |
        v
Web Speech API transcript
        |
        v
Node controller
  |-- deterministic navigation / search / tabs / scroll
  |-- verbatim text and URL extraction
  |-- explicit target resolution
  |-- compact page snapshot
        |
        | only when page-local semantic judgment is needed
        v
local cklxx/laya-browser
  page.actions + page text + goal + history
        |
        v
operation + target probabilities
        |
        v
policy.js
ACT / WAIT / IGNORE / CONFIRM / DISAMBIGUATE
        |
        v
Playwright -> controlled Chromium
```

The model does not generate URLs or typed text. Spoken URLs, search queries, and form text are extracted deterministically from the transcript. The model is mainly used for ambiguous page-local operation and target selection.

## What is local?

- Laya browser inference: local
- Playwright / Chromium control: local
- Policy and command routing: local
- STT: currently the browser Web Speech API

There is no TypeSafe/JEV API dependency, no hosted Laya inference call, and no model API key.

Speech-to-text currently uses `SpeechRecognition` / `webkitSpeechRecognition`. Depending on the browser/platform implementation, STT may use a browser-provided remote speech service and is therefore not guaranteed to work offline.

## Windows quick start

Requirements:

- Node.js >= 20
- Python available through `py`
- Chrome or Edge
- NVIDIA GPU optional but strongly recommended

```powershell
git clone https://github.com/mo-tunn/laya-voice-browser.git
cd laya-voice-browser

npm install
npm run setup:laya
npx playwright install chromium

.\run.ps1
```

You can also use:

```powershell
.\run.cmd
```

The launcher prefers port `8787`. If it is occupied, it automatically selects the next free local port and prints the control-room URL.

Pressing **Ctrl+C** shuts down the Node process and the project-owned Laya / Playwright child processes.

Open the printed control-room URL in normal Chrome or Edge and click **Start mic**.

## Local model setup

`npm run setup:laya` creates a project-local `.venv`.

On Windows with an NVIDIA driver, the setup script installs the CUDA-enabled PyTorch build when possible. To force CPU-only setup:

```powershell
$env:LAYA_SETUP_CPU=1
npm run setup:laya
```

The first model start downloads `cklxx/laya-browser` from Hugging Face. Later starts use the local cache.

Default local endpoints:

```text
control room: http://127.0.0.1:8787
model HTTP:   http://127.0.0.1:8001
model:        cklxx/laya-browser
```

The Node app starts the model bridge automatically:

```text
.venv\Scripts\python.exe scripts\laya-browser-server.py
```

## Configuration

A local `.env` file is optional.

```text
LAYA_URL=http://127.0.0.1:8001
LAYA_MODEL=cklxx/laya-browser
# LAYA_DEVICE=cuda
LAYA_AUTO_START=1
LAYA_START_TIMEOUT_MS=300000
LAYA_TIMEOUT_MS=30000

PORT=8787
HOST=127.0.0.1
```

If `LAYA_DEVICE` is omitted, the Python bridge selects CUDA when available and otherwise uses CPU.

## Example commands

| Command | Behavior |
| --- | --- |
| `go to wikipedia` | deterministic navigation |
| `open example dot com` | spoken URL normalization |
| `search for alan turing` | page search box or deterministic web search |
| `search youtube for lofi beats` | deterministic site search |
| `click the first result` | deterministic ordinal result resolution |
| `click the github link` | explicit target filtering + model fallback |
| `open the documentation` | semantic page-local target selection |
| `type hello world into the search box` | model selects field; text stays verbatim |
| `scroll down a bit` | deterministic scroll |
| `go back` / `reload` | deterministic browser control |
| `open a new tab` | deterministic tab control |
| `click place order` | destructive-action confirmation gate |

Multi-command speech is supported, for example:

```text
go to example dot com and click the more information link
```

## Why hybrid routing?

The generic Laya `typed-decisions` checkpoint is not specialized for browser element selection. On this project's 34-case browser decision suite it reached 10/34.

The browser-specialized checkpoint performs much better when it receives the observation format it was trained for:

```json
{
  "url": "https://example.com",
  "title": "Example",
  "text": "visible page text",
  "actions": [
    {
      "id": "e01",
      "node": "e01",
      "kind": "click",
      "label": "Learn more",
      "role": "link"
    }
  ]
}
```

The controller still avoids asking the model questions that code can answer exactly:

- spoken URLs and payload text remain verbatim;
- navigation/history/tab/scroll commands are closed-set;
- `first result` / `second result` are resolved deterministically;
- strong explicit element labels are resolved before fuzzy model output;
- numbered disambiguation replies do not call the model;
- destructive actions require a confirmation gate.

## Project layout

```text
src/start.js                    .env loader + app entrypoint
src/server.js                   Express / WebSocket control server
src/controller.js               streaming transcript orchestration
src/snapshot.js                 DOM perception + compact action space
src/spans.js                    deterministic text / URL extraction
src/laya.js                     hybrid command router + Laya adapter
src/laya-process.js             local model lifecycle
src/policy.js                   action / wait / confirm / disambiguate policy
src/executor.js                 Playwright execution
scripts/laya-browser-server.py  local Hugging Face model HTTP bridge
scripts/setup-laya.ps1          Windows Python / CUDA setup
run.ps1                         PowerShell launcher and process supervisor
run.cmd                         Windows convenience launcher
```

## Verification

Current local verification:

```text
unit tests:          46/46 passed
integration cases:   34/34 passed
integration rate:    100%
npm run test:all:    81/81 passed
headless demo:       16/16 passed
hosted model APIs:   0
```

On the tested RTX 3050 Ti laptop, warm page-local model decisions are generally in the tens to low hundreds of milliseconds. Deterministic global commands avoid model inference entirely.

Run the checks yourself:

```powershell
npm test
npm run test:integration
npm run test:all
npm run demo:ci
```

## Security

The control server binds to `127.0.0.1` by default.

The controlled Chromium profile persists under `.browser-profile/`.

Destructive actions have a confirmation gate, but this is still browser automation. Use a dedicated browser profile and avoid leaving sensitive sessions open unnecessarily.

The Hugging Face checkpoint is loaded with `trust_remote_code=True`. Pin a model revision if you need a fully reproducible or audited deployment.

## License and attribution

MIT licensed. The original Git history and license are retained.

Original project: [moritzkremb/jev-voice-browser](https://github.com/moritzkremb/jev-voice-browser)
