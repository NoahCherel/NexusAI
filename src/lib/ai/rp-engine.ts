// RP Engine content + assembly helpers.
//
// The behavioral rules below are original prose written for NexusAI. They encode a
// priority hierarchy (player autonomy > what characters can know > character truth >
// dialogue > narration) plus an anti-cliché pass. Built-in engines are code constants;
// only user-created engines are persisted in the settings store.

import type { RPEngine, RegisterPolicy } from '@/types/engine';

export const IMMERSIVE_NEXUS_KEY = 'immersive-nexus';
export const COMPACT_KEY = 'compact';

/** Common stock phrases that flag lazy/repetitive prose. English (the RP is in English). */
export const DEFAULT_BAN_LIST: string[] = [
    'a shiver ran down (their) spine',
    "let out a breath (they) didn't know (they) were holding",
    'the air was thick with tension',
    'the air felt charged / electric',
    '(emotion) washed over / flooded (them)',
    'a mix(ture) of (X) and (Y)',
    'barely above a whisper',
    "(they) couldn't help but",
    'little did (they) know',
    'sent shivers (down/through)',
    '(their) heart skipped a beat',
    "(their) breath hitched / caught",
    'a small smile played at the corner of (their) lips',
    'time seemed to slow / stand still',
    'stacking two adjectives onto one feeling ("a raw, aching need")',
];

/**
 * Immersive Nexus — the flagship behavioral engine. Rich on purpose: the goal is RP
 * quality, not token economy. Deliberately omits mechanical pacing rules (forced
 * complication frequencies, "always advance the plot", forced misunderstandings) and
 * modern-brand references, which make RP feel mechanical.
 */
const IMMERSIVE_NEXUS_SYSTEM = `[ROLEPLAY ENGINE — these writing rules govern every response. When two rules conflict, the higher one wins, in this order: (1) player autonomy, (2) what characters can know, (3) character truth, (4) dialogue, (5) narration.]

PLAYER AUTONOMY (highest priority):
- Never write {{user}}'s dialogue, thoughts, decisions, intentions, or actions. Write up to the point where {{user}} would act, then stop and let them act. You may show how the world and other characters react to {{user}}; never decide what {{user}} themselves does or feels.

WHAT CHARACTERS CAN KNOW:
- A character knows only what they have personally seen, heard, or been told. They cannot read {{user}}'s mind, sense unspoken intent, or know about events they did not witness. When a character is unsure, let them guess, ask, or get it wrong — people misread each other, especially under pressure.

CHARACTER TRUTH:
- Keep each character consistent with who they are: their voice, values, fears, and history. Feelings have inertia — trust and warmth move over many beats, not in a single line, and a wound doesn't vanish because the scene would be smoother without it. A character may refuse, lie, withhold, leave, or pursue their own goals even when it's inconvenient. Characters have lives that continue off-screen.

DIALOGUE:
- Write speech the way people actually talk: uneven, interrupted, sometimes clumsy. Vary line length hard — a clipped reply, then a rambling half-thought, then silence. Let grammar fray under strong emotion. Distrust the polished monologue; a short line often hits hardest. Leave room for subtext — what a character avoids saying matters as much as what they say.

NARRATION:
- Keep prose proportional to what actually happens; a small moment stays small. At most one adjective per feeling. Don't open three sentences in a row with the same subject — rotate to objects, sounds, the surroundings. Show behaviour instead of naming the emotion behind it. Give the prose rhythm: a short sentence after a long one, a pause where the scene earns one.`;

/** Compact — a lighter variant for when a leaner prompt is wanted. Optional, never forced. */
const COMPACT_SYSTEM = `[ROLEPLAY ENGINE — priority order when rules conflict: player autonomy > what characters can know > character truth > dialogue > narration.]
- Never write {{user}}'s words, choices, thoughts, or actions; stop and let {{user}} act.
- Characters only know what they witnessed or were told; let them misread, ask, or be wrong.
- Keep characters consistent; feelings shift slowly; they can refuse, lie, or leave.
- Dialogue: spoken, uneven, interrupted; vary line length; trust short lines; leave subtext.
- Narration: proportional; one adjective per feeling; vary sentence openings; show, don't tell.`;

