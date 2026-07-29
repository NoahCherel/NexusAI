/**
 * Server-side character-card importer: POST { url } → { card, avatarDataUrl? }.
 *
 * Runs on the local Next server (the user's own machine → residential IP), which is what
 * lets the JannyAI download API through Cloudflare Bot Fight Mode, and sidesteps CORS for
 * every platform. Endpoint patterns follow SillyTavern's importers. Would NOT survive a
 * datacenter deployment (Cloudflare blocks cloud IPs) — this app is local-first.
 */

import { NextRequest } from 'next/server';
import { detectImportUrl, type DetectedImport } from '@/lib/import/url-detector';
import { parseCharacterCardPNGBuffer, normalizeCharacterCard } from '@/lib/character-parser';
import type { CharacterCard } from '@/types/character';

export const runtime = 'nodejs';

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB guard

// A realistic browser UA helps with bot-gated CDNs; harmless elsewhere.
const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: '*/*',
};

class ImportError extends Error {
    constructor(
        message: string,
        public kind: 'cloudflare' | 'not_found' | 'bad_response' = 'bad_response'
    ) {
        super(message);
    }
}

function assertNotBlocked(res: Response, platform: string): void {
    if (res.status === 403 || res.headers.get('cf-mitigated')) {
        throw new ImportError(
            `${platform} a bloqué la requête (Cloudflare). Réessayez dans un moment, ou téléchargez la carte (PNG) manuellement et glissez-la dans l'importeur.`,
            'cloudflare'
        );
    }
    if (res.status === 404) {
        throw new ImportError('Carte introuvable (supprimée ou privée).', 'not_found');
    }
}

async function fetchBuffer(url: string, platform: string): Promise<ArrayBuffer> {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
    assertNotBlocked(res, platform);
    if (!res.ok) throw new ImportError(`${platform}: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_DOWNLOAD_BYTES) throw new ImportError('Fichier trop volumineux.');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new ImportError('Fichier trop volumineux.');
    return buf;
}

function pngToResult(buf: ArrayBuffer): { card: CharacterCard; avatarDataUrl: string } {
    const card = parseCharacterCardPNGBuffer(buf);
    const avatarDataUrl = `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
    return { card, avatarDataUrl };
}

async function importJannyAI(id: string) {
    const res = await fetch('https://api.jannyai.com/api/v1/download', {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId: id }),
    });
    assertNotBlocked(res, 'JannyAI');
    if (!res.ok) throw new ImportError(`JannyAI: HTTP ${res.status}`);
    const data = (await res.json()) as { status?: string; downloadUrl?: string; error?: string };
    if (data.status !== 'ok' || !data.downloadUrl) {
        throw new ImportError(`JannyAI: ${data.error || 'carte introuvable'}`, 'not_found');
    }
    return pngToResult(await fetchBuffer(data.downloadUrl, 'JannyAI'));
}

async function importChub(id: string) {
    // Preferred: the official card download (a standard tavern PNG).
    const dl = await fetch('https://api.chub.ai/api/characters/download', {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'tavern', fullPath: id }),
    });
    if (dl.ok) {
        const buf = await dl.arrayBuffer();
        if (buf.byteLength <= MAX_DOWNLOAD_BYTES) {
            try {
                return pngToResult(buf);
            } catch {
                /* fall through to the JSON metadata endpoint */
            }
        }
    }

    // Fallback: project metadata (JSON), mapped by hand.
    const res = await fetch(`https://api.chub.ai/api/characters/${id}?full=true`, {
        headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
    });
    assertNotBlocked(res, 'Chub');
    if (!res.ok) throw new ImportError(`Chub: HTTP ${res.status}`);
    const json = (await res.json()) as {
        node?: { definition?: Record<string, unknown>; avatar_url?: string };
    };
    const def = json.node?.definition;
    if (!def) throw new ImportError('Chub: définition de carte absente.', 'not_found');
    const card = normalizeCharacterCard({
        ...def,
        first_mes: def.first_message ?? def.first_mes,
        mes_example: def.example_dialogs ?? def.mes_example,
    });
    let avatarDataUrl: string | undefined;
    if (json.node?.avatar_url) {
        try {
            const buf = await fetchBuffer(json.node.avatar_url, 'Chub');
            avatarDataUrl = `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
        } catch {
            /* avatar is optional */
        }
    }
    return { card, avatarDataUrl };
}

async function importPygmalion(id: string) {
    const res = await fetch(`https://server.pygmalion.chat/api/export/character/${id}/v2`, {
        headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
    });
    assertNotBlocked(res, 'Pygmalion');
    if (!res.ok) throw new ImportError(`Pygmalion: HTTP ${res.status}`);
    const json = (await res.json()) as { character?: Record<string, unknown> };
    if (!json.character) throw new ImportError('Pygmalion: carte introuvable.', 'not_found');
    const card = normalizeCharacterCard(json.character);
    // The V2 envelope's data.avatar may be a URL — inline it.
    let avatarDataUrl: string | undefined;
    const avatar = (json.character as { data?: { avatar?: string } }).data?.avatar;
    if (avatar && /^https?:\/\//.test(avatar)) {
        try {
            const buf = await fetchBuffer(avatar, 'Pygmalion');
            avatarDataUrl = `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
        } catch {
            /* avatar is optional */
        }
    }
    return { card, avatarDataUrl };
}

async function importRisuAI(id: string) {
    const buf = await fetchBuffer(
        `https://realm.risuai.net/api/v1/download/png-v3/${id}?non_commercial=true`,
        'RisuAI'
    );
    return pngToResult(buf);
}

