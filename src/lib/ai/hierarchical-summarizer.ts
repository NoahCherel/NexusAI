/**
 * Hierarchical Summarization Service
 * 
 * Implements a 3-level pyramid of summaries:
 * - Level 0: Chunk summaries (every ~10 messages) — ~200 tokens each
 * - Level 1: Section summaries (every ~5 L0 summaries) — ~150 tokens each
 * - Level 2: Arc summaries (every ~3 L1 summaries) — ~100 tokens each
 * 
 * Each level compresses the level below, creating an efficient memory hierarchy.
 */

import type { MemorySummary, SummaryLevel } from '@/types/rag';
import type { Message } from '@/types/chat';
import { saveSummary, getSummariesByConversation } from '@/lib/db';
import { countTokens } from '@/lib/tokenizer';

// Configuration
export const DEFAULT_CHUNK_SIZE = 10;  // Messages per L0 summary (default)
const L1_THRESHOLD = 5;      // L0 summaries per L1 summary
const L2_THRESHOLD = 3;      // L1 summaries per L2 summary

export const SUMMARIZATION_PROMPT_L0 = `You are a RPG session chronicler. Summarize this chunk of roleplay messages into a concise narrative paragraph.

RULES:
- Write in past tense, third person
- Capture: WHO did WHAT, WHERE, key decisions, important dialogue
- Include specific names, items, locations
- Max 3-4 sentences
- Also extract 3-5 KEY FACTS as a separate list (atomic, searchable statements)
- Output in this JSON format:

{
  "summary": "narrative summary paragraph...",
  "keyFacts": ["fact 1", "fact 2", "fact 3"]
}`;

export const SUMMARIZATION_PROMPT_L1 = `You are a RPG story arc compiler. Combine these chapter summaries into a broader section summary.

RULES:
- Write in past tense, third person
- Focus on overarching plot progression, character development, and consequences
- Preserve critical names, items, and locations
- Max 2-3 sentences
- Extract 2-3 CRITICAL facts that define this section
- Output JSON:

{
  "summary": "section summary...",
  "keyFacts": ["critical fact 1", "critical fact 2"]
}`;

