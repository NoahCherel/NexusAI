import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { APIPreset } from '@/types/preset';
import { DEFAULT_PRESETS, DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/types/preset';

export interface ApiKeyConfig {
    provider: 'openrouter' | 'openai' | 'anthropic';
    encryptedKey: string;
    isValid?: boolean;
}

export interface Persona {
    id: string;
    name: string;
    displayName?: string; // For UI demarcation
    bio: string;
    avatar?: string;
}

export interface CustomModel {
    id: string;
    name: string;
    modelId: string;
    provider: 'openrouter' | 'openai' | 'anthropic';
    isFree: boolean;
}

// Default models available out of the box
// Default models available out of the box
export const DEFAULT_MODELS: CustomModel[] = [
    {
        id: 'llama-3.3-70b',
        name: 'Llama 3.3 70B (Free)',
        modelId: 'meta-llama/llama-3.3-70b-instruct:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'deepseek-r1-0528',
        name: 'DeepSeek R1 0528 (Free)',
        modelId: 'deepseek/deepseek-r1-0528:free',
        provider: 'openrouter',
        isFree: true,
    },

    {
        id: 'mistral-small-3.1',
        name: 'Mistral Small 3.1 24B (Free)',
        modelId: 'mistralai/mistral-small-3.1-24b-instruct:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'qwen-coder',
        name: 'Qwen 3 Coder (Free)',
        modelId: 'qwen/qwen3-coder:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'mistral-large',
        name: 'Mistral Large 2411 (Free)',
        modelId: 'mistralai/mistral-large-2411:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'nvidia-nemotron-70b',
        name: 'Nvidia Nemotron 70B (Free)',
        modelId: 'nvidia/llama-3.1-nemotron-70b-instruct:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'dolphin-24b',
        name: 'Dolphin Mistral 24B (Free)',
        modelId: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'gemma-3-27b',
        name: 'Gemma 3 27B (Free)',
        modelId: 'google/gemma-3-27b-it:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'deepseek-v3',
        name: 'DeepSeek V3 (Chat)',
        modelId: 'deepseek/deepseek-chat',
        provider: 'openrouter',
        isFree: false,
    },
    {
        id: 'deepseek-r1-paid',
        name: 'DeepSeek R1 (Full)',
        modelId: 'deepseek/deepseek-r1',
        provider: 'openrouter',
        isFree: false,
    },
    {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3.0 Flash (Preview)',
        modelId: 'google/gemini-3-flash-preview',
        provider: 'openrouter',
        isFree: false,
    },
    {
        id: 'deepseek-v3.2',
        name: 'DeepSeek v3.2',
        modelId: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        isFree: false,
    },
    {
        id: 'gemini-3-pro',
        name: 'Gemini 3 Pro',
        modelId: 'google/gemini-3-pro-preview',
        provider: 'openrouter',
        isFree: false,
    },
    {
        id: 'gpt-4o',
        name: 'GPT-4o',
        modelId: 'openai/gpt-4o',
        provider: 'openrouter',
        isFree: false,
    },
    {
        id: 'claude-sonnet',
        name: 'Claude 3.5 Sonnet',
        modelId: 'anthropic/claude-3.5-sonnet',
        provider: 'openrouter',
        isFree: false,
    },
];

interface SettingsState {
    // API Keys (encrypted)
    apiKeys: ApiKeyConfig[];
    activeProvider: 'openrouter' | 'openai' | 'anthropic';

    // Model settings
    activeModel: string;
    customModels: CustomModel[];
    temperature: number;
    maxTokens: number;
    enableReasoning: boolean;

    // User Personas
    personas: Persona[];
    activePersonaId: string | null;

    // API Presets
    presets: APIPreset[];
    activePresetId: string | null;

    // UI Settings
    theme: 'dark' | 'light' | 'system';
    showThoughts: boolean;
    showWorldState: boolean;
    immersiveMode: boolean;
    lorebookAutoExtract: boolean;

    // Background AI Model
    backgroundModel: string | null; // null = auto (free model rotation), string = specific modelId

    // RAG / Memory Settings
    enableFactExtraction: boolean;
    enableHierarchicalSummaries: boolean;
    enableRAGRetrieval: boolean;
    minRAGConfidence: number; // 0–1, minimum confidence threshold for RAG sections
    customFactCategories: string[]; // User-defined fact categories (in addition to built-in ones)

    // Actions
    setApiKey: (config: ApiKeyConfig) => void;
    removeApiKey: (provider: string) => void;
    setActiveProvider: (provider: 'openrouter' | 'openai' | 'anthropic') => void;
    setActiveModel: (model: string) => void;
    addCustomModel: (model: CustomModel) => void;
    removeCustomModel: (id: string) => void;
    setTemperature: (temp: number) => void;
    setMaxTokens: (tokens: number) => void;
    setEnableReasoning: (enabled: boolean) => void;

    // Persona Actions
    addPersona: (persona: Persona) => void;
    updatePersona: (id: string, updates: Partial<Persona>) => void;
    deletePersona: (id: string) => void;
    setActivePersonaId: (id: string | null) => void;

    setTheme: (theme: 'dark' | 'light' | 'system') => void;
    setShowThoughts: (show: boolean) => void;
    setShowWorldState: (show: boolean) => void;
    setImmersiveMode: (immersive: boolean) => void;
    setLorebookAutoExtract: (enabled: boolean) => void;
    setBackgroundModel: (model: string | null) => void;
    setEnableFactExtraction: (enabled: boolean) => void;
    setEnableHierarchicalSummaries: (enabled: boolean) => void;
    setEnableRAGRetrieval: (enabled: boolean) => void;
    setMinRAGConfidence: (value: number) => void;
    setCustomFactCategories: (categories: string[]) => void;

    // Preset Actions
    addPreset: (preset: APIPreset) => void;
    updatePreset: (id: string, updates: Partial<APIPreset>) => void;
    deletePreset: (id: string) => void;
    setActivePreset: (id: string | null) => void;
    getActivePreset: () => APIPreset | null;
    initializeDefaultPresets: () => void;
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set, get) => ({
            // Default state
            apiKeys: [],
            activeProvider: 'openrouter',
            activeModel: 'deepseek/deepseek-r1-0528:free',
            customModels: [],
            temperature: 0.8,
            maxTokens: 2048,
            enableReasoning: false,
            personas: [],
            activePersonaId: null,
            presets: [],
            activePresetId: null,
            theme: 'dark',
            showThoughts: true,
            showWorldState: true,
            immersiveMode: false,
            lorebookAutoExtract: true,
            backgroundModel: null,
            enableFactExtraction: true,
            enableHierarchicalSummaries: true,
            enableRAGRetrieval: true,
            minRAGConfidence: 0,
            customFactCategories: [],

            // Actions
            setApiKey: (config) =>
                set((state) => ({
                    apiKeys: [
                        ...state.apiKeys.filter((k) => k.provider !== config.provider),
                        config,
                    ],
                })),

            removeApiKey: (provider) =>
                set((state) => ({
                    apiKeys: state.apiKeys.filter((k) => k.provider !== provider),
                })),

            setActiveProvider: (provider) => set({ activeProvider: provider }),
            setActiveModel: (model) => set({ activeModel: model }),

            addCustomModel: (model) =>
                set((state) => ({
                    customModels: [...state.customModels, model],
                })),
            removeCustomModel: (id) =>
                set((state) => ({
                    customModels: state.customModels.filter((m) => m.id !== id),
                })),

            setTemperature: (temperature) => set({ temperature }),
            setMaxTokens: (maxTokens) => set({ maxTokens }),
            setEnableReasoning: (enableReasoning) => set({ enableReasoning }),

            // Persona Actions
            addPersona: (persona) => set((state) => ({ personas: [...state.personas, persona] })),
            updatePersona: (id, updates) =>
                set((state) => ({
                    personas: state.personas.map((p) => (p.id === id ? { ...p, ...updates } : p)),
                })),
            deletePersona: (id) =>
                set((state) => ({
                    personas: state.personas.filter((p) => p.id !== id),
                    activePersonaId: state.activePersonaId === id ? null : state.activePersonaId,
                })),
            setActivePersonaId: (activePersonaId) => set({ activePersonaId }),

            setTheme: (theme) => set({ theme }),
            setShowThoughts: (showThoughts) => set({ showThoughts }),
            setShowWorldState: (showWorldState) => set({ showWorldState }),
            setImmersiveMode: (immersiveMode) => set({ immersiveMode }),
            setLorebookAutoExtract: (lorebookAutoExtract) => set({ lorebookAutoExtract }),
            setBackgroundModel: (backgroundModel) => set({ backgroundModel }),
            setEnableFactExtraction: (enableFactExtraction) => set({ enableFactExtraction }),
            setEnableHierarchicalSummaries: (enableHierarchicalSummaries) =>
                set({ enableHierarchicalSummaries }),
            setEnableRAGRetrieval: (enableRAGRetrieval) => set({ enableRAGRetrieval }),
            setMinRAGConfidence: (minRAGConfidence) =>
                set({ minRAGConfidence: Math.max(0, Math.min(1, minRAGConfidence)) }),
            setCustomFactCategories: (customFactCategories) => set({ customFactCategories }),

            // Preset Actions
            addPreset: (preset) =>
                set((state) => ({
                    presets: [...state.presets, preset],
                })),

            updatePreset: (id, updates) =>
                set((state) => ({
                    presets: state.presets.map((p) => (p.id === id ? { ...p, ...updates } : p)),
                })),

            deletePreset: (id) =>
                set((state) => ({
                    presets: state.presets.filter((p) => p.id !== id),
                    activePresetId: state.activePresetId === id ? null : state.activePresetId,
                })),

            setActivePreset: (activePresetId) => set({ activePresetId }),

            getActivePreset: () => {
                const state = get();
                if (!state.activePresetId) return null;
                return state.presets.find((p) => p.id === state.activePresetId) || null;
            },

            initializeDefaultPresets: () =>
                set((state) => {
                    // Only initialize if no presets exist
                    if (state.presets.length > 0) return {};

                    const newPresets: APIPreset[] = DEFAULT_PRESETS.map((p, i) => ({
                        ...p,
                        id: `default-${i}`,
                        createdAt: new Date(),
                    }));

                    return {
                        presets: newPresets,
                        activePresetId: newPresets[0]?.id || null,
                    };
                }),
        }),
        {
            name: 'nexusai-settings',
        }
    )
);
