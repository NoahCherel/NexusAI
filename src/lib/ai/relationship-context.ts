/**
 * Relationship context: the canon seeding heuristic (applied only to bonds the user creates by
 * hand), the one automatic bond, and the directional relationship block injected into the RP
 * prompt.
 *
 * Relationships are CREATED MANUALLY, in the Relations panel. Nothing here mints pairs from the
 * cast automatically: doing so used to fabricate them in N² — every name detected on stage got
 * bonds with the player and with every other name — so walk-on NPCs accumulated relationships
 * that then shipped in the prompt on every single turn. The only exception is
 * `mainCharacterBond`, seeded once when the conversation is created.
 */

import type { DirectedRelationship, RelationshipAxes } from '@/types/chat';
import { USER_REL_KEY } from '@/types/chat';
import { axisLabel, makeRelationship, NEUTRAL_AXES } from '@/lib/ai/relationship-engine';

/**
 * Map a canonical relationship description (e.g. "younger sister, devoted", "rival") to starting
 * axis values. Coarse keyword heuristic — the analyst refines it as the RP unfolds. Applied when
 * the user adds a bond the canon dossier already describes; {{user}} is never seeded this way
 * (the player is a newcomer who must earn everything).
 */
export function seedAxesFromNature(nature: string): Partial<RelationshipAxes> {
    const n = nature.toLowerCase();
    const has = (...words: string[]) => words.some((w) => n.includes(w));

    if (
        has(
            'sister',
            'brother',
            'sibling',
            'family',
            'son',
            'daughter',
            'father',
            'mother',
            'parent'
        )
    ) {
        return { trust: 55, affection: 65, respect: 30 };
    }
    if (has('love', 'lover', 'romantic', 'spouse', 'wife', 'husband', 'crush', 'beloved')) {
        return { trust: 50, affection: 70, respect: 35, attraction: 70 };
    }
    if (has('best friend', 'close friend')) return { trust: 55, affection: 65, respect: 35 };
    if (has('friend', 'ally', 'comrade', 'teammate', 'partner')) {
        return { trust: 35, affection: 40, respect: 30 };
    }
    if (has('mentor', 'teacher', 'master', 'sensei', 'student', 'apprentice', 'pupil')) {
        return { trust: 40, affection: 25, respect: 60 };
    }
    if (has('rival')) return { trust: 5, affection: -5, respect: 55 };
    if (has('enemy', 'nemesis', 'antagonist', 'foe')) {
        return { trust: -45, affection: -40, respect: 25 };
    }
    if (has('distrust', 'wary', 'suspicious', 'threat')) return { trust: -25, affection: -10 };
    if (has('acquaint', 'colleague', 'know')) return { trust: 10, affection: 10, respect: 10 };
    // Unknown nature: mild positive acquaintance.
    return { trust: 10, affection: 10, respect: 15 };
}

/**
 * The one bond created without the user asking for it: the player ↔ the card's own character,
 * both directions, neutral (the player is a newcomer who earns everything). Seeded ONCE, when
 * the conversation is created — never lazily re-added, so deleting it in the panel sticks.
 *
 * Costs about one prompt line: the neutral {{user}}→character direction stays hidden by
 * `formatRelationshipBlock` until the user actually sets it.
 */
export function mainCharacterBond(characterName: string): DirectedRelationship[] {
    const name = characterName.trim();
    if (!name || name === USER_REL_KEY) return [];
    return [makeRelationship(USER_REL_KEY, name), makeRelationship(name, USER_REL_KEY)];
}

/**
 * Who is on stage right now — the single source of truth for both the analyst and the injected
 * block, so the two can never drift apart again.
 *
 * Scanning the reply text for cast names was the ONLY signal, and it is a weak one: a character
 * almost never says their own name in their own line ("She threw herself in front of him"), so
 * the character who just spoke read as absent. Ground truth the app already holds beats the
 * heuristic: who actually spoke, who is on the Troupe roster, who has been in the last beats.
 * Text matching stays, as one signal among several.
 */
