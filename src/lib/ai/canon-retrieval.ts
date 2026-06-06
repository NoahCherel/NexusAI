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
import type { CanonDossier, ArcOutline, CanonRelationship, CanonRosterEntry } from '@/types/canon';

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

/**
 * Extract the first balanced JSON object from a model response.
 *
 * Robust to truncation: if the output is cut off mid-array (e.g. `maxTokens` reached
 * during a long roster), we try to salvage by closing the JSON at the last complete entry.
 * Specifically for a `{ "characters": [ … ] }` shape, we cut after the last fully-closed
 * `}` inside the array and synthetically close the array + object. This means a partial
 * roster still yields a usable parse instead of dropping everything.
 */
function extractJsonObject(text: string): unknown | null {
    const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json\n?/gi, '')
        .replace(/```\n?/g, '');
    const first = cleaned.indexOf('{');
    if (first === -1) return null;

    // Fast path: full balanced JSON.
    const last = cleaned.lastIndexOf('}');
    if (last > first) {
        try {
            return JSON.parse(cleaned.substring(first, last + 1));
        } catch {
            /* fall through to salvage */
        }
    }

    // Salvage path: find an array opener, walk forward keeping bracket depth, and remember
    // the offset right after the last complete top-level array element (`}` at depth 1 inside
    // the array). Then close brackets to balance.
    const arrStart = cleaned.indexOf('[', first);
    if (arrStart === -1) return null;
    let depth = 0;
    let inStr = false;
    let escape = false;
    let lastGoodEnd = -1;
    for (let i = arrStart; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (inStr) {
            if (escape) escape = false;
            else if (ch === '\\') escape = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            continue;
        }
        if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') {
            depth--;
            // Right after a complete top-level array element: array depth is 1 (we're back inside
            // the array but outside any object) ⇒ remember this position as a safe truncation point.
            if (ch === '}' && depth === 1) lastGoodEnd = i + 1;
        }
    }
    if (lastGoodEnd === -1) return null;
    const salvaged = cleaned.substring(first, lastGoodEnd) + ']}';
    try {
        const parsed = JSON.parse(salvaged);
        console.warn('[Canon] JSON was truncated — salvaged partial entries.');
        return parsed;
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
  "appearsInArcs": ["arc name where they first appear", "other arcs where they are prominent"],
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

    const existing = await getCanonDossier(work, character);
    if (!options.force) {
        // Never silently overwrite manual edits.
        if (existing?.userEdited) return existing;
        // Reuse a real (non-stub) cached dossier at the same cap.
        if (existing && !existing.stub && existing.timelineCap === timelineCap) return existing;
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
              appearsInArcs?: string[];
              sources?: string[];
          }
        | null;
    if (!parsed || typeof parsed.identity !== 'string') {
        console.warn('[Canon] Dossier response was not parseable JSON:', result.content.slice(0, 300));
        return null;
    }

    const fetchedArcs = Array.isArray(parsed.appearsInArcs)
        ? parsed.appearsInArcs.filter((s) => typeof s === 'string')
        : [];
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
        // Keep arcs the roster already knew if the dossier call didn't return any.
        appearsInArcs: fetchedArcs.length > 0 ? fetchedArcs : existing?.appearsInArcs,
        sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s) => typeof s === 'string') : [],
        fetchedAt: Date.now(),
        stub: false,
        enabled: existing?.enabled ?? true,
    };

    await saveCanonDossier(dossier);
    return dossier;
}

const ROSTER_SYSTEM_PROMPT = `You are a canon archivist with deep knowledge of fiction. List the MAJOR recurring characters of the OFFICIAL, CANONICAL work named by the user (protagonists, deuteragonists, key allies, rivals, major antagonists). Aim for the 15-30 most important named characters.

CRITICAL:
- Use ONLY the official canon of the named work. NEVER include fan-fiction, fan-made, OC, or non-canonical characters. If a name is not a real canonical character of THIS work, do not list it.
- For each, give the canonical arc(s) where they first appear or are prominent, using the work's standard official arc names.
- If you do not actually know this work, return an empty characters array rather than inventing names.

