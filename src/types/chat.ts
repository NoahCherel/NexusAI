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
    createdAt: Date;
    updatedAt: Date;
}

export interface WorldState {
    inventory: string[];
    location: string;
    relationships: Record<string, number>;
    customState?: Record<string, unknown>;
}

export interface ChatSettings {
    provider: 'openrouter' | 'openai' | 'anthropic';
    model: string;
    temperature: number;
    maxTokens: number;
    preset: 'creative' | 'balanced' | 'precise' | 'custom';
}