export function onStageNames(opts: {
    /** The card's own character: always on stage, named or not. */
    cardName?: string;
    /** Ground truth — who the app attributed this beat to. */
    speakerNames?: string[];
    /** Troupe: the declared on-stage roster. */
    sceneRoster?: string[];
    /** Canon sticky cast (name → last-seen), already pruned to its window when written. */
    stickyCast?: Record<string, number>;
    /** Names literally matched in the recent text. */
    mentioned?: string[];
}): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (n: string | undefined) => {
        const v = n?.trim();
        if (!v || v === USER_REL_KEY) return;
        const k = v.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push(v);
    };

    add(opts.cardName);
    opts.speakerNames?.forEach(add);
    opts.sceneRoster?.forEach(add);
    Object.keys(opts.stickyCast || {}).forEach(add);
    opts.mentioned?.forEach(add);
    return out;
}

/** Resolve the {{user}} sentinel to a display name. */
function display(name: string, userName: string): string {
    return name === USER_REL_KEY ? userName : name;
}

/**
 * Format the relationships among the active characters into the prompt block. Only relationships
 * touching an active character are shown (keeps token cost bounded to who's on stage).
 */
export function formatRelationshipBlock(
    relationships: DirectedRelationship[] | undefined,
    activeNames: string[],
    userName: string
): string {
    if (!relationships || relationships.length === 0) return '';
    const activeSet = new Set([
        USER_REL_KEY.toLowerCase(),
        ...activeNames.map((n) => n.toLowerCase()),
    ]);

    const isUnsetUserOrigin = (r: DirectedRelationship) =>
        r.from === USER_REL_KEY &&
        r.ledger.length === 0 &&
        !r.note?.trim() &&
        (Object.keys(r.axes) as (keyof RelationshipAxes)[]).every(
            (k) => r.axes[k] === NEUTRAL_AXES[k]
        );

    const relevant = relationships.filter(
        (r) =>
            activeSet.has(r.from.toLowerCase()) &&
            activeSet.has(r.to.toLowerCase()) &&
            // Always show NPC-origin bonds (even neutral, so the model treats the player as a
            // stranger). Hide player-origin bonds the user hasn't set — the AI must not author
            // the player's own feelings.
            !isUnsetUserOrigin(r)
    );
    if (relevant.length === 0) return '';

    const lines = relevant.map((r) => {
        const axes = r.axes;
        const axisStr = (
            [
                ['trust', axes.trust],
                ['affection', axes.affection],
                ['respect', axes.respect],
                ['attraction', axes.attraction],
            ] as const
        )
            // Hide attraction when it's flat-neutral to reduce noise in non-romance scenes.
            .filter(([axis, v]) => axis !== 'attraction' || v !== NEUTRAL_AXES.attraction)
            .map(([axis, v]) => `${axis} ${v} (${axisLabel(axis, v)})`)
            .join(', ');

        // Last couple of ledger reasons keep the model consistent with WHY a value is where it is.
        const recent = r.ledger
            .slice(-2)
            .map((e) => `${e.delta > 0 ? '+' : ''}${e.delta} ${e.axis} "${e.reason}"`)
            .join('; ');
        const recentStr = recent ? ` — recent: ${recent}` : '';
        const noteStr = r.note?.trim() ? ` [knows: ${r.note.trim()}]` : '';

        return `${display(r.from, userName)} → ${display(r.to, userName)}: ${axisStr}${recentStr}${noteStr}`;
    });

    return (
        `[RELATIONSHIPS — directional and NOT mutual (A→B differs from B→A). These feelings ` +
        `constrain how each character behaves right now, even in a friendly scene: do not act warmer, ` +
        `more trusting, or more forgiving than the values justify. Relationships move slowly; trust ` +
        `especially must be earned over many beats.]\n` +
        lines.join('\n')
    );
}
