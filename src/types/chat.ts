// Chat and conversation types
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
    createdAt: Date;
    updatedAt: Date;
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
    provider: 'openrouter' | 'openai' | 'anthropic';
    model: string;
    temperature: number;
    maxTokens: number;
    preset: 'creative' | 'balanced' | 'precise' | 'custom';
}
