/**
 * The Chronicle — hierarchical long-term memory.
 *
 * A 3-level pyramid, each level compressing the one below:
 * - Level 0 — Fragment: ~10 messages
 * - Level 1 — Section:  5 Fragments ≈ 50 messages
 * - Level 2 — Arc:      3 Sections  ≈ 150 messages
 *
 * `buildChronicle` renders the pyramid AS a pyramid. The levels overlap by construction —
 * Arc 1 and its Sections describe the same 150 messages at different zoom levels — and the
 * old flat rendering (`📖 Story Arc:` then `📝 Recent Events:`, no ranges, no nesting) gave
 * the model no way to know that. It could read an Arc and its own Sections as two separate
 * runs of events.
 */

import type { MemorySummary, SummaryLevel } from '@/types/rag';
import type { Message } from '@/types/chat';
import { saveSummary, getSummariesByConversation } from '@/lib/db';
import { countTokens } from '@/lib/tokenizer';
import { fitRankedBlock } from './rag-budget';

// Configuration
export const DEFAULT_CHUNK_SIZE = 10; // Messages per L0 summary (default)
const L1_THRESHOLD = 5; // L0 summaries per L1 summary
const L2_THRESHOLD = 3; // L1 summaries per L2 summary

export const SUMMARIZATION_PROMPT_L0 = `You are a RPG session chronicler. Summarize this chunk of roleplay messages into a concise narrative paragraph.

CRITICAL — LANGUAGE: Write in the SAME LANGUAGE as the source material. If the roleplay is in French, write in French. Never translate.

RULES:
- Write EXCLUSIVELY in past tense, third person (e.g. "Character walked..." NOT "Character walks...")
- Capture: WHO did WHAT, WHERE, key decisions, important dialogue
- Include specific names, items, locations
- Max 3-4 sentences
- Do NOT repeat information already covered in previous summaries
- Do NOT include things that are no longer relevant (e.g. completed side conversations, resolved misunderstandings)
- Focus on ACTIONS and CONSEQUENCES, not descriptions of scenery or internal thoughts unless plot-critical
- Also extract 3-5 KEY FACTS as a separate list (atomic, searchable statements, also in past tense)
- Output in this JSON format:

{
  "summary": "narrative summary paragraph...",
  "keyFacts": ["fact 1", "fact 2", "fact 3"]
}`;

// L1/L2 are the DURABLE memory: once the raw messages fall out of the context window this
// text is all that survives of them. They used to be capped at "Max 2-3 sentences", which is
// why long roleplays felt amnesiac — 50 messages compressed into two lines. They are now
// asked for real substance, and told why.

export const SUMMARIZATION_PROMPT_L1 = `You are the chronicler of an ongoing roleplay. Write the SECTION summary covering this stretch of the story.

CRITICAL — LANGUAGE: Write in the SAME LANGUAGE as the source material. If the roleplay is in French, write in French. Never translate.

WHY THIS MATTERS: Once the raw messages scroll out of the model's context window, THIS TEXT IS ALL THAT REMAINS of them. Anything you leave out is forgotten forever. Be specific and concrete, never vague.

RULES:
- Past tense, third person.
- 150 to 250 words, in 2 or 3 dense paragraphs. Do not pad, but do not compress into a couple of lines either.
- Cover, in narrative order:
  * what happened — actions and their consequences
  * decisions made, and by whom
  * named people, places and objects introduced, changed, gained or lost
  * how the relationships between characters shifted
  * anything left UNRESOLVED at the end of this stretch: a promise, a threat, a debt, an injury, a secret, a question asked but not answered
- Preserve exact proper nouns and numbers. NEVER invent anything that is not in the source.
- Merge overlapping information from the fragments; do not narrate the same event twice.
- Skip scenery and internal monologue unless they changed the plot.
- End with one line: the state at the close of this section — where everyone is, and what is pending.
- Also extract 3 to 5 key facts: atomic, self-contained statements, same language, past tense.
- Output JSON:

{
  "summary": "section summary, 150-250 words...",
  "keyFacts": ["fact 1", "fact 2", "fact 3"]
}`;

