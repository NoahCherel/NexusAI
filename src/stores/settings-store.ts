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

interface SettingsState {
    // API Keys (encrypted)
    apiKeys: ApiKeyConfig[];
    activeProvider: 'openrouter' | 'openai' | 'anthropic';

    // Model settings
    activeModel: string;
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
