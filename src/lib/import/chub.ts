/**
 * Chub.ai API shared helpers — used by BOTH the server routes (/api/marketplace,
 * /api/import) and the CLIENT-side browser fallbacks.
 *
 * Why a browser fallback exists: Chub's WAF fingerprints TLS. The Next server (undici)
 * passes sometimes and gets 403 other times; a real browser always carries a legitimate
 * Chrome fingerprint, and api.chub.ai serves permissive CORS (their own frontend calls it
 * cross-origin). So the client retries blocked requests itself.
 */

export interface MarketplaceCard {
    name: string;
    fullPath: string;
    tagline: string;
    avatarUrl: string;
    stars: number;
    chats: number;
    tokens: number;
    topics: string[];
    nsfwImage: boolean;
}

export interface ChubNode {
    name?: string;
    fullPath?: string;
    tagline?: string;
    description?: string;
    avatar_url?: string;
    starCount?: number;
    n_public_chats?: number;
    nChats?: number;
    nTokens?: number;
    topics?: string[];
    nsfw_image?: boolean;
}

export const CHUB_SEARCH_URL = 'https://api.chub.ai/search';
export const CHUB_DOWNLOAD_URL = 'https://api.chub.ai/api/characters/download';

export const CHUB_ALLOWED_SORTS = new Set([
    'star_count',
    'trending_downloads',
    'created_at',
    'last_activity_at',
    'rating',
    'n_favorites',
]);

export function buildChubSearchParams(options: {
    query?: string;
    page?: number;
    nsfw?: boolean;
    sort?: string;
}): URLSearchParams {
    const query = typeof options.query === 'string' ? options.query.slice(0, 200) : '';
    const page = Number.isInteger(options.page) && options.page! > 0 ? options.page! : 1;
    const sort = CHUB_ALLOWED_SORTS.has(options.sort || '') ? options.sort! : 'star_count';
    return new URLSearchParams({
        first: '24',
        page: String(page),
        namespace: 'characters',
        search: query,
        include_forks: 'true',
        nsfw: String(options.nsfw === true),
        nsfl: 'false',
        asc: 'false',
        sort,
    });
}

/**
 * BROWSER-ONLY: download + parse a Chub card entirely client-side (uses btoa/fetch from
 * the page). Fallback for when the server proxy gets 403'd by the WAF — the browser's
 * real Chrome TLS fingerprint passes. Returns null on any failure (caller keeps its own
 * error message).
 */
export async function downloadChubCardInBrowser(
    fullPath: string
): Promise<{ card: import('@/types/character').CharacterCard; avatarDataUrl: string } | null> {
    try {
        const res = await fetch(CHUB_DOWNLOAD_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ format: 'tavern', fullPath }),
        });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const { parseCharacterCardPNGBuffer } = await import('@/lib/character-parser');
        const card = parseCharacterCardPNGBuffer(buf);
        // Chunked base64 conversion — String.fromCharCode(...) on a whole card PNG would
        // blow the call stack.
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        return { card, avatarDataUrl: `data:image/png;base64,${btoa(binary)}` };
    } catch (err) {
        console.warn('[Chub] Browser download fallback failed:', err);
        return null;
    }
}

export function normalizeChubNodes(nodes: ChubNode[]): MarketplaceCard[] {
    return nodes
        .filter((n) => n.fullPath && n.name)
        .map((n) => ({
            name: n.name!,
            fullPath: n.fullPath!,
            tagline: n.tagline || (n.description || '').slice(0, 140),
            avatarUrl:
                n.avatar_url || `https://avatars.charhub.io/avatars/${n.fullPath}/avatar.webp`,
            stars: n.starCount ?? 0,
            chats: n.n_public_chats ?? n.nChats ?? 0,
            tokens: n.nTokens ?? 0,
            topics: (n.topics || []).filter((t) => t !== 'ROOT').slice(0, 6),
            nsfwImage: !!n.nsfw_image,
        }));
}