export const SUMMARIZATION_PROMPT_L2 = `You are the chronicler of an ongoing roleplay. Write the ARC summary: the high-level account of a long stretch of the story, built from its section summaries.

CRITICAL — LANGUAGE: Write in the SAME LANGUAGE as the source material. If the roleplay is in French, write in French. Never translate.

WHY THIS MATTERS: This is the OLDEST layer of memory. When the story grows long, this summary may be the only trace left of everything that happened in this arc. Someone reading it alone must understand what this stretch of the story was.

RULES:
- Past tense, third person.
- 250 to 350 words, in 2 or 3 paragraphs.
- Cover:
  * the through-line — what this arc was actually about
  * the major turning points, in order
  * how the situation at the END of the arc differs from its beginning: who changed, what was gained or lost, which relationships were transformed
  * what remains OPEN going into what follows
- Preserve exact proper nouns and numbers. NEVER invent anything that is not in the sections.
- Eliminate redundancy: each piece of information appears once. Drop what was superseded, keep what still shapes the present.
- End with one line: the state at the close of this arc.
- Also extract 2 to 4 defining facts of the whole arc, same language, past tense.
- Output JSON:

{
  "summary": "arc summary, 250-350 words...",
  "keyFacts": ["defining fact 1", "defining fact 2"]
}`;

/**
 * Check if a new L0 summary is needed based on message count.
 * Uses actual message ranges from existing summaries rather than assuming fixed chunk sizes.
 * @param chunkSize - Dynamic chunk size (default: DEFAULT_CHUNK_SIZE)
 */
export function shouldCreateL0Summary(
    messageCount: number,
    existingSummaries: MemorySummary[],
    chunkSize: number = DEFAULT_CHUNK_SIZE
): boolean {
    const l0Summaries = existingSummaries.filter((s) => s.level === 0);
    // Use the actual highest message index covered by existing summaries
    const coveredMessages =
        l0Summaries.length > 0 ? Math.max(...l0Summaries.map((s) => s.messageRange[1])) : 0;
    return messageCount - coveredMessages >= chunkSize;
}

/**
 * Check if L1 summary is needed.
 */
export function shouldCreateL1Summary(existingSummaries: MemorySummary[]): boolean {
    // Delegates rather than counting: `getL0SummariesForL1` decides coverage from `childIds`,
    // and a second, count-based opinion here drifted from it the moment a summary was deleted
    // by hand — which the memory panel now encourages.
    return getL0SummariesForL1(existingSummaries) !== null;
}

/**
 * Check if L2 summary is needed.
 */
export function shouldCreateL2Summary(existingSummaries: MemorySummary[]): boolean {
    return getL1SummariesForL2(existingSummaries) !== null;
}

/**
 * Get messages that need to be summarized (not yet covered by L0 summaries).
 * Uses actual message ranges from existing summaries rather than assuming fixed chunk sizes.
 */
export function getUnsummarizedMessages(
    messages: Message[],
    existingSummaries: MemorySummary[]
): Message[] {
    const l0Summaries = existingSummaries.filter((s) => s.level === 0);
    // Use the actual highest message index covered by existing summaries
    const coveredCount =
        l0Summaries.length > 0 ? Math.max(...l0Summaries.map((s) => s.messageRange[1])) : 0;

    // Sort by creation time
    const sorted = [...messages].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return sorted.slice(coveredCount);
}

/**
 * Get the chunk of messages to summarize next.
 * @param chunkSize - Dynamic chunk size (default: DEFAULT_CHUNK_SIZE)
 */
export function getNextChunkToSummarize(
    messages: Message[],
    existingSummaries: MemorySummary[],
    chunkSize: number = DEFAULT_CHUNK_SIZE
): Message[] | null {
    const unsummarized = getUnsummarizedMessages(messages, existingSummaries);
    if (unsummarized.length < chunkSize) return null;
    return unsummarized.slice(0, chunkSize);
}

/**
 * Get L0 summaries that need to be combined into an L1 summary.
 */
