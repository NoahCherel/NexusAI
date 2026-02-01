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
            ? `Existing keys (you may still extract NEW info about these): ${existingKeys.join(', ')}`
            : 'No existing keys.';

    const systemPrompt = `You are a world-building assistant. Analyze the AI response and extract world facts.

CRITICAL RULES:
1. Extract ONLY Proper Nouns (Named Characters, Named Unique Locations, Named Unique Artifacts).
2. Do NOT create entries for generic objects, traps, items, formations, or concepts.
3. Extract NEW information about entities, including entities that already exist in the lorebook.
4. Be VERY concise - each entry max 2-3 sentences describing only the NEW facts revealed.
5. Categorize: "character" for persons, "location" for places, "notion" for groups/organizations.

**MOST IMPORTANT - ONE ENTITY PER ENTRY:**
- Each entry must be about EXACTLY ONE entity (one character, one location, etc.)
- The "keys" array should contain ONLY variations of that ONE entity's name (e.g., ["Komoaru", "Komo"] or ["Knight-Captain Ruyijon", "Ruyijon"])
- NEVER put multiple different characters/entities in the same entry
- If two characters interact, create TWO separate entries - one for each character
- Bad example: {"keys":["Noah","Komoaru"],"content":"They escaped together"} ❌
- Good example: {"keys":["Komoaru"],"content":"Revealed to have ice magic abilities"} ✓

6. Only extract genuinely NEW information - don't repeat what's already known.
7. If there is no NEW information to extract, return an empty array: []

${existingKeysStr}

Output format (JSON array only):
[{"keys":["EntityName","AltName"],"content":"NEW facts about this entity","priority":10,"category":"character"}]`;

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: activeProvider,
                apiKey,
                model: activeModel,
                systemPrompt,
                maxTokens: 8000,
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

        // Clean up the response first
        let cleanContent = text
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
            .replace(/```json\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();

        // Robust JSON Extraction: Find the first '[' and last ']'
        const firstBracket = cleanContent.indexOf('[');
        const lastBracket = cleanContent.lastIndexOf(']');

        if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
            console.warn('Lorebook extraction: No JSON array found in response');
            return [];
        }

        const jsonString = cleanContent.substring(firstBracket, lastBracket + 1);

        try {
            const entries = JSON.parse(jsonString);
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