Respond with ONLY this JSON object:
{ "characters": [ { "name": "Character Name", "appearsInArcs": ["Arc Name", "..."] } ] }`;

/**
 * One-shot roster fetch: the list of major characters + the arcs they appear in. Stores each
 * as a lightweight stub dossier (full canon fetched later, on demand). Returns the entries.
 * Existing full or user-edited dossiers are preserved (only their arcs are backfilled).
 *
 * Pass `excludeNames` to ask the model for ADDITIONAL canonical characters beyond a known cast
 * — used by "Plus de persos" so a second click brings new names instead of repeating the top 15.
 */
export async function fetchCastRoster(
    work: string,
    excludeNames: string[] = []
): Promise<CanonRosterEntry[]> {
    if (!work.trim()) return [];
    const config = await getRetrievalConfig();
    if (!config) return [];

    const hasExclude = excludeNames.length > 0;
    console.log(
        `[Canon] Fetching cast roster for ${work} via ${config.model}` +
            (hasExclude ? ` (excluding ${excludeNames.length} already-known)` : '')
    );

    const userPrompt = hasExclude
        ? `Work: ${work}\n\nThe following canonical characters are ALREADY in the roster — DO NOT list them again. List OTHER major canonical characters of the work, especially recurring supporting cast, secondary antagonists, mentors, captains, family members, and other named characters who appear across multiple arcs. Aim for 15-25 new names. If you cannot think of more genuinely canonical characters, return an empty array rather than padding with minor one-off names.\n\nAlready known: ${excludeNames.join(', ')}`
        : `Work: ${work}`;

    const result = await backgroundAICall({
        systemPrompt: ROSTER_SYSTEM_PROMPT,
        userPrompt,
        apiKey: config.apiKey,
        models: [config.model],
        temperature: 0.2,
        // Long works (Naruto: 25+ chars × 10-15 arcs each) easily exceed 2500 tokens. With the
        // salvage parser this is a soft cap, but bumping it avoids losing entries.
        maxTokens: 6000,
        // Model knowledge, NOT web search: a generic "list characters of X" web search pulls in
        // fan-fiction/OC characters. The base model knows the canonical cast of popular works.
        disableReasoning: true,
    });
    if (!result) return [];

    const parsed = extractJsonObject(result.content) as { characters?: CanonRosterEntry[] } | null;
    const list = Array.isArray(parsed?.characters) ? parsed!.characters : [];
    const excludeSet = new Set(excludeNames.map((n) => n.trim().toLowerCase()));
    const entries = list
        .filter((c): c is CanonRosterEntry => !!c && typeof c.name === 'string' && !!c.name.trim())
        .map((c) => ({
            name: c.name.trim(),
            appearsInArcs: Array.isArray(c.appearsInArcs)
                ? c.appearsInArcs.filter((s) => typeof s === 'string')
                : [],
        }))
        // Safety net: even when told to exclude, models occasionally slip a known name back in.
        .filter((e) => !excludeSet.has(e.name.toLowerCase()));

    for (const entry of entries) {
        const existing = await getCanonDossier(work, entry.name);
        if (existing && !existing.stub) {
            // Keep the full/edited dossier; just backfill arcs if missing.
            if ((!existing.appearsInArcs || existing.appearsInArcs.length === 0) && entry.appearsInArcs?.length) {
                await saveCanonDossier({ ...existing, appearsInArcs: entry.appearsInArcs });
            }
            continue;
        }
        const stub: CanonDossier = {
            work: work.trim(),
            character: entry.name,
            timelineCap: '',
            identity: '',
            backstory: '',
            relationships: [],
            appearsInArcs: entry.appearsInArcs,
            fetchedAt: Date.now(),
            stub: true,
            enabled: true,
        };
        await saveCanonDossier(stub);
    }
    return entries;
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