export function getL0SummariesForL1(existingSummaries: MemorySummary[]): MemorySummary[] | null {
    const l0s = existingSummaries
        .filter((s) => s.level === 0)
        .sort((a, b) => a.messageRange[0] - b.messageRange[0]);

    const l1s = existingSummaries.filter((s) => s.level === 1);
    const alreadyCoveredL0Ids = new Set(l1s.flatMap((l1) => l1.childIds));

    const uncovered = l0s.filter((l0) => !alreadyCoveredL0Ids.has(l0.id));

    if (uncovered.length < L1_THRESHOLD) return null;
    return uncovered.slice(0, L1_THRESHOLD);
}

/**
 * Get L1 summaries that need to be combined into an L2 summary.
 */
export function getL1SummariesForL2(existingSummaries: MemorySummary[]): MemorySummary[] | null {
    const l1s = existingSummaries
        .filter((s) => s.level === 1)
        .sort((a, b) => a.messageRange[0] - b.messageRange[0]);

    const l2s = existingSummaries.filter((s) => s.level === 2);
    const alreadyCoveredL1Ids = new Set(l2s.flatMap((l2) => l2.childIds));

    const uncovered = l1s.filter((l1) => !alreadyCoveredL1Ids.has(l1.id));

    if (uncovered.length < L2_THRESHOLD) return null;
    return uncovered.slice(0, L2_THRESHOLD);
}

/**
 * Parse the summarization response.
 */
export function parseSummarizationResponse(
    text: string
): { summary: string; keyFacts: string[] } | null {
    try {
        // Try JSON parse first
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                summary: parsed.summary || '',
                keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts : [],
            };
        }

        // Fallback: treat entire text as summary
        const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (cleanText) {
            return { summary: cleanText, keyFacts: [] };
        }

        return null;
    } catch {
        // If JSON parse fails, use the raw text
        const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        return cleanText ? { summary: cleanText, keyFacts: [] } : null;
    }
}

/**
 * Build the prompt for L0 summarization.
 */
export function buildL0Prompt(
    messages: Message[],
    characterName: string,
    userName: string
): string {
    // Speaker-aware labels: Troupe turns carry their own character's name and user
    // messages carry the persona used AT SEND TIME — never relabel everything with the
    // main card character / currently active persona.
    const formatted = messages
        .map(
            (m) =>
                `${m.speaker?.name || (m.role === 'user' ? userName : characterName)}: ${m.content}`
        )
        .join('\n\n');

    return `Character: ${characterName}\nPlayer: ${userName}\n\n--- Messages ---\n${formatted}\n\n--- End Messages ---\n\nSummarize this chunk:`;
}

/**
 * Build the prompt for L1 summarization.
 */
export function buildL1Prompt(l0Summaries: MemorySummary[]): string {
    const formatted = l0Summaries
        .map(
            (s, i) =>
                `Chapter ${i + 1} (messages ${s.messageRange[0]}-${s.messageRange[1]}):\n${s.content}`
        )
        .join('\n\n');

    return `--- Chapter Summaries ---\n${formatted}\n\n--- End ---\n\nCombine into a section summary:`;
}

/**
 * Build the prompt for L2 summarization.
 */
export function buildL2Prompt(l1Summaries: MemorySummary[]): string {
    const formatted = l1Summaries
        .map(
            (s, i) =>
                `Section ${i + 1} (messages ${s.messageRange[0]}-${s.messageRange[1]}):\n${s.content}`
        )
        .join('\n\n');

    return `--- Section Summaries ---\n${formatted}\n\n--- End ---\n\nCombine into an arc summary:`;
}

/**
 * Create and save a summary object.
 */
export async function createSummary(
    conversationId: string,
    level: SummaryLevel,
    content: string,
    keyFacts: string[],
    messageRange: [number, number],
    childIds: string[] = [],
    /** Active-branch message IDs at creation time (branch-aware filtering). */
    branchPath?: string[]
): Promise<MemorySummary> {
    const summary: MemorySummary = {
        id: crypto.randomUUID(),
        conversationId,
        level,
        messageRange,
        content,
        keyFacts,
        childIds,
        createdAt: Date.now(),
        branchPath,
    };

    await saveSummary(summary);
    return summary;
}

// ============================================
// The Chronicle — rendering memory for injection
// ============================================

