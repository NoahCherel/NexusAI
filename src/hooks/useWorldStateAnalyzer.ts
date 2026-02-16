'use client';

import { useCallback, useRef, useState } from 'react';
import { useChatStore, useSettingsStore, useLorebookStore } from '@/stores';
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
        conversationId?: string,
        force?: boolean
    ) => Promise<void>;
    isAnalyzing: boolean;
}

/**
 * Hook that analyzes chat messages and updates world state in the background.
 * Now uses DeepSeek R1 0528 for enhanced reasoning.
 */
export function useWorldStateAnalyzer(): UseWorldStateAnalyzerReturn {
    const [isAnalyzing, setIsAnalyzing] = useState(false);

    // Helper to perform AI request directly to OpenRouter
    const performAIRequest = async (
        modelList: string[],
        messages: { role: string; content: string }[],
        apiKey: string,
        temperature = 0.1,
        maxTokens = 2000
    ): Promise<{ content: string; usedModel: string } | null> => {
        let usedModel = '';
        let fullContent = '';

        for (const model of modelList) {
            try {
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                        'HTTP-Referer':
                            typeof window !== 'undefined'
                                ? window.location.origin
                                : 'http://localhost:3000',
                        'X-Title': 'NexusAI',
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature,
                        max_tokens: maxTokens,
                        stream: false, // Non-streaming for simpler parsing
                    }),
                });

                if (response.ok) {
                    usedModel = model;
                    const data = await response.json();
                    fullContent = data.choices?.[0]?.message?.content || '';
                    if (fullContent) break;
                } else if (response.status === 429) {
                    // Rate limited, try next model
                    continue;
                } else {
                    const errorText = await response.text();
                    console.error(`[AI] Error fetching ${model}:`, response.status, errorText);
                }
            } catch (e) {
                console.error(`[AI] Error fetching ${model}:`, e);
                continue;
            }
        }

        if (usedModel && fullContent) {
            return { content: fullContent, usedModel };
        }
        return null;
    };

    const analyzeMessage = useCallback(
        async (message: string, characterName: string, conversationId?: string, force = false) => {
            // Check if analysis is needed
            if (!force && !shouldAnalyzeMessage(message)) {
                return;
            }

            const chatStore = useChatStore.getState();
            const settingsStore = useSettingsStore.getState();
            const targetConversationId = conversationId || chatStore.activeConversationId;

            if (!targetConversationId) return;

            // Get current world state
            const currentConversation = chatStore.conversations.find(
                (c) => c.id === targetConversationId
            );
            if (!currentConversation) return;

            const currentWorldState = currentConversation.worldState;
            const openRouterKeyConfig = settingsStore.apiKeys.find(
                (k) => k.provider === 'openrouter'
            );
            const activePersona = settingsStore.personas.find(
                (p) => p.id === settingsStore.activePersonaId
            );
            const userName = activePersona?.name || 'You';

            if (!openRouterKeyConfig) return;

            setIsAnalyzing(true);

            try {
                const apiKey = await decryptApiKey(openRouterKeyConfig.encryptedKey);

                // --- 1. World State Analysis ---
                const processedMessage = message.replace(/{{user}}/gi, userName);
                const processedLocation = (currentWorldState.location || 'Unknown').replace(
                    /{{user}}/gi,
                    userName
                );

                const models = settingsStore.backgroundModel
                    ? [settingsStore.backgroundModel]
                    : [
                          'deepseek/deepseek-r1-0528:free', // Primary
                          'meta-llama/llama-3.3-70b-instruct:free',
                          'mistralai/mistral-small-3.1-24b-instruct:free',
                      ];

                const resultData = await performAIRequest(
                    models,
                    [
                        { role: 'system', content: ANALYST_PROMPT },
                        {
                            role: 'user',
                            content: `Current state:\n- Inventory: ${JSON.stringify(currentWorldState.inventory).replace(/{{user}}/gi, userName)}\n- Location: "${processedLocation}"\n- Relationships: ${JSON.stringify(currentWorldState.relationships).replace(/{{user}}/gi, userName)}\n\nUser Reference:\n- Name: ${userName}\n- Bio: ${activePersona?.bio || 'Unknown'}\n\nNPC Character: ${characterName}\n\nMessage to analyze: "${processedMessage}"`,
                        },
                    ],
                    apiKey,
                    0.5, // Temperature
                    8000 // Increased limit for world state analysis
                );

                if (resultData) {
                    const changes = parseAnalystResponse(resultData.content);
                    if (changes) {
                        const hasChanges =
                            changes.inventory_add.length > 0 ||
                            changes.inventory_remove.length > 0 ||
                            changes.location !== null ||
                            Object.keys(changes.relationship_changes).length > 0;

                        if (hasChanges) {
                            const newWorldState = mergeWorldState(currentWorldState, changes);
                            chatStore.updateWorldState(targetConversationId, newWorldState);
                        }
                    }
                }
            } catch (error) {
                console.error('[WorldStateAnalyzer] Error:', error);
            } finally {
                setIsAnalyzing(false);
            }
        },
        []
    );

    return {
        analyzeMessage,
        isAnalyzing,
    };
}
