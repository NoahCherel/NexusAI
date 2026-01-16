'use client';

import { useCallback, useRef } from 'react';
import { useChatStore, useSettingsStore } from '@/stores';
import {
    shouldAnalyzeMessage,
    ANALYST_PROMPT,
    parseAnalystResponse,
    mergeWorldState,
} from '@/lib/ai/background-analyst';
import { decryptApiKey } from '@/lib/crypto';

interface UseWorldStateAnalyzerReturn {
    analyzeMessage: (
        message: string,
        characterName: string,
        conversationId?: string
    ) => Promise<void>;
    isAnalyzing: boolean;
}

/**
 * Hook that analyzes chat messages and updates world state in the background.
 * Uses a free-tier model to avoid adding cost to the user.
 */
export function useWorldStateAnalyzer(): UseWorldStateAnalyzerReturn {
    const isAnalyzingRef = useRef(false);

    // We don't subscribe to state updates here to avoid re-creating the callback unnecessarily.
    // Instead we read state directly inside the callback.

    const analyzeMessage = useCallback(
        async (message: string, characterName: string, conversationId?: string) => {
            // Check if analysis is needed
            if (!shouldAnalyzeMessage(message)) {
                console.log('[WorldStateAnalyzer] No action verbs detected, skipping');
                return;
            }

            // Get fresh state
            const chatStore = useChatStore.getState();
            const settingsStore = useSettingsStore.getState();

            // Use provided ID or active ID from store
            const targetConversationId = conversationId || chatStore.activeConversationId;

            if (!targetConversationId) {
                console.log('[WorldStateAnalyzer] No active conversation');
                return;
            }

            // Get current world state
            const currentConversation = chatStore.conversations.find(
                (c) => c.id === targetConversationId
            );
            if (!currentConversation) {
                console.log('[WorldStateAnalyzer] Conversation not found in store');
                return;
            }

            const currentWorldState = currentConversation.worldState;

            // Get OpenRouter API key specifically for the Analyst
            const openRouterKeyConfig = settingsStore.apiKeys.find(
                (k) => k.provider === 'openrouter'
            );
            const activePersona = settingsStore.personas.find(
                (p) => p.id === settingsStore.activePersonaId
            );
            const userName = activePersona?.name || 'You';

            if (!openRouterKeyConfig) {
                console.log(
                    '[WorldStateAnalyzer] No OpenRouter API key found for background analysis'
                );
                return;
            }

            isAnalyzingRef.current = true;

            try {
                const apiKey = await decryptApiKey(openRouterKeyConfig.encryptedKey);

                // Replace {{user}} with persona name in message and state for better analysis context
                const processedMessage = message.replace(/{{user}}/gi, userName);
                const processedLocation = (currentWorldState.location || 'Unknown').replace(
                    /{{user}}/gi,
                    userName
                );
                // Inventory/Rel might be arrays/objects, for simplicity we just stringify then replace in the template string below

                // Models to try (primary and fallback)
                // Models to try (primary and fallback)
                // Prioritizing high-intelligence and reasoning models that are free
                const models = [
                    'google/gemini-2.0-flash-exp:free', // Fast, large context, reliable
                    'meta-llama/llama-3.3-70b-instruct:free', // Very high intelligence
                    'deepseek/deepseek-r1:free', // Strong reasoning (if available)
                    'deepseek/deepseek-r1-distill-llama-70b:free', // Good alternative
                    'qwen/qwen-2.5-72b-instruct:free', // Strong performance
                    'mistralai/mistral-large-2411:free', // Mistral's best
                    'nvidia/llama-3.1-nemotron-70b-instruct:free',
                    // User suggested robust fallbacks
                    'deepseek/deepseek-r1-0528:free',
                    'qwen/qwen3-coder:free',
                    'mistralai/mistral-small-3.1-24b-instruct:free',
                    'google/gemma-3-27b-it:free',
                ];

                let response: Response | null = null;
                let usedModel = '';

                for (const model of models) {
                    // ... (fetch loop remains the same)
                    try {
                        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                            method: 'POST',
                            headers: {
                                Authorization: `Bearer ${apiKey}`,
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
                                        content: `Current state:\n- Inventory: ${JSON.stringify(currentWorldState.inventory).replace(/{{user}}/gi, userName)}\n- Location: "${processedLocation}"\n- Relationships: ${JSON.stringify(currentWorldState.relationships).replace(/{{user}}/gi, userName)}\n\nUser Reference:\n- Name: ${userName}\n- Bio: ${activePersona?.bio || 'Unknown'}\n\nNPC Character: ${characterName}\n\nMessage to analyze: "${processedMessage}"`,
                                    },
                                ],
                                max_tokens: 1000, // Increased for reasoning models
                                temperature: 0.1,
                            }),
                        });
                    } catch (e) {
                        console.error(`[WorldStateAnalyzer] Error fetching ${model}:`, e);
                        continue;
                    }

                    if (response.ok) {
                        usedModel = model;
                        break;
                    }

                    if (response.status === 429) {
                        console.log(
                            `[WorldStateAnalyzer] ${model} rate limited, trying fallback...`
                        );
                        continue;
                    }
                    console.log(`[WorldStateAnalyzer] ${model} failed with ${response.status}`);
                }

                if (!response || !response.ok) {
                    const errorText = response ? await response.text() : 'No response';
                    console.log('[WorldStateAnalyzer] All models failed. Last error:', errorText);
                    return;
                }

                console.log(`[WorldStateAnalyzer] Using model: ${usedModel}`);

                const data = await response.json();
                const responseMessage = data.choices?.[0]?.message;
                // Handle various DeepSeek/Reasoning model output locations
                // Some put content in 'content', some in 'reasoning_content', some in 'reasoning'
                const content =
                    responseMessage?.content ||
                    responseMessage?.reasoning_content ||
                    (responseMessage as any)?.reasoning ||
                    '';

                if (!content) {
                    console.log(
                        '[WorldStateAnalyzer] No content in response, data:',
                        JSON.stringify(data)
                    );
                    return;
                }

                // Parse changes
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
                chatStore.updateWorldState(targetConversationId, newWorldState);

                console.log('[WorldStateAnalyzer] World state updated:', {
                    changes,
                    newState: newWorldState,
                });
            } catch (error) {
                console.error('[WorldStateAnalyzer] Error:', error);
            } finally {
                isAnalyzingRef.current = false;
            }
        },
        []
    ); // Empty dependency array = stable function reference!

    return {
        analyzeMessage,
        isAnalyzing: isAnalyzingRef.current,
    };
}
