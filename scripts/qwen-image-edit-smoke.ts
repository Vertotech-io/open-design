#!/usr/bin/env node
/**
 * Smoke test for the DeepInfra Qwen-Image-Edit i2i path.
 *
 * Drives the same daemon route the React UI's "Image" tab hits
 * (POST /api/projects/:id/media/generate, then poll /api/media/tasks/
 * :id/wait), but as a one-shot CLI so the wire shape can be exercised
 * without clicking through the UI. Use this when:
 *
 *   * `apps/daemon/src/media.ts:renderDeepInfraImage` is changed
 *   * the request/response shape needs to be re-verified after a
 *     DeepInfra API change
 *   * the UI itself is broken and you need to triage daemon-vs-frontend
 *
 * Mirrors the existing scripts/beam-bridge-smoke.ts style: zero new
 * dependencies, debug scaffolding (per the standing rule, not part of
 * any release).
 *
 * Required env:
 *   DEEPINFRA_API_KEY        — read by the daemon's media-config from
 *                              env or Keychain export. Must be set.
 *
 * Optional env:
 *   OD_DAEMON_URL            — default http://127.0.0.1:17456 (matches
 *                              tools-dev's default daemon port)
 *
 * Usage:
 *   node scripts/qwen-image-edit-smoke.mjs --image /abs/path/age-verify.png
 *   node scripts/qwen-image-edit-smoke.mjs --image ref.png --template prompt-templates/image/illustration-crayon-kid-drawing-rework.json
 *   node scripts/qwen-image-edit-smoke.mjs --image ref.png --prompt "rework this into 8-bit pixel art"
 *
 * What it does:
 *   1. Loads the prompt — from --prompt, or from --template's `prompt`
 *      field, defaulting to the crayon-rework template that ships in
 *      this repo.
 *   2. Creates a fresh Open Design project (image surface) via
 *      POST /api/projects.
 *   3. Copies the reference image into the project's working directory
 *      under .od/projects/<id>/ so the daemon's resolveProjectImage
 *      sandbox check is happy (i2i requires a path inside the project
 *      tree, not an absolute path elsewhere on disk).
 *   4. POSTs /api/projects/<id>/media/generate with
 *      model=qwen-image-edit and the project-relative image path.
 *   5. Polls /api/media/tasks/<taskId>/wait until status==='done' or
 *      'failed', surfacing daemon-side progress lines as they land.
 *   6. Prints the resulting artifact path and `open`s it on macOS.
 */
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, basename, join, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';

// -------- args ----------------------------------------------------------

interface SmokeArgs {
  image: string | null;
  template: string | null;
  prompt: string | null;
  name: string | null;
  aspect: string;
  /** Daemon model id from IMAGE_MODELS where provider==='deepinfra'. */
  model: string;
}

function parseArgs(argv: string[]): SmokeArgs {
  const out: SmokeArgs = {
    image: null,
    template: null,
    prompt: null,
    name: null,
    aspect: '4:3',
    model: 'wan-2.7-image-edit',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write(`error: ${a} requires a value\n`);
        process.exit(2);
      }
      return v;
    };
    if (a === '--image') out.image = next();
    else if (a === '--template') out.template = next();
    else if (a === '--prompt') out.prompt = next();
    else if (a === '--name') out.name = next();
    else if (a === '--aspect') out.aspect = next();
    else if (a === '--model') out.model = next();
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: node --experimental-strip-types scripts/qwen-image-edit-smoke.ts [--model <id>] [--image <path>] [--template <json>] [--prompt <str>] [--name <str>] [--aspect 4:3]\n' +
          '\n' +
          '--image is required for i2i models (wan-2.7-image-edit, qwen-image-edit).\n' +
          '--image is forbidden for t2i models (qwen-image-max).\n' +
          'Default --model is wan-2.7-image-edit. Set --model qwen-image-max for prompt-only generation.\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const DEFAULT_TEMPLATE = join(
  REPO_ROOT,
  'prompt-templates/image/illustration-crayon-kid-drawing-rework.json',
);
const DAEMON_URL = (process.env.OD_DAEMON_URL || 'http://127.0.0.1:17456').replace(/\/$/, '');

const args = parseArgs(process.argv.slice(2));

// Mirror the daemon's DEEPINFRA_IMAGE_MODELS mode field. Kept in sync
// by hand; if the daemon adds a new model, add it here too or the
// smoke will reject it.
const I2I_MODELS = new Set(['wan-2.7-image-edit', 'qwen-image-edit']);
const T2I_MODELS = new Set(['qwen-image-max', 'flux-2-klein-4b', 'flux-2-pro', 'seedream-4']);

if (I2I_MODELS.has(args.model) && !args.image) {
  process.stderr.write(
    `error: model ${args.model} is i2i; --image <path> is required (any reference image)\n`,
  );
  process.exit(2);
}
if (T2I_MODELS.has(args.model) && args.image) {
  process.stderr.write(
    `error: model ${args.model} is t2i; --image is not accepted (omit --image to generate from prompt alone)\n`,
  );
  process.exit(2);
}
if (!I2I_MODELS.has(args.model) && !T2I_MODELS.has(args.model)) {
  process.stderr.write(
    `error: unknown --model "${args.model}" (known: ${[...I2I_MODELS, ...T2I_MODELS].join(', ')})\n`,
  );
  process.exit(2);
}

let imageAbs: string | null = null;
if (args.image) {
  imageAbs = isAbsolute(args.image) ? args.image : resolve(process.cwd(), args.image);
  if (!existsSync(imageAbs)) {
    process.stderr.write(`error: --image not found: ${imageAbs}\n`);
    process.exit(2);
  }
}

