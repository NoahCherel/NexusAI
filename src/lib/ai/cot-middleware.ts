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

import { extractUsageSentinel, type ProviderUsage } from './usage-sentinel';

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
    llmThinkingDiv:
        /<div\b(?=[^>]*\bclass=(["'])(?=[^"']*\bllm\b)(?=[^"']*\bthinking\b)[^"']*\1)[^>]*>([\s\S]*?)<\/div>/gi,
};

/**
 * Extract and normalize Chain of Thought content from AI responses
 */
export function normalizeCoT(response: string, provider?: string): CoTResult {
    if (!response) {
        return { thought: null, content: '', hasThoughts: false };
    }

    const thoughts: string[] = [];
    let content = response;

    // Try provider-specific pattern first
    if (provider && THOUGHT_PATTERNS[provider]) {
        const pattern = THOUGHT_PATTERNS[provider];
        const matches = [...response.matchAll(pattern)];

        if (matches.length > 0) {
            // Collect all thought blocks
            thoughts.push(...matches.map((m) => m[1].trim()));
            // Remove thought tags from content
            content = response.replace(pattern, '').trim();
        }
    }

    // Always run generic cleanup too: providers can mix formats, and old messages may
    // already contain hidden LLM thinking divs in the saved content.
    const genericPatterns = [THOUGHT_PATTERNS.generic, THOUGHT_PATTERNS.llmThinkingDiv];
    const genericMatches = genericPatterns.flatMap((pattern) =>
        [...content.matchAll(pattern)].map((match) => ({
            pattern,
            text: match[2] ?? match[1] ?? '',
        }))
    );

    if (genericMatches.length > 0) {
        thoughts.push(...genericMatches.map((m) => m.text.trim()));
        content = genericPatterns
            .reduce((current, pattern) => current.replace(pattern, ''), content)
            .trim();
    }

    // Clean up content - remove extra whitespace (preserve single newlines/spaces)
    content = content.replace(/\n{3,}/g, '\n\n');

    // Only trim if specifically requested or if it's the full final response?
    // For safety in streaming, we should NOT trim here.
    // Let the calling code trim if it wants the final result trimmed.

    const thought = thoughts.filter(Boolean).join('\n\n') || null;

    return {
        thought,
        content, // Removed .trim() to preserve leading/trailing spaces in chunks
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

    // Do NOT trim visibleContent here either as it destroys stream spacing
    return { inThought, thoughtContent: thoughtContent, visibleContent };
}

/**
 * The whole stream received so far, split into what the user sees and the model's thinking.
 * Always pass the ACCUMULATED text: a `<think>` opened in one network chunk and closed in a
 * later one is only recognisable on the whole text. The usage sentinel is removed first, so
 * it can never be swallowed by an unclosed thought.
 */
export function splitStreamedReply(
    raw: string,
    provider?: string
): { visible: string; thought: string; usage?: ProviderUsage } {
    const { clean, usage } = extractUsageSentinel(raw);
    // /api/chat wraps each reasoning delta in its own <think>…</think>: join them back into
    // one block, or the thought would be split into one trimmed paragraph per delta.
    const parsed = parseStreamingChunk(clean.replace(/<\/think><think>/g, ''), provider);
    return { visible: parsed.visibleContent, thought: parsed.thoughtContent, usage };
}