export const SUMMARIZATION_PROMPT_L2 = `You are a RPG epic chronicler. Combine these section summaries into a grand arc summary.

RULES:
- Write in past tense, third person
- Capture the overarching narrative arc, major turning points
- This is the highest-level summary — it should give someone a complete overview
- Max 2-3 sentences
- Extract 1-2 defining facts of the entire arc
- Output JSON:

{
  "summary": "arc summary...",
  "keyFacts": ["defining fact 1"]
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
    const l0Summaries = existingSummaries.filter(s => s.level === 0);
    // Use the actual highest message index covered by existing summaries
    const coveredMessages = l0Summaries.length > 0
        ? Math.max(...l0Summaries.map(s => s.messageRange[1]))
        : 0;
    return messageCount - coveredMessages >= chunkSize;
}

/**
 * Check if L1 summary is needed.
 */
export function shouldCreateL1Summary(existingSummaries: MemorySummary[]): boolean {
    const l0Summaries = existingSummaries.filter(s => s.level === 0);
    const l1Summaries = existingSummaries.filter(s => s.level === 1);
    const uncoveredL0 = l0Summaries.length - (l1Summaries.length * L1_THRESHOLD);
    return uncoveredL0 >= L1_THRESHOLD;
}

/**
 * Check if L2 summary is needed.
 */
export function shouldCreateL2Summary(existingSummaries: MemorySummary[]): boolean {
    const l1Summaries = existingSummaries.filter(s => s.level === 1);
    const l2Summaries = existingSummaries.filter(s => s.level === 2);
    const uncoveredL1 = l1Summaries.length - (l2Summaries.length * L2_THRESHOLD);
    return uncoveredL1 >= L2_THRESHOLD;
}

/**
 * Get messages that need to be summarized (not yet covered by L0 summaries).
 * Uses actual message ranges from existing summaries rather than assuming fixed chunk sizes.
 */
export function getUnsummarizedMessages(
    messages: Message[],
    existingSummaries: MemorySummary[]
): Message[] {
    const l0Summaries = existingSummaries.filter(s => s.level === 0);
    // Use the actual highest message index covered by existing summaries
    const coveredCount = l0Summaries.length > 0
        ? Math.max(...l0Summaries.map(s => s.messageRange[1]))
        : 0;
    
    // Sort by creation time
    const sorted = [...messages].sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
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
        .filter(s => s.level === 0)
        .sort((a, b) => a.messageRange[0] - b.messageRange[0]);
    
    const l1s = existingSummaries.filter(s => s.level === 1);
    const alreadyCoveredL0Ids = new Set(l1s.flatMap(l1 => l1.childIds));
    
    const uncovered = l0s.filter(l0 => !alreadyCoveredL0Ids.has(l0.id));
    
    if (uncovered.length < L1_THRESHOLD) return null;
    return uncovered.slice(0, L1_THRESHOLD);
}

/**
 * Get L1 summaries that need to be combined into an L2 summary.
 */
export function getL1SummariesForL2(existingSummaries: MemorySummary[]): MemorySummary[] | null {
    const l1s = existingSummaries
        .filter(s => s.level === 1)
        .sort((a, b) => a.messageRange[0] - b.messageRange[0]);
    
    const l2s = existingSummaries.filter(s => s.level === 2);
    const alreadyCoveredL1Ids = new Set(l2s.flatMap(l2 => l2.childIds));
    
    const uncovered = l1s.filter(l1 => !alreadyCoveredL1Ids.has(l1.id));
    
    if (uncovered.length < L2_THRESHOLD) return null;
    return uncovered.slice(0, L2_THRESHOLD);
}

/**
 * Parse the summarization response.
 */
export function parseSummarizationResponse(text: string): { summary: string; keyFacts: string[] } | null {
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
export function buildL0Prompt(messages: Message[], characterName: string, userName: string): string {
    const formatted = messages
        .map(m => `${m.role === 'user' ? userName : characterName}: ${m.content}`)
        .join('\n\n');
    
    return `Character: ${characterName}\nPlayer: ${userName}\n\n--- Messages ---\n${formatted}\n\n--- End Messages ---\n\nSummarize this chunk:`;
}

/**
 * Build the prompt for L1 summarization.
 */
export function buildL1Prompt(l0Summaries: MemorySummary[]): string {
    const formatted = l0Summaries
        .map((s, i) => `Chapter ${i + 1} (messages ${s.messageRange[0]}-${s.messageRange[1]}):\n${s.content}`)
        .join('\n\n');
    
    return `--- Chapter Summaries ---\n${formatted}\n\n--- End ---\n\nCombine into a section summary:`;
}

/**
 * Build the prompt for L2 summarization.
 */
export function buildL2Prompt(l1Summaries: MemorySummary[]): string {
    const formatted = l1Summaries
        .map((s, i) => `Section ${i + 1} (messages ${s.messageRange[0]}-${s.messageRange[1]}):\n${s.content}`)
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
    embedding?: number[]
): Promise<MemorySummary> {
    const summary: MemorySummary = {
        id: crypto.randomUUID(),
        conversationId,
        level,
        messageRange,
        content,
        keyFacts,
        embedding,
        childIds,
        createdAt: Date.now(),
    };

    await saveSummary(summary);
    return summary;
}

/**
 * Get the best available summary for context injection.
 * Returns the highest-level summary available, or combines lower levels.
 */
/**
 * Remove near-duplicate summaries (>60% word overlap).
 * Keeps the first (most recent) of each similar group.
 */
function deduplicateSummaries(summaries: MemorySummary[]): MemorySummary[] {
    const result: MemorySummary[] = [];
    for (const s of summaries) {
        const isDup = result.some(existing => computeWordOverlap(existing.content, s.content) > 0.6);
        if (!isDup) result.push(s);
    }
    return result;
}

export async function getBestContextSummary(
    conversationId: string,
    maxTokens: number = 300
): Promise<string> {
    const summaries = await getSummariesByConversation(conversationId);
    if (summaries.length === 0) return '';

    // Try L2 first (most compressed)
    const l2s = summaries
        .filter(s => s.level === 2)
        .sort((a, b) => b.createdAt - a.createdAt);
    
    if (l2s.length > 0) {
        let result = '📖 Story Arc:\n' + l2s.map(s => s.content).join('\n');
        
        // If budget allows, add recent L0 not covered by L2
        const coveredByL2 = new Set<string>();
        for (const l2 of l2s) {
            for (const l1Id of l2.childIds) {
                const l1 = summaries.find(s => s.id === l1Id);
                if (l1) l1.childIds.forEach(id => coveredByL2.add(id));
            }
        }
        
        const recentUncovered = summaries
            .filter(s => s.level === 0 && !coveredByL2.has(s.id))
            .sort((a, b) => b.createdAt - a.createdAt);
        
        if (recentUncovered.length > 0 && countTokens(result) < maxTokens - 100) {
            const dedupedRecent = deduplicateSummaries(recentUncovered);
            result += '\n\n📝 Recent Events:\n' + dedupedRecent.map(s => s.content).join('\n');
        }
        
        return result;
    }

    // Try L1
    const l1s = summaries
        .filter(s => s.level === 1)
        .sort((a, b) => b.createdAt - a.createdAt);
    
    if (l1s.length > 0) {
        let result = '📖 Story So Far:\n' + l1s.map(s => s.content).join('\n');
        
        // Add uncovered L0s
        const coveredByL1 = new Set(l1s.flatMap(l1 => l1.childIds));
        const recentUncovered = summaries
            .filter(s => s.level === 0 && !coveredByL1.has(s.id))
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 3);
        
        if (recentUncovered.length > 0 && countTokens(result) < maxTokens - 100) {
            const dedupedRecent = deduplicateSummaries(recentUncovered);
            result += '\n\n📝 Recent:\n' + dedupedRecent.map(s => s.content).join('\n');
        }
        
        return result;
    }

    // Only L0 available — take most recent ones within budget, deduplicating similar content
    const l0s = summaries
        .filter(s => s.level === 0)
        .sort((a, b) => b.createdAt - a.createdAt);
    
    let result = '📝 Recent Events:\n';
    let currentTokens = countTokens(result);
    const includedTexts: string[] = [];
    
    for (const s of l0s) {
        const sTokens = countTokens(s.content);
        if (currentTokens + sTokens > maxTokens) break;
        
        // Basic dedup: skip if too similar to an already-included summary
        const isDuplicate = includedTexts.some(existing => {
            const overlap = computeWordOverlap(existing, s.content);
            return overlap > 0.6; // >60% word overlap means near-duplicate
        });
        if (isDuplicate) continue;
        
        result += s.content + '\n';
        currentTokens += sTokens;
        includedTexts.push(s.content);
    }
    
    return result;
}

/**
 * Compute word-level Jaccard overlap between two texts.
 * Returns 0-1 where 1 = identical words.
 */
function computeWordOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let intersection = 0;
    for (const w of wordsA) {
        if (wordsB.has(w)) intersection++;
    }
    const union = wordsA.size + wordsB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Get all summaries organized by level for display.
 */
export async function getSummaryHierarchy(conversationId: string): Promise<{
    l0: MemorySummary[];
    l1: MemorySummary[];
    l2: MemorySummary[];
    totalMessages: number;
}> {
    const summaries = await getSummariesByConversation(conversationId);
    return {
        l0: summaries.filter(s => s.level === 0).sort((a, b) => a.messageRange[0] - b.messageRange[0]),
        l1: summaries.filter(s => s.level === 1).sort((a, b) => a.messageRange[0] - b.messageRange[0]),
        l2: summaries.filter(s => s.level === 2).sort((a, b) => a.messageRange[0] - b.messageRange[0]),
        totalMessages: summaries.reduce((max, s) => Math.max(max, s.messageRange[1]), 0),
    };
}
