/**
 * Relationship engine — the anti-positivity-bias core.
 *
 * LLMs make NPCs warm up instantly, forgive everything, and trust strangers. This module
 * enforces realistic relationship dynamics in CODE (not just prompt wording), so values can't
 * jump 0→100 in one beat:
 *
 *   - Per-turn delta caps (normal vs. major event).
 *   - Asymmetric velocity per axis (trust rises slowly, falls fast).
 *   - Resistance near the extremes (the last 20 points are the hardest to earn).
 *   - A ledger that records WHY each value moved, fed back to the model for consistency.
 *
 * All functions here are pure and unit-tested.
 */

import type {
    RelationshipAxis,
    RelationshipAxes,
    RelationshipLedgerEntry,
    DirectedRelationship,
} from '@/types/chat';

export const RELATIONSHIP_AXES: RelationshipAxis[] = ['trust', 'affection', 'respect', 'attraction'];

export const NEUTRAL_AXES: RelationshipAxes = {
    trust: 0,
    affection: 0,
    respect: 0,
    attraction: 0,
};

/** Per-turn caps on the RAW delta the analyst may request. */
export const NORMAL_DELTA_CAP = 8;
export const MAJOR_DELTA_CAP = 25;

/** How many ledger entries to keep per relationship (older ones are dropped). */
export const LEDGER_MAX = 12;

/**
 * Velocity multipliers. `up` applies to positive deltas, `down` to negative ones.
 * Trust is the anti-bias linchpin: slow to gain (×0.5), fast to lose (×1.2).
 */
const AXIS_VELOCITY: Record<RelationshipAxis, { up: number; down: number }> = {
    trust: { up: 0.5, down: 1.2 },
    respect: { up: 0.65, down: 1.0 },
    affection: { up: 0.8, down: 1.0 },
    attraction: { up: 0.9, down: 0.9 },
};

/** Clamp to the canonical [-100, 100] range. */
export function clampAxis(v: number): number {
    return Math.max(-100, Math.min(100, v));
}

/**
 * Apply a single raw delta to one axis value, enforcing cap → velocity → extreme-resistance.
 * Returns the new value and the EFFECTIVE (post-inertia, rounded) delta actually applied.
 */
export function applyAxisDelta(
    current: number,
    rawDelta: number,
    axis: RelationshipAxis,
    isMajor = false
): { value: number; applied: number } {
    if (!rawDelta) return { value: clampAxis(current), applied: 0 };

    // 1. Cap the requested raw delta.
    const cap = isMajor ? MAJOR_DELTA_CAP : NORMAL_DELTA_CAP;
    let d = Math.max(-cap, Math.min(cap, rawDelta));

    // 2. Asymmetric velocity.
    const vel = AXIS_VELOCITY[axis];
    d *= d > 0 ? vel.up : vel.down;

    // 3. Resistance near the extremes — only when pushing FURTHER toward an extreme
    //    (same sign as current). Pulling back toward 0 is unimpeded (easy to lose a high).
    if (current !== 0 && Math.sign(d) === Math.sign(current)) {
        d *= 1 - (Math.abs(current) / 100) * 0.6; // at |100| → ×0.4, at 0 → ×1.0
    }

    const next = clampAxis(current + d);
    const applied = Math.round(next - current);
    // Re-derive the stored value from the rounded applied delta so value and ledger agree.
    return { value: clampAxis(current + applied), applied };
}

export interface ProposedDelta {
    axis: RelationshipAxis;
    delta: number; // raw, signed
    reason: string;
    major?: boolean;
}

/**
 * Apply a batch of proposed deltas to a relationship, recording each EFFECTIVE change in the
 * ledger. Deltas with no net effect (rounded to 0 after inertia) are dropped from the ledger.
 */
export function applyDeltas(
    rel: DirectedRelationship,
    deltas: ProposedDelta[],
    messageId?: string,
    now: number = Date.now()
): DirectedRelationship {
    const axes: RelationshipAxes = { ...rel.axes };
    const newEntries: RelationshipLedgerEntry[] = [];

    for (const p of deltas) {
        if (!RELATIONSHIP_AXES.includes(p.axis)) continue;
        const { value, applied } = applyAxisDelta(axes[p.axis], p.delta, p.axis, p.major);
        if (applied === 0) continue;
        axes[p.axis] = value;
        newEntries.push({
            ts: now,
            axis: p.axis,
            delta: applied,
            reason: p.reason.trim().slice(0, 200),
            messageId,
        });
    }

    if (newEntries.length === 0) return rel;

    const ledger = [...rel.ledger, ...newEntries].slice(-LEDGER_MAX);
    return { ...rel, axes, ledger, updatedAt: now };
}

/** A short human label for an axis value, used in the prompt and the UI. */
export function axisLabel(axis: RelationshipAxis, v: number): string {
    if (axis === 'trust') {
        if (v <= -60) return 'betrayed/hostile';
        if (v <= -25) return 'distrustful';
        if (v < 15) return 'wary';
        if (v < 45) return 'cautiously trusting';
        if (v < 75) return 'trusting';
        return 'fully relies on them';
    }
    if (axis === 'affection') {
        if (v <= -60) return 'hateful';
        if (v <= -25) return 'dislikes';
        if (v < 15) return 'indifferent';
        if (v < 45) return 'friendly';
        if (v < 75) return 'fond';
        return 'devoted';
    }
    if (axis === 'respect') {
        if (v <= -60) return 'contemptuous';
        if (v <= -25) return 'dismissive';
        if (v < 15) return 'unproven';
        if (v < 45) return 'respects';
        if (v < 75) return 'admires';
        return 'reveres';
    }
    // attraction
    if (v <= -60) return 'repulsed';
    if (v <= -25) return 'put off';
    if (v < 15) return 'neutral';
    if (v < 45) return 'intrigued';
    if (v < 75) return 'drawn to them';
    return 'infatuated';
}

/** Create a fresh relationship with the given starting axes (defaults to neutral). */
export function makeRelationship(
    from: string,
    to: string,
    axes: Partial<RelationshipAxes> = {},
    seededFromCanon = false
): DirectedRelationship {
    return {
        from,
        to,
        axes: { ...NEUTRAL_AXES, ...axes },
        ledger: [],
        seededFromCanon,
        updatedAt: Date.now(),
    };
}

/** Stable lookup key for a directional pair (case-insensitive). */
export function relKey(from: string, to: string): string {
    return `${from.trim().toLowerCase()}→${to.trim().toLowerCase()}`;
}

export function findRelationship(
    rels: DirectedRelationship[] | undefined,
    from: string,
    to: string
): DirectedRelationship | undefined {
    if (!rels) return undefined;
    const key = relKey(from, to);
    return rels.find((r) => relKey(r.from, r.to) === key);
}
