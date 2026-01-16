'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { decryptApiKey } from '@/lib/crypto';

/**
 * Generate a concise RPG state summary using the selected AI model.
 * Returns a string that can be appended to long-term memory.
 */
export async function generateMemorySummary(
    recentMessages: { role: string; content: string }[],
    worldState: { location: string; inventory: string[]; relationships: Record<string, number> },
    characterName: string
): Promise<string> {
    const { apiKeys, activeProvider, activeModel } = useSettingsStore.getState();

    // Get encrypted key for active provider
    const keyConfig = apiKeys.find((k) => k.provider === activeProvider);
    if (!keyConfig) {
        throw new Error(`No API key configured for ${activeProvider}`);
    }

    // Decrypt the API key
    const apiKey = await decryptApiKey(keyConfig.encryptedKey);
    if (!apiKey) {
        throw new Error('Failed to decrypt API key');
    }

    const systemPrompt = `You are a concise RPG session summarizer. Given the recent conversation and world state, create a VERY brief summary (max 3-4 sentences) capturing:
- Current situation/location
- Key recent events
- Important relationship changes
- Any critical items or plot points

Be extremely concise. This summary will be used as long-term memory to reduce token costs.
Output ONLY the summary text, no extra formatting.`;

    const worldContext = `
Current World State:
- Location: ${worldState.location || 'Unknown'}
- Inventory: ${worldState.inventory.length > 0 ? worldState.inventory.join(', ') : 'Empty'}
- Relationships: ${
        Object.entries(worldState.relationships)
            .map(
                ([name, value]) =>
                    `${name}: ${value > 0 ? 'Friendly' : value < 0 ? 'Hostile' : 'Neutral'}`
            )
            .join(', ') || 'None established'
    }
`;

    const messagesContext = recentMessages
        .slice(-10)
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: activeProvider,
                apiKey,
                model: activeModel,
                systemPrompt,
                messages: [
                    {
                        role: 'user',
                        content: `${worldContext}\n\nRecent conversation with ${characterName}:\n${messagesContext}\n\nGenerate a concise summary:`,
                    },
                ],
            }),
        });

        if (!response.ok) {
            throw new Error(`API request failed: ${response.statusText}`);
        }

        // The API returns a streaming text response, consume it as text
        const text = await response.text();

        // Clean up any CoT markers that might be present
        const cleanText = text
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
            .trim();

        return cleanText;
    } catch (error) {
        console.error('Failed to generate memory summary:', error);
        throw error;
    }
}

/**
 * Format a memory entry with timestamp
 */
export function formatMemoryEntry(summary: string): string {
    const now = new Date();
    const timestamp = now.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
    return `[${timestamp}] ${summary}`;
}
