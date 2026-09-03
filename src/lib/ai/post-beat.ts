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
import {
    maintainNarrativeAfterBeat,
    type DirectedMaintenanceContext,
} from '@/lib/ai/narrative-maintenance';

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
    /**
     * Who the app attributed this beat to. Ground truth for the relationship analyst, which
     * otherwise has to infer presence from name matching — and a character's own line almost
     * never contains their own name. Defaults to the card's character.
     */
    speakerNames?: string[];
    /**
     * Id of the message this generation replaces (regenerate / retry / reroll). The relationship
     * analyst rolls its deltas back before scoring the new version, so a rerolled beat neither
     * double-counts nor freezes.
     */
    supersededMessageId?: string;
    /**
     * Directed beats: the retrieval stack already built for the beat. Forwarded so the
     * Auditor and the Story Director read the same canon, lorebook and Chronicle the writer
     * did, instead of a bare state dump. Absent for a manual edit, which rebuilds its own.
     */
    sceneContext?: DirectedMaintenanceContext;
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
        speakerNames,
        supersededMessageId,
    } = params;

    const settings = useSettingsStore.getState();
    let stalled = false;

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
        ({ stalled } = detectStall(finalContent, prevAssistant?.content));
        if (stalled) {
            const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId);
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
            targetId,
            speakerNames,
            supersededMessageId
        ).catch((e) => console.error('[Relationships] analysis failed', e));
    }

    // Directed beats get a branch/revision-guarded continuity audit and adaptive story plan.
    // It is deliberately non-blocking: the committed bubbles are already visible and remain
    // usable even when the background route is unavailable.
    const targetMessage = useChatStore
        .getState()
        .messages.find((message) => message.id === targetId);
    if (targetMessage?.sceneBeatId && !isImpersonation && !skipBeatAnalyses) {
        maintainNarrativeAfterBeat({
            character,
            conversationId,
            beatId: targetMessage.sceneBeatId,
            targetMessageId: targetId,
            beatContent: beatContent || finalContent,
            stalled,
            history,
            sceneContext: params.sceneContext,
        }).catch((error) => console.error('[Narrative maintenance] failed', error));
    }
}
