/**
 * Anti-stall (momentum) detector.
 *
 * Cheap, synchronous, no extra API calls: compares the latest assistant beat with the
 * previous one by lexical novelty (Jaccard distance over content words). When two
 * consecutive beats are very similar AND the world state didn't move, the scene is
 * stalling and we inject a one-shot nudge to push it forward (toward the next canonical
 * beat when an Arc is set).
 */

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'as',
    'is', 'was', 'were', 'be', 'been', 'being', 'her', 'his', 'their', 'its', 'he', 'she',
    'they', 'it', 'you', 'i', 'we', 'that', 'this', 'these', 'those', 'then', 'than', 'so',
    'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'à', 'au', 'aux', 'en',
    'dans', 'sur', 'pour', 'avec', 'que', 'qui', 'se', 'sa', 'son', 'ses', 'il', 'elle',
    'ils', 'elles', 'ne', 'pas', 'est', 'sont',
]);

function contentWordSet(text: string): Set<string> {
    const words = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    return new Set(words);
}

/** Jaccard similarity (0..1) between two texts' content-word sets. */
export function lexicalSimilarity(a: string, b: string): number {
    const sa = contentWordSet(a);
    const sb = contentWordSet(b);
    if (sa.size === 0 || sb.size === 0) return 0;
    let inter = 0;
    for (const w of sa) if (sb.has(w)) inter++;
    const union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
}

export interface StallResult {
    stalled: boolean;
    similarity: number;
}

/**
 * Detect whether the scene is stalling.
 * @param latest the assistant beat just produced
 * @param previous the previous assistant beat (or undefined)
 * @param worldStateChanged whether the world state moved this turn (if known)
 * @param threshold similarity above which beats count as "too similar" (default 0.5)
 */
export function detectStall(
    latest: string,
    previous: string | undefined,
    worldStateChanged: boolean,
    threshold = 0.5
): StallResult {
    if (!previous) return { stalled: false, similarity: 0 };
    const similarity = lexicalSimilarity(latest, previous);
    return { stalled: similarity >= threshold && !worldStateChanged, similarity };
}

/** Build the one-shot nudge text; steers toward `nextBeat` when an Arc is set. */
export function buildMomentumNudge(nextBeat?: string): string {
    const target = nextBeat?.trim()
        ? `advance one concrete step toward the next canonical beat (${nextBeat.trim()})`
        : 'introduce one concrete complication, a new goal, or an external event';
    return `The scene is stalling — the last beats are repeating without progress. In your next response, ${target}. Keep it to a single primary beat, in character.`;
}
