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

            // Use Gemini Flash (free) for analysis via OpenRouter
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'NexusAI World Analyzer',
                },
                body: JSON.stringify({
                    model: 'google/gemini-2.0-flash-exp:free',
                    messages: [
                        { role: 'system', content: ANALYST_PROMPT },
                        {
                            role: 'user',
                            content: `État actuel:\n- Inventaire: ${JSON.stringify(currentWorldState.inventory)}\n- Lieu: "${currentWorldState.location || 'Inconnu'}"\n- Relations: ${JSON.stringify(currentWorldState.relationships)}\n\nPersonnage PNJ: ${characterName}\n\nMessage à analyser: "${message}"`
                        }
                    ],
                    max_tokens: 300,
                    temperature: 0.1, // Low temp for consistent parsing
                }),
            });

            if (!response.ok) {
                console.error('[WorldStateAnalyzer] API error:', response.statusText);
                return;
            }

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
