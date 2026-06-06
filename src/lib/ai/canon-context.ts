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
import { useSettingsStore } from '@/stores/settings-store';

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
    /** Diagnostic info for the Context Preview — not used by the prompt itself. */
    injectionMeta?: {
        injectedNames: string[];
        ignoredStubs: string[];
        ignoredDisabled: string[];
        scanDepth: number;
        dueToAppear?: string[];
    };
}

/**
 * Resolve the *active arc names* given a free-form position like "S1E5" or "Naruto Shippuden,
 * Season 1, Episode 1". Strategy:
 *
 *   1. If the position already contains one of the work's canonical arc names verbatim, use those.
 *   2. Else, if the position has an episode/chapter number AND we have an outline, return the
 *      arc at index N-1 (outlines are numbered "1. Arc Name — …", ordered chronologically).
 *      A coarse but useful approximation — early episodes ⇒ early arc.
 *   3. Else, fall back to the raw position (and let the word-overlap matcher try).
 */
export function resolveActiveArcNames(position: string, outline: string | undefined): string[] {
    const pos = position.trim();
    if (!pos) return [];
    const arcs = parseOutlineArcs(outline);
    const posLower = pos.toLowerCase();

    // 1. Verbatim arc name in the position?
    const verbatim = arcs.filter((a) => posLower.includes(a.toLowerCase()));
    if (verbatim.length > 0) return verbatim;

    // 2. Episode/chapter number heuristic. We accept S1E12, Episode 7, Chapter 40, Ep. 5, etc.
    //    For seasons > 1 we'd ideally know each season's episode range, but we don't, so we
    //    use the first numeric clue as a global episode index.
    const m = pos.match(/(?:s\d+\s*e|episode|chapter|chap\.?|ep\.?|ch\.?)\s*(\d+)/i);
    if (m && arcs.length > 0) {
        const ep = parseInt(m[1], 10);
        // A typical arc spans ~15-25 episodes. Map ep → arc index using a soft bucketing.
        // For users who only set a high-level season, we just take the first arc as a default.
        if (ep <= 25 && arcs[0]) return [arcs[0]];
        // Beyond that, do a rough proportional mapping.
        const perArc = 22;
        const idx = Math.min(arcs.length - 1, Math.floor((ep - 1) / perArc));
        return [arcs[idx]];
    }

    // 3. Fallback: nothing resolvable, return empty (the caller will try raw word overlap).
    return [];
}

/** Parse "1. Arc Name — …" lines out of a numbered outline. */
function parseOutlineArcs(outline: string | undefined): string[] {
    if (!outline) return [];
    const arcs: string[] = [];
    for (const rawLine of outline.split(/\r?\n/)) {
        const m = rawLine.match(/^\s*\d+[.)]\s*([^—\-:]+?)(?:\s*[—\-:]|$)/);
        if (m) arcs.push(m[1].trim());
    }
    return arcs;
}

/** True if any of `appearsInArcs` matches any of `targets` (case-insensitive). */
function anyArcMatches(appearsInArcs: string[] | undefined, targets: string[]): boolean {
    if (!appearsInArcs || appearsInArcs.length === 0 || targets.length === 0) return false;
    const want = new Set(targets.map((t) => t.toLowerCase()));
    return appearsInArcs.some((a) => want.has(a.toLowerCase()));
}

/** Fallback: word-overlap matcher for the free-text case. */
function wordOverlapMatch(appearsInArcs: string[] | undefined, context: string): boolean {
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

const SCAN_DEPTH = 10;

export async function buildCanonOptions(
    card: CharacterCard,
    conversation: Conversation | undefined,
    recentMessages: Message[]
): Promise<CanonPromptOptions> {
    // Master switch: when off, nothing canon-related reaches the prompt.
    if (!useSettingsStore.getState().useCanonCodex) return {};

    const work = resolveWork(card);
    if (!work) return {};

    const all = await getCanonDossiersByWork(work);
    const isInjectable = (d: CanonDossier) => d.enabled !== false && !d.stub && !!d.identity.trim();

    const activeNames = new Set(
        getActiveCanonNames(card, conversation, recentMessages, SCAN_DEPTH).map((n) =>
            n.toLowerCase()
        )
    );

    // Partition for diagnostics: injected vs stub vs disabled, among mentioned cast members.
    const mentioned = all.filter((d) => activeNames.has(d.character.toLowerCase()));
    const injected = mentioned.filter(isInjectable);
    const ignoredStubs = mentioned.filter((d) => d.stub).map((d) => d.character);
    const ignoredDisabled = mentioned
        .filter((d) => d.enabled === false && !d.stub)
        .map((d) => d.character);

    // Arc Compass is ON by default — only an explicit `enabled: false` turns it off. This is
    // what lets new conversations get the Director block without any user setup.
    const arcEnabled = conversation?.arc?.enabled !== false;

    // Arc outline is loaded whether or not the arc is enabled, because the matcher needs it
    // to translate "S1E5" into an arc name. The outline is only INJECTED in the prompt when
    // the arc is enabled.
    const outline = (await getArcOutline(work))?.outline;
    const arcOutlineForPrompt = arcEnabled ? outline : undefined;

    // Compute due-to-appear: characters whose canonical arcs intersect where we are now.
    // Strategy: first try resolving the position to one of the canonical arc names (handles
    // "S1E5"-style positions via the outline). If that fails, fall back to free-text overlap.
    let dueToAppear: string[] | undefined;
    if (arcEnabled) {
        const pos = `${conversation?.arc?.currentPosition || ''} ${conversation?.arc?.nextBeat || ''}`;
        const activeArcs = resolveActiveArcNames(pos, outline);
        dueToAppear = all
            .filter((d) => {
                if (d.enabled === false) return false;
                if (activeNames.has(d.character.toLowerCase())) return false;
                if (activeArcs.length > 0) return anyArcMatches(d.appearsInArcs, activeArcs);
                return wordOverlapMatch(d.appearsInArcs, pos);
            })
            .map((d) => d.character)
            .slice(0, 8);
        if (dueToAppear.length === 0) dueToAppear = undefined;
    }

    // Synthesize a default-enabled arc when the conversation has none, so the Director block
    // appears without the user having to toggle anything. The work falls back to the resolved
    // one so the prompt still names the franchise.
    const arc = arcEnabled
        ? conversation?.arc || { enabled: true, work }
        : conversation?.arc;

    return {
        canonDossiers: injected,
        rpJournal: conversation?.rpJournal,
        arc,
        arcOutline: arcOutlineForPrompt,
        momentumNudge: conversation?.momentumNudge,
        dueToAppear,
        injectionMeta: {
            injectedNames: injected.map((d) => d.character),
            ignoredStubs,
            ignoredDisabled,
            scanDepth: SCAN_DEPTH,
            dueToAppear,
        },
    };
}
