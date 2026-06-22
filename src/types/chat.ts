// Chat and conversation types
import type { Provider } from '@/lib/ai/providers';

export interface Message {
    id: string;
    conversationId: string;
    parentId: string | null;
    role: 'user' | 'assistant' | 'system';
    content: string;
    thought?: string;
    isActiveBranch: boolean;
    childrenIds?: string[];
    createdAt: Date;
    worldStateSnapshot?: WorldState;
    banListSnapshot?: string[]; // Style Guard ban list as of this branch tip (branch-aware)

    // Message ordering and regeneration tracking
    messageOrder: number; // Sequential position in timeline (1, 2, 3...)
    regenerationIndex: number; // Which regeneration attempt (0 = original, 1+ = regens)
}

export interface Conversation {
    id: string;
    characterId: string;
    title: string;
    worldState: WorldState; // Kept for backward compatibility (maps to root branch)
    worldStates?: Record<string, WorldState>; // Branch-specific states (branchId -> state)
    notes?: string[]; // Conversation-scoped persona notes/memories
    storyGuidance?: string; // User-written memo to guide the AI's narrative direction
    scratchpad?: string; // AI's working memory from the previous turn
    arc?: ArcCompass; // Directed progression toward the work's canonical arc
    momentumNudge?: string; // Transient anti-stall directive, consumed next turn then cleared
    rpJournal?: Record<string, string[]>; // Per-character "in this RP" developments, layered on canon
    relationships?: DirectedRelationship[]; // Phase 2: directional, multi-axis, history-aware bonds
    banList?: string[]; // Style Guard: conversation-level fallback for branches without a banListSnapshot (legacy/seed)
    createdAt: Date;
    updatedAt: Date;
}

// ============================================================================
// Relationships (Phase 2) — directional, multi-axis, history-aware.
// Replaces the old symmetric WorldState.relationships scalar map.
// ============================================================================

/** Canonical sentinel used as a stable `from`/`to` key for the player's persona. */
export const USER_REL_KEY = '{{user}}';

export type RelationshipAxis = 'trust' | 'affection' | 'respect' | 'attraction';

export interface RelationshipAxes {
    trust: number; // -100..100 — belief/reliance. Slow to build, fast to break.
    affection: number; // -100..100 — warmth/liking.
    respect: number; // -100..100 — regard for competence/standing.
    attraction: number; // -100..100 — romantic/sexual interest.
}

/** A single recorded change to one axis, with the reason that justified it. */
export interface RelationshipLedgerEntry {
    ts: number;
    axis: RelationshipAxis;
    delta: number; // the EFFECTIVE delta applied after inertia rules
    reason: string;
    messageId?: string;
}

/** One character's feelings toward another. Directional: A→B is independent of B→A. */
export interface DirectedRelationship {
    from: string; // character name, or USER_REL_KEY for the player
    to: string; // character name, or USER_REL_KEY for the player
    axes: RelationshipAxes;
    ledger: RelationshipLedgerEntry[]; // most-recent-last, capped
    note?: string; // freeform: known facts / current thoughts about the target
    seededFromCanon?: boolean; // true if the starting values came from a canon relationship
    updatedAt?: number;
}

// Directed progression toward the next canonical beat of the work.
// The full arc outline lives in the `arcOutlines` store (keyed by `work`); this holds
// only the per-conversation cursor and the next beat to steer toward.
export interface ArcCompass {
    enabled?: boolean;
    work?: string;
    currentPosition?: string; // auto-captured from the GM's trailing [timeline …]; = canon timelineCap
    nextBeat?: string; // the specific canonical beat to steer toward, subtly
}

export interface WorldState {
    inventory: string[];
    location: string;
    relationships: Record<string, number>;
    customState?: Record<string, unknown>;
    dismissedInventoryItems?: string[]; // Items manually removed by user — prevents re-adding
}

export interface ChatSettings {
    provider: Provider;
    model: string;
    temperature: number;
    maxTokens: number;
    preset: 'creative' | 'balanced' | 'precise' | 'custom';
}
