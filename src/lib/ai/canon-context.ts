'use client';

/**
 * Assembles the Canon Codex + Arc + momentum options for `buildSystemPrompt`, from the
 * work card and the current conversation. Loads the immutable dossiers of the NPCs active
 * in the recent scene (so we only spend tokens on who's on stage) plus the work's arc map.
 */

import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type { CanonDossier } from '@/types/canon';
import { getCanonDossier, getArcOutline } from '@/lib/db';
import { deriveWorkFromName } from '@/lib/ai/canon-retrieval';

export function resolveWork(card: CharacterCard): string {
    return (card.work?.trim() || deriveWorkFromName(card.name)).trim();
}

/** Names from the roster that are mentioned in the last `depth` messages. */
export function getActiveCanonNames(
    card: CharacterCard,
    conversation: Conversation | undefined,
    recentMessages: Message[],
    depth = 10
): string[] {
    const roster =
        card.canonCast && card.canonCast.length > 0
            ? card.canonCast
            : Object.keys(conversation?.worldState?.relationships || {});
    if (roster.length === 0) return [];
    const text = recentMessages
        .slice(-depth)
        .map((m) => m.content)
        .join(' ')
        .toLowerCase();
    return roster.filter((n) => {
        const ln = n.toLowerCase();
        return text.includes(ln) || text.includes(ln.split(' ')[0]);
    });
}

export interface CanonPromptOptions {
    canonDossiers?: CanonDossier[];
    rpJournal?: Record<string, string[]>;
    arc?: Conversation['arc'];
    arcOutline?: string;
    momentumNudge?: string;
}

export async function buildCanonOptions(
    card: CharacterCard,
    conversation: Conversation | undefined,
    recentMessages: Message[]
): Promise<CanonPromptOptions> {
    const work = resolveWork(card);
    if (!work) return {};

    const activeNames = getActiveCanonNames(card, conversation, recentMessages);
    const dossiers = (
        await Promise.all(activeNames.map((n) => getCanonDossier(work, n)))
    ).filter((d): d is CanonDossier => !!d);

    const arcOutline = conversation?.arc?.enabled
        ? (await getArcOutline(work))?.outline
        : undefined;

    return {
        canonDossiers: dossiers,
        rpJournal: conversation?.rpJournal,
        arc: conversation?.arc,
        arcOutline,
        momentumNudge: conversation?.momentumNudge,
    };
}
