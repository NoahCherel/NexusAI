'use client';

/**
 * Post-beat background pipeline — everything that runs AFTER a generation completes:
 * arc cursor capture + canon dossier fetch, anti-stall detection (momentum nudge), and
 * relationship analysis.
 *
 * Single entry point (fire-and-forget, mirrors the historical inline behaviour of the chat
 * page) so the chat page — and later the Mode Troupe orchestrator — can't drift apart.
 *
 * Fact extraction used to run here too. It was removed with the rest of the WorldFact system:
 * the Chronicle's Sections carry that memory now, and they cost no extra background call.
 */

import type { CharacterCard } from '@/types/character';
import type { Message } from '@/types/chat';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { resolveWork, nameMatchesText } from '@/lib/ai/canon-context';
import { fetchCharacterDossier } from '@/lib/ai/canon-retrieval';
import { detectStall, buildMomentumNudge } from '@/lib/ai/momentum';
import { analyzeAndUpdateRelationships } from '@/lib/ai/relationship-analyst';

export interface PostBeatParams {
    character: CharacterCard;
    conversationId: string;
    /** Cleaned content (scratchpad/CoT stripped) — drives canon/arc/stall/relations. */
    finalContent: string;
    /** Id of the generated message. */
    targetId: string;
    /** History BEFORE the generated message (stall detection compares to the previous beat). */
    history: Message[];
    isImpersonation: boolean;
    /**
     * This generation is not a fresh beat worth analysing: a non-final Troupe turn, or a
     * regenerate/continue/retry of something already analysed. Suppresses the relationship
     * analyst — running it again double-counts the same beat.
     */
    skipBeatAnalyses: boolean;
    /**
     * Troupe: the whole beat (every speaker, name-prefixed) instead of just the last turn's
     * line. The relationship analyst needs it — judging a 3-speaker beat from its last reply
     * alone misses what the other characters actually did. Defaults to `finalContent`.
     */
    beatContent?: string;
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
        targetId,
        history,
        isImpersonation,
        skipBeatAnalyses,
        beatContent,
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

    // ===== Relationships (Phase 2): update NPC bonds from this beat, in the background.
    // ONCE per beat — `skipBeatAnalyses` holds it back on the non-final Troupe turns (it used
    // to fire per speaker, which multiplied the background calls AND let one beat move an axis
    // by 3 × NORMAL_DELTA_CAP) and on regenerate/continue/retry. =====
    if (finalContent && !isImpersonation && !skipBeatAnalyses) {
        analyzeAndUpdateRelationships(
            character,
            conversationId,
            beatContent || finalContent,
            targetId
        ).catch((e) => console.error('[Relationships] analysis failed', e));
    }
}
