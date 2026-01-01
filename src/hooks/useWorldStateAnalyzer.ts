'use client';

import { useCallback, useRef } from 'react';
import { useChatStore, useSettingsStore } from '@/stores';
import {
    shouldAnalyzeMessage,
    ANALYST_PROMPT,
    parseAnalystResponse,
    mergeWorldState,
    type WorldStateChanges
} from '@/lib/ai/background-analyst';
import { decryptApiKey } from '@/lib/crypto';

interface UseWorldStateAnalyzerReturn {
    analyzeMessage: (message: string, characterName: string) => Promise<void>;
    isAnalyzing: boolean;
}

/**
 * Hook that analyzes chat messages and updates world state in the background.
 * Uses a free-tier model to avoid adding cost to the user.
 */
export function useWorldStateAnalyzer(): UseWorldStateAnalyzerReturn {
    const isAnalyzingRef = useRef(false);

    const { updateWorldState, conversations, activeConversationId } = useChatStore();
    const { apiKeys, activeProvider } = useSettingsStore();

    const analyzeMessage = useCallback(async (message: string, characterName: string) => {
        // Check if analysis is needed
        if (!shouldAnalyzeMessage(message)) {
            console.log('[WorldStateAnalyzer] No action verbs detected, skipping');
            return;
        }

        if (!activeConversationId) {
            console.log('[WorldStateAnalyzer] No active conversation');
            return;
        }

        // Get current world state
        const currentConversation = conversations.find(c => c.id === activeConversationId);
        if (!currentConversation) return;

        const currentWorldState = currentConversation.worldState;

        // Get OpenRouter API key specifically for the Analyst (since we use Gemini Flash via OpenRouter)
        const openRouterKeyConfig = apiKeys.find(k => k.provider === 'openrouter');

        if (!openRouterKeyConfig) {
            console.log('[WorldStateAnalyzer] No OpenRouter API key found for background analysis');
            return;
        }

        isAnalyzingRef.current = true;

        try {
            const apiKey = await decryptApiKey(openRouterKeyConfig.encryptedKey);

            // Models to try (primary and fallback)
            const models = [
                'google/gemini-2.0-flash-exp:free',
                'deepseek/deepseek-r1-0528:free'
            ];

            let response: Response | null = null;
            let usedModel = '';

            for (const model of models) {
                response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': window.location.origin,
                        'X-Title': 'NexusAI World Analyzer',
                    },
                    body: JSON.stringify({
                        model,
                        messages: [
                            { role: 'system', content: ANALYST_PROMPT },
                            {
                                role: 'user',
                                content: `Current state:\n- Inventory: ${JSON.stringify(currentWorldState.inventory)}\n- Location: "${currentWorldState.location || 'Unknown'}"\n- Relationships: ${JSON.stringify(currentWorldState.relationships)}\n\nNPC Character: ${characterName}\n\nMessage to analyze: "${message}"`
                            }
                        ],
                        max_tokens: 300,
                        temperature: 0.1,
                    }),
                });

                if (response.ok) {
                    usedModel = model;
                    break;
                }

                if (response.status === 429) {
                    console.log(`[WorldStateAnalyzer] ${model} rate limited, trying fallback...`);
                    continue;
                }

                // Other error, stop trying
                console.error('[WorldStateAnalyzer] API error:', response.statusText);
                return;
            }

            if (!response || !response.ok) {
                console.log('[WorldStateAnalyzer] All models rate limited, skipping');
                return;
            }

            console.log(`[WorldStateAnalyzer] Using model: ${usedModel}`);

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content;

            if (!content) {
                console.log('[WorldStateAnalyzer] No content in response');
                return;
            }

            console.log('[WorldStateAnalyzer] Raw response:', content);

            const changes = parseAnalystResponse(content);
            if (!changes) {
                console.log('[WorldStateAnalyzer] Could not parse changes');
                return;
            }

            // Check if there are any actual changes
            const hasChanges =
                changes.inventory_add.length > 0 ||
                changes.inventory_remove.length > 0 ||
                changes.location !== null ||
                Object.keys(changes.relationship_changes).length > 0;

            if (!hasChanges) {
                console.log('[WorldStateAnalyzer] No changes detected');
                return;
            }

            // Merge and update
            const newWorldState = mergeWorldState(currentWorldState, changes);
            updateWorldState(activeConversationId, newWorldState);

            console.log('[WorldStateAnalyzer] World state updated:', {
                changes,
                newState: newWorldState
            });

        } catch (error) {
            console.error('[WorldStateAnalyzer] Error:', error);
        } finally {
            isAnalyzingRef.current = false;
        }
    }, [activeConversationId, conversations, apiKeys, activeProvider, updateWorldState]);

    return {
        analyzeMessage,
        isAnalyzing: isAnalyzingRef.current,
    };
}
