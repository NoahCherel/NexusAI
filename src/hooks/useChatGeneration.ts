'use client';

/**
 * Chat generation hook — owns the full foreground generation flow of the chat page:
 * payload assembly (lorebook + canon + RAG via the shared builders), streaming, abort,
 * scratchpad capture, and the post-beat pipeline hand-off. Exposes the user actions:
 * send / stop / regenerate / continueMessage / impersonate / retry.
 *
 * Pure extraction of the historical page.tsx logic — behaviour must stay identical.
 */

import { useEffect, useRef, useState } from 'react';
import type { CharacterCard } from '@/types/character';
import type { Message as CAMessage } from '@/types/chat';
import type { Message } from '@/types';
import { useSettingsStore, useChatStore, useLorebookStore } from '@/stores';
import { useNotificationStore } from '@/components/ui/api-notification';
import { decryptApiKey } from '@/lib/crypto';
import { parseStreamingChunk, normalizeCoT } from '@/lib/ai/cot-middleware';
import { buildConversationPayload } from '@/lib/ai/payload-builder';
import { buildCanonOptions } from '@/lib/ai/canon-context';
import {
    retrieveRelevantContext,
    resolveActiveLorebookEntries,
} from '@/lib/ai/rag-service';
import { extractLorebookEntries, extractRpDevelopments } from '@/lib/lorebook-extractor';
import { directorDecide, applySceneChange } from '@/lib/ai/scene-orchestrator';
import { NANOGPT_USAGE_REFRESH_EVENT } from '@/lib/ai/nanogpt-usage';
import { countTokens } from '@/lib/tokenizer';
import type { PostBeatParams } from '@/lib/ai/post-beat';

// Trailing sentinel appended by /api/chat carrying the provider-reported token usage.
const USAGE_SENTINEL_RE = /\n?<\|nexus_usage\|>(\{[\s\S]*?\})\s*$/;

/** Decrypted key of the ACTIVE provider (null while loading or when none is stored). */
export function useActiveApiKey(): string | null {
    const { apiKeys, activeProvider } = useSettingsStore();
    const [currentApiKey, setCurrentApiKey] = useState<string | null>(null);

    // Get decrypted API key on mount/change
    useEffect(() => {
        const loadApiKey = async () => {
            const keyConfig = apiKeys.find((k) => k.provider === activeProvider);
            if (keyConfig) {
                try {
                    const decrypted = await decryptApiKey(keyConfig.encryptedKey);
                    setCurrentApiKey(decrypted);
                } catch {
                    setCurrentApiKey(null);
                }
            } else {
                setCurrentApiKey(null);
            }
        };
        loadApiKey();
    }, [apiKeys, activeProvider]);

    return currentApiKey;
}

interface UseChatGenerationParams {
    character: CharacterCard | null;
    activeConversationId: string | null;
    /** Active-branch messages. */
    messages: CAMessage[];
    /** Decrypted key of the active provider (from useActiveApiKey). */
    currentApiKey: string | null;
    /** Post-response background pipeline (from useBackgroundPipeline). */
    runPostBeat: (params: PostBeatParams) => void;
}