export interface ChronicleStats {
    /** Arcs actually rendered with their text. */
    arcs: number;
    /** Sections actually rendered with their text. */
    sections: number;
    /** Uncovered Fragments rendered to bridge the gap before the verbatim window. */
    fragments: number;
    /** Arcs listed but not rendered (budget). */
    omittedArcs: number;
    /** Sections shown as a placeholder under their Arc (budget). */
    omittedSections: number;
    /**
     * Messages that left the verbatim window WITHOUT ever being summarized. These are gone
     * from the model's memory entirely — nothing else covers them now that facts and vector
     * chunks are gone. Non-zero means the summary pipeline is behind, or was off.
     */
    uncoveredEvictedMessages: number;
}

export interface ChronicleResult {
    text: string;
    stats: ChronicleStats;
}

const EMPTY_STATS: ChronicleStats = {
    arcs: 0,
    sections: 0,
    fragments: 0,
    omittedArcs: 0,
    omittedSections: 0,
    uncoveredEvictedMessages: 0,
};

/** A Chronicle that says nothing — for callers that need a value before retrieval runs. */
export const EMPTY_CHRONICLE: ChronicleResult = { text: '', stats: EMPTY_STATS };

/**
 * English, like the rest of the assembled prompt (`[CURRENT CONTEXT]`, `[ARC]`,
 * `[IN THIS RP]`). The summaries nested inside are written in the roleplay's own language.
 */
const CHRONICLE_PREAMBLE = `[CHRONICLE — what has already happened in this story, oldest first.
The levels OVERLAP: an Arc summarizes the SAME period as the Sections nested under it, only
more compressed; a Section summarizes the SAME period as its Fragments. NEVER treat an Arc and
its Sections as two different sequences of events — they are one sequence at two zoom levels.
The most recent messages appear in full in the conversation above.]`;

const OMITTED_SECTION_LINE = '(this period is covered by the Arc above)';
const STILL_LIVE_MARKER = ' (the end of this period also appears in full above)';

/** `[0, 50]` → `messages 1-50`. Stored ranges are 0-based with an EXCLUSIVE end. */
function rangeLabel(range: [number, number]): string {
    return `messages ${range[0] + 1}-${range[1]}`;
}

/**
 * Does `outer` fully contain `inner`? Coverage is decided on ranges, not by walking
 * `childIds`: the old two-hop lookup (Arc → Section → Fragment) silently reported "not
 * covered" whenever the intermediate Section had been filtered out, and re-injected an Arc
 * together with its own Fragments.
 */
function covers(outer: [number, number], inner: [number, number]): boolean {
    return inner[0] >= outer[0] && inner[1] <= outer[1];
}

function indent(text: string, pad: string): string {
    return text
        .split('\n')
        .map((line) => (line.trim() ? pad + line : line))
        .join('\n');
}

/**
 * Build the Chronicle block for injection.
 *
 * Budget policy, most to least essential — what is dropped first is what the Arc above it
 * already covers:
 *  1. bridging Fragments — the stretch between the last Section and the verbatim window. A
 *     hole here is the worst possible one: it sits immediately before what the model can see.
 *  2. every Arc — the spine, few and compressed.
 *  3. Sections, newest first, with whatever is left.
 *
 * @param budget Hard ceiling. The returned text is guaranteed to cost at most this.
 * @param evictedMessageCount Messages pushed out of the verbatim window. Zero means nothing
 *   was evicted yet, so the raw history already says everything → empty result.
 */