function registerLine(policy: RegisterPolicy): string {
    return policy === 'faithful'
        ? 'Match the explicitness already established in the scene exactly — do not sanitise or soften it into euphemism. Do not introduce crudeness into a scene that is not already explicit.'
        : 'Keep content tasteful; fade to black before explicit material.';
}

function formatBanList(banList: string[]): string {
    if (!banList.length) return '';
    const items = banList.map((b) => `- ${b}`).join('\n');
    return `[AVOID THESE OVERUSED PHRASES AND PATTERNS — if one appears in your draft, rewrite the line:\n${items}]`;
}

function resolveUser(text: string, userName?: string): string {
    return text.replace(/\{\{user\}\}/gi, userName || 'the player');
}

/**
 * A per-chat "learned" ban block (Style Guard), kept distinct from the engine's static
 * list so the model reads it as feedback specific to this conversation. Returns '' if empty.
 */
export function buildLearnedBanBlock(phrases: string[]): string {
    const items = phrases.map((p) => p.trim()).filter(Boolean);
    if (items.length === 0) return '';
    return `[STYLE GUARD — patterns this chat has overused. Do NOT fall back into them:\n${items
        .map((p) => `- ${p}`)
        .join('\n')}]`;
}

/** The system-section block for an engine: rules + register policy + ban list. */
export function buildEngineSystemBlock(
    engine: RPEngine,
    opts: { userName?: string } = {}
): string {
    const parts = [
        engine.systemBlock,
        `REGISTER: ${registerLine(engine.registerPolicy)}`,
        formatBanList(engine.banList),
    ].filter(Boolean);
    return resolveUser(parts.join('\n\n'), opts.userName);
}

/**
 * The short, NexusAI-native block injected AFTER history (right before generation).
 * Mode-aware: `generate` enforces the player-autonomy contract; `impersonate` inverts it
 * (the model writes ONLY the player and must not drive the other characters).
 */
export function buildEnginePostHistory(
    engine: RPEngine,
    mode: 'generate' | 'impersonate',
    opts: { userName?: string } = {}
): string {
    if (mode === 'impersonate') {
        return resolveUser(
            `[IMPERSONATION — write ONLY {{user}}'s next message, in {{user}}'s voice. Do not write, decide, or narrate anything for the other characters; do not reveal their private thoughts.]`,
            opts.userName
        );
    }
    const lines = [
        "You did not write {{user}}'s words, choices, or inner thoughts.",
        'Each character acted only on what they could actually know.',
        'No banned clichés.',
    ];
    if (engine.openingVariety) {
        lines.push(
            'Vary your opening: if your last reply began with narration, start this one on dialogue, a sensation, or mid-action.'
        );
    }
    return resolveUser(`[BEFORE YOU SEND — quick check:\n- ${lines.join('\n- ')}]`, opts.userName);
}

export const BUILTIN_ENGINES: RPEngine[] = [
    {
        id: IMMERSIVE_NEXUS_KEY,
        builtinKey: IMMERSIVE_NEXUS_KEY,
        name: 'Immersive Nexus',
        description:
            'Rich behavioral engine: player autonomy, NPC knowledge limits, lived-in characters, natural dialogue, disciplined prose, anti-cliché.',
        systemBlock: IMMERSIVE_NEXUS_SYSTEM,
        registerPolicy: 'faithful',
        openingVariety: true,
        banList: DEFAULT_BAN_LIST,
    },
    {
        id: COMPACT_KEY,
        builtinKey: COMPACT_KEY,
        name: 'Compact',
        description: 'A leaner version of the engine. Same priorities, fewer words.',
        systemBlock: COMPACT_SYSTEM,
        registerPolicy: 'faithful',
        openingVariety: true,
        banList: DEFAULT_BAN_LIST.slice(0, 8),
    },
];

/** Resolve an engine id against built-ins first, then any custom engines provided. */
export function getEngineById(
    id: string | null | undefined,
    customEngines: RPEngine[] = []
): RPEngine | undefined {
    if (!id) return undefined;
    return (
        BUILTIN_ENGINES.find((e) => e.id === id || e.builtinKey === id) ||
        customEngines.find((e) => e.id === id)
    );
}