// -------- prompt --------------------------------------------------------

let prompt = args.prompt;
let templateMeta = null;
if (!prompt) {
  const templatePath = args.template
    ? (isAbsolute(args.template) ? args.template : resolve(process.cwd(), args.template))
    : DEFAULT_TEMPLATE;
  const raw = readFileSync(templatePath, 'utf8');
  templateMeta = JSON.parse(raw);
  if (typeof templateMeta.prompt !== 'string' || !templateMeta.prompt.trim()) {
    process.stderr.write(`error: template ${templatePath} has no usable "prompt" field\n`);
    process.exit(2);
  }
  prompt = templateMeta.prompt;
}

// -------- daemon API helpers --------------------------------------------

async function apiPost(path: string, body: unknown): Promise<any> {
  const resp = await fetch(`${DAEMON_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`POST ${path} ${resp.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// -------- step 1: create project ---------------------------------------

/**
 * Build a filesystem-friendly slug from a free-form name. The daemon's
 * project ID regex accepts [A-Za-z0-9._-]{1,128} (apps/daemon/src/
 * server.ts:643), so the slug is lowercased, non-alphanumerics become
 * hyphens, runs collapse, and the result is truncated. The slug goes
 * BEFORE the timestamp so `ls .od/projects/qwen-img-smoke-*xkcd-2*`
 * works without a SQLite lookup; the timestamp suffix preserves
 * chronological sort order at the end of the name.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

const projectName = args.name || (templateMeta?.title
  ? `${templateMeta.title} smoke`
  : 'Qwen-Image-Edit smoke test');
const slug = slugify(projectName);
const ts = Date.now().toString(36);
const projectId = slug
  ? `qwen-img-smoke-${slug}-${ts}`
  : `qwen-img-smoke-${ts}`;

process.stderr.write(`[1/5] creating project ${projectId} (${projectName})\n`);

await apiPost('/api/projects', {
  id: projectId,
  name: projectName,
  // Pick an image-mode-compatible skill so the project metadata stays
  // sensible in the UI; the smoke doesn't actually go through the
  // skill-driven chat path (it goes straight to /api/.../media/generate).
  metadata: { kind: 'image' },
});

// -------- step 2: stage reference into project dir (i2i only) ---------

const projectDir = join(REPO_ROOT, '.od', 'projects', projectId);
mkdirSync(projectDir, { recursive: true });

let refName: string | null = null;
if (imageAbs) {
  refName = basename(imageAbs);
  copyFileSync(imageAbs, join(projectDir, refName));
  process.stderr.write(`[2/5] staged reference ${refName}\n`);
} else {
  process.stderr.write(`[2/5] t2i model — no reference staged\n`);
}

// -------- step 3: kick off generation ----------------------------------

process.stderr.write(`[3/5] POST /api/projects/${projectId}/media/generate (model=${args.model}, aspect=${args.aspect})\n`);

const genReqBody: Record<string, unknown> = {
  surface: 'image',
  model: args.model,
  prompt,
  aspect: args.aspect,
};
if (refName) genReqBody.image = refName; // project-relative; daemon enforces in-project sandbox
const genResp = await apiPost(`/api/projects/${projectId}/media/generate`, genReqBody);

const taskId = genResp.taskId;
if (!taskId) {
  process.stderr.write(`error: response missing taskId: ${JSON.stringify(genResp)}\n`);
  process.exit(1);
}

process.stderr.write(`[4/5] polling task ${taskId.slice(0, 8)}...\n`);

// -------- step 4: poll ---------------------------------------------------

let since = 0;
let lastStatus = '';
const startedAt = Date.now();
// Hard cap so a stuck DeepInfra call doesn't make this run forever.
const MAX_WALL_MS = 5 * 60_000;

let final: any = null;
while (true) {
  if (Date.now() - startedAt > MAX_WALL_MS) {
    throw new Error(`smoke test timed out after ${(MAX_WALL_MS / 1000) | 0}s`);
  }
  const snapshot = await apiPost(`/api/media/tasks/${taskId}/wait`, { since, timeoutMs: 25000 });
  for (const line of snapshot.progress || []) {
    process.stderr.write(`  · ${line}\n`);
  }
  since = snapshot.nextSince ?? since;
  if (snapshot.status !== lastStatus) {
    process.stderr.write(`  status: ${snapshot.status}\n`);
    lastStatus = snapshot.status;
  }
  if (snapshot.status === 'done' || snapshot.status === 'failed') {
    final = snapshot;
    break;
  }
}

// -------- step 5: report -----------------------------------------------

if (final.status === 'failed') {
  process.stderr.write(`\n[5/5] FAILED: ${JSON.stringify(final.error, null, 2)}\n`);
  process.exit(1);
}

const file = final.file || {};
const elapsedSec = ((final.endedAt - final.startedAt) / 1000).toFixed(1);
process.stderr.write(`\n[5/5] done in ${elapsedSec}s\n`);
process.stdout.write(JSON.stringify({ projectId, taskId, file, prompt: prompt.slice(0, 80) + '…' }, null, 2) + '\n');

// On macOS, open the resulting artifact for visual check.
if (process.platform === 'darwin' && file.path) {
  const artifactAbs = isAbsolute(file.path) ? file.path : join(REPO_ROOT, file.path);
  if (existsSync(artifactAbs)) {
    spawn('open', [artifactAbs], { stdio: 'ignore', detached: true }).unref();
    process.stderr.write(`opened ${artifactAbs}\n`);
  }
}
