/**
 * Chain of Thought (CoT) Middleware
 *
 * Normalizes thinking/reasoning content from different AI providers.
 * Each provider formats CoT differently:
 * - DeepSeek: <think>...</think>
 * - Anthropic: <thinking>...</thinking> (Extended Thinking)
 * - OpenAI o1/o3: reasoning_content in API response
 * - Some models: <reasoning>...</reasoning>
 *
 * This middleware extracts thoughts and returns clean content.
 */

export interface CoTResult {
    thought: string | null;
    content: string;
    hasThoughts: boolean;
}

// Patterns for different providers' thought formats
const THOUGHT_PATTERNS: Record<string, RegExp> = {
    deepseek: /<think>([\s\S]*?)<\/think>/gi,
    anthropic: /<thinking>([\s\S]*?)<\/thinking>/gi,
    openai: /<reasoning>([\s\S]*?)<\/reasoning>/gi,
    generic: /<(?:think(?:ing)?|reasoning)>([\s\S]*?)<\/(?:think(?:ing)?|reasoning)>/gi,
};

/**
 * Extract and normalize Chain of Thought content from AI responses
 */
export function normalizeCoT(response: string, provider?: string): CoTResult {
    if (!response) {
        return { thought: null, content: '', hasThoughts: false };
    }

    let thought: string | null = null;
    let content = response;

    // Try provider-specific pattern first
    if (provider && THOUGHT_PATTERNS[provider]) {
        const pattern = THOUGHT_PATTERNS[provider];
        const matches = [...response.matchAll(pattern)];

        if (matches.length > 0) {
            // Collect all thought blocks
            thought = matches.map((m) => m[1].trim()).join('\n\n');
            // Remove thought tags from content
            content = response.replace(pattern, '').trim();
        }
    }

    // If no provider-specific match, try generic pattern
    if (!thought) {
        const genericPattern = THOUGHT_PATTERNS.generic;
        const matches = [...response.matchAll(genericPattern)];

        if (matches.length > 0) {
            thought = matches.map((m) => m[1].trim()).join('\n\n');
            content = response.replace(genericPattern, '').trim();
        }
    }

    // Clean up content - remove extra whitespace
    content = content.replace(/\n{3,}/g, '\n\n').trim();

    return {
        thought,
        content,
        hasThoughts: thought !== null && thought.length > 0,
    };
}

/**
 * Parse streaming chunk for partial thought detection
 * Returns current state of thought parsing
 */
export function parseStreamingChunk(
    accumulated: string,
    provider?: string
): { inThought: boolean; thoughtContent: string; visibleContent: string } {
    // Check if we're currently inside a thought tag
    const openTags = ['<think>', '<thinking>', '<reasoning>'];
    const closeTags = ['</think>', '</thinking>', '</reasoning>'];

    let inThought = false;
    let thoughtContent = '';
    let visibleContent = '';

    // Simple state machine to track tag nesting
    const lowerAccum = accumulated.toLowerCase();

    for (const openTag of openTags) {
        const closeTag = closeTags[openTags.indexOf(openTag)];
        let searchPos = 0;

        while (searchPos < lowerAccum.length) {
            const openPos = lowerAccum.indexOf(openTag, searchPos);
            if (openPos === -1) break;

            const closePos = lowerAccum.indexOf(closeTag, openPos);

            if (closePos === -1) {
                // Unclosed tag - we're still in a thought
                inThought = true;
                thoughtContent = accumulated.slice(openPos + openTag.length);
                visibleContent = accumulated.slice(0, openPos);
                break;
            } else {
                // Closed tag - extract thought and continue
                thoughtContent += accumulated.slice(openPos + openTag.length, closePos) + '\n';
                searchPos = closePos + closeTag.length;
            }
        }
    }

    // If not in thought, visible content is everything minus extracted thoughts
    if (!inThought) {
        const result = normalizeCoT(accumulated, provider);
        visibleContent = result.content;
        thoughtContent = result.thought || '';
    }

    return { inThought, thoughtContent: thoughtContent.trim(), visibleContent };
}

/**
 * Format thought content for display
 */
export function formatThoughtForDisplay(thought: string): string {
    if (!thought) return '';

    // Clean up and format
    return thought
        .replace(/\n{3,}/g, '\n\n') // Reduce excessive newlines
        .replace(/^\s+|\s+$/g, '') // Trim
        .replace(/^-\s*/gm, '• '); // Convert dashes to bullets
}

/**
 * Check if a model supports reasoning/thinking
 */
export function supportsReasoning(modelId: string): boolean {
    const reasoningModels = [
        'deepseek-r1',
        'deepseek-reasoner',
        'o1',
        'o1-mini',
        'o1-preview',
        'o3',
        'o3-mini',
        'claude-3-opus', // Extended thinking
        'gemini-2.0-flash-thinking',
    ];

    return reasoningModels.some((m) => modelId.toLowerCase().includes(m));
}
