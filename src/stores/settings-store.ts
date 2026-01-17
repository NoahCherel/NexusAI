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
        id: 'gemini-flash',
        name: 'Gemini 2.0 Flash (Free)',
        modelId: 'google/gemini-2.0-flash-exp:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'llama-3.3-70b',
        name: 'Llama 3.3 70B (Free)',
        modelId: 'meta-llama/llama-3.3-70b-instruct:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'deepseek-r1',
        name: 'DeepSeek R1 (Free)',
        modelId: 'deepseek/deepseek-r1:free',
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
        id: 'deepseek-r1-distill',
        name: 'DeepSeek R1 Distill 70B (Free)',
        modelId: 'deepseek/deepseek-r1-distill-llama-70b:free',
        provider: 'openrouter',
        isFree: true,
    },
    {
        id: 'qwen-2.5-72b',
        name: 'Qwen 2.5 72B (Free)',
        modelId: 'qwen/qwen-2.5-72b-instruct:free',
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
            activeModel: 'google/gemini-2.0-flash-exp:free',
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

            // Preset Actions
            addPreset: (preset) =>
                set((state) => ({
                    presets: [...state.presets, preset],
                })),

            updatePreset: (id, updates) =>
                set((state) => ({
                    presets: state.presets.map((p) =>
                        p.id === id ? { ...p, ...updates } : p
                    ),
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
