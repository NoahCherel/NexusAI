'use client';

/**
 * Assembles the Canon Codex + Arc + momentum options for `buildSystemPrompt`, from the
 * work card and the current conversation. Loads the immutable dossiers of the NPCs active
 * in the recent scene (so we only spend tokens on who's on stage) plus the work's arc map.
 */

import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type { CanonDossier } from '@/types/canon';
import { getCanonDossiersByWork, getArcOutline } from '@/lib/db';
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
    dueToAppear?: string[];
}

/** True if any of the character's appearance arcs shares a significant word with `context`. */
function arcMatches(appearsInArcs: string[] | undefined, context: string): boolean {
    if (!appearsInArcs || appearsInArcs.length === 0 || !context.trim()) return false;
    const ctx = context.toLowerCase();
    return appearsInArcs.some((a) =>
        a
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 4)
            .some((w) => ctx.includes(w))
    );
}

export async function buildCanonOptions(
    card: CharacterCard,
    conversation: Conversation | undefined,
    recentMessages: Message[]
): Promise<CanonPromptOptions> {
    const work = resolveWork(card);
    if (!work) return {};

    const all = await getCanonDossiersByWork(work);
    const isInjectable = (d: CanonDossier) => d.enabled !== false && !d.stub && !!d.identity.trim();

    const activeNames = new Set(
        getActiveCanonNames(card, conversation, recentMessages).map((n) => n.toLowerCase())
    );
    const dossiers = all.filter(
        (d) => isInjectable(d) && activeNames.has(d.character.toLowerCase())
    );

    // Characters whose canonical arc matches where we are now, but who aren't on stage yet —
    // a hint for the GM to introduce them naturally (subject to butterfly-effect divergence).
    let dueToAppear: string[] | undefined;
    if (conversation?.arc?.enabled) {
        const context = `${conversation.arc.currentPosition || ''} ${conversation.arc.nextBeat || ''}`;
        dueToAppear = all
            .filter(
                (d) =>
                    d.enabled !== false &&
                    !activeNames.has(d.character.toLowerCase()) &&
                    arcMatches(d.appearsInArcs, context)
            )
            .map((d) => d.character)
            .slice(0, 8);
        if (dueToAppear.length === 0) dueToAppear = undefined;
    }

    const arcOutline = conversation?.arc?.enabled
        ? (await getArcOutline(work))?.outline
        : undefined;

    return {
        canonDossiers: dossiers,
        rpJournal: conversation?.rpJournal,
        arc: conversation?.arc,
        arcOutline,
        momentumNudge: conversation?.momentumNudge,
        dueToAppear,
    };
}
