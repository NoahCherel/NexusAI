/**
 * Relationship context: seeding from canon, ensuring missing pairs exist, and formatting the
 * directional relationship block injected into the RP prompt.
 */

import type { DirectedRelationship, RelationshipAxes } from '@/types/chat';
import { USER_REL_KEY } from '@/types/chat';
import type { CanonDossier } from '@/types/canon';
import { axisLabel, makeRelationship, findRelationship, NEUTRAL_AXES } from '@/lib/ai/relationship-engine';

/**
 * Map a canonical relationship description (e.g. "younger sister, devoted", "rival") to starting
 * axis values. Coarse keyword heuristic — the analyst refines it as the RP unfolds. {{user}} is
 * never seeded this way (the player is a newcomer who must earn everything).
 */
export function seedAxesFromNature(nature: string): Partial<RelationshipAxes> {
    const n = nature.toLowerCase();
    const has = (...words: string[]) => words.some((w) => n.includes(w));

    if (has('sister', 'brother', 'sibling', 'family', 'son', 'daughter', 'father', 'mother', 'parent')) {
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
 * Ensure relationships exist for the given active characters, returning a possibly-extended list.
 * Creates {{user}}↔char (neutral — strangers earn everything) and char→{{user}}, plus cast↔cast
 * among active characters seeded from the canon dossier's relationships. Pure: returns a new list
 * and a `changed` flag so the caller can persist only when needed.
 */
export function ensureRelationships(
    existing: DirectedRelationship[] | undefined,
    activeNames: string[],
    dossiers: CanonDossier[]
): { relationships: DirectedRelationship[]; changed: boolean } {
    const list = [...(existing || [])];
    let changed = false;
    const ensure = (from: string, to: string, axes: Partial<RelationshipAxes>, seeded: boolean) => {
        if (from.toLowerCase() === to.toLowerCase()) return;
        if (findRelationship(list, from, to)) return;
        list.push(makeRelationship(from, to, axes, seeded));
        changed = true;
    };

    const dossierByName = new Map(dossiers.map((d) => [d.character.toLowerCase(), d]));

    for (const name of activeNames) {
        // {{user}} ↔ character: both directions, neutral (the player is a newcomer).
        ensure(USER_REL_KEY, name, {}, false);
        ensure(name, USER_REL_KEY, {}, false);

        // character → other active characters: seed from canon relationship nature.
        const dossier = dossierByName.get(name.toLowerCase());
        if (dossier?.relationships) {
            for (const other of activeNames) {
                if (other.toLowerCase() === name.toLowerCase()) continue;
                const canonRel = dossier.relationships.find(
                    (r) => r.name.toLowerCase() === other.toLowerCase()
                );
                if (canonRel) ensure(name, other, seedAxesFromNature(canonRel.nature), true);
            }
        }
    }
    return { relationships: list, changed };
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
    const activeSet = new Set([USER_REL_KEY.toLowerCase(), ...activeNames.map((n) => n.toLowerCase())]);

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
