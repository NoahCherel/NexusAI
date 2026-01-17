// API Preset types for configuring AI generation parameters

export interface APIPreset {
    id: string;
    name: string;
    description?: string;

    // Generation parameters
    temperature: number;
    maxOutputTokens: number;
    maxContextTokens: number;
    topP: number;
    topK: number;
    minP?: number;
    repetitionPenalty: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stoppingStrings: string[];
    minLength?: number;

    // Prompt Structure
    systemPromptTemplate: string;
    preHistoryInstructions?: string; // Added before chat history
    postHistoryInstructions?: string; // Added after chat history
    promptNote?: string; // Inserted at specific depth
    promptNoteDepth?: number;
    impersonationPrompt?: string; // For the "Robot" button
    assistantPrefill?: string; // Forces start of response

    // Toggles & Behavior
    enableReasoning: boolean;
    includeNames: boolean;
    banEmojis: boolean;
    useLorebooks: boolean;
    useAutoSummarization: boolean;
    trimIncompleteSentences?: boolean;

    // Lorebook Settings
    lorebookScanDepth?: number;
    lorebookTokenBudget?: number;
    lorebookRecursiveScanning?: boolean;
    matchWholeWords?: boolean;

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
        topK: 40,
        repetitionPenalty: 1.05,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stoppingStrings: [],
        systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        enableReasoning: false,
        includeNames: true,
        banEmojis: false,
        useLorebooks: true,
        useAutoSummarization: true,
        isDefault: true,
    },
    {
        name: 'Creative',
        description: 'Higher creativity for imaginative scenarios',
        temperature: 1.2,
        maxOutputTokens: 3000,
        maxContextTokens: 8192,
        topP: 0.98,
        topK: 100,
        repetitionPenalty: 1.02,
        frequencyPenalty: 0.1,
        presencePenalty: 0.1,
        stoppingStrings: [],
        systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        enableReasoning: false,
        includeNames: true,
        banEmojis: false,
        useLorebooks: true,
        useAutoSummarization: true,
        isDefault: true,
    },
    {
        name: 'Precise',
        description: 'Lower temperature for consistent, focused responses',
        temperature: 0.4,
        maxOutputTokens: 2048,
        maxContextTokens: 8192,
        topP: 0.85,
        topK: 20,
        repetitionPenalty: 1.1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stoppingStrings: [],
        systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        enableReasoning: true,
        includeNames: true,
        banEmojis: false,
        useLorebooks: true,
        useAutoSummarization: true,
        isDefault: true,
    },
];
