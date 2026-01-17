'use client';

import { useCallback, useRef } from 'react';
import { useChatStore, useSettingsStore, useLorebookStore } from '@/stores';
import {
    shouldAnalyzeMessage,
    ANALYST_PROMPT,
    parseAnalystResponse,
    mergeWorldState,
    LOREBOOK_CONSOLIDATION_PROMPT,
    parseConsolidationResponse,
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
 * Now uses DeepSeek R1 0528 for enhanced reasoning.
 */
export function useWorldStateAnalyzer(): UseWorldStateAnalyzerReturn {
    const isAnalyzingRef = useRef(false);
    const isConsolidatingRef = useRef(false);

    // Helper to perform AI request
    const performAIRequest = async (
        modelList: string[],
        messages: { role: string; content: string }[],
        apiKey: string,
        temperature = 0.1
    ) => {
        let response: Response | null = null;
        let usedModel = '';

        for (const model of modelList) {
            try {
                response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': window.location.origin,
                        'X-Title': 'NexusAI Analyst',
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        max_tokens: 2000,
                        temperature,
                    }),
                });
            } catch (e) {
                console.error(`[AI] Error fetching ${model}:`, e);
                continue;
            }

            if (response.ok) {
                usedModel = model;
                break;
            }

            if (response.status === 429) {
                console.log(`[AI] ${model} rate limited, trying fallback...`);
                continue;
            }
        }
        return { response, usedModel };
    };

    const consolidateLorebook = useCallback(async (conversationId: string, apiKey: string) => {
        if (isConsolidatingRef.current) return;

        const { activeLorebook, updateLorebook } = useLorebookStore.getState();
        if (!activeLorebook || activeLorebook.entries.length < 2) return;

        console.log('[LorebookManager] Starting consolidation check...');
        isConsolidatingRef.current = true;

        try {
            const entriesList = activeLorebook.entries
                .map((e, i) => `[${i}] Keywords: ${e.keys.join(', ')}\nContent: ${e.content}`)
                .join('\n\n');

            const models = [
                'deepseek/deepseek-r1-0528:free', // Primary for reasoning
                'deepseek/deepseek-r1:free',
                'meta-llama/llama-3.3-70b-instruct:free',
                'google/gemini-2.0-flash-exp:free',
            ];

            const { response, usedModel } = await performAIRequest(
                models,
                [
                    { role: 'system', content: LOREBOOK_CONSOLIDATION_PROMPT },
                    { role: 'user', content: `Lorebook Entries:\n${entriesList}` },
                ],
                apiKey
            );

            if (!response || !response.ok) return;
            console.log(`[LorebookManager] Consolidating using ${usedModel}`);

            const data = await response.json();
            const content =
                data.choices?.[0]?.message?.content ||
                data.choices?.[0]?.message?.reasoning_content ||
                '';
            const result = parseConsolidationResponse(content);

            if (result && result.consolidated.length > 0) {
                // Apply merges
                // We specifically keep 'unchanged' entries and add 'consolidated' ones
                // But wait, if we remove original indices, we must be careful not to shift indices during processing if not careful.
                // Safest way:
                // 1. Identify all indices that are part of a merge.
                // 2. Keep entries NOT in that set.
                // 3. Add new merged entries.

                const mergedIndices = new Set<number>();
                result.consolidated.forEach((c) =>
                    c.originalIndices.forEach((idx) => mergedIndices.add(idx))
                );

                const newEntries = activeLorebook.entries.filter((_, i) => !mergedIndices.has(i));

                result.consolidated.forEach((c) => {
                    newEntries.push({
                        keys: c.keywords,
                        content: c.content,
                        enabled: true,
                    });
                });

                updateLorebook({ ...activeLorebook, entries: newEntries });
                console.log(
                    `[LorebookManager] Merged ${mergedIndices.size} entries into ${result.consolidated.length}.`
                );
            }
        } catch (error) {
            console.error('[LorebookManager] Error:', error);
        } finally {
            isConsolidatingRef.current = false;
        }
    }, []);

    const analyzeMessage = useCallback(
        async (message: string, characterName: string, conversationId?: string) => {
            // Check if analysis is needed
            if (!shouldAnalyzeMessage(message)) {
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

            isAnalyzingRef.current = true;

            try {
                const apiKey = await decryptApiKey(openRouterKeyConfig.encryptedKey);

                // --- 1. World State Analysis ---
                const processedMessage = message.replace(/{{user}}/gi, userName);
                const processedLocation = (currentWorldState.location || 'Unknown').replace(
                    /{{user}}/gi,
                    userName
                );

                const models = [
                    'deepseek/deepseek-r1-0528:free', // Requested Primary
                    'deepseek/deepseek-r1:free',
                    'google/gemini-2.0-flash-exp:free',
                    'meta-llama/llama-3.3-70b-instruct:free',
                    'qwen/qwen-2.5-72b-instruct:free',
                ];

                const { response, usedModel } = await performAIRequest(
                    models,
                    [
                        { role: 'system', content: ANALYST_PROMPT },
                        {
                            role: 'user',
                            content: `Current state:\n- Inventory: ${JSON.stringify(currentWorldState.inventory).replace(/{{user}}/gi, userName)}\n- Location: "${processedLocation}"\n- Relationships: ${JSON.stringify(currentWorldState.relationships).replace(/{{user}}/gi, userName)}\n\nUser Reference:\n- Name: ${userName}\n- Bio: ${activePersona?.bio || 'Unknown'}\n\nNPC Character: ${characterName}\n\nMessage to analyze: "${processedMessage}"`,
                        },
                    ],
                    apiKey
                );

                if (response && response.ok) {
                    console.log(`[WorldStateAnalyzer] Using ${usedModel}`);
                    const data = await response.json();
                    const content =
                        data.choices?.[0]?.message?.content ||
                        data.choices?.[0]?.message?.reasoning_content ||
                        '';

                    const changes = parseAnalystResponse(content);
                    if (changes) {
                        const hasChanges =
                            changes.inventory_add.length > 0 ||
                            changes.inventory_remove.length > 0 ||
                            changes.location !== null ||
                            Object.keys(changes.relationship_changes).length > 0;

                        if (hasChanges) {
                            const newWorldState = mergeWorldState(currentWorldState, changes);
                            chatStore.updateWorldState(targetConversationId, newWorldState);
                            console.log('[WorldStateAnalyzer] Updated state.');
                        }
                    }
                }

                // --- 2. Lorebook Consolidation Check (Every 10 messages) ---
                // We use a simplified check using localStorage for persistence across reloads/sessions
                const MSG_COUNT_KEY = `msg_count_${targetConversationId}`;
                const currentCount = parseInt(localStorage.getItem(MSG_COUNT_KEY) || '0', 10);
                const newCount = currentCount + 1;
                localStorage.setItem(MSG_COUNT_KEY, newCount.toString());

                if (newCount % 10 === 0) {
                    // Fire and forget consolidation
                    consolidateLorebook(targetConversationId, apiKey).catch(console.error);
                }
            } catch (error) {
                console.error('[WorldStateAnalyzer] Error:', error);
            } finally {
                isAnalyzingRef.current = false;
            }
        },
        [consolidateLorebook]
    );

    return {
        analyzeMessage,
        isAnalyzing: isAnalyzingRef.current,
    };
}