export function useChatGeneration({
    character,
    activeConversationId,
    messages,
    currentApiKey,
    runPostBeat,
}: UseChatGenerationParams) {
    const [isLoading, setIsLoading] = useState(false);
    const abortControllerRef = useRef<AbortController | null>(null);
    // Scene Mode: cancels the remaining character turns of a running beat (Stop button or
    // a new user message).
    const stopRequestedRef = useRef(false);
    const [isSceneRunning, setIsSceneRunning] = useState(false);

    const {
        activeProvider,
        activeModel,
        temperature,
        activePersonaId,
        personas,
        enableReasoning,
        useFlexTier,
        getActivePreset,
        getActiveEngine,
    } = useSettingsStore();
    const { conversations, addMessage, updateMessage, deleteMessage, getActiveBranchBanList } =
        useChatStore();
    const { activeLorebook } = useLorebookStore();

    const triggerAiReponse = async (
        history: CAMessage[],
        options: {
            isImpersonation?: boolean;
            prefill?: string;
            skipFactExtraction?: boolean;
            /**
             * Continue-in-place for providers WITHOUT assistant prefill (NanoGPT/OpenAI):
             * `history` must END with this existing assistant message; the model gets an
             * explicit continue instruction and the streamed continuation is appended to
             * the message (overlap-deduped) instead of creating a new one.
             */
            continueTargetId?: string;
            /** Scene Mode: attribute the generated message to this speaker (one turn). */
            speaker?: CAMessage['speaker'];
            /** Director stage direction for this speaker (Scene Mode). */
            sceneDirection?: string;
            /** Director dramatic goal for the beat (Scene Mode, first speaker only). */
            sceneGoal?: string;
            /** Unified scene style: one generation writes the whole directed beat. */
            sceneEnsemble?: import('@/lib/ai/payload-builder').BuildConversationPayloadParams['sceneEnsemble'];
        } = {}
    ): Promise<{ id: string; content: string } | undefined> => {
        if (!currentApiKey || !character) return;
        setIsLoading(true);

        // Failed generations stay in the transcript for the Retry UI, but must never be
        // sent back to the model: drop error-flagged messages with no usable content.
        history = history.filter((m) => !(m.error && !m.content.trim()));

        // Stop any previous request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        abortControllerRef.current = new AbortController();

        const activePreset = getActivePreset();
        const activePersona = personas.find((p) => p.id === activePersonaId);
        const activeEngine = getActiveEngine();

        // 1. Canon Codex first (immutable identity + Arc + momentum + relationships): its
        // injected text also feeds the lorebook keyword scan below, so entries fire on
        // canon/journal facts, not just recent messages.
        // persistSticky: generation updates the sticky-cast window (previews never mutate).
        const currentConv = conversations.find((c) => c.id === activeConversationId);
        const combinedMemory = [...(currentConv?.notes || []), ...(character.longTermMemory || [])];
        const canonOptions = await buildCanonOptions(
            character,
            currentConv,
            history,
            activePersona?.name || 'the player',
            { persistSticky: true }
        );
        const canonScanText = [
            ...(canonOptions.canonDossiers ?? []).map(
                (d) => `${d.character}\n${d.identity}\n${d.backstory ?? ''}`
            ),
            ...Object.entries(canonOptions.rpJournal ?? {}).flatMap(([name, notes]) => [
                name,
                ...notes,
            ]),
            canonOptions.relationshipBlock ?? '',
        ]
            .filter(Boolean)
            .join('\n');

        // 2. Active lorebook entries — single shared resolver (hybrid: keyword + semantic).
        const lastUserMsg = history[history.length - 1]?.content || '';
        const activeEntries = await resolveActiveLorebookEntries({
            messages: history,
            lorebook: activeLorebook,
            preset: activePreset,
            characterName: character.name,
            userPersonaName: activePersona?.name,
            hybrid: true,
            queryText: lastUserMsg,
            tokenBudget: activePreset?.lorebookTokenBudget ?? 2000,
            extraScanText: canonScanText || undefined,
        });

        const { enableRAGRetrieval, minRAGConfidence, enableScratchpad } =
            useSettingsStore.getState();
        const maxContextTokens = activePreset?.maxContextTokens ?? 16384;
        const maxOutputTokens = activePreset?.maxOutputTokens ?? 2048;

        const {
            messagesPayload,
            includedMessageCount,
            droppedMessageCount,
            stablePrefixLength,
            suggestedCutMessageId,
            tokenBreakdown,
        } = await buildConversationPayload({
                mode: options.isImpersonation ? 'impersonate' : 'generate',
                character,
                        activeEntries,
                history,
                recentMessages: history,
                activePreset,
                activeEngine,
                learnedBanList: activeConversationId
                    ? getActiveBranchBanList(activeConversationId)
                    : undefined,
                userPersona: activePersona,
                longTermMemory: combinedMemory,
                storyGuidance: currentConv?.storyGuidance,
                scratchpad: currentConv?.scratchpad,
                enableScratchpad,
                canonOptions,
                assistantPrefill: options.prefill,
                activeProvider,
                maxContextTokens,
                maxOutputTokens,
                historyCutMessageId: currentConv?.historyCutMessageId,
                continueFromAssistant: !!options.continueTargetId,
                sceneSpeaker:
                    options.speaker?.kind === 'character' ? options.speaker.name : undefined,
                sceneNarrator: options.speaker?.kind === 'narrator',
                sceneDirection: options.sceneDirection,
                sceneGoal: options.sceneGoal,
                sceneEnsemble: options.sceneEnsemble,
                retrieveRag:
                    enableRAGRetrieval && activeConversationId
                        ? (ragBudget) =>
                              retrieveRelevantContext(
                                  lastUserMsg,
                                  activeConversationId,
                                  ragBudget,
                                  {
                                                                    recentMessages: history,
                                      activeBranchMessageIds: messages.map((m) => m.id),
                                      minConfidence: minRAGConfidence,
                                      // Priority of truth: facts restating canon/lorebook
                                      // content injected this turn are dropped.
                                      dedupAgainstTexts: [
                                          ...(canonOptions.canonDossiers ?? []).map(
                                              (d) =>
                                                  `${d.identity}\n${d.backstory ?? ''}\n${d.abilities ?? ''}`
                                          ),
                                          ...activeEntries.map((e) => e.content),
                                      ],
                                  }
                              )
                        : undefined,
            });

        // The momentum nudge is one-shot: it has now been injected, so clear it.
        if (currentConv?.momentumNudge && activeConversationId) {
            useChatStore.getState().setMomentumNudge(activeConversationId, undefined);
        }

        // History window moved (hysteresis overflow): persist the new anchor so following
        // turns reuse the exact same prefix — that's what lets the provider cache hit.
        if (suggestedCutMessageId && activeConversationId && !options.isImpersonation) {
            useChatStore.getState().setHistoryCut(activeConversationId, suggestedCutMessageId);
        }

        if (droppedMessageCount > 0) {
            console.log(
                `[RAG] Context: ${includedMessageCount} msgs included, ${droppedMessageCount} truncated. Tokens: sys=${tokenBreakdown.system} rag=${tokenBreakdown.rag} hist=${tokenBreakdown.history} total=${tokenBreakdown.total}`
            );
        }

        // 5. Prepare Target Message (Assistant or User). Continue-in-place reuses the
        // existing message (last of `history`) instead of creating a new one.
        const targetRole = options.isImpersonation ? 'user' : 'assistant';
        const continuing = !!options.continueTargetId;
        const targetId = options.continueTargetId ?? crypto.randomUUID();

        // Initialize content state
        const initialContent = continuing
            ? history[history.length - 1]?.content || ''
            : options.prefill || '';
        let fullContent = initialContent;

        if (activeConversationId && !continuing) {
            addMessage({
                id: targetId,
                conversationId: activeConversationId,
                parentId: history[history.length - 1]?.id || null,
                role: targetRole,
                content: initialContent,
                isActiveBranch: true,
                createdAt: new Date(),
                messageOrder: history.length + 1,
                regenerationIndex: 0,
                speaker: options.speaker,
            });
        }

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: messagesPayload,
                    provider: activeProvider,
                    model: activeModel,
                    apiKey: currentApiKey,
                    // Extended Parameters
                    temperature: activePreset?.temperature ?? temperature,
                    maxTokens: activePreset?.maxOutputTokens ?? 2048,
                    topP: activePreset?.topP,
                    topK: activePreset?.topK,
                    frequencyPenalty: activePreset?.frequencyPenalty,
                    presencePenalty: activePreset?.presencePenalty,
                    repetitionPenalty: activePreset?.repetitionPenalty,
                    minP: activePreset?.minP,
                    stoppingStrings: activePreset?.stoppingStrings,
                    // System prompt is now in messages[0]
                    systemInstruction: undefined,
                    enableReasoning: activePreset?.enableReasoning ?? enableReasoning,
                    useFlexTier: activePreset?.useFlexTier ?? useFlexTier,
                    // Cache-stable prefix boundary (system + history) for Claude cache_control.
                    cachePrefixLength: stablePrefixLength,
                }),
                signal: abortControllerRef.current.signal,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(
                    errorData.error || `API Error: ${response.status} ${response.statusText}`
                );
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader');

            const decoder = new TextDecoder();

            // If we have a prefill that WASN'T sent to the API, we start with it. If it WAS
            // sent (Anthropic), the stream continues AFTER it. Always maintain `fullContent`.
            fullContent = initialContent;
            let assistantThought = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });

                // Special handling for thoughts:
                const parsed = parseStreamingChunk(chunk, activeProvider);
                if (parsed.thoughtContent) assistantThought += parsed.thoughtContent;
                if (parsed.visibleContent) fullContent += parsed.visibleContent;

                // Update the message in store
                updateMessage(targetId, {
                    content: fullContent,
                    thought: assistantThought || undefined,
                });
            }

            // NanoGPT quota was just consumed by this generation — ask the usage badge/panel to
            // refetch (no-op for other providers; the badge only renders for NanoGPT).
            if (activeProvider === 'nanogpt') {
                window.dispatchEvent(new Event(NANOGPT_USAGE_REFRESH_EVENT));
            }

            // Continue-in-place: strip the overlap between the end of the original message
            // and the start of the continuation (models often re-emit the last sentence —
            // or the whole message — despite the instruction).
            if (continuing) {
                let streamed = fullContent.slice(initialContent.length);
                const maxOverlap = Math.min(initialContent.length, streamed.length);
                for (let n = maxOverlap; n >= 12; n--) {
                    if (streamed.startsWith(initialContent.slice(-n))) {
                        streamed = streamed.slice(n);
                        break;
                    }
                }
                const needsSpace =
                    streamed.length > 0 &&
                    !/\s$/.test(initialContent) &&
                    !/^[\s.,;:!?…»)"'\]]/.test(streamed);
                fullContent = initialContent + (needsSpace ? ' ' : '') + streamed;
            }

            // Extract the trailing usage sentinel (provider-reported token accounting).
            let usage: CAMessage['usage'];
            const usageMatch = fullContent.match(USAGE_SENTINEL_RE);
            if (usageMatch) {
                fullContent = fullContent.replace(USAGE_SENTINEL_RE, '');
                try {
                    const u = JSON.parse(usageMatch[1]);
                    usage = {
                        promptTokens: u.promptTokens ?? 0,
                        completionTokens: u.completionTokens ?? 0,
                        cachedTokens: u.cachedTokens,
                        cost: u.cost,
                    };
                } catch {
                    /* malformed sentinel — fall through to the local estimate */
                }
            }

            // Final parse
            const finalResult = normalizeCoT(fullContent, activeProvider);

            // Extract scratchpad
            let finalContent = finalResult.content;

            // Scene Mode: the history carries "Name: " prefixes so models often imitate the
            // pattern — strip the speaker's own prefix from their reply.
            if (options.speaker?.kind === 'character') {
                const escaped = options.speaker.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                finalContent = finalContent.replace(new RegExp(`^\\s*${escaped}\\s*:\\s*`), '');
            }
            const scratchpadMatch = finalContent.match(/<scratchpad>([\s\S]*?)<\/scratchpad>/i);
            if (scratchpadMatch) {
                const scratchpadContent = scratchpadMatch[1].trim();
                if (activeConversationId) {
                    useChatStore
                        .getState()
                        .updateScratchpad(activeConversationId, scratchpadContent);
                }
                // Remove scratchpad from final content
                finalContent = finalContent
                    .replace(/<scratchpad>[\s\S]*?<\/scratchpad>/i, '')
                    .trim();
            }

            // Weekly OpenRouter budget: accumulate the REAL accounted cost (never the
            // local estimates — the tracker only counts what OpenRouter actually billed).
            if (usage?.cost && usage.cost > 0) {
                useSettingsStore.getState().addWeeklySpend(usage.cost);
            }

            // No provider-reported usage (e.g. NanoGPT) → local tokenizer estimate, so the
            // per-message badge and quota tracking still work.
            if (!usage) {
                usage = {
                    promptTokens: Math.max(0, tokenBreakdown.total - maxOutputTokens),
                    completionTokens: countTokens(finalContent),
                    estimated: true,
                };
            }

            updateMessage(targetId, {
                content: finalContent,
                thought: finalResult.thought || assistantThought || undefined,
                usage,
            });

            // Post-beat pipeline: arc capture + canon dossier fetch, momentum, relationship
            // analysis, and fact extraction — single background entry point.
            if (character && activeConversationId) {
                runPostBeat({
                    character,
                    conversationId: activeConversationId,
                    finalContent,
                    fullContent,
                    targetId,
                    history,
                    branchMessageIds: messages.map((m) => m.id),
                                personaName: activePersona?.name,
                    isImpersonation: !!options.isImpersonation,
                    skipFactExtraction: !!options.skipFactExtraction,
                });
            }

            return { id: targetId, content: finalContent };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return;
            }

            const { addNotification, updateNotification } = useNotificationStore.getState();
            const notifId = addNotification('Failed to generate response', 'world');
            updateNotification(
                notifId,
                'error',
                error instanceof Error ? error.message : 'Unknown error'
            );

            if (activeConversationId) {
                if (continuing) {
                    // A failed continuation must not damage the existing message (and must
                    // not flag it with `error` — Retry would DELETE it). Restore and let
                    // the notification carry the failure.
                    updateMessage(targetId, { content: initialContent });
                } else {
                    // Keep the error OUT of `content` (it would be sent back to the model on
                    // the next turn) — ChatBubble renders it as a banner with a Retry action.
                    updateMessage(targetId, {
                        content: fullContent,
                        error:
                            error instanceof Error
                                ? error.message
                                : 'Failed to get response. Check API Key or Network.',
                    });
                }
            }
        } finally {
            setIsLoading(false);
            abortControllerRef.current = null;
        }
    };

    const stop = () => {
        stopRequestedRef.current = true;
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            setIsLoading(false);
        }
    };

    /** Prefix scene-attributed messages with their speaker so the model knows who spoke. */
    const withSpeakerPrefixes = (history: CAMessage[]): CAMessage[] =>
        history.map((m) =>
            m.role === 'assistant' && m.speaker
                ? { ...m, content: `${m.speaker.name}: ${m.content}` }
                : m
        );

    /**
     * Scene Mode beat: one cheap Director call (background AI) decides narration, roster
     * changes and up to 3 speakers; each speaker then gets their own streamed generation
     * attributed via `speaker`. Post-beat analyses (facts/relations/journal) run ONCE, on
     * the last turn, over the whole beat.
     */
    const runSceneBeat = async (historyOverride?: CAMessage[]) => {
        if (!activeConversationId || !character) return;
        const conv = useChatStore
            .getState()
            .conversations.find((c) => c.id === activeConversationId);
        if (!conv?.sceneMode) return;
        const roster = (conv.sceneRoster ?? []).filter(Boolean);
        if (roster.length === 0) return;

        stopRequestedRef.current = false;
        const beatHistory: CAMessage[] = [...(historyOverride ?? messages)];
        const activePersona = personas.find((p) => p.id === activePersonaId);
        const userName = activePersona?.name || 'the player';

        setIsSceneRunning(true);
        try {
            // 1. Director decision (never on the paid RP model).
            const decision = await directorDecide({
                roster,
                userName,
                recentMessages: beatHistory,
                relationships: conv.relationships,
                arcPosition: conv.arc?.currentPosition,
                maxSpeakers: useSettingsStore.getState().maxSceneSpeakers,
            });
            if (stopRequestedRef.current) return;

            // 2. Roster enter/exit.
            const newRoster = applySceneChange(roster, decision.sceneChange);
            if (newRoster.join('|') !== roster.join('|')) {
                useChatStore.getState().setSceneRoster(activeConversationId, newRoster);
            }

            // 'unified' style: ONE RP call writes the whole directed beat as a single
            // message (narration woven in — no separate narrator bubble, no per-speaker
            // turns). Cheaper than turn-by-turn; regen redoes the whole beat.
            if ((conv.sceneStyle ?? 'turns') === 'unified') {
                await triggerAiReponse(withSpeakerPrefixes(beatHistory), {
                    sceneEnsemble: {
                        roster: newRoster,
                        directions: decision.speakers,
                        sceneGoal: decision.sceneGoal,
                        narrationHint: decision.narration,
                        userName,
                    },
                    skipFactExtraction: false,
                });
                return;
            }

            // 3. Narration (already written by the Director — no extra LLM call).
            if (decision.narration) {
                const narratorMsg: CAMessage = {
                    id: crypto.randomUUID(),
                    conversationId: activeConversationId,
                    parentId: beatHistory[beatHistory.length - 1]?.id || null,
                    role: 'assistant',
                    content: decision.narration,
                    isActiveBranch: true,
                    createdAt: new Date(),
                    messageOrder: beatHistory.length + 1,
                    regenerationIndex: 0,
                    speaker: { kind: 'narrator', name: 'Narrateur' },
                };
                addMessage(narratorMsg);
                beatHistory.push(narratorMsg);
            }

            // 4. Character turns, sequential and streamed. Hard cap; Stop (or a new user
            // message) cancels the remaining turns.
            const speakers = decision.speakers;
            for (let i = 0; i < speakers.length; i++) {
                if (stopRequestedRef.current) break;
                const speaker = { kind: 'character' as const, name: speakers[i].name };
                const result = await triggerAiReponse(withSpeakerPrefixes(beatHistory), {
                    speaker,
                    sceneDirection: speakers[i].direction,
                    sceneGoal: i === 0 ? decision.sceneGoal : undefined,
                    skipFactExtraction: i < speakers.length - 1,
                });
                if (!result) break;
                beatHistory.push({
                    id: result.id,
                    conversationId: activeConversationId,
                    parentId: beatHistory[beatHistory.length - 1]?.id || null,
                    role: 'assistant',
                    content: result.content,
                    isActiveBranch: true,
                    createdAt: new Date(),
                    messageOrder: beatHistory.length + 1,
                    regenerationIndex: 0,
                    speaker,
                });
            }
        } finally {
            setIsSceneRunning(false);
        }
    };

    const send = async (userMessage: string) => {
        if (!activeConversationId || !character) return;

        // Extraction on the PREVIOUS assistant message (the one the user is confirming by replying).
        // This ensures only the active regeneration branch gets extracted.
        const { lorebookAutoExtract } = useSettingsStore.getState();
        // Whole-work RPG cards use the canon-safe RP journal instead of the (canon-destroying)
        // lorebook accretion: canonical identity stays immutable, only "in this RP" notes are logged.
        const isCanonCard = !!(
            character.work ||
            (character.canonCast && character.canonCast.length)
        );
        if (lorebookAutoExtract && messages.length > 0) {
            const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
            if (lastAssistantMsg?.content) {
                if (isCanonCard) {
                    const convId = activeConversationId;
                    extractRpDevelopments(lastAssistantMsg.content, character.canonCast || [])
                        .then((devs) => {
                            const { appendRpJournal } = useChatStore.getState();
                            for (const d of devs) appendRpJournal(convId, d.character, d.note);
                        })
                        .catch((err) => console.error('RP journal extraction failed:', err));
                } else if (activeLorebook) {
                    const existingKeys = activeLorebook.entries.flatMap((e) => e.keys);
                    extractLorebookEntries(lastAssistantMsg.content, existingKeys)
                        .then((newEntries) => {
                            if (newEntries.length > 0) {
                                const { addSuggestions } = useLorebookStore.getState();
                                addSuggestions(
                                    newEntries.map((e) => ({
                                        keys: e.keys,
                                        content: e.content,
                                        category: e.category,
                                    }))
                                );
                            }
                        })
                        .catch((err) => console.error('Lorebook extraction failed:', err));
                }
            }
        }

        const lastParams = messages.length > 0 ? messages[messages.length - 1] : null;

        // Stamp the persona used AT SEND TIME — switching personas later must not rewrite
        // the attribution of past messages.
        const sendPersona = personas.find((p) => p.id === activePersonaId);
        const newUserMessage: Message = {
            id: crypto.randomUUID(),
            conversationId: activeConversationId,
            parentId: lastParams?.id || null,
            role: 'user',
            content: userMessage,
            isActiveBranch: true,
            createdAt: new Date(),
            messageOrder: messages.length + 1,
            regenerationIndex: 0,
            speaker: {
                kind: 'user',
                name: sendPersona?.name || 'You',
                personaId: sendPersona?.id,
            },
        };

        addMessage(newUserMessage);

        const activePreset = getActivePreset();
        const prefill = activePreset?.assistantPrefill || undefined;

        // Construct history for API (include the new message)
        const history = [...messages, newUserMessage];

        // Scene Mode: the beat is orchestrated (director + up to 3 character turns). A new
        // user message always cancels any still-running beat first.
        stopRequestedRef.current = true;
        const convForSend = conversations.find((c) => c.id === activeConversationId);
        if (
            convForSend?.sceneMode &&
            (convForSend.sceneRoster?.length ?? 0) > 0 &&
            useSettingsStore.getState().enableTroupeMode
        ) {
            await runSceneBeat(history);
            return;
        }

        await triggerAiReponse(history, { prefill });
    };

    const impersonate = async (): Promise<string | void> => {
        if (!activeConversationId || isLoading || !currentApiKey || !character) return;

        setIsLoading(true);

        let generatedText = '';

        try {
            const activePreset = getActivePreset();
            const activePersona = personas.find((p) => p.id === activePersonaId);

            // 1. Context — keyword-only lorebook scan via the shared resolver. NOTE: the
            // historical impersonation budget (preset value or the scanner's own default)
            // is kept as-is.
            const activeEntries = await resolveActiveLorebookEntries({
                messages,
                lorebook: activeLorebook,
                preset: activePreset,
                characterName: character.name,
                userPersonaName: activePersona?.name,
                tokenBudget: activePreset?.lorebookTokenBudget,
            });

            const impConv = conversations.find((c) => c.id === activeConversationId);
            const impMem = [...(impConv?.notes || []), ...(character.longTermMemory || [])];

            // Unified assembly with the INVERTED contract (mode: 'impersonate'): the builder
            // strips "Do not speak for <user>" and asserts the write-only-the-player contract
            // after history. Kept context-light (no canon/RAG) as before.
            const { messagesPayload } = await buildConversationPayload({
                mode: 'impersonate',
                character,
                        activeEntries,
                history: messages,
                recentMessages: messages,
                activePreset,
                activeEngine: getActiveEngine(),
                learnedBanList: activeConversationId
                    ? getActiveBranchBanList(activeConversationId)
                    : undefined,
                userPersona: activePersona,
                longTermMemory: impMem,
                storyGuidance: impConv?.storyGuidance,
                scratchpad: impConv?.scratchpad,
                activeProvider,
                maxContextTokens: activePreset?.maxContextTokens ?? 16384,
                maxOutputTokens: activePreset?.maxOutputTokens ?? 2048,
            });

            // 2. API Call
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: messagesPayload,
                    provider: activeProvider,
                    model: activeModel,
                    apiKey: currentApiKey,
                    temperature: activePreset?.temperature ?? temperature,
                    maxTokens: activePreset?.maxOutputTokens ?? 2048,
                    topP: activePreset?.topP,
                    topK: activePreset?.topK,
                    frequencyPenalty: activePreset?.frequencyPenalty,
                    presencePenalty: activePreset?.presencePenalty,
                    repetitionPenalty: activePreset?.repetitionPenalty,
                    minP: activePreset?.minP,
                    stoppingStrings: activePreset?.stoppingStrings,
                    enableReasoning: activePreset?.enableReasoning ?? enableReasoning,
                    useFlexTier: activePreset?.useFlexTier ?? useFlexTier,
                }),
            });

            if (!response.ok) throw new Error('Impersonation failed');

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader');
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                // We must accumulate the raw text first, because chunk-based parsing
                // of thoughts split across chunks is unreliable.
                generatedText += chunk;
            }

            // Strip the trailing usage sentinel — the drafted text goes into the input box.
            generatedText = generatedText.replace(USAGE_SENTINEL_RE, '');
            const final = normalizeCoT(generatedText, activeProvider);
            return final.content;
        } catch (err) {
            console.error('Impersonation error:', err);
        } finally {
            setIsLoading(false);
        }
    };

    const regenerate = async (id: string) => {
        if (!activeConversationId) return;

        const msgIndex = messages.findIndex((m) => m.id === id);
        if (msgIndex === -1) return;

        const msgToRegen = messages[msgIndex];

        // Only assistant messages can be regenerated — this creates a sibling. A Scene
        // Mode turn keeps its speaker: same attribution, same voice contract, and the
        // history keeps its 'Name:' prefixes so the model knows who said what.
        if (msgToRegen.role === 'assistant') {
            const history = messages.slice(0, msgIndex);
            await triggerAiReponse(
                msgToRegen.speaker ? withSpeakerPrefixes(history) : history,
                { skipFactExtraction: true, speaker: msgToRegen.speaker }
            );
        }
    };

    const continueMessage = async (id: string) => {
        if (!activeConversationId || !character) return;

        const msgIndex = messages.findIndex((m) => m.id === id);
        if (msgIndex === -1) return;

        const msgToContinue = messages[msgIndex];

        // Only continue assistant messages
        if (msgToContinue.role !== 'assistant') return;

        const supportsPrefill = activeProvider === 'anthropic' || activeProvider === 'openrouter';
        if (supportsPrefill) {
            // Prefill path: the trailing assistant message makes the model literally keep
            // typing. Replace the message with prefill + continuation.
            const prefill = msgToContinue.content + ' ';
            const history = messages.slice(0, msgIndex);
            deleteMessage(id);
            await triggerAiReponse(
                msgToContinue.speaker ? withSpeakerPrefixes(history) : history,
                { prefill, skipFactExtraction: true, speaker: msgToContinue.speaker }
            );
        } else {
            // No prefill support (NanoGPT/OpenAI): keep the message in place and in the
            // history, instruct an explicit continuation, append it (overlap-deduped).
            // The old code deleted the message and regenerated everything — duplicated text.
            const history = messages.slice(0, msgIndex + 1);
            await triggerAiReponse(history, { continueTargetId: id, skipFactExtraction: true });
        }
    };

    // Retry a failed generation: drop the errored message and regenerate from the same point.
    const retry = async (id: string) => {
        const msgIndex = messages.findIndex((m) => m.id === id);
        if (msgIndex === -1) return;
        const msgToRetry = messages[msgIndex];
        const history = messages.slice(0, msgIndex);
        deleteMessage(id);
        await triggerAiReponse(
            msgToRetry.speaker ? withSpeakerPrefixes(history) : history,
            { skipFactExtraction: true, speaker: msgToRetry.speaker }
        );
    };

    return {
        isLoading,
        isSceneRunning,
        send,
        stop,
        regenerate,
        continueMessage,
        impersonate,
        retry,
        runSceneBeat,
    };
}
