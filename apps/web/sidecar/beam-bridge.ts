/**
 * BEAM Daemon bridge — gates open-design's run/event surface behind
 * `BEAM_DAEMON_URL`. When set, `POST /api/runs`, `GET /api/runs/:id/events`,
 * and `POST /api/runs/:id/cancel` go through here instead of the JS daemon.
 *
 * What this proves: the BEAM Design Daemon at ~/code/beam-design-daemon can
 * back the existing React UI without touching any UI code — the contract
 * surface (ChatSseEvent union from `@open-design/contracts`) is the seam.
 *
 * Architecture:
 *   POST /api/runs                  → opens WS to BEAM, joins channel,
 *                                     sends run.start, returns {runId}.
 *                                     Buffers events into an in-memory queue
 *                                     keyed by runId.
 *   GET /api/runs/:id/events (SSE) → consumes the queue + live stream,
 *                                     translating Channel events to the
 *                                     ChatSseEvent shape the React UI parses.
 *   POST /api/runs/:id/cancel      → sends run.cancel and tears down.
 *
 * Zero npm deps — uses Node 22+'s built-in WebSocket, EventEmitter, fs.
 */

import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ChatSseEndPayload,
  ChatSseStartPayload,
  DaemonAgentPayload,
  SseErrorPayload,
} from "@open-design/contracts";

// ---- Config -----------------------------------------------------------------

export interface BeamBridgeConfig {
  /** ws:// URL for the BEAM daemon's Phoenix socket (e.g. ws://127.0.0.1:4000/socket/websocket). */
  daemonUrl: string;
  /** Phoenix Channel topic suffix; the daemon's workspace_id. */
  workspaceId: string;
  /** Path to the BEAM daemon's auth token file (mode 0600). */
  tokenPath: string;
  /** How long to retain a completed run's buffered events (ms). */
  retentionMs: number;
  /**
   * Optional agent override. When set, forces every run through this BEAM
   * agent regardless of what the React UI picked. Useful when the JS
   * daemon's `/api/agents` only advertises CLI agents (claude/codex/etc.)
   * and the operator wants HTTP-only paths like `deepinfra`.
   */
  agentOverride: string | null;
  /**
   * Tier-aware default models. When the request carries image attachments,
   * `modelVision` is used; otherwise `modelText`. The legacy `BEAM_MODEL`
   * env var still works as a tier-agnostic default — it populates both
   * tiers if neither `BEAM_MODEL_TEXT` nor `BEAM_MODEL_VISION` are set.
   *
   * "Right model at the right time": pay $0.88/1M output for a vision
   * flagship only when the request actually includes an image; fall back
   * to a cheap text model (e.g. DeepSeek-V3.2 at $0.38/1M) for plain
   * text chats.
   */
  modelText: string | null;
  modelVision: string | null;
  /**
   * Roots used to resolve relative attachment paths into absolute file
   * paths the bridge can read. Falls back to the sidecar's cwd.
   */
  attachmentRoots: string[];
  /** Hard cap on a single attached image's bytes after read (defends the model + the channel payload). */
  maxImageBytes: number;
}

export function configFromEnv(): BeamBridgeConfig | null {
  const daemonUrl = process.env.BEAM_DAEMON_URL;
  if (daemonUrl == null || daemonUrl === "") return null;
  const legacy = process.env.BEAM_MODEL?.trim() || null;
  const text = process.env.BEAM_MODEL_TEXT?.trim() || legacy;
  const vision = process.env.BEAM_MODEL_VISION?.trim() || legacy;
  const roots = (process.env.BEAM_ATTACHMENT_ROOTS || "")
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    daemonUrl,
    workspaceId: process.env.BEAM_WORKSPACE_ID || "open-design",
    tokenPath:
      process.env.BEAM_DESIGN_TOKEN_PATH ||
      join(homedir(), ".beam-design", "auth-token"),
    retentionMs: 5 * 60_000,
    agentOverride: process.env.BEAM_AGENT_ID?.trim() || null,
    modelText: text,
    modelVision: vision,
    attachmentRoots: roots.length > 0 ? roots : [process.cwd()],
    maxImageBytes: Number(process.env.BEAM_MAX_IMAGE_BYTES || 5 * 1024 * 1024),
  };
}

