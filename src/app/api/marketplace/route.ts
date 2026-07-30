/**
 * Marketplace search proxy: POST { query, page, nsfw, sort } → normalized card list.
 *
 * Chub's WAF fingerprints clients: a REALISTIC full browser header set is required (short
 * UAs get "This request has been blocked"), and even then the undici TLS fingerprint gets
 * 403'd intermittently. Strategy: rich headers + one retry, and on persistent block return
 * `kind: 'blocked'` so the CLIENT retries directly from the browser (real Chrome
 * fingerprint + permissive CORS on api.chub.ai) — see MarketplaceBrowser.
 */

import { NextRequest } from 'next/server';
import {
    CHUB_SEARCH_URL,
    buildChubSearchParams,
    normalizeChubNodes,
    normalizeChubDetail,
    chubDetailUrl,
    type ChubNode,
} from '@/lib/import/chub';

export const runtime = 'nodejs';

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: 'https://chub.ai/',
    Origin: 'https://chub.ai',
};

function isBlocked(status: number, text: string): boolean {
    return status === 403 || text.startsWith('This request has been blocked');
}

async function chubSearch(params: URLSearchParams): Promise<
    | { ok: true; nodes: ChubNode[]; count: number }
    | { ok: false; blocked: boolean; status: number }
> {
    const res = await fetch(`${CHUB_SEARCH_URL}?${params}`, { headers: BROWSER_HEADERS });
    const text = await res.text();
    if (!res.ok || isBlocked(res.status, text)) {
        return { ok: false, blocked: isBlocked(res.status, text), status: res.status };
    }
    try {
        const json = JSON.parse(text) as { data?: { nodes?: ChubNode[]; count?: number } };
        return { ok: true, nodes: json.data?.nodes ?? [], count: json.data?.count ?? 0 };
    } catch {
        return { ok: false, blocked: text.startsWith('This request'), status: res.status };
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = (await req.json().catch(() => ({}))) as {
            query?: string;
            page?: number;
            nsfw?: boolean;
            sort?: string;
            /** Detail mode: fullPath of a card to preview (creator/project). */
            detail?: string;
        };

        // Detail mode — full card preview before import.
        if (typeof body.detail === 'string' && /^[^/]+\/[^/]+$/.test(body.detail)) {
            let res = await fetch(chubDetailUrl(body.detail), { headers: BROWSER_HEADERS });
            let text = await res.text();
            if (!res.ok || isBlocked(res.status, text)) {
                await new Promise((r) => setTimeout(r, 700));
                res = await fetch(chubDetailUrl(body.detail), { headers: BROWSER_HEADERS });
                text = await res.text();
            }
            if (!res.ok || isBlocked(res.status, text)) {
                return Response.json(
                    {
                        error: 'Chub a bloqué la requête côté serveur.',
                        kind: isBlocked(res.status, text) ? 'blocked' : 'error',
                    },
                    { status: 502 }
                );
            }
            try {
                const json = JSON.parse(text) as { node?: ChubNode };
                const detail = json.node ? normalizeChubDetail(json.node) : null;
                if (!detail) {
                    return Response.json({ error: 'Carte introuvable.' }, { status: 404 });
                }
                return Response.json({ detail });
            } catch {
                return Response.json({ error: 'Réponse Chub invalide.' }, { status: 502 });
            }
        }

        const params = buildChubSearchParams(body);

        let result = await chubSearch(params);
        if (!result.ok && result.blocked) {
            // One polite retry — the WAF verdict is often transient.
            await new Promise((r) => setTimeout(r, 700));
            result = await chubSearch(params);
        }

        if (!result.ok) {
            return Response.json(
                {
                    error: result.blocked
                        ? 'Chub a bloqué la recherche côté serveur.'
                        : `Chub search: HTTP ${result.status}`,
                    // The client falls back to a direct browser fetch on this kind.
                    kind: result.blocked ? 'blocked' : 'error',
                },
                { status: 502 }
            );
        }

        const results = normalizeChubNodes(result.nodes);
        return Response.json({ results, count: result.count || results.length });
    } catch (error) {
        console.error('Marketplace search error:', error);
        return Response.json(
            { error: error instanceof Error ? error.message : 'Search failed', kind: 'error' },
            { status: 500 }
        );
    }
}
