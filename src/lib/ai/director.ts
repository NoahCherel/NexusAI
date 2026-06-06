'use client';

/**
 * Director: instantiate canonical characters within a whole-work RPG card, and propose
 * arc-aware next scenes. "Creating a character" here means fetching their immutable canon
 * dossier (timeline-capped) and adding them to the card's persistent `canonCast` roster —
 * not inventing them.
 */

import { useSettingsStore } from '@/stores/settings-store';
import { useCharacterStore } from '@/stores/character-store';
import { decryptApiKey } from '@/lib/crypto';
import { backgroundAICall } from '@/lib/ai/background-ai';
import { fetchCharacterDossier, fetchCastRoster } from '@/lib/ai/canon-retrieval';
import { resolveWork } from '@/lib/ai/canon-context';
import { getCanonDossiersByWork } from '@/lib/db';
import { getArcOutline } from '@/lib/db';
import type { CharacterCard } from '@/types/character';
import type { Conversation } from '@/types/chat';
import type { CanonDossier } from '@/types/canon';

async function getModelConfig(): Promise<{ apiKey: string; model: string } | null> {
    const { apiKeys, activeModel, backgroundModel } = useSettingsStore.getState();
    const keyConfig = apiKeys.find((k) => k.provider === 'openrouter') || apiKeys[0];
    if (!keyConfig) {
        console.warn('[Director] No API key configured.');
        return null;
    }
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

/**
 * Pre-fill the card's canon cast: one web call fetches the roster of major characters (names
 * + arcs they appear in), stored as stub dossiers; full dossiers are fetched later on demand.
 * Adds every roster name to the card's `canonCast`. Returns the number of NEW characters added.
 *
 * Pass `mode: 'more'` to ask for ADDITIONAL canonical characters beyond what's already known
 * (uses both the card's `canonCast` and any dossiers already in the DB as the exclusion set,
 * so subsequent clicks keep surfacing new names instead of repeating the top 15).
 */
export async function populateCanonRoster(
    card: CharacterCard,
    mode: 'initial' | 'more' = 'initial'
): Promise<number> {
    const work = resolveWork(card);
    if (!work) return 0;

    let excludeNames: string[] = [];
    if (mode === 'more') {
        // Source of truth = the DB dossiers, NOT `card.canonCast`. The card's list can lag
        // behind deletions (a stub may have been removed via the cast tab without being purged
        // from the card's roster), and including a deleted name in the exclusion list both
        // wastes prompt tokens and prevents the model from re-suggesting it on demand.
        excludeNames = (await getCanonDossiersByWork(work)).map((d) => d.character);
    }

    const entries = await fetchCastRoster(work, excludeNames);
    if (entries.length === 0) return 0;

    const existing = card.canonCast || [];
    const lower = new Set(existing.map((n) => n.toLowerCase()));
    const merged = [...existing];
    let added = 0;
    for (const e of entries) {
        if (!lower.has(e.name.toLowerCase())) {
            merged.push(e.name);
            lower.add(e.name.toLowerCase());
            added++;
        }
    }
    const updates: Partial<CharacterCard> = { canonCast: merged };
    if (!card.work) updates.work = work;
    await useCharacterStore.getState().updateCharacter(card.id, updates);
    return added;
}

/**
 * Instantiate a canonical character within the work card: fetch (or reuse) their dossier,
 * capped at the conversation's current timeline, and add them to the card's `canonCast`.
 */
export async function createCanonCharacter(
    card: CharacterCard,
    conversation: Conversation | undefined,
    name: string
): Promise<CanonDossier | null> {
    const work = resolveWork(card);
    if (!work || !name.trim()) return null;
    const cap = conversation?.arc?.currentPosition?.trim() || 'Start';

    const dossier = await fetchCharacterDossier(work, name.trim(), cap);
    if (!dossier) return null;

    const cast = card.canonCast || [];
    const exists = cast.some((c) => c.toLowerCase() === name.trim().toLowerCase());
    const updates: Partial<CharacterCard> = {};
    if (!exists) updates.canonCast = [...cast, dossier.character];
    if (!card.work) updates.work = work; // persist the resolved work on first use
    if (Object.keys(updates).length > 0) {
        await useCharacterStore.getState().updateCharacter(card.id, updates);
    }
    return dossier;
}

/** Propose three arc-aware next scenes (who / when / what). */
export async function proposeScenes(
    card: CharacterCard,
    conversation: Conversation | undefined,
    recentSummary?: string
): Promise<string[]> {
    const config = await getModelConfig();
    if (!config) return [];

    const work = resolveWork(card);
    const outline = (await getArcOutline(work))?.outline || '';
    const cast = (card.canonCast || []).join(', ');
    const nextBeat = conversation?.arc?.nextBeat || '';
    const position = conversation?.arc?.currentPosition || '';

    const systemPrompt = `You are the Director of a roleplay set in an existing work. Propose exactly 3 distinct next-scene ideas that move the story forward, staying true to canon and the work's arc progression. Each scene: one short sentence (who / when / what). Favor scenes that gently advance toward the next canonical beat without spoiling or railroading. Output a plain numbered list, nothing else.`;

    const userPrompt = [
        `Work: ${work}`,
        position && `Current position: ${position}`,
        nextBeat && `Next canonical beat to steer toward: ${nextBeat}`,
        outline && `Arc map:\n${outline}`,
        cast && `Characters in play: ${cast}`,
        recentSummary && `Recently: ${recentSummary}`,
    ]
        .filter(Boolean)
        .join('\n');

    const result = await backgroundAICall({
        systemPrompt,
        userPrompt,
        apiKey: config.apiKey,
        models: [config.model],
        temperature: 0.9,
        // Generous budget: if a reasoning model ignores disableReasoning, leave room for the
        // list to still be produced (the <think> blocks are stripped by backgroundAICall).
        maxTokens: 1500,
        disableReasoning: true, // we want the list, not the model's thinking
    });
    if (!result) return [];

    return result.content
        .split('\n')
        .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
        .filter((l) => l.length > 0)
        .slice(0, 3);
}
