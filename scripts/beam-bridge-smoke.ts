#!/usr/bin/env bun
// BEAM bridge smoke test — verifies apps/web/sidecar/beam-bridge.ts works
// end-to-end without needing the full Next.js sidecar mount (which is
// blocked by the pnpm engine pin on this user's box).
//
// Spins up a tiny http.createServer that mounts the same bridge handlers
// startWebSidecar wires in `feat/beam-react-bridge`, then issues the
// React UI's two-call sequence (POST /api/runs → GET /api/runs/:id/events)
// against it and verifies the SSE shape matches what apps/web/src/providers/
// daemon.ts expects.
//
// Usage:
//   1. Start the BEAM daemon pointed at the open-design tree:
//        cd ~/code/beam-design-daemon
//        BEAM_DESIGN_WORKSPACE_DIR=/Users/jwen/workspace/ml/open-design \
//          mix run --no-halt
//   2. Run this smoke test:
//        BEAM_DAEMON_URL=ws://127.0.0.1:4000/socket/websocket \
//          bun scripts/beam-bridge-smoke.ts
//
// Bun is required (Node would need the project's full pnpm install
// because the bridge imports types from @open-design/contracts; Bun's
// native `import type` erasure sidesteps that).

import { createServer } from "node:http";

const {
  configFromEnv,
  handleBeamRunStart,
  handleBeamRunEvents,
  matchBeamBridgeRoute,
} = await import("../apps/web/sidecar/beam-bridge.ts");

const config = configFromEnv();
if (config == null) {
  console.error("✗ BEAM_DAEMON_URL is not set; cannot run smoke test.");
  process.exit(2);
}

console.log(`→ bridge config: daemonUrl=${config.daemonUrl} workspace=${config.workspaceId}`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const match = matchBeamBridgeRoute(req.method, url.pathname);
  if (match == null) {
    res.statusCode = 404;
    res.end(`no bridge route for ${req.method} ${url.pathname}`);
    return;
  }
  try {
    if (match.kind === "start") return await handleBeamRunStart(config, req, res);
    if (match.kind === "events") return handleBeamRunEvents(config, match.runId, req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain");
    }
    res.end(`bridge error: ${err?.message ?? String(err)}`);
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`✓ bridge harness listening at ${base}\n`);

// --- Step 1: POST /api/runs (mirrors apps/web/src/providers/daemon.ts) ---

const reqBody = {
  agentId: process.env.BEAM_AGENT_ID || "claude-code",
  message: process.env.BEAM_MESSAGE || "Reply with the single word PONG and nothing else.",
  skillId: process.env.BEAM_SKILL_ID || "html-ppt",
  designSystemId: process.env.BEAM_DESIGN_SYSTEM_ID || "agentic",
  projectId: "smoke-test",
  conversationId: "smoke-test-conv",
  assistantMessageId: "smoke-test-msg",
  clientRequestId: "smoke-test-req",
};

const createResp = await fetch(`${base}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(reqBody),
});

if (!createResp.ok) {
  console.error(`✗ POST /api/runs failed: ${createResp.status} ${await createResp.text()}`);
  server.close();
  process.exit(3);
}

const { runId } = await createResp.json();
console.log(`✓ POST /api/runs → 202 runId=${runId}`);

// --- Step 2: GET /api/runs/:id/events (SSE consumer, mirrors React UI) ---

const eventsResp = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events`);
if (!eventsResp.ok) {
  console.error(`✗ GET /api/runs/${runId}/events failed: ${eventsResp.status}`);
  server.close();
  process.exit(4);
}
console.log(`✓ GET /api/runs/${runId}/events → 200 ${eventsResp.headers.get("content-type")}\n`);

const reader = eventsResp.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let sawStart = false;
let sawEnd = false;
let agentTextLen = 0;
let stdoutLen = 0;
const STALL_MS = parseInt(process.env.BEAM_STALL_TIMEOUT_MS ?? "30000", 10);
const stallTimer = setTimeout(() => {
  console.error(`✗ stalled waiting for SSE end (${STALL_MS}ms)`);
  process.exit(7);
}, STALL_MS);

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const lines = frame.split("\n");
    let event = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event === "") continue;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      payload = data;
    }

    switch (event) {
      case "start":
        sawStart = true;
        console.log(
          `← start runId=${payload.runId} agentId=${payload.agentId} bin=${payload.bin}`,
        );
        break;
      case "agent": {
        const t = payload?.type;
        if (t === "text_delta") {
          agentTextLen += String(payload.delta ?? "").length;
          process.stdout.write(payload.delta ?? "");
        } else if (t === "status") {
          console.log(`\n← agent status="${payload.label}"`);
        } else {
          console.log(`← agent ${t}: ${JSON.stringify(payload).slice(0, 80)}`);
        }
        break;
      }
      case "stdout":
        stdoutLen += String(payload?.chunk ?? "").length;
        process.stdout.write(payload?.chunk ?? "");
        break;
      case "stderr":
        process.stderr.write(payload?.chunk ?? "");
        break;
      case "error":
        console.log(`\n← error code=${payload.code} message=${payload.message}`);
        break;
      case "end":
        sawEnd = true;
        console.log(`\n← end status=${payload.status} code=${payload.code}`);
        break;
      default:
        console.log(`← (unknown event ${event}): ${data.slice(0, 80)}`);
    }
  }

  if (sawEnd) break;
}

clearTimeout(stallTimer);
server.close();

// --- Verification ---

const ok = sawStart && sawEnd;
console.log(
  `\nsummary: start=${sawStart} end=${sawEnd} agent_text_chars=${agentTextLen} stdout_chars=${stdoutLen}`,
);
console.log(ok ? "\n✓ Bridge smoke test passed." : "\n✗ Bridge smoke test FAILED.");
process.exit(ok ? 0 : 1);
