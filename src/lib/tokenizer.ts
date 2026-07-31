/**
 * Proper token counting using gpt-tokenizer.
 * Replaces the naive `Math.ceil(text.length / 4)` heuristic.
 */
import { encode } from 'gpt-tokenizer';

/**
 * Count exact tokens for a given text using the cl100k_base tokenizer.
 * This is the tokenizer used by GPT-4, GPT-3.5-turbo, and most modern models.
 * It's a reasonable approximation for other models too (within ~10%).
 */
export function countTokens(text: string): number {
    if (!text) return 0;
    try {
        return encode(text).length;
    } catch {
        // Fallback to heuristic if encoding fails
        return Math.ceil(text.length / 4);
    }
}

/**
 * Estimate tokens for multiple texts efficiently.
 */
export function countTokensBatch(texts: string[]): number {
    return texts.reduce((sum, text) => sum + countTokens(text), 0);
}

// ---------------------------------------------------------------------------
// Per-message memoization: every generation re-tokenizes the WHOLE history
// (hundreds of ms of BPE on long chats at the moment the user hits send).
// Finalized messages are immutable, so cache by id + a cheap content hash
// (djb2 ≈ 50× cheaper than BPE; edits and streaming still recount).
// ---------------------------------------------------------------------------

const MESSAGE_TOKEN_CACHE_MAX = 4096;
const messageTokenCache = new Map<string, number>();

function cheapHash(text: string): number {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
        h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return h;
}

/** Memoized `countTokens` for message content, keyed by message id + content hash. */
export function countMessageTokens(id: string, text: string): number {
    if (!text) return 0;
    const key = `${id}:${text.length}:${cheapHash(text)}`;
    const hit = messageTokenCache.get(key);
    if (hit !== undefined) return hit;
    const count = countTokens(text);
    if (messageTokenCache.size >= MESSAGE_TOKEN_CACHE_MAX) {
        const oldest = messageTokenCache.keys().next().value;
        if (oldest) messageTokenCache.delete(oldest);
    }
    messageTokenCache.set(key, count);
    return count;
}

/**
 * Truncate text to fit within a token budget.
 * Returns the truncated text and the actual token count.
 */
export function truncateToTokenBudget(
    text: string,
    maxTokens: number
): { text: string; tokens: number } {
    const tokens = countTokens(text);
    if (tokens <= maxTokens) {
        return { text, tokens };
    }

    // Binary search for the right truncation point
    let low = 0;
    let high = text.length;
    let bestText = '';
    let bestTokens = 0;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const truncated = text.slice(0, mid);
        const count = countTokens(truncated);

        if (count <= maxTokens) {
            bestText = truncated;
            bestTokens = count;
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return { text: bestText, tokens: bestTokens };
}
