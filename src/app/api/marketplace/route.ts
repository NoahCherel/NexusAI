/**
 * Marketplace search proxy: POST { query, page, nsfw, sort } → normalized card list.
 *
 * Chub's search API (api.chub.ai/search) works from the local Next server but requires a
 * REALISTIC full browser User-Agent — short UAs get "This request has been blocked" from
 * their WAF. JannyAI has no reachable catalogue API (Cloudflare interactive challenge on
 * every endpoint), so the marketplace is Chub-only; JannyAI cards go through the by-URL
 * importer (with its browser fallback).
 */

import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json',
};

const ALLOWED_SORTS = new Set([
    'star_count',
    'trending_downloads',
    'created_at',
    'last_activity_at',
    'rating',
    'n_favorites',
]);

interface ChubNode {
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
    createdAt?: string;
}

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

export async function POST(req: NextRequest) {
    try {
        const body = (await req.json().catch(() => ({}))) as {
            query?: string;
            page?: number;
            nsfw?: boolean;
            sort?: string;
        };
        const query = typeof body.query === 'string' ? body.query.slice(0, 200) : '';
        const page = Number.isInteger(body.page) && body.page! > 0 ? body.page! : 1;
        const nsfw = body.nsfw === true;
        const sort = ALLOWED_SORTS.has(body.sort || '') ? body.sort! : 'star_count';

        const params = new URLSearchParams({
            first: '24',
            page: String(page),
            namespace: 'characters',
            search: query,
            include_forks: 'true',
            nsfw: String(nsfw),
            nsfl: 'false',
            asc: 'false',
            sort,
        });

        const res = await fetch(`https://api.chub.ai/search?${params}`, {
            headers: BROWSER_HEADERS,
        });
        if (!res.ok) {
            return Response.json(
                { error: `Chub search: HTTP ${res.status}` },
                { status: 502 }
            );
        }
        const text = await res.text();
        if (text.startsWith('This request has been blocked')) {
            return Response.json(
                { error: 'Chub a bloqué la recherche (WAF). Réessayez dans un moment.' },
                { status: 502 }
            );
        }
        const json = JSON.parse(text) as { data?: { nodes?: ChubNode[]; count?: number } };
        const nodes = json.data?.nodes ?? [];

        const results: MarketplaceCard[] = nodes
            .filter((n) => n.fullPath && n.name)
            .map((n) => ({
                name: n.name!,
                fullPath: n.fullPath!,
                tagline: n.tagline || (n.description || '').slice(0, 140),
                avatarUrl:
                    n.avatar_url ||
                    `https://avatars.charhub.io/avatars/${n.fullPath}/avatar.webp`,
                stars: n.starCount ?? 0,
                chats: n.n_public_chats ?? n.nChats ?? 0,
                tokens: n.nTokens ?? 0,
                topics: (n.topics || []).filter((t) => t !== 'ROOT').slice(0, 6),
                nsfwImage: !!n.nsfw_image,
            }));

        return Response.json({ results, count: json.data?.count ?? results.length, page });
    } catch (error) {
        console.error('Marketplace search error:', error);
        return Response.json(
            { error: error instanceof Error ? error.message : 'Search failed' },
            { status: 500 }
        );
    }
}
