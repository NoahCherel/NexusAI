'use client';

/**
 * Relationship analyst — the background pass that turns "what happened this beat" into
 * justified, capped relationship deltas. Heavily biased AGAINST the LLM's instinct to make
 * everyone warm up instantly.
 *
 * It MOVES existing bonds; it never creates one. Pairs are created by hand in the Relations
 * panel (plus the single player↔card bond seeded at conversation creation). The guarantee is
 * structural, not a prompt instruction: an unknown pair is dropped at the `findRelationship`
 * check below. Auto-minting bonds for every name detected on stage is what used to bloat the
 * prompt with walk-on NPCs nobody cared about.
 *
 * Only NPC-origin relationships are updated (NPC→player, NPC→NPC). The player's own feelings
 * ({{user}}→X) are never authored by the AI — that's the user's to set in the editor.
 */

import { useSettingsStore } from '@/stores/settings-store';
import { useChatStore } from '@/stores/chat-store';
import { backgroundAICall } from '@/lib/ai/background-ai';
import { getCanonDossiersByWork } from '@/lib/db';
import { resolveWork, getActiveCanonNames } from '@/lib/ai/canon-context';
import { onStageNames } from '@/lib/ai/relationship-context';
import {
    applyDeltas,
    revertMessageDeltas,
    findRelationship,
    relKey,
    RELATIONSHIP_AXES,
    axisLabel,
    type ProposedDelta,
} from '@/lib/ai/relationship-engine';
import { USER_REL_KEY, type RelationshipAxis, type DirectedRelationship } from '@/types/chat';
import type { CharacterCard } from '@/types/character';
import type { CanonDossier } from '@/types/canon';

export const RELATIONSHIP_ANALYST_PROMPT = `You track how characters FEEL about each other in a roleplay, and you fight the usual AI tendency to make everyone instantly warm, trusting and forgiving.

You output small, JUSTIFIED changes (deltas) to four axes, each -100..100:
- trust — belief/reliance. The hardest to earn, the easiest to lose. A stranger starts near 0.
- affection — warmth/liking.
- respect — regard for competence/standing (independent of liking).
- attraction — romantic/sexual interest.

HARD RULES:
- You may ONLY move relationships that already appear in the list you are given. Never invent a pair, and never introduce a character that is not listed — such changes are discarded.
- DEFAULT TO NO CHANGE. Most beats move nothing. Only emit a delta when the message contains a concrete cause (an action, a revelation, a betrayal, a kindness, a display of skill, a slight).
- Deltas are SMALL: normally between -8 and +8. Reserve magnitudes up to ±25 (set "major": true) ONLY for genuinely major events (betrayal, saving a life, a confession, a killing).
- Trust barely moves up on nice words — it grows from repeated, costly, demonstrated reliability. It drops sharply on deception or betrayal.
- A character's personality matters: a suspicious or cynical character grants trust/affection even slower.
- NEVER emit a change whose "from" is the player ({{user}} / the player's name). You only model how NPCs feel.
- Give a short, concrete reason for every delta, grounded in the message.
- If nothing meaningful happened, return { "changes": [] }.

Respond with ONLY this JSON:
{ "changes": [ { "from": "Character", "to": "Character or {{user}}", "axis": "trust|affection|respect|attraction", "delta": -8..25, "major": false, "reason": "what in the scene caused it" } ] }`;

/** Defensive cap on how many bonds are described to the analyst in one call. */
const MAX_ANALYZED_BONDS = 20;

interface RawChange {
    from?: string;
    to?: string;
    axis?: string;
    delta?: number;
    major?: boolean;
    reason?: string;
}

