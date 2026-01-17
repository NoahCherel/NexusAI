'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { decryptApiKey } from '@/lib/crypto';
import type { LorebookEntry } from '@/types/character';

/**
 * Extract new world facts from AI response and format as lorebook entries.
 * Uses the selected AI model for extraction.
 */
export async function extractLorebookEntries(
    aiResponse: string,
    existingKeys: string[]
): Promise<LorebookEntry[]> {
    const { apiKeys, activeProvider, activeModel } = useSettingsStore.getState();

    // Get encrypted key for active provider
    const keyConfig = apiKeys.find((k) => k.provider === activeProvider);
    if (!keyConfig) {
        console.warn('No API key configured, skipping lorebook extraction');
        return [];
    }

    // Decrypt the API key
    let apiKey: string;
    try {
        apiKey = await decryptApiKey(keyConfig.encryptedKey);
        if (!apiKey) {
            console.warn('Failed to decrypt API key, skipping lorebook extraction');
            return [];
        }
    } catch {
        console.warn('API key decryption error, skipping lorebook extraction');
        return [];
    }

    const existingKeysStr =
        existingKeys.length > 0
            ? `Existing keys to avoid duplicating: ${existingKeys.join(', ')}`
            : 'No existing keys.';

    const systemPrompt = `You are a world-building assistant Analyze the AI response and extract NEW important world facts that should be remembered.

Rules:
1. Only extract NOVEL information not already in existing keys
2. Be VERY concise - each entry max 2-3 sentences
3. Categorize each entry as: "character", "location", or "notion"
   - character: Named individuals, NPCs, companions
   - location: Places, regions, buildings
   - notion: Concepts, factions, organizations, items, plot points, events
4. Return ONLY a valid JSON array, no markdown, no explanation
5. If no new facts, return exactly: []

${existingKeysStr}

Output format (JSON array only, nothing else):
[{"keys":["keyword1","keyword2"],"content":"Brief description","priority":10,"category":"character"|"location"|"notion"}]`;

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
                        content: `Extract new world facts from this AI response:\n\n${aiResponse}`,
                    },
                ],
            }),
        });

        if (!response.ok) {
            console.error('Lorebook extraction API failed:', response.statusText);
            return [];
        }

        // The API returns a streaming text response, consume it as text
        const text = await response.text();

        // Clean up the response
        const cleanContent = text
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
            .replace(/```json\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();

        // Try to find JSON array in the response
        const jsonMatch = cleanContent.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.log('No JSON array found in lorebook extraction response');
            return [];
        }

        try {
            const entries = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(entries)) return [];

            return entries
                .filter(
                    (
                        e: unknown
                    ): e is {
                        keys: string[];
                        content: string;
                        priority?: number;
                        category?: string;
                    } =>
                        typeof e === 'object' &&
                        e !== null &&
                        Array.isArray((e as { keys?: unknown }).keys) &&
                        typeof (e as { content?: unknown }).content === 'string'
                )
                .map((e) => ({
                    keys: e.keys,
                    content: e.content,
                    enabled: true,
                    priority: e.priority || 10,
                    category: e.category as any,
                })) as unknown as LorebookEntry[];
        } catch {
            console.error('Failed to parse lorebook extraction response:', cleanContent);
            return [];
        }
    } catch (error) {
        console.error('Lorebook extraction failed:', error);
        return [];
    }
}

export const LOREBOOK_AUTO_EXTRACT_KEY = 'lorebook-auto-extract';