async function importAICC(id: string) {
    const buf = await fetchBuffer(
        `https://aicharactercards.com/wp-json/pngapi/v1/image/${id}`,
        'AICharacterCards'
    );
    return pngToResult(buf);
}

const HANDLERS: Record<DetectedImport['platform'], (id: string) => Promise<{ card: CharacterCard; avatarDataUrl?: string }>> = {
    jannyai: importJannyAI,
    chub: importChub,
    pygmalion: importPygmalion,
    risuai: importRisuAI,
    aicharactercards: importAICC,
};

// Hosts we accept for the direct-PNG proxy mode (JannyAI client-side fallback): the
// download URL handed out by JannyAI's API points at their card storage. Suffix-matched.
const PNG_PROXY_HOST_ALLOWLIST = [
    '.jannyai.com',
    '.janitorai.com',
    '.r2.dev',
    '.cloudflarestorage.com',
];

export async function POST(req: NextRequest) {
    try {
        const { url, pngUrl } = (await req.json()) as { url?: string; pngUrl?: string };

        // Fallback mode: the client already resolved a card-PNG URL (e.g. it called the
        // JannyAI API from the browser, where a real Chrome fingerprint passes Cloudflare)
        // and only needs the CORS-free download + parse.
        if (pngUrl && typeof pngUrl === 'string') {
            let parsed: URL;
            try {
                parsed = new URL(pngUrl);
            } catch {
                return Response.json({ error: 'URL de PNG invalide.' }, { status: 400 });
            }
            const hostOk =
                parsed.protocol === 'https:' &&
                PNG_PROXY_HOST_ALLOWLIST.some(
                    (suffix) =>
                        parsed.hostname.endsWith(suffix) || parsed.hostname === suffix.slice(1)
                );
            if (!hostOk) {
                return Response.json({ error: 'Hôte de PNG non autorisé.' }, { status: 400 });
            }
            const result = pngToResult(await fetchBuffer(pngUrl, 'JannyAI'));
            return Response.json({ ...result, platform: 'JannyAI' });
        }

        if (!url || typeof url !== 'string') {
            return Response.json({ error: 'URL manquante.' }, { status: 400 });
        }

        const detected = detectImportUrl(url);
        if (!detected) {
            return Response.json(
                {
                    error: 'URL non reconnue. Plateformes supportées : JannyAI, Chub.ai / CharacterHub, Pygmalion, RisuAI Realm, AICharacterCards.',
                },
                { status: 400 }
            );
        }

        const result = await HANDLERS[detected.platform](detected.id);
        return Response.json({ ...result, platform: detected.label });
    } catch (error) {
        if (error instanceof ImportError) {
            const status = error.kind === 'not_found' ? 404 : 502;
            return Response.json({ error: error.message, kind: error.kind }, { status });
        }
        console.error('Import error:', error);
        return Response.json(
            { error: error instanceof Error ? error.message : 'Import failed' },
            { status: 500 }
        );
    }
}