export function parseRelationshipDeltas(text: string): RawChange[] {
    const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json\n?/gi, '')
        .replace(/```\n?/g, '');
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return [];
    try {
        const parsed = JSON.parse(cleaned.substring(first, last + 1));
        return Array.isArray(parsed?.changes) ? parsed.changes : [];
    } catch {
        return [];
    }
}

/**
 * Build the per-relationship state lines fed to the analyst. Each line is tagged on-stage or
 * off-stage rather than filtered out: the model is told who is present and decides for itself
 * what moved. Hard-filtering the candidates is what silenced the analyst — a character almost
 * never writes their own name in their own line, so the one who just spoke read as absent.
 */
function describeRelationships(
    rels: DirectedRelationship[],
    userName: string,
    onStage: Set<string>
): string {
    return rels
        .map((r) => {
            const a = r.axes;
            const axisStr = RELATIONSHIP_AXES.map(
                (ax) => `${ax} ${a[ax]} (${axisLabel(ax, a[ax])})`
            ).join(', ');
            const from = r.from === USER_REL_KEY ? userName : r.from;
            const to = r.to === USER_REL_KEY ? userName : r.to;
            const present =
                onStage.has(r.from.toLowerCase()) || r.from === USER_REL_KEY
                    ? ''
                    : ' [not in this scene]';
            return `${from} → ${to}: ${axisStr}${present}`;
        })
        .join('\n');
}

/**
 * Analyze the latest beat and update NPC-origin relationships among the characters on stage.
 * Gated by its own toggle (it makes a background API call on the unified background layer —
 * NanoGPT quota or free OpenRouter models). Creates nothing: a conversation with no
 * hand-made bond costs zero here, not even a DB read.
 */
export async function analyzeAndUpdateRelationships(
    card: CharacterCard,
    conversationId: string,
    newMessage: string,
    messageId?: string,
    /** Ground truth from the app: who the beat was attributed to. */
    speakerNames?: string[],
    /**
     * Id of the message this one replaces (regenerate / retry / continue-by-reroll produce a
     * NEW message, so its deltas are filed under a different id than the version being
     * discarded). Its deltas are rolled back before the fresh beat is scored.
     */
    supersededMessageId?: string
): Promise<void> {
    const settings = useSettingsStore.getState();
    // Deliberately NOT gated on useCanonCodex: relationships also work for OC cards and
    // canon-off setups (the panel stays functional). Only its own toggle disables it.
    if (!(settings.enableRelationshipAnalyst ?? true)) return;
    if (!newMessage.trim()) return;

    const chat = useChatStore.getState();
    const conv = chat.conversations.find((c) => c.id === conversationId);
    if (!conv) return;

    // Nothing tracked → nothing to move. Bail before the dossier read and the API call:
    // bonds are only born in the Relations panel, so an untouched conversation is free.
    let tracked = conv.relationships || [];
    if (tracked.length === 0) return;

    // Re-scoring a beat we already scored (regenerate / continue / retry): roll back the
    // previous version's deltas, so one beat counts once however often it is rewritten. The
    // alternative — skipping the analysis — is what made rerolled beats stop moving.
    // Both ids matter: continue-in-place reuses the same message, a reroll makes a new one.
    //
    // Computed here but NOT persisted: writing the rollback before the API call would destroy
    // the bond's history outright whenever that call fails (no key, quota, network).
    const staleIds = [...new Set([messageId, supersededMessageId].filter(Boolean) as string[])];
    let rolledBack = false;
    if (staleIds.length > 0) {
        const next = tracked.map((r) =>
            staleIds.reduce((acc, id) => revertMessageDeltas(acc, id), r)
        );
        rolledBack = next.some((r, i) => r !== tracked[i]);
        if (rolledBack) tracked = next;
    }

    // Canon dossiers only enrich the analysis (personality cues) — the analyst runs without them.
    const work = resolveWork(card);
    const dossiers = work ? await getCanonDossiersByWork(work) : [];

    // Who is on stage. Ground truth (the speaker the app attributed, the Troupe roster, the
    // recent cast) plus literal name matches — NOT name matching alone, which misses the very
    // character who just spoke and so returned "nobody is here" on ordinary prose.
    const activeNames = onStageNames({
        cardName: card.name,
        speakerNames,
        sceneRoster: conv.sceneRoster,
        stickyCast: conv.stickyCast,
        mentioned: getActiveCanonNames(card, conv, [{ content: newMessage } as never], 1),
    });

    const activePersona = settings.personas.find((p) => p.id === settings.activePersonaId);
    // Persona-at-send-time: the ledger must name the persona who actually played this
    // beat, not whichever persona is active when the analysis runs.
    const lastUserSpeaker = [...chat.messages]
        .reverse()
        .find(
            (m) => m.conversationId === conversationId && m.role === 'user' && m.speaker?.name
        )?.speaker?.name;
    const userName = lastUserSpeaker || activePersona?.name || 'the player';

    // Candidates: every NPC-origin bond ({{user}}→X is the player's to write, never the AI's).
    // Deliberately NOT filtered down to who is on stage — that filter only ever made sense as
    // damage control for auto-created bonds, and with manual creation the list is short. It is
    // ordered instead (on-stage first, then NPC→player, then most recently touched) and capped,
    // with presence marked per line so the model judges rather than being pre-censored.
    const activeSet = new Set(activeNames.map((n) => n.toLowerCase()));
    const rank = (r: DirectedRelationship) =>
        (activeSet.has(r.from.toLowerCase()) ? 0 : 4) +
        (activeSet.has(r.to.toLowerCase()) || r.to === USER_REL_KEY ? 0 : 2) +
        (r.to === USER_REL_KEY ? 0 : 1);
    const eligible = tracked
        .filter((r) => r.from !== USER_REL_KEY)
        .sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MAX_ANALYZED_BONDS);
    if (eligible.length === 0) return;

    // Short personality cues so the analyst can modulate by character.
    const dossierByName = new Map(dossiers.map((d) => [d.character.toLowerCase(), d] as const));
    const personaCues = activeNames
        .map((n) => dossierByName.get(n.toLowerCase()))
        .filter((d): d is CanonDossier => !!d && !!d.identity.trim())
        .map((d) => `${d.character}: ${d.identity.slice(0, 220)}`)
        .join('\n');

    // Who wrote this beat. Without it the analyst got an unattributed block of prose and had to
    // guess the speaker from the narration — a character's own line rarely names them.
    const spoke = (speakerNames?.length ? speakerNames : [card.name]).filter(Boolean);

    const userPrompt = [
        `Player (the user, {{user}}): ${userName}`,
        `Characters present in this scene: ${activeNames.join(', ') || '(unclear)'}`,
        `This beat was written by: ${spoke.join(', ')}. The prose is theirs — narration in the third person ("she", "he") refers to them unless another character is named.`,
        personaCues && `Character personalities:\n${personaCues}`,
        `Current relationship values (only propose changes for these "from" characters; NEVER for ${userName}). Lines marked [not in this scene] belong to characters who are absent — leave them alone unless the beat genuinely involves them:\n${describeRelationships(
            eligible,
            userName,
            activeSet
        )}`,
        `Latest message in the scene:\n"""${newMessage.replace(/{{user}}/gi, userName).slice(0, 4000)}"""`,
    ]
        .filter(Boolean)
        .join('\n\n');

    const result = await backgroundAICall({
        systemPrompt: RELATIONSHIP_ANALYST_PROMPT,
        userPrompt,
        temperature: 0.3,
        maxTokens: 1200,
        disableReasoning: true,
    });
    // Analysis failed (no key, quota, network): leave the bonds exactly as they were. In
    // particular do NOT commit the rollback — a failed reroll must not erase history.
    if (!result) return;

    /** Commit the rollback even when nothing new moved: the old beat no longer exists. */
    const persistRollbackOnly = () => {
        if (rolledBack) useChatStore.getState().setRelationships(conversationId, tracked);
    };

    const changes = parseRelationshipDeltas(result.content);
    if (changes.length === 0) return persistRollbackOnly();

    // Group valid changes by relationship key.
    const byKey = new Map<string, { rel: DirectedRelationship; deltas: ProposedDelta[] }>();
    for (const c of changes) {
        if (!c.from || !c.to || !c.axis || typeof c.delta !== 'number') continue;
        if (c.from === USER_REL_KEY || c.from.toLowerCase() === userName.toLowerCase()) continue; // never the player
        if (!RELATIONSHIP_AXES.includes(c.axis as RelationshipAxis)) continue;
        const toKey = c.to.toLowerCase() === userName.toLowerCase() ? USER_REL_KEY : c.to;
        const rel = findRelationship(tracked, c.from, toKey);
        // The creation guard: an unknown pair is dropped, never minted. Bonds are born by hand
        // in the Relations panel — the model only gets to move what already exists.
        if (!rel) continue;
        const k = relKey(rel.from, rel.to);
        if (!byKey.has(k)) byKey.set(k, { rel, deltas: [] });
        byKey.get(k)!.deltas.push({
            axis: c.axis as RelationshipAxis,
            delta: c.delta,
            reason: c.reason || 'unspecified',
            major: !!c.major,
        });
    }
    if (byKey.size === 0) return persistRollbackOnly();

    // Apply via the engine (caps, velocity, resistance, ledger) and persist.
    const updatedByKey = new Map<string, DirectedRelationship>();
    for (const { rel, deltas } of byKey.values()) {
        updatedByKey.set(relKey(rel.from, rel.to), applyDeltas(rel, deltas, messageId));
    }
    const next = tracked.map((r) => updatedByKey.get(relKey(r.from, r.to)) || r);
    useChatStore.getState().setRelationships(conversationId, next);
    console.log(`[Relationships] Updated ${updatedByKey.size} bond(s) from the last beat.`);
}
