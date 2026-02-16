/**
 * Vector Embedding Service
 *
 * Uses @xenova/transformers (all-MiniLM-L6-v2) for client-side embeddings.
 * Falls back to a TF-IDF/BM25 approach if the model can't be loaded.
 * Runs in the main thread (Web Workers are complex with Next.js).
 */

// Dynamic import to avoid SSR issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Xenova/transformers types are dynamic
let pipeline: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Xenova/transformers embedder instance
let embedderInstance: any = null;
let isLoading = false;
let loadError: Error | null = null;

// Simple in-memory cache for recently computed embeddings
const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 500;

/**
 * Initialize the embedder (lazy load).
 * Returns true if successfully loaded, false otherwise.
 */
export async function initEmbedder(): Promise<boolean> {
    if (embedderInstance) return true;
    if (loadError) return false;
    if (isLoading) {
        // Wait for current load
        while (isLoading) {
            await new Promise((r) => setTimeout(r, 100));
        }
        return !!embedderInstance;
    }

    isLoading = true;
    try {
        const transformers = await import('@xenova/transformers');
        pipeline = transformers.pipeline;
        embedderInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
            // Use quantized model for faster loading (~6MB vs ~23MB)
            quantized: true,
        });
        console.log('[Embedder] Model loaded successfully');
        return true;
    } catch (error) {
        loadError = error as Error;
        console.warn('[Embedder] Failed to load ML model, falling back to TF-IDF:', error);
        return false;
    } finally {
        isLoading = false;
    }
}

/**
 * Generate embedding for a text using the ML model.
 */
export async function embedText(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
        return new Array(384).fill(0);
    }

    // Check cache
    const cacheKey = text.slice(0, 200); // Use first 200 chars as key
    if (embeddingCache.has(cacheKey)) {
        return embeddingCache.get(cacheKey)!;
    }

    const modelReady = await initEmbedder();

    let embedding: number[];

    if (modelReady && embedderInstance) {
        try {
            // Truncate input to ~128 tokens (~512 chars) for MiniLM
            const truncated = text.slice(0, 512);
            const output = await embedderInstance(truncated, {
                pooling: 'mean',
                normalize: true,
            });
            embedding = Array.from(output.data as Float32Array);
        } catch (error) {
            console.error('[Embedder] ML embedding failed, using fallback:', error);
            embedding = tfidfEmbed(text);
        }
    } else {
        embedding = tfidfEmbed(text);
    }

    // Cache the result
    if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value;
        if (firstKey) embeddingCache.delete(firstKey);
    }
    embeddingCache.set(cacheKey, embedding);

    return embedding;
}

/**
 * Batch embed multiple texts efficiently.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
    // Process sequentially to avoid OOM
    const results: number[][] = [];
    for (const text of texts) {
        results.push(await embedText(text));
    }
    return results;
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dot = 0,
        normA = 0,
        normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;
    return dot / magnitude;
}

/**
 * Find top-K most similar items from a collection.
 */
export function findTopK<T extends { embedding?: number[] }>(
    query: number[],
    items: T[],
    k: number = 5,
    minScore: number = 0.1
): Array<{ item: T; score: number }> {
    return items
        .filter((item) => item.embedding && item.embedding.length > 0)
        .map((item) => ({
            item,
            score: cosineSimilarity(query, item.embedding!),
        }))
        .filter((r) => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
}

// ============================================
// TF-IDF Fallback Embedding
// ============================================

// Common English/French stop words
const STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'shall',
    'can',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'and',
    'but',
    'or',
    'not',
    'no',
    'this',
    'that',
    'these',
    'those',
    'it',
    'its',
    'he',
    'she',
    'they',
    'we',
    'you',
    'i',
    'me',
    'my',
    'your',
    'his',
    'her',
    'their',
    'our',
    'le',
    'la',
    'les',
    'un',
    'une',
    'des',
    'du',
    'de',
    'et',
    'ou',
    'je',
    'tu',
    'il',
    'elle',
    'nous',
    'vous',
    'ils',
    'elles',
    'ce',
    'qui',
    'que',
    'ne',
    'pas',
    'dans',
    'sur',
    'pour',
    'avec',
    'se',
]);

/**
 * Simple TF-IDF-based embedding as fallback.
 * Creates a fixed-size hash-based vector from word frequencies.
 */
function tfidfEmbed(text: string): number[] {
    const DIM = 384; // Match MiniLM dimension
    const vector = new Array(DIM).fill(0);

    // Tokenize and filter
    const words = text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    if (words.length === 0) return vector;

    // Hash each word to a dimension and accumulate
    for (const word of words) {
        const hash = simpleHash(word);
        const dim = Math.abs(hash) % DIM;
        const sign = hash > 0 ? 1 : -1;
        vector[dim] += sign * (1 / words.length); // Normalized TF
    }

    // Also use bigrams for some semantic capture
    for (let i = 0; i < words.length - 1; i++) {
        const bigram = words[i] + '_' + words[i + 1];
        const hash = simpleHash(bigram);
        const dim = Math.abs(hash) % DIM;
        const sign = hash > 0 ? 1 : -1;
        vector[dim] += sign * (0.5 / words.length);
    }

    // L2 normalize
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < DIM; i++) vector[i] /= norm;
    }

    return vector;
}

function simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}

/**
 * Check if the ML embedder is available.
 */
export function isEmbedderReady(): boolean {
    return !!embedderInstance;
}

/**
 * Get embedder status for UI.
 */
export function getEmbedderStatus(): 'loading' | 'ready' | 'fallback' | 'idle' {
    if (isLoading) return 'loading';
    if (embedderInstance) return 'ready';
    if (loadError) return 'fallback';
    return 'idle';
}
