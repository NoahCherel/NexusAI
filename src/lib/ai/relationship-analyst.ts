'use client';

/**
 * Relationship analyst — the background pass that turns "what happened this beat" into
 * justified, capped relationship deltas. Heavily biased AGAINST the LLM's instinct to make
 * everyone warm up instantly.
 *
 * Only NPC-origin relationships are updated (NPC→player, NPC→NPC). The player's own feelings
 * ({{user}}→X) are never authored by the AI — that's the user's to set in the editor.
 */

import { useSettingsStore } from '@/stores/settings-store';
import { useChatStore } from '@/stores/chat-store';
import { decryptApiKey } from '@/lib/crypto';
import { backgroundAICall } from '@/lib/ai/background-ai';
import { getCanonDossiersByWork } from '@/lib/db';
import { resolveWork, getActiveCanonNames } from '@/lib/ai/canon-context';
import { ensureRelationships } from '@/lib/ai/relationship-context';
import {
    applyDeltas,
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
- DEFAULT TO NO CHANGE. Most beats move nothing. Only emit a delta when the message contains a concrete cause (an action, a revelation, a betrayal, a kindness, a display of skill, a slight).
- Deltas are SMALL: normally between -8 and +8. Reserve magnitudes up to ±25 (set "major": true) ONLY for genuinely major events (betrayal, saving a life, a confession, a killing).
- Trust barely moves up on nice words — it grows from repeated, costly, demonstrated reliability. It drops sharply on deception or betrayal.
- A character's personality matters: a suspicious or cynical character grants trust/affection even slower.
- NEVER emit a change whose "from" is the player ({{user}} / the player's name). You only model how NPCs feel.
- Give a short, concrete reason for every delta, grounded in the message.
- If nothing meaningful happened, return { "changes": [] }.

Respond with ONLY this JSON:
{ "changes": [ { "from": "Character", "to": "Character or {{user}}", "axis": "trust|affection|respect|attraction", "delta": -8..25, "major": false, "reason": "what in the scene caused it" } ] }`;

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

async function getConfig(): Promise<{ apiKey: string; model: string } | null> {
    const { apiKeys, activeModel, backgroundModel } = useSettingsStore.getState();
    const keyConfig = apiKeys.find((k) => k.provider === 'openrouter') || apiKeys[0];
    if (!keyConfig) return null;
    try {
        const apiKey = await decryptApiKey(keyConfig.encryptedKey);
        if (!apiKey) return null;
        const model =
            backgroundModel ||
            (activeModel && activeModel.includes('/') ? activeModel : 'google/gemini-3-flash-preview');
        return { apiKey, model };
    } catch {
        return null;
    }
}

/** Build the per-relationship state lines fed to the analyst. */
function describeRelationships(rels: DirectedRelationship[], userName: string): string {
    return rels
        .map((r) => {
            const a = r.axes;
            const axisStr = RELATIONSHIP_AXES.map(
                (ax) => `${ax} ${a[ax]} (${axisLabel(ax, a[ax])})`
            ).join(', ');
            const from = r.from === USER_REL_KEY ? userName : r.from;
            const to = r.to === USER_REL_KEY ? userName : r.to;
            return `${from} → ${to}: ${axisStr}`;
        })
        .join('\n');
}

/**
 * Analyze the latest beat and update NPC-origin relationships among the characters on stage.
 * Gated by the Canon Codex master switch and web/auto-fetch (it makes a background API call).
 */
export async function analyzeAndUpdateRelationships(
    card: CharacterCard,
    conversationId: string,
    newMessage: string,
    messageId?: string
): Promise<void> {
    const settings = useSettingsStore.getState();
    if (!settings.useCanonCodex || !settings.useCanonAutoFetch) return;
    if (!newMessage.trim()) return;

    const work = resolveWork(card);
    if (!work) return;

    const chat = useChatStore.getState();
    const conv = chat.conversations.find((c) => c.id === conversationId);
    if (!conv) return;

    const dossiers = await getCanonDossiersByWork(work);

    // Which cast members are involved in this beat?
    const activeNames = getActiveCanonNames(
        card,
        conv,
        [{ content: newMessage } as never],
        1
    );
    if (activeNames.length === 0) return; // no tracked character on stage → nothing to update

    // Seed any missing pairs (NPC→player + canon-seeded NPC→NPC) and persist if new ones appeared.
    const { relationships: seeded, changed } = ensureRelationships(
        conv.relationships,
        activeNames,
        dossiers
    );
    if (changed) chat.setRelationships(conversationId, seeded);

    const config = await getConfig();
    if (!config) return;

    const activePersona = settings.personas.find((p) => p.id === settings.activePersonaId);
    const userName = activePersona?.name || 'the player';

    // Relationships eligible for update: NPC-origin, touching an active character.
    const activeSet = new Set([USER_REL_KEY.toLowerCase(), ...activeNames.map((n) => n.toLowerCase())]);
    const eligible = seeded.filter(
        (r) =>
            r.from !== USER_REL_KEY &&
            activeSet.has(r.from.toLowerCase()) &&
            activeSet.has(r.to.toLowerCase())
    );
    if (eligible.length === 0) return;

    // Short personality cues so the analyst can modulate by character.
    const dossierByName = new Map(dossiers.map((d) => [d.character.toLowerCase(), d] as const));
    const personaCues = activeNames
        .map((n) => dossierByName.get(n.toLowerCase()))
        .filter((d): d is CanonDossier => !!d && !!d.identity.trim())
        .map((d) => `${d.character}: ${d.identity.slice(0, 220)}`)
        .join('\n');

    const userPrompt = [
        `Player (the user, {{user}}): ${userName}`,
        personaCues && `Character personalities:\n${personaCues}`,
        `Current relationship values (only propose changes for these "from" characters; NEVER for ${userName}):\n${describeRelationships(
            eligible,
            userName
        )}`,
        `Latest message in the scene:\n"""${newMessage.replace(/{{user}}/gi, userName).slice(0, 4000)}"""`,
    ]
        .filter(Boolean)
        .join('\n\n');

    const result = await backgroundAICall({
        systemPrompt: RELATIONSHIP_ANALYST_PROMPT,
        userPrompt,
        apiKey: config.apiKey,
        models: [config.model],
        temperature: 0.3,
        maxTokens: 1200,
        disableReasoning: true,
    });
    if (!result) return;

    const changes = parseRelationshipDeltas(result.content);
    if (changes.length === 0) return;

    // Group valid changes by relationship key.
    const byKey = new Map<string, { rel: DirectedRelationship; deltas: ProposedDelta[] }>();
    for (const c of changes) {
        if (!c.from || !c.to || !c.axis || typeof c.delta !== 'number') continue;
        if (c.from === USER_REL_KEY || c.from.toLowerCase() === userName.toLowerCase()) continue; // never the player
        if (!RELATIONSHIP_AXES.includes(c.axis as RelationshipAxis)) continue;
        const toKey = c.to.toLowerCase() === userName.toLowerCase() ? USER_REL_KEY : c.to;
        const rel = findRelationship(seeded, c.from, toKey);
        if (!rel) continue; // only update pairs we already track (no surprise new characters here)
        const k = relKey(rel.from, rel.to);
        if (!byKey.has(k)) byKey.set(k, { rel, deltas: [] });
        byKey.get(k)!.deltas.push({
            axis: c.axis as RelationshipAxis,
            delta: c.delta,
            reason: c.reason || 'unspecified',
            major: !!c.major,
        });
    }
    if (byKey.size === 0) return;

    // Apply via the engine (caps, velocity, resistance, ledger) and persist.
    const updatedByKey = new Map<string, DirectedRelationship>();
    for (const { rel, deltas } of byKey.values()) {
        updatedByKey.set(relKey(rel.from, rel.to), applyDeltas(rel, deltas, messageId));
    }
    const next = seeded.map((r) => updatedByKey.get(relKey(r.from, r.to)) || r);
    useChatStore.getState().setRelationships(conversationId, next);
    console.log(`[Relationships] Updated ${updatedByKey.size} bond(s) from the last beat.`);
}
