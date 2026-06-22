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
    useFlexTier?: boolean;

    // Lorebook Settings
    lorebookScanDepth?: number;
    lorebookTokenBudget?: number;
    lorebookRecursiveScanning?: boolean;
    matchWholeWords?: boolean;

    isDefault?: boolean;
    // Stable identity for built-in presets, so we can reconcile/upgrade them across
    // releases without matching on the (user-editable) name or the array index.
    builtinKey?: string;
    builtinVersion?: number;
    // Set when the user edits a built-in preset — the reconciler then leaves it alone.
    userModified?: boolean;
    createdAt: Date;
}

// Default system prompt template with all placeholders
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `About {{character_name}}:
{{character_description}}

{{character_personality}}

{{scenario}}

{{world_state}}

{{memory}}

{{lorebook}}

About {{user}}: {{user_bio}}

[System note: Stay in character at all times. Write naturally and engagingly. Do not speak for {{user}}.]`;

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
        useFlexTier: false,
        isDefault: true,
        builtinKey: 'balanced',
        builtinVersion: 1,
    },
    {
        name: 'Immersive RP',
        description:
            'Sampling tuned for immersive roleplay (high creativity, no penalties — anti-repetition is handled by the RP engine ban list). Best paired with the Immersive Nexus engine.',
        temperature: 1,
        maxOutputTokens: 2048,
        maxContextTokens: 16384,
        topP: 0.95,
        topK: 0,
        repetitionPenalty: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stoppingStrings: [],
        systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        enableReasoning: false,
        includeNames: true,
        banEmojis: true,
        useLorebooks: true,
        useAutoSummarization: true,
        useFlexTier: false,
        isDefault: true,
        builtinKey: 'immersive-rp',
        builtinVersion: 1,
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
        useFlexTier: false,
        isDefault: true,
        builtinKey: 'creative',
        builtinVersion: 1,
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
        useFlexTier: false,
        isDefault: true,
        builtinKey: 'precise',
        builtinVersion: 1,
    },
];