export async function buildChronicle(
    conversationId: string,
    budget: number,
    evictedMessageCount?: number,
    activeBranchMessageIds?: string[]
): Promise<ChronicleResult> {
    if (budget <= 0) return { text: '', stats: { ...EMPTY_STATS } };
    if (evictedMessageCount !== undefined && evictedMessageCount <= 0) {
        return { text: '', stats: { ...EMPTY_STATS } };
    }

    let summaries = await getSummariesByConversation(conversationId);

    if (activeBranchMessageIds && activeBranchMessageIds.length > 0) {
        const branchSet = new Set(activeBranchMessageIds);
        summaries = summaries.filter((s) =>
            // Legacy summaries without branchPath stay (graceful degradation).
            s.branchPath && s.branchPath.length > 0
                ? s.branchPath.some((id) => branchSet.has(id))
                : true
        );
    }

    // Coverage is measured BEFORE the eviction filter: it is what the pipeline has summarized
    // so far, independent of what we are about to inject.
    const allL0 = summaries.filter((s) => s.level === 0);
    const coveredCount = allL0.length > 0 ? Math.max(...allL0.map((s) => s.messageRange[1])) : 0;
    const uncoveredEvictedMessages =
        evictedMessageCount !== undefined ? Math.max(0, evictedMessageCount - coveredCount) : 0;

    if (evictedMessageCount !== undefined) {
        summaries = summaries.filter((s) =>
            s.level === 0
                ? // A Fragment earns its place only once its whole range is out of the window.
                  s.messageRange[1] <= evictedMessageCount
                : // Arcs/Sections may straddle the boundary — harmless now that every entry
                  // carries its range and the preamble spells out the overlap.
                  s.messageRange[0] < evictedMessageCount
        );
    }

    const stats: ChronicleStats = { ...EMPTY_STATS, uncoveredEvictedMessages };
    if (summaries.length === 0) return { text: '', stats };

    const byRange = (a: MemorySummary, b: MemorySummary) => a.messageRange[0] - b.messageRange[0];
    const arcs = summaries.filter((s) => s.level === 2).sort(byRange);
    const sections = summaries.filter((s) => s.level === 1).sort(byRange);
    const fragments = summaries.filter((s) => s.level === 0).sort(byRange);

    // Numbering follows chronology, not creation time: a regenerated Arc keeps its number.
    const arcNumber = new Map(arcs.map((a, i) => [a.id, i + 1]));
    const sectionNumber = new Map(sections.map((s, i) => [s.id, i + 1]));

    const liveMarker = (s: MemorySummary) =>
        evictedMessageCount !== undefined && s.messageRange[1] > evictedMessageCount
            ? STILL_LIVE_MARKER
            : '';

    const renderArc = (a: MemorySummary) =>
        `■ ARC ${arcNumber.get(a.id)} — ${rangeLabel(a.messageRange)}${liveMarker(a)}\n${a.content}`;
    const renderSection = (s: MemorySummary) =>
        indent(
            `▸ Section ${sectionNumber.get(s.id)} — ${rangeLabel(s.messageRange)}${liveMarker(s)}\n${s.content}`,
            '  '
        );
    const renderOmittedSection = (s: MemorySummary) =>
        indent(
            `▸ Section ${sectionNumber.get(s.id)} — ${rangeLabel(s.messageRange)}\n${OMITTED_SECTION_LINE}`,
            '  '
        );

    // A Fragment whose period a Section already covers is redundant — even if that Section is
    // later dropped for budget, its Arc still covers the period.
    const bridging = fragments.filter(
        (f) => !sections.some((s) => covers(s.messageRange, f.messageRange))
    );

    let remaining = budget - countTokens(CHRONICLE_PREAMBLE);
    if (remaining <= 0) return { text: '', stats };

    // 1. Bridging fragments, newest first, then back into chronological order.
    let keptFragments: MemorySummary[] = [];
    if (bridging.length > 0) {
        const fitted = fitRankedBlock(
            [...bridging].reverse(),
            (f) => f.content,
            '',
            Math.min(remaining, Math.floor(budget * 0.4)),
            { separator: '\n\n' }
        );
        if (fitted) {
            keptFragments = [...fitted.kept].sort(byRange);
            remaining -= fitted.tokens;
        }
    }

    // 2. Arcs — newest first, so a tight budget keeps the recent spine.
    let keptArcs: MemorySummary[] = [];
    if (arcs.length > 0 && remaining > 0) {
        const fitted = fitRankedBlock([...arcs].reverse(), renderArc, '', remaining, {
            separator: '\n\n',
        });
        if (fitted) {
            keptArcs = [...fitted.kept].sort(byRange);
            remaining -= fitted.tokens;
        }
    }

    // 3. Sections with what is left, newest first.
    let keptSections: MemorySummary[] = [];
    if (sections.length > 0 && remaining > 0) {
        const fitted = fitRankedBlock([...sections].reverse(), renderSection, '', remaining, {
            separator: '\n\n',
        });
        if (fitted) keptSections = [...fitted.kept].sort(byRange);
    }

    const keptArcIds = new Set(keptArcs.map((a) => a.id));
    let keptSectionIds = new Set(keptSections.map((s) => s.id));

    const assemble = (sectionIds: Set<string>, frags: MemorySummary[]) =>
        renderChronicle({
            arcs,
            sections,
            fragments: frags,
            keptArcIds,
            keptSectionIds: sectionIds,
            arcNumber,
            renderArc,
            renderSection,
            renderOmittedSection,
        });

    // Verify against the REAL token count and shed the oldest Section until it fits: the
    // per-entry estimate can undershoot once everything is joined together.
    let text = assemble(keptSectionIds, keptFragments);
    while (countTokens(text) > budget && keptSectionIds.size > 0) {
        const oldest = sections.find((s) => keptSectionIds.has(s.id))!;
        keptSectionIds = new Set([...keptSectionIds].filter((id) => id !== oldest.id));
        text = assemble(keptSectionIds, keptFragments);
    }
    // Last resort: the Arcs alone still overflow. Give up the bridging fragments too.
    if (countTokens(text) > budget && keptFragments.length > 0) {
        keptFragments = [];
        text = assemble(keptSectionIds, keptFragments);
    }
    if (countTokens(text) > budget) return { text: '', stats };

    stats.arcs = keptArcIds.size;
    stats.sections = keptSectionIds.size;
    stats.fragments = keptFragments.length;
    stats.omittedArcs = arcs.length - keptArcIds.size;
    stats.omittedSections = sections.length - keptSectionIds.size;
    return { text, stats };
}