function readToken(path: string): string {
  return readFileSync(path, "utf8").trim();
}

// ---- Run registry -----------------------------------------------------------

interface BeamRun {
  runId: string;
  ws: WebSocket;
  emitter: EventEmitter;
  // Replayable buffer so a late `/events` subscriber doesn't miss the start.
  buffer: Array<{ event: string; payload: unknown }>;
  terminal: ChatSseEndPayload | null;
  startedAt: number;
}

const runs = new Map<string, BeamRun>();

function reapStale(retentionMs: number): void {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (run.terminal != null && now - run.startedAt > retentionMs) {
      runs.delete(id);
    }
  }
}

// ---- Phoenix v2 channel helpers --------------------------------------------

interface PhoenixFrame {
  joinRef: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}

function frameToWire(frame: PhoenixFrame): string {
  return JSON.stringify([frame.joinRef, frame.ref, frame.topic, frame.event, frame.payload]);
}

function wireToFrame(raw: string): PhoenixFrame | null {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 5) return null;
    return { joinRef: arr[0], ref: arr[1], topic: arr[2], event: arr[3], payload: arr[4] };
  } catch {
    return null;
  }
}

// ---- BEAM event → ChatSseEvent translation ---------------------------------

function translateBeamPayload(beamEvent: string, payload: any):
  | { sseEvent: "agent"; data: DaemonAgentPayload }
  | { sseEvent: "stdout"; data: { chunk: string } }
  | { sseEvent: "stderr"; data: { chunk: string } }
  | { sseEvent: "end"; data: ChatSseEndPayload }
  | { sseEvent: "error"; data: SseErrorPayload }
  | null {
  switch (beamEvent) {
    case "run.output": {
      const kind = payload?.kind;
      const delta = String(payload?.delta ?? "");
      if (kind === "agent" || kind === "text") {
        return { sseEvent: "agent", data: { type: "text_delta", delta } };
      }
      if (kind === "status") {
        return { sseEvent: "agent", data: { type: "status", label: delta.trim() || "running" } };
      }
      if (kind === "stderr") {
        return { sseEvent: "stderr", data: { chunk: delta } };
      }
      // stdout / unknown → fall back to stdout
      return { sseEvent: "stdout", data: { chunk: delta } };
    }
    case "run.terminal": {
      const status: ChatSseEndPayload["status"] =
        payload?.status === "succeeded"
          ? "succeeded"
          : payload?.status === "cancelled"
            ? "canceled"
            : "failed";
      return {
        sseEvent: "end",
        data: { code: typeof payload?.exit === "number" ? payload.exit : null, status },
      };
    }
    default:
      return null;
  }
}

// ---- POST /api/runs handler ------------------------------------------------

interface ChatRequestLike {
  agentId?: string;
  message?: string;
  skillId?: string | null;
  designSystemId?: string | null;
  model?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  /**
   * Mirrors `ChatRequest.attachments` from `@open-design/contracts`: a
   * list of paths (absolute or root-relative) to files attached by the
   * user. The bridge reads image entries off disk and forwards them as
   * inline base64 image blocks so vision models can see them.
   */
  attachments?: string[];
}

const AGENT_ID_TO_BEAM: Record<string, string> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  anthropic: "claude-code",
  deepinfra: "deepinfra",
};

function mapAgentId(agentId: string | undefined, override: string | null): string {
  if (override != null && override !== "") return override;
  return (agentId && AGENT_ID_TO_BEAM[agentId]) || "claude-code";
}

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

interface BridgeImage {
  base64: string;
  mime: string;
}

/**
 * Resolve a user-attached file path into an absolute path the bridge can
 * read. Tries (in order): absolute as given, each `attachmentRoots`
 * entry. Returns null if no candidate resolves to an existing file —
 * caller logs and skips.
 */
function resolveAttachmentPath(p: string, roots: string[]): string | null {
  if (isAbsolute(p)) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      return null;
    }
    return null;
  }
  for (const root of roots) {
    const abs = resolve(root, p);
    try {
      if (statSync(abs).isFile()) return abs;
    } catch {
      // try next root
    }
  }
  return null;
}

