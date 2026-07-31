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

/** Hard ceiling — the effective cap is the user's `maxSceneSpeakers` setting (1..8). */
export const MAX_SPEAKERS_CEILING = 8;
export const DEFAULT_MAX_SPEAKERS = 5;

export interface SceneChange {
    location?: string;
    event?: string;
    enter?: string[];
    exit?: string[];
}

export interface SceneSpeaker {
    name: string;
    /** The Director's stage direction for this turn: goal, emotion, initiative. */
    direction?: string;
}

export interface DirectorDecision {
    narration?: string;
    speakers: SceneSpeaker[];
    /** Dramatic goal of the whole beat (given to the first speaker as shared context). */
    sceneGoal?: string;
    sceneChange?: SceneChange;
}

function buildDirectorSystemPrompt(maxSpeakers: number): string {
    return `You are the scene DIRECTOR of an ensemble roleplay. You never write the characters' dialogue; you decide WHO reacts, WITH WHAT INTENT, and WHAT shifts on stage. Your job is to keep every beat DRAMATICALLY INTERESTING: vary who takes the spotlight, create friction, initiatives and secrets, never let everyone politely agree.
Reply with ONE JSON object, nothing else:
{
  "narration": "1-3 sentences of diegetic scene narration (weather, atmosphere, events, passage of time). Omit or empty if nothing changed.",
  "sceneGoal": "one sentence: the dramatic point of this beat (a tension to sharpen, a reveal to seed, a choice to force).",
  "speakers": [
    { "name": "Name1", "direction": "one sentence of stage direction: what this character wants, feels, or DOES this turn." },
    { "name": "Name2", "direction": "..." }
  ],
  "sceneChange": { "location": "...", "event": "...", "enter": ["Name"], "exit": ["Name"] }
}
Rules:
- "speakers": ONLY names from the roster, most-relevant first, at most ${maxSpeakers}. Whoever was directly addressed reacts first. Not everyone needs to speak — pick the characters whose reaction MATTERS this beat; silence is fine (empty array).
- Give each speaker a DIFFERENT direction — contrasting goals and emotions make the scene alive. Someone may interrupt, deflect, lie, act instead of talking.
- Never include the player in "speakers". Never reveal secrets in "narration".
- "narration" is diegetic prose (no meta, no brackets), or omitted.
- "sceneChange" only when something actually changes; "enter"/"exit" adjust who is on stage.`;
}

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
            // Prefer the stamped speaker (persona at send time / scene attribution).
            const who = m.speaker?.name || (m.role === 'user' ? userName : 'GM');
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
 * chatter around the object, accepts BOTH speaker formats (legacy `string[]` and
 * `{name, direction}[]`), enforces roster membership (case-insensitive), the speaker cap,
 * and drops the player from speakers.
 */
export function parseDirectorResponse(
    raw: string,
    roster: string[],
    userName?: string,
    maxSpeakers: number = DEFAULT_MAX_SPEAKERS
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

    const cap = Math.max(1, Math.min(MAX_SPEAKERS_CEILING, maxSpeakers));

    // Canonical-name resolution: the model may echo names with different casing.
    const canonical = new Map(roster.map((n) => [n.toLowerCase(), n]));
    const userLower = userName?.toLowerCase();

    const speakers: SceneSpeaker[] = [];
    if (Array.isArray(parsed.speakers)) {
        for (const s of parsed.speakers) {
            let name: string | undefined;
            let direction: string | undefined;
            if (typeof s === 'string') {
                name = s;
            } else if (s && typeof s === 'object') {
                const obj = s as Record<string, unknown>;
                if (typeof obj.name === 'string') name = obj.name;
                if (typeof obj.direction === 'string' && obj.direction.trim()) {
                    direction = obj.direction.trim();
                }
            }
            if (!name) continue;
            const resolved = canonical.get(name.trim().toLowerCase());
            if (!resolved) continue;
            if (userLower && resolved.toLowerCase() === userLower) continue;
            if (!speakers.some((sp) => sp.name === resolved)) {
                speakers.push({ name: resolved, direction });
            }
            if (speakers.length >= cap) break;
        }
    }

    const narrationRaw = typeof parsed.narration === 'string' ? parsed.narration.trim() : '';
    const sceneGoal =
        typeof parsed.sceneGoal === 'string' && parsed.sceneGoal.trim()
            ? parsed.sceneGoal.trim()
            : undefined;

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
        sceneGoal,
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
    maxSpeakers?: number;
}): Promise<DirectorDecision> {
    const maxSpeakers = params.maxSpeakers ?? DEFAULT_MAX_SPEAKERS;
    try {
        const result = await backgroundAICall({
            systemPrompt: buildDirectorSystemPrompt(maxSpeakers),
            userPrompt: buildDirectorUserPrompt(params),
            temperature: 0.6,
            maxTokens: 700,
        });
        if (!result) return { speakers: [] };
        return parseDirectorResponse(result.content, params.roster, params.userName, maxSpeakers);
    } catch (err) {
        console.warn('[Scene] Director call failed:', err);
        return { speakers: [] };
    }
}
