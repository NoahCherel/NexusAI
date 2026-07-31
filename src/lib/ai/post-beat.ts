'use client';

/**
 * Post-beat background pipeline — everything that runs AFTER a generation completes:
 * arc cursor capture + canon dossier fetch, anti-stall detection (momentum nudge),
 * relationship analysis, and fact extraction.
 *
 * Single entry point (fire-and-forget, mirrors the historical inline behaviour of the chat
 * page) so the chat page — and later the Mode Troupe orchestrator — can't drift apart.
 */

import type { CharacterCard } from '@/types/character';
import type { Message } from '@/types/chat';
import type { WorldFact } from '@/types/rag';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { backgroundAICall } from '@/lib/ai/background-ai';
import {
    FACT_EXTRACTION_PROMPT,
    buildFactExtractionPrompt,
    parseFactExtractionResponse,
    deduplicateFacts,
} from '@/lib/ai/fact-extractor';
import { scoreMessageQuality } from '@/lib/ai/message-quality';
import { resolveWork, nameMatchesText } from '@/lib/ai/canon-context';
import { fetchCharacterDossier } from '@/lib/ai/canon-retrieval';
import { detectStall, buildMomentumNudge } from '@/lib/ai/momentum';
import { analyzeAndUpdateRelationships } from '@/lib/ai/relationship-analyst';
import {
    embedText,
    isEmbedderReady,
    getEmbeddingModelSignature,
} from '@/lib/ai/embedding-service';
import { saveFactsBatch, getFactsByConversation } from '@/lib/db';

export interface PostBeatParams {
    character: CharacterCard;
    conversationId: string;
    /** Cleaned content (scratchpad/CoT stripped) — drives canon/arc/stall/relations. */
    finalContent: string;
    /** Raw streamed content — the historical input to fact extraction. */
    fullContent: string;
    /** Id of the generated message (extracted facts are tied to it). */
    targetId: string;
    /** History BEFORE the generated message (stall detection compares to the previous beat). */
    history: Message[];
    /** Active-branch message ids at generation time (branch-aware fact tagging). */
    branchMessageIds: string[];
    personaName?: string;
    isImpersonation: boolean;
    skipFactExtraction: boolean;
}

/**
 * Kick off all post-beat analyses. Synchronous: each analysis runs fire-and-forget with its
 * own error handling, exactly like the historical inline code.
 */
export function runPostBeatAnalyses(params: PostBeatParams): void {
    const {
        character,
        conversationId,
        finalContent,
        fullContent,
        targetId,
        history,
        branchMessageIds,
        personaName,
        isImpersonation,
        skipFactExtraction,
    } = params;

    const settings = useSettingsStore.getState();

    // ===== Canon: capture the GM's trailing [timeline …] as the arc cursor (= canon cap),
    // then lazily fetch/refresh dossiers for roster members active this turn. =====
    {
        const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId);
        // Arc Compass: enabled by default. Treat undefined as ON; only an explicit
        // `enabled: false` from the user turns it off.
        if (conv && conv.arc?.enabled !== false) {
            const work = resolveWork(character);
            let cap = conv.arc?.currentPosition || 'Start';
            const tl = finalContent.match(
                /\[([^\]\n]*(?:season|episode|s\d|e\d|arc|chapter|timeline)[^\]\n]*)\]\s*$/i
            );
            if (tl) {
                const pos = tl[1].trim();
                if (pos && pos !== conv.arc?.currentPosition) {
                    cap = pos;
                    useChatStore.getState().updateArc(conversationId, {
                        ...(conv.arc || {}),
                        currentPosition: pos,
                    });
                }
            }
            const roster = character.canonCast || [];
            if (work && roster.length > 0) {
                const lower = finalContent.toLowerCase();
                const active = roster.filter((n) => nameMatchesText(n, lower));
                for (const name of active) {
                    fetchCharacterDossier(work, name, cap).catch((e) =>
                        console.error('[Canon] dossier fetch failed', name, e)
                    );
                }
            }
        }
    }

    // ===== Anti-stall: if this beat barely advanced vs the previous one, queue a one-shot
    // nudge for the next turn. Local analysis, no API call. =====
    if (finalContent && !isImpersonation && (settings.enableMomentum ?? true)) {
        const prevAssistant = [...history].reverse().find((m) => m.role === 'assistant');
        const { stalled } = detectStall(finalContent, prevAssistant?.content);
        if (stalled) {
            const conv = useChatStore
                .getState()
                .conversations.find((c) => c.id === conversationId);
            useChatStore
                .getState()
                .setMomentumNudge(conversationId, buildMomentumNudge(conv?.arc?.nextBeat));
        }
    }

    // ===== Relationships (Phase 2): update NPC bonds from this beat, in the background. =====
    if (finalContent && !isImpersonation) {
        analyzeAndUpdateRelationships(character, conversationId, finalContent, targetId).catch(
            (e) => console.error('[Relationships] analysis failed', e)
        );
    }

    // ===== RAG: background fact extraction from the AI response (skip on regeneration).
    // Quality gate: skip extraction for trivial/short responses to save API calls. =====
    if (settings.enableFactExtraction && fullContent && !skipFactExtraction) {
        const responseQuality = scoreMessageQuality({ role: 'assistant', content: fullContent });
        if (responseQuality.score >= 4) {
            (async () => {
                try {
                    // Troupe mode: list the OTHER characters present in recent beats so
                    // facts credit the right speaker instead of the main card character.
                    const sceneCharacters = [
                        ...new Set(
                            history
                                .slice(-12)
                                .filter(
                                    (m) =>
                                        m.speaker?.kind === 'character' &&
                                        m.speaker.name !== character.name
                                )
                                .map((m) => m.speaker!.name)
                        ),
                    ];
                    const factPrompt = buildFactExtractionPrompt(
                        fullContent,
                        character.name,
                        personaName || 'User',
                        sceneCharacters
                    );

                    // Runs on the unified background layer — backgroundAICall resolves its
                    // own keys (NanoGPT quota or free OpenRouter rotation).
                    const { backgroundModel: bgModel } = useSettingsStore.getState();
                    const factSystemPrompt = FACT_EXTRACTION_PROMPT;

                    const factResult = await backgroundAICall({
                        systemPrompt: factSystemPrompt,
                        userPrompt: factPrompt,
                        temperature: 0.2,
                        backgroundModel: bgModel,
                    });

                    if (!factResult) return;

                    const extractedFacts = parseFactExtractionResponse(
                        factResult.content,
                        conversationId,
                        targetId
                    );
                    if (extractedFacts.length === 0) return;

                    const existingFacts = await getFactsByConversation(conversationId);
                    const deduped = deduplicateFacts(extractedFacts, existingFacts);
                    if (deduped.length === 0) return;

                    // Tag facts with the active branch path for branch-aware retrieval
                    const factsWithIds: WorldFact[] = [];
                    for (const f of deduped) {
                        const emb = await embedText(f.fact);
                        factsWithIds.push({
                            ...f,
                            id: crypto.randomUUID(),
                            embedding: emb,
                            embeddingRevision: isEmbedderReady()
                                ? getEmbeddingModelSignature()
                                : undefined,
                            branchPath: branchMessageIds,
                        });
                    }
                    await saveFactsBatch(factsWithIds);
                    console.log(`[RAG] Extracted ${factsWithIds.length} facts from response`);
                } catch (err) {
                    console.error('[RAG] Fact extraction failed:', err);
                }
            })();
        } else {
            console.log(
                `[RAG] Skipping fact extraction — response quality too low (${responseQuality.score}/10: ${responseQuality.label})`
            );
        }
    }
}
