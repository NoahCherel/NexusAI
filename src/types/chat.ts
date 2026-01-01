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
}

export interface Conversation {
    id: string;
    characterId: string;
    title: string;
    worldState: WorldState;
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
