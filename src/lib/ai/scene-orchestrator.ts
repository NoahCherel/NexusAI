'use client';

/**
 * Scene Mode (Troupe) orchestration.
 *
 * After each player beat, a cheap background "Director" call decides what happens on
 * stage: optional narration (scene/weather/event), which characters reply (max 3), and
 * roster changes (enter/exit). Each chosen character then gets their own streamed
 * generation with a per-speaker contract (voice, POV, knowledge limits).
 *
 * The Director runs on the unified background layer (NanoGPT quota / free OpenRouter),
 * NEVER on the paid RP model. Character turns use the active RP provider.
 */

import type { Message, DirectedRelationship } from '@/types/chat';
import { USER_REL_KEY } from '@/types/chat';
import { backgroundAICall } from '@/lib/ai/background-ai';

export const MAX_SPEAKERS_PER_BEAT = 3;

export interface SceneChange {
    location?: string;
    event?: string;
    enter?: string[];
    exit?: string[];
}

export interface DirectorDecision {
    narration?: string;
    speakers: string[];
    sceneChange?: SceneChange;
}

const DIRECTOR_SYSTEM_PROMPT = `You are the scene director of a roleplay. You never write dialogue; you decide WHO reacts and WHAT shifts in the scene. Reply with ONE JSON object, nothing else:
{
  "narration": "1-3 sentences of scene narration (weather, atmosphere, events, time). Omit or empty if nothing changed.",
  "speakers": ["Name1", "Name2"],
  "sceneChange": { "location": "...", "event": "...", "enter": ["Name"], "exit": ["Name"] }
}
Rules:
- "speakers": ONLY names from the roster, most-relevant first, at most ${MAX_SPEAKERS_PER_BEAT}. Whoever was directly addressed reacts first. Not everyone needs to speak — silence is fine (empty array) if the beat targets no one.
- Never include the player in "speakers".
- "narration" is diegetic prose (no meta, no brackets), or omitted.
- "sceneChange" only when something actually changes; "enter"/"exit" adjust who is on stage.`;

export function buildDirectorUserPrompt(params: {
    roster: string[];
    userName: string;
    recentMessages: Message[];
    relationships?: DirectedRelationship[];
    arcPosition?: string;
}): string {
    const { roster, userName, recentMessages, relationships, arcPosition } = params;
    const transcript = recentMessages
        .slice(-10)
        .map((m) => {
            const who =
                m.role === 'user' ? userName : m.speaker?.name || 'GM';
            return `${who}: ${m.content.slice(0, 600)}`;
        })
        .join('\n');

    const relLines = (relationships || [])
        .filter((r) => roster.includes(r.from) && (roster.includes(r.to) || r.to === USER_REL_KEY))
        .slice(0, 12)
        .map(
            (r) =>
                `${r.from} → ${r.to === USER_REL_KEY ? userName : r.to}: trust ${r.axes.trust}, affection ${r.axes.affection}`
        )
        .join('\n');

    return [
        `On stage: ${roster.join(', ')}`,
        `The player is: ${userName}`,
        arcPosition ? `Story position: ${arcPosition}` : '',
        relLines ? `Relationships:\n${relLines}` : '',
        `Recent beats:\n${transcript}`,
        `Decide the next stage direction (JSON only).`,
    ]
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Robust parse of the Director's JSON. Pure (unit-tested): tolerates code fences and
 * chatter around the object, enforces roster membership (case-insensitive), the speaker
 * cap, and drops the player from speakers.
 */
export function parseDirectorResponse(
    raw: string,
    roster: string[],
    userName?: string
): DirectorDecision {
    const empty: DirectorDecision = { speakers: [] };
    if (!raw) return empty;

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return empty;

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
        return empty;
    }

    // Canonical-name resolution: the model may echo names with different casing.
    const canonical = new Map(roster.map((n) => [n.toLowerCase(), n]));
    const userLower = userName?.toLowerCase();

    const speakers: string[] = [];
    if (Array.isArray(parsed.speakers)) {
        for (const s of parsed.speakers) {
            if (typeof s !== 'string') continue;
            const resolved = canonical.get(s.trim().toLowerCase());
            if (!resolved) continue;
            if (userLower && resolved.toLowerCase() === userLower) continue;
            if (!speakers.includes(resolved)) speakers.push(resolved);
            if (speakers.length >= MAX_SPEAKERS_PER_BEAT) break;
        }
    }

    const narrationRaw = typeof parsed.narration === 'string' ? parsed.narration.trim() : '';

    let sceneChange: SceneChange | undefined;
    const sc = parsed.sceneChange as Record<string, unknown> | undefined;
    if (sc && typeof sc === 'object') {
        const names = (v: unknown): string[] | undefined =>
            Array.isArray(v)
                ? v.filter((x): x is string => typeof x === 'string' && !!x.trim())
                : undefined;
        sceneChange = {
            location: typeof sc.location === 'string' ? sc.location : undefined,
            event: typeof sc.event === 'string' ? sc.event : undefined,
            enter: names(sc.enter),
            exit: names(sc.exit),
        };
        if (!sceneChange.location && !sceneChange.event && !sceneChange.enter?.length && !sceneChange.exit?.length) {
            sceneChange = undefined;
        }
    }

    return {
        narration: narrationRaw || undefined,
        speakers,
        sceneChange,
    };
}

/** Apply enter/exit to the roster (dedup, keep order, exits win over enters). */
export function applySceneChange(roster: string[], change?: SceneChange): string[] {
    if (!change) return roster;
    const exits = new Set((change.exit || []).map((n) => n.toLowerCase()));
    const next = roster.filter((n) => !exits.has(n.toLowerCase()));
    for (const name of change.enter || []) {
        if (!next.some((n) => n.toLowerCase() === name.toLowerCase())) next.push(name);
    }
    return next;
}

/** One Director decision via the background AI layer. Never throws — silent scene on failure. */
export async function directorDecide(params: {
    roster: string[];
    userName: string;
    recentMessages: Message[];
    relationships?: DirectedRelationship[];
    arcPosition?: string;
}): Promise<DirectorDecision> {
    try {
        const result = await backgroundAICall({
            systemPrompt: DIRECTOR_SYSTEM_PROMPT,
            userPrompt: buildDirectorUserPrompt(params),
            temperature: 0.6,
            maxTokens: 500,
        });
        if (!result) return { speakers: [] };
        return parseDirectorResponse(result.content, params.roster, params.userName);
    } catch (err) {
        console.warn('[Scene] Director call failed:', err);
        return { speakers: [] };
    }
}
