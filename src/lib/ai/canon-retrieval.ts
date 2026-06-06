'use client';

/**
 * Agentic canon retrieval.
 *
 * Fetches IMMUTABLE canonical ground truth (character dossiers + arc outlines) for an
 * existing work, via OpenRouter's web_search server tool, and caches it in the `canon` /
 * `arcOutlines` stores. This is the missing "ground truth" layer: the RP layer is always
 * layered ON TOP and never overwrites it.
 *
 * Character dossiers are scoped to a `timelineCap` so they never leak future-arc spoilers
 * into the fiction. Arc outlines are NOT capped (Director/GM meta-knowledge).
 */

import { useSettingsStore } from '@/stores/settings-store';
import { decryptApiKey } from '@/lib/crypto';
import { backgroundAICall } from '@/lib/ai/background-ai';
import { saveCanonDossier, getCanonDossier, saveArcOutline, getArcOutline } from '@/lib/db';
import type { CanonDossier, ArcOutline, CanonRelationship } from '@/types/canon';

/** Best-effort derivation of a work name from an RPG card (e.g. "NarutoRPG" -> "Naruto"). */
export function deriveWorkFromName(cardName: string): string {
    return cardName
        .replace(/\b(rpg|roleplay|rp|simulator|sim|world|universe|saga)\b/gi, '')
        .replace(/[_\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Resolve an OpenRouter API key + a grounding-capable model from settings. */
async function getRetrievalConfig(): Promise<{ apiKey: string; model: string } | null> {
    const { apiKeys, activeModel, backgroundModel } = useSettingsStore.getState();
    // Prefer an OpenRouter-labelled key, but fall back to any stored key (web search needs
    // OpenRouter, and the user's key is an OpenRouter key regardless of which slot it's in).
    const keyConfig = apiKeys.find((k) => k.provider === 'openrouter') || apiKeys[0];
    if (!keyConfig) {
        console.warn('[Canon] No API key configured — web canon retrieval unavailable.');
        return null;
    }
    try {
        const apiKey = await decryptApiKey(keyConfig.encryptedKey);
        if (!apiKey) {
            console.warn('[Canon] API key failed to decrypt — web canon retrieval unavailable.');
            return null;
        }
        // Use the configured background model first (these are background tasks); then the
        // active model if it's an OpenRouter slug; else a capable default.
        const model =
            backgroundModel ||
            (activeModel && activeModel.includes('/') ? activeModel : 'google/gemini-3-flash-preview');
        return { apiKey, model };
    } catch (e) {
        console.warn('[Canon] API key decryption error:', e);
        return null;
    }
}

/** Extract the first balanced JSON object from a model response. */
function extractJsonObject(text: string): unknown | null {
    const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json\n?/gi, '')
        .replace(/```\n?/g, '');
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return null;
    try {
        return JSON.parse(cleaned.substring(first, last + 1));
    } catch {
        return null;
    }
}

const DOSSIER_SYSTEM_PROMPT = `You are a canon archivist. Using web search of the work's wiki/fandom and other authoritative sources, produce a STRICTLY CANONICAL dossier for one character of a given fictional work.

HARD RULES:
- Report only what is canonical in the source work. Do NOT invent, embellish, or use fan theories.
- TIMELINE CAP: include ONLY information established up to and including the given cap. NEVER reveal anything from later in the timeline (no future powers, deaths, twists, or relationships that have not happened yet). When unsure whether a fact is past the cap, omit it.
- Capture the character's VOICE precisely (speech register, verbal tics, how they address others).
- Keep each field tight and factual.

Respond with ONLY this JSON object, no prose:
{
  "identity": "personality, temperament, speech/voice pattern, appearance (1 dense paragraph)",
  "backstory": "canonical background up to the cap (1 dense paragraph)",
  "relationships": [{"name": "Other Character", "nature": "relationship from this character's POV"}],
  "abilities": "canonical abilities/skills known by the cap, or empty string",
  "sources": ["url", "url"]
}`;

/**
 * Fetch (or return cached) the immutable canon dossier for a character of `work`,
 * capped at `timelineCap`. Pass `force` to refetch (e.g. when the timeline advanced).
 */
export async function fetchCharacterDossier(
    work: string,
    character: string,
    timelineCap: string,
    options: { force?: boolean } = {}
): Promise<CanonDossier | null> {
    if (!work.trim() || !character.trim()) return null;

    if (!options.force) {
        const cached = await getCanonDossier(work, character);
        // Reuse cache only if it covers the same (or a later) cap is hard to compare generically,
        // so we reuse on exact cap match; advancing the timeline passes force=true.
        if (cached && cached.timelineCap === timelineCap) return cached;
    }

    const config = await getRetrievalConfig();
    if (!config) return null;

    console.log(`[Canon] Fetching dossier: ${character} (${work}) @ ${timelineCap} via ${config.model}`);

    const userPrompt = `Work: ${work}\nCharacter: ${character}\nTimeline cap (include only canon up to here, no spoilers beyond): ${timelineCap}`;

    const result = await backgroundAICall({
        systemPrompt: DOSSIER_SYSTEM_PROMPT,
        userPrompt,
        apiKey: config.apiKey,
        models: [config.model],
        temperature: 0.2,
        maxTokens: 4000,
        webSearch: true,
        webMaxResults: 5,
    });
    if (!result) return null;

    const parsed = extractJsonObject(result.content) as
        | {
              identity?: string;
              backstory?: string;
              relationships?: CanonRelationship[];
              abilities?: string;
              sources?: string[];
          }
        | null;
    if (!parsed || typeof parsed.identity !== 'string') {
        console.warn('[Canon] Dossier response was not parseable JSON:', result.content.slice(0, 300));
        return null;
    }

    const dossier: CanonDossier = {
        work: work.trim(),
        character: character.trim(),
        timelineCap,
        identity: parsed.identity || '',
        backstory: parsed.backstory || '',
        relationships: Array.isArray(parsed.relationships)
            ? parsed.relationships.filter(
                  (r): r is CanonRelationship =>
                      !!r && typeof r.name === 'string' && typeof r.nature === 'string'
              )
            : [],
        abilities: typeof parsed.abilities === 'string' ? parsed.abilities : undefined,
        sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s) => typeof s === 'string') : [],
        fetchedAt: Date.now(),
    };

    await saveCanonDossier(dossier);
    return dossier;
}

const ARC_SYSTEM_PROMPT = `You are a canon archivist. Using web search of the work's wiki/fandom, produce the ordered list of MAJOR STORY ARCS / key beats of a fictional work, from beginning to end.

RULES:
- Canonical arcs only, in chronological order. One short line each (arc name + one-clause summary).
- This is a high-level map for a Game Master, so include the whole work (spoilers allowed here).

Respond with ONLY this JSON object:
{ "outline": "1. Arc Name — summary\\n2. ...", "sources": ["url"] }`;

/** Fetch (or return cached) the full canonical arc outline for `work`. */
export async function fetchArcOutline(
    work: string,
    options: { force?: boolean } = {}
): Promise<ArcOutline | null> {
    if (!work.trim()) return null;
    if (!options.force) {
        const cached = await getArcOutline(work);
        if (cached) return cached;
    }

    const config = await getRetrievalConfig();
    if (!config) return null;

    const result = await backgroundAICall({
        systemPrompt: ARC_SYSTEM_PROMPT,
        userPrompt: `Work: ${work}`,
        apiKey: config.apiKey,
        models: [config.model],
        temperature: 0.2,
        maxTokens: 3000,
        webSearch: true,
        webMaxResults: 5,
    });
    if (!result) return null;

    const parsed = extractJsonObject(result.content) as
        | { outline?: string; sources?: string[] }
        | null;
    if (!parsed || typeof parsed.outline !== 'string' || !parsed.outline.trim()) return null;

    const outline: ArcOutline = {
        work: work.trim(),
        outline: parsed.outline,
        sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s) => typeof s === 'string') : [],
        fetchedAt: Date.now(),
    };
    await saveArcOutline(outline);
    return outline;
}
