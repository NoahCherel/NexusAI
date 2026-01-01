import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
export const DEFAULT_MODELS: CustomModel[] = [
    { id: 'gemini-flash', name: 'Gemini 2.0 Flash (Free)', modelId: 'google/gemini-2.0-flash-exp:free', provider: 'openrouter', isFree: true },
    { id: 'deepseek-r1', name: 'DeepSeek R1 (Free)', modelId: 'deepseek/deepseek-r1-0528:free', provider: 'openrouter', isFree: true },
    { id: 'deepseek-chimera', name: 'DeepSeek Chimera (Free)', modelId: 'tngtech/deepseek-r1t2-chimera:free', provider: 'openrouter', isFree: true },
    { id: 'llama-maverick', name: 'Llama 4 Maverick (Free)', modelId: 'meta-llama/llama-4-maverick:free', provider: 'openrouter', isFree: true },
    { id: 'gpt-4o', name: 'GPT-4o', modelId: 'openai/gpt-4o', provider: 'openrouter', isFree: false },
    { id: 'claude-sonnet', name: 'Claude 3.5 Sonnet', modelId: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', isFree: false },
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
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
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
        }),
        {
            name: 'nexusai-settings',
        }
    )
);
