import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const SIDECAR_URL = process.env.DESIGN_LAB_SIDECAR_URL ?? 'http://127.0.0.1:5174';
const TOKEN_PATH = `${homedir()}/.claude/state/design-lab/api-token`;

export interface DesignLabContext {
    client?: unknown;
    cases?: unknown[];
    styleGuide?: unknown;
}

function readDesignLabToken(): string | null {
    try {
        const token = readFileSync(TOKEN_PATH, 'utf8').trim();
        return token.length > 0 ? token : null;
    } catch {
        return null;
    }
}

async function fetchContextOnce(url: URL, token: string): Promise<Response> {
    return fetch(url, {
        headers: {
            'Accept': 'application/json',
            'X-Design-Lab-Token': token
        }
    });
}

export async function loadDesignLabContext(input: {
    client?: string;
    scenario?: string;
}): Promise<DesignLabContext | null> {
    const url = new URL('/api/context', SIDECAR_URL);
    if (input.client) url.searchParams.set('client', input.client);
    if (input.scenario) url.searchParams.set('scenario', input.scenario);

    let token = readDesignLabToken();
    if (!token) return null;

    try {
        let resp = await fetchContextOnce(url, token);

        if (resp.status === 401) {
            // Token rotated after sidecar cold spawn. Re-read once, then fail soft.
            token = readDesignLabToken();
            if (!token) return null;
            resp = await fetchContextOnce(url, token);
        }

        if (!resp.ok) return null;
        return await resp.json() as DesignLabContext;
    } catch {
        return null;
    }
}

export async function buildGenerationPrompt(basePrompt: string, input: {
    client?: string;
    scenario?: string;
}): Promise<string> {
    const context = await loadDesignLabContext(input);
    if (!context) {
        return basePrompt; // fallback to no-memory generation
    }

    return [
        basePrompt,
        '',
        'Use this design-lab memory context as preference evidence:',
        JSON.stringify(context, null, 2)
    ].join('\n');
}
