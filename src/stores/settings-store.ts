import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { APIPreset } from '@/types/preset';
import { DEFAULT_PRESETS, DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/types/preset';
import type { RPEngine } from '@/types/engine';
import { IMMERSIVE_NEXUS_KEY, getEngineById } from '@/lib/ai/rp-engine';
import type { Provider } from '@/lib/ai/providers';

export interface ApiKeyConfig {
    provider: Provider;
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
    provider: Provider;
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
    activeProvider: Provider;

    // Model settings
    activeModel: string;
    customModels: CustomModel[];
    // NanoGPT subscription models, fetched dynamically from the user's subscription
    // (GET /api/subscription/v1/models). Empty until a valid NanoGPT key is saved.
    nanogptModels: CustomModel[];
    temperature: number;
    maxTokens: number;
    enableReasoning: boolean;
    useFlexTier: boolean;

    // User Personas
    personas: Persona[];
    activePersonaId: string | null;

    // API Presets
    presets: APIPreset[];
    activePresetId: string | null;

    // RP Engine — behavioral/writing layer, chosen independently of the API preset.
    activeEngineId: string | null; // null = off (legacy behaviour, no engine block)
    customEngines: RPEngine[]; // user-created engines (built-ins live as code constants)

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

    // Canon Codex (Arc + Casting + Director)
    // Master switch: when false, no canon/arc/casting injection happens at all.
    useCanonCodex: boolean;
    // When false, the web-fetch buttons (Peupler le casting, Plus de persos, Récupérer la
    // carte des arcs, Récupérer la fiche complète) are disabled. Useful for custom universes
    // where the user writes everything manually. Dossiers already in the DB are still injected.
    useCanonAutoFetch: boolean;

    // Actions
    setApiKey: (config: ApiKeyConfig) => void;
    removeApiKey: (provider: string) => void;
    setActiveProvider: (provider: Provider) => void;
    setActiveModel: (model: string) => void;
    addCustomModel: (model: CustomModel) => void;
    removeCustomModel: (id: string) => void;
    setNanogptModels: (models: CustomModel[]) => void;
    setTemperature: (temp: number) => void;
    setMaxTokens: (tokens: number) => void;
    setEnableReasoning: (enabled: boolean) => void;
    setUseFlexTier: (enabled: boolean) => void;

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
    setUseCanonCodex: (enabled: boolean) => void;
    setUseCanonAutoFetch: (enabled: boolean) => void;

    // Preset Actions
    addPreset: (preset: APIPreset) => void;
    updatePreset: (id: string, updates: Partial<APIPreset>) => void;
    deletePreset: (id: string) => void;
    setActivePreset: (id: string | null) => void;
    getActivePreset: () => APIPreset | null;
    initializeDefaultPresets: () => void;

    // RP Engine Actions
    setActiveEngineId: (id: string | null) => void;
    addCustomEngine: (engine: RPEngine) => void;
    updateCustomEngine: (id: string, updates: Partial<RPEngine>) => void;
    deleteCustomEngine: (id: string) => void;
    getActiveEngine: () => RPEngine | null;
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set, get) => ({
            // Default state
            apiKeys: [],
            activeProvider: 'openrouter',
            activeModel: 'deepseek/deepseek-r1-0528:free',
            customModels: [],
            nanogptModels: [],
            temperature: 0.8,
            maxTokens: 2048,
            enableReasoning: false,
            useFlexTier: false,
            personas: [],
            activePersonaId: null,
            presets: [],
            activePresetId: null,
            activeEngineId: IMMERSIVE_NEXUS_KEY,
            customEngines: [],
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
            useCanonCodex: true,
            useCanonAutoFetch: true,

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
            setNanogptModels: (models) => set({ nanogptModels: models }),

            setTemperature: (temperature) => set({ temperature }),
            setMaxTokens: (maxTokens) => set({ maxTokens }),
            setEnableReasoning: (enableReasoning) => set({ enableReasoning }),
            setUseFlexTier: (useFlexTier) => set({ useFlexTier }),

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
            setUseCanonCodex: (useCanonCodex) => set({ useCanonCodex }),
            setUseCanonAutoFetch: (useCanonAutoFetch) => set({ useCanonAutoFetch }),
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

            // Seeds built-in presets on first run, and on later runs reconciles by
            // stable `builtinKey`: back-fills the key onto legacy presets (id `default-N`,
            // no key) by name, then appends any built-in the user is missing — without
            // ever overwriting a preset the user has edited or touching their custom ones.
            initializeDefaultPresets: () =>
                set((state) => {
                    if (state.presets.length === 0) {
                        const seeded: APIPreset[] = DEFAULT_PRESETS.map((p, i) => ({
                            ...p,
                            id: `default-${i}`,
                            createdAt: new Date(),
                        }));
                        const balanced = seeded.find((p) => p.builtinKey === 'balanced');
                        return {
                            presets: seeded,
                            activePresetId: balanced?.id || seeded[0]?.id || null,
                        };
                    }

                    const nameToKey: Record<string, string> = {
                        Balanced: 'balanced',
                        Creative: 'creative',
                        Precise: 'precise',
                        'Immersive RP': 'immersive-rp',
                    };

                    let changed = false;
                    const reconciled = state.presets.map((p) => {
                        if (!p.builtinKey && p.isDefault && nameToKey[p.name]) {
                            changed = true;
                            return { ...p, builtinKey: nameToKey[p.name], builtinVersion: 1 };
                        }
                        return p;
                    });

                    const existingKeys = new Set(
                        reconciled.map((p) => p.builtinKey).filter(Boolean)
                    );
                    const toAdd: APIPreset[] = DEFAULT_PRESETS.filter(
                        (d) => d.builtinKey && !existingKeys.has(d.builtinKey)
                    ).map((d) => ({
                        ...d,
                        id: `builtin-${d.builtinKey}`,
                        createdAt: new Date(),
                    }));

                    if (!changed && toAdd.length === 0) return {};
                    return { presets: [...reconciled, ...toAdd] };
                }),

            // RP Engine Actions
            setActiveEngineId: (activeEngineId) => set({ activeEngineId }),
            addCustomEngine: (engine) =>
                set((state) => ({ customEngines: [...state.customEngines, engine] })),
            updateCustomEngine: (id, updates) =>
                set((state) => ({
                    customEngines: state.customEngines.map((e) =>
                        e.id === id ? { ...e, ...updates } : e
                    ),
                })),
            deleteCustomEngine: (id) =>
                set((state) => ({
                    customEngines: state.customEngines.filter((e) => e.id !== id),
                    activeEngineId:
                        state.activeEngineId === id ? IMMERSIVE_NEXUS_KEY : state.activeEngineId,
                })),
            getActiveEngine: () => {
                const state = get();
                return getEngineById(state.activeEngineId, state.customEngines) || null;
            },
        }),
        {
            name: 'nexusai-settings',
        }
    )
);
