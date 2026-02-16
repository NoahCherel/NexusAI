/**
 * Shared utility for background AI calls (summarization, fact extraction, etc.)
 *
 * Features:
 * - Model fallback chain: tries multiple free models in order
 * - Exponential backoff on 429 rate limits
 * - Global rate limiter to space out requests
 * - Streaming response reading
 */

// Fallback model chain — tried in order, skips on 429
const FREE_MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-r1-0528:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'qwen/qwen3-8b:free',
];

// Global request queue to avoid concurrent rate limit hits
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 2000; // Min 2s between background AI calls

async function waitForSlot(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    lastRequestTime = Date.now();
}

interface BackgroundAIOptions {
    systemPrompt: string;
    userPrompt: string;
    apiKey: string;
    temperature?: number;
    maxTokens?: number;
    /** Override the default model chain */
    models?: string[];
    /** Max retries per model on 429 */
    maxRetries?: number;
    /** User-chosen background model override (from settings). Bypasses fallback chain. */
    backgroundModel?: string | null;
}

interface BackgroundAIResult {
    content: string;
    usedModel: string;
}

/**
 * Make a background AI call with model fallback and rate limit handling.
 * Returns cleaned text (thinking tags removed) or null on total failure.
 */
export async function backgroundAICall(
    options: BackgroundAIOptions
): Promise<BackgroundAIResult | null> {
    const {
        systemPrompt,
        userPrompt,
        apiKey,
        temperature = 0.3,
        maxTokens = 2000,
        models,
        maxRetries = 2,
        backgroundModel,
    } = options;

    // If user chose a specific background model, use only that (no fallback chain)
    const modelChain = backgroundModel ? [backgroundModel] : (models ?? FREE_MODELS);

    for (const model of modelChain) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Wait for global rate limit slot
                await waitForSlot();

                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: userPrompt }],
                        provider: 'openrouter',
                        model,
                        apiKey,
                        systemPrompt,
                        temperature,
                        maxTokens,
                    }),
                });

                if (response.ok) {
                    const text = await readStreamFull(response);
                    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                    if (cleaned) {
                        return { content: cleaned, usedModel: model };
                    }
                    // Empty response — try next model
                    break;
                }

                if (response.status === 429) {
                    if (attempt < maxRetries) {
                        // Exponential backoff: 3s, 6s
                        const delay = 3000 * Math.pow(2, attempt);
                        console.warn(
                            `[BackgroundAI] 429 on ${model}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
                        );
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    // Exhausted retries for this model, try next
                    console.warn(
                        `[BackgroundAI] 429 on ${model}, exhausted retries, trying next model`
                    );
                    break;
                }

                // Other error — try next model
                console.warn(`[BackgroundAI] ${response.status} on ${model}, trying next model`);
                break;
            } catch (err) {
                console.warn(`[BackgroundAI] Error on ${model}:`, err);
                break;
            }
        }
    }

    console.error('[BackgroundAI] All models exhausted');
    return null;
}

/**
 * Read a streaming response body to completion.
 */
async function readStreamFull(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';

    const decoder = new TextDecoder();
    let text = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); // Flush

    return text;
}
