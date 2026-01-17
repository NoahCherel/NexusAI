// API Preset types for configuring AI generation parameters

export interface APIPreset {
    id: string;
    name: string;
    description?: string;

    // Generation parameters
    temperature: number;
    maxOutputTokens: number;
    maxContextTokens: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;

    // System prompt template with placeholders:
    // {{character_name}}, {{character_description}}, {{character_personality}}
    // {{scenario}}, {{first_message}}, {{world_state}}, {{lorebook}}
    systemPromptTemplate: string;

    // Flags
    enableReasoning: boolean;

    isDefault?: boolean;
    createdAt: Date;
}

// Default system prompt template with all placeholders
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `You are {{character_name}}.

{{character_description}}

{{character_personality}}

{{scenario}}

{{world_state}}

{{lorebook}}

Stay in character at all times. Respond naturally and engagingly.`;

// Built-in presets
export const DEFAULT_PRESETS: Omit<APIPreset, 'id' | 'createdAt'>[] = [
    {
        name: 'Balanced',
        description: 'Default balanced settings for general roleplay',
        temperature: 0.8,
        maxOutputTokens: 2048,
        maxContextTokens: 8192,
        topP: 0.95,
        systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        enableReasoning: false,
        isDefault: true,
    },
    {
        name: 'Creative',
        description: 'Higher creativity for imaginative scenarios',
        temperature: 1.2,
        maxOutputTokens: 3000,
        maxContextTokens: 8192,
        topP: 0.98,
        systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        enableReasoning: false,
        isDefault: true,
    },
    {
        name: 'Precise',
        description: 'Lower temperature for consistent, focused responses',
        temperature: 0.4,
        maxOutputTokens: 2048,
        maxContextTokens: 8192,
        topP: 0.85,
        systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        enableReasoning: true,
        isDefault: true,
    },
];
