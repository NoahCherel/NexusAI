'use client';

/**
 * Full-text search across ALL conversations (titles + message contents), straight from
 * IndexedDB. On-demand only (debounced sidebar search) — a linear scan is fine for a
 * local-first app; no index maintenance, always fresh.
 */

import { initDB } from '@/lib/db';
import type { Conversation, Message } from '@/types/chat';

export interface ConversationSearchHit {
    conversationId: string;
    characterId: string;
    title: string;
    /** Text around the first content match (or the title when only it matches). */
    snippet: string;
    matchCount: number;
    updatedAt: number;
}

export async function searchConversations(
    term: string,
    limit = 8
): Promise<ConversationSearchHit[]> {
    const q = term.trim().toLowerCase();
    if (q.length < 2) return [];

    const db = await initDB();
    const conversations = (await db.getAll('conversations')) as Conversation[];
    const hits: ConversationSearchHit[] = [];

    for (const conv of conversations) {
        let matchCount = 0;
        let snippet = '';

        if (conv.title?.toLowerCase().includes(q)) {
            matchCount++;
            snippet = conv.title;
        }

        const messages = (await db.getAllFromIndex(
            'messages',
            'by-conversation',
            conv.id
        )) as Message[];
        for (const m of messages) {
            const idx = m.content?.toLowerCase().indexOf(q) ?? -1;
            if (idx >= 0) {
                matchCount++;
                if (!snippet || snippet === conv.title) {
                    const start = Math.max(0, idx - 32);
                    snippet =
                        (start > 0 ? '…' : '') +
                        m.content.slice(start, idx + q.length + 48).replace(/\s+/g, ' ') +
                        '…';
                }
            }
        }

        if (matchCount > 0) {
            hits.push({
                conversationId: conv.id,
                characterId: conv.characterId,
                title: conv.title || 'Sans titre',
                snippet,
                matchCount,
                updatedAt: new Date(conv.updatedAt).getTime() || 0,
            });
        }
    }

    return hits
        .sort((a, b) => b.matchCount - a.matchCount || b.updatedAt - a.updatedAt)
        .slice(0, limit);
}