/** Nest the kept entries under their Arcs. Pure: same inputs → same string. */
function renderChronicle(input: {
    arcs: MemorySummary[];
    sections: MemorySummary[];
    fragments: MemorySummary[];
    keptArcIds: Set<string>;
    keptSectionIds: Set<string>;
    arcNumber: Map<string, number>;
    renderArc: (s: MemorySummary) => string;
    renderSection: (s: MemorySummary) => string;
    renderOmittedSection: (s: MemorySummary) => string;
}): string {
    const { arcs, sections, fragments, keptArcIds, keptSectionIds, arcNumber } = input;
    const parts: string[] = [CHRONICLE_PREAMBLE];

    const droppedArcs = arcs.filter((a) => !keptArcIds.has(a.id));
    if (droppedArcs.length > 0) {
        const from = droppedArcs[0];
        const to = droppedArcs[droppedArcs.length - 1];
        // Say it out loud rather than leaving a silent hole in the numbering.
        parts.push(
            `[Arcs ${arcNumber.get(from.id)}-${arcNumber.get(to.id)} — messages ${
                from.messageRange[0] + 1
            }-${to.messageRange[1]}: omitted for space]`
        );
    }

    const claimed = new Set<string>();
    for (const arc of arcs) {
        if (!keptArcIds.has(arc.id)) continue;
        const block: string[] = [input.renderArc(arc)];
        for (const section of sections) {
            if (!covers(arc.messageRange, section.messageRange)) continue;
            claimed.add(section.id);
            block.push(
                keptSectionIds.has(section.id)
                    ? input.renderSection(section)
                    : input.renderOmittedSection(section)
            );
        }
        parts.push(block.join('\n\n'));
    }

    // Sections under no rendered Arc: the tail of the story, or Arcs dropped for space.
    for (const section of sections) {
        if (claimed.has(section.id) || !keptSectionIds.has(section.id)) continue;
        parts.push(input.renderSection(section));
    }

    if (fragments.length > 0) {
        const from = fragments[0].messageRange[0] + 1;
        const to = fragments[fragments.length - 1].messageRange[1];
        parts.push(
            `▸ Recent fragments — messages ${from}-${to}\n${fragments
                .map((f) => f.content)
                .join('\n')}`
        );
    }

    return parts.join('\n\n');
}