/**
 * Read attachment paths off disk and keep only the image entries. Files
 * exceeding `maxImageBytes` are skipped (not an error — the model can
 * still respond on text alone). Non-image extensions are also skipped:
 * the bridge today only forwards visual context to vision models, not
 * raw documents (PDF/DOCX), since BEAM's deepinfra adapter speaks
 * OpenAI's chat-completions image_url shape and not the file-input
 * extension.
 */
function readImageAttachments(
  paths: readonly string[],
  roots: string[],
  maxImageBytes: number,
): BridgeImage[] {
  const out: BridgeImage[] = [];
  for (const raw of paths) {
    const ext = extname(raw).toLowerCase();
    const mime = IMAGE_EXT_TO_MIME[ext];
    if (mime == null) continue;
    const abs = resolveAttachmentPath(raw, roots);
    if (abs == null) {
      console.warn(`[beam-bridge] attachment not found, skipping: ${raw}`);
      continue;
    }
    try {
      const bytes = readFileSync(abs);
      if (bytes.length > maxImageBytes) {
        console.warn(
          `[beam-bridge] attachment ${raw} (${bytes.length} bytes) exceeds BEAM_MAX_IMAGE_BYTES=${maxImageBytes}, skipping`,
        );
        continue;
      }
      out.push({ base64: bytes.toString("base64"), mime });
    } catch (err) {
      console.warn(`[beam-bridge] failed to read attachment ${raw}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Pick the model based on whether the request carries images:
 *   - request.model (UI explicit) wins outright if set
 *   - else BEAM_MODEL_VISION when there are images
 *   - else BEAM_MODEL_TEXT
 *   - else null (BEAM falls back to its own default model)
 */
function pickModel(
  config: BeamBridgeConfig,
  bodyModel: string | null | undefined,
  hasImages: boolean,
): string | null {
  if (bodyModel != null && bodyModel !== "") return bodyModel;
  return hasImages ? config.modelVision : config.modelText;
}

async function readJsonBody(req: IncomingMessage): Promise<ChatRequestLike> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequestLike;
  } catch {
    return {};
  }
}

function generateRunId(): string {
  return "beam_" + Math.random().toString(16).slice(2, 18);
}

export async function handleBeamRunStart(
  config: BeamBridgeConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  reapStale(config.retentionMs);
  const body = await readJsonBody(req);
  const runId = generateRunId();
  const beamAgent = mapAgentId(body.agentId, config.agentOverride);
  const images = readImageAttachments(
    body.attachments ?? [],
    config.attachmentRoots,
    config.maxImageBytes,
  );
  const beamModel = pickModel(config, body.model, images.length > 0);

  let token: string;
  try {
    token = readToken(config.tokenPath);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: { code: "BEAM_AUTH_TOKEN_MISSING", message: `${config.tokenPath}: ${(err as Error).message}` },
      }),
    );
    return;
  }

  const url = `${config.daemonUrl}?token=${encodeURIComponent(token)}&vsn=2.0.0`;
  const topic = `design:v1:${config.workspaceId}`;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: { code: "BEAM_CONNECT_FAILED", message: (err as Error).message },
      }),
    );
    return;
  }

  const emitter = new EventEmitter();
  const run: BeamRun = {
    runId,
    ws,
    emitter,
    buffer: [],
    terminal: null,
    startedAt: Date.now(),
  };
  runs.set(runId, run);

  // Emit a synthetic `start` event immediately so a fast `/events` consumer
  // sees the run shape before any agent output arrives.
  const startPayload: ChatSseStartPayload = {
    runId,
    agentId: beamAgent,
    bin: beamAgent === "claude-code" ? "claude" : beamAgent,
    cwd: null,
    projectId: body.projectId ?? null,
    model: beamModel ?? null,
  };
  run.buffer.push({ event: "start", payload: startPayload });
  emitter.emit("sse", { event: "start", payload: startPayload });

  let nextRef = 1;
  const send = (event: string, payload: Record<string, unknown>): string => {
    const ref = String(nextRef++);
    ws.send(frameToWire({ joinRef: "1", ref, topic, event, payload }));
    return ref;
  };

  let joined = false;

  ws.addEventListener("open", () => {
    ws.send(frameToWire({ joinRef: "1", ref: String(nextRef++), topic, event: "phx_join", payload: {} }));
  });

  ws.addEventListener("message", (msg) => {
    const frame = wireToFrame(typeof msg.data === "string" ? msg.data : String(msg.data));
    if (frame == null) return;

    if (frame.event === "phx_reply") {
      if (!joined) {
        if ((frame.payload as any)?.status === "ok") {
          joined = true;
          send("run.start", {
            skill_id: body.skillId ?? "html-ppt",
            design_system_id: body.designSystemId ?? "obsidian-claude-gradient",
            prompt: body.message ?? "",
            agent: beamAgent,
            ...(beamModel ? { model: beamModel } : {}),
            ...(images.length > 0 ? { images } : {}),
          });
        } else {
          terminate(run, {
            code: -1,
            status: "failed",
          });
        }
      }
      return;
    }

    const translated = translateBeamPayload(frame.event, frame.payload);
    if (translated == null) return;

    run.buffer.push({ event: translated.sseEvent, payload: translated.data });
    emitter.emit("sse", { event: translated.sseEvent, payload: translated.data });

    if (translated.sseEvent === "end") {
      terminate(run, translated.data);
    }
  });

  ws.addEventListener("error", (err: any) => {
    terminate(run, { code: -1, status: "failed" });
    const message = err?.message ?? String(err);
    const errorPayload: SseErrorPayload = {
      message,
      error: { code: "UPSTREAM_UNAVAILABLE", message },
    };
    run.buffer.push({ event: "error", payload: errorPayload });
    emitter.emit("sse", { event: "error", payload: errorPayload });
  });

  ws.addEventListener("close", () => {
    if (run.terminal == null) {
      terminate(run, { code: -1, status: "failed" });
    }
  });

  // Mirror the JS daemon's contract: synchronous 202 with the runId.
  res.statusCode = 202;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ runId }));
}

function terminate(run: BeamRun, payload: ChatSseEndPayload): void {
  if (run.terminal != null) return;
  run.terminal = payload;
  // Don't push another `end` if the translator already did.
  // Caller is responsible for the bookkeeping.
  try {
    run.ws.close(1000, "run-terminal");
  } catch {
    // ignore
  }
}

// ---- GET /api/runs/:id/events handler --------------------------------------

function writeSseFrame(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function handleBeamRunEvents(
  _config: BeamBridgeConfig,
  runId: string,
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const run = runs.get(runId);
  if (run == null) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: `unknown runId: ${runId}` } }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();

  // Replay buffered events (start, any agent/output already received).
  for (const entry of run.buffer) {
    writeSseFrame(res, entry.event, entry.payload);
  }

  if (run.terminal != null) {
    res.end();
    return;
  }

  const onSse = (entry: { event: string; payload: unknown }) => {
    writeSseFrame(res, entry.event, entry.payload);
    if (entry.event === "end") {
      run.emitter.off("sse", onSse);
      res.end();
    }
  };

  run.emitter.on("sse", onSse);

  // Cleanup on client disconnect.
  res.on("close", () => {
    run.emitter.off("sse", onSse);
  });
}

// ---- POST /api/runs/:id/cancel handler -------------------------------------

export function handleBeamRunCancel(
  _config: BeamBridgeConfig,
  runId: string,
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const run = runs.get(runId);
  if (run == null) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: `unknown runId: ${runId}` } }));
    return;
  }

  // Best-effort cancel; v1 of the BEAM channel returns not_yet_implemented
  // for run.cancel (U7 follow-up). Closing the socket is the safe fallback.
  try {
    run.ws.close(1000, "client-cancel");
  } catch {
    // ignore
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}

// ---- Routing helper --------------------------------------------------------

export interface BeamBridgeRouteMatch {
  kind: "start" | "events" | "cancel";
  runId?: string;
}

export function matchBeamBridgeRoute(method: string | undefined, pathname: string): BeamBridgeRouteMatch | null {
  if (method === "POST" && pathname === "/api/runs") return { kind: "start" };
  const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname);
  if (method === "GET" && eventsMatch?.[1]) return { kind: "events", runId: decodeURIComponent(eventsMatch[1]) };
  const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(pathname);
  if (method === "POST" && cancelMatch?.[1]) return { kind: "cancel", runId: decodeURIComponent(cancelMatch[1]) };
  return null;
}
