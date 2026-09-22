import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createSafeSettingsStorage, SETTINGS_KEY, SETTINGS_VERSION } from '@/lib/settings-storage';
import type { APIPreset } from '@/types/preset';
import { DEFAULT_PRESETS } from '@/types/preset';
import type { RPEngine } from '@/types/engine';
import { IMMERSIVE_NEXUS_KEY, getEngineById } from '@/lib/ai/rp-engine';
import type { Provider } from '@/lib/ai/providers';

/** Monday of the current week (local time), as YYYY-MM-DD — the weekly-budget anchor. */
export function currentWeekStart(): string {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

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
        id: 'gemini-3-1-pro',
        name: 'Gemini 3.1 Pro',
        modelId: 'google/gemini-3.1-pro-preview',
        provider: 'openrouter',
        isFree: false,
    },
    {
        id: 'Gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        modelId: 'google/gemini-3.8-flash',
        provider: 'openrouter',
        isFree: false,
    }
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
    enableReasoning: boolean;
    // OpenRouter flex service tier (service_tier: 'flex'): half price, slower capacity on
    // the same live request. Unrelated to the Batch API, which a `:batch` model selects.
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
    showThoughts: boolean;
    immersiveMode: boolean;
    lorebookAutoExtract: boolean;

    // Background AI routing
    // 'auto' = NanoGPT subscription quota when a key exists (better models), else free
    // OpenRouter rotation. Web-search tasks (canon retrieval) always stay on OpenRouter.
    backgroundProvider: 'auto' | 'nanogpt' | 'openrouter-free';
    backgroundModel: string | null; // OpenRouter background override (null = free model rotation)
    nanogptBackgroundModel: string | null; // NanoGPT background override (null = auto-pick from subscription)

    // RAG / Memory Settings
    enableHierarchicalSummaries: boolean;

    // Per-response <scratchpad> working memory. Costs output tokens on every reply and
    // invalidates prompt caching, so it's opt-in.
    enableScratchpad: boolean;
    // Per-message token/cost badge under assistant replies.
    showUsageBadge: boolean;
    // Weekly OpenRouter budget (USD). null = tracking off. Real accounted costs only.
    weeklyBudgetUsd: number | null;
    // Cumulated OpenRouter cost for the current week (rolls over on Monday).
    weeklySpend: { weekStart: string; cost: number };
    // Scene Mode (Troupe): AI narrator + one reply per on-stage character. Global gate;
    // each conversation opts in via its own 🎬 toggle.
    enableTroupeMode: boolean;
    // Feature gate for the new atomic, multi-agent scene pipeline.
    enableDirectedSceneMode: boolean;
    directedAuditMode: 'shadow' | 'enforce';
    // Max character turns per scene beat (the Director may pick fewer). 1..8.
    maxSceneSpeakers: number;
    // Number of character-intent calls allowed to run at once. 1..8.
    sceneReflectionConcurrency: number;
    // Directional relationship analyst (one background call per beat).
    enableRelationshipAnalyst: boolean;
    // Anti-stall detection + one-shot momentum nudge.
    enableMomentum: boolean;

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
    setEnableReasoning: (enabled: boolean) => void;
    setUseFlexTier: (enabled: boolean) => void;

    // Persona Actions
    addPersona: (persona: Persona) => void;
    updatePersona: (id: string, updates: Partial<Persona>) => void;
    deletePersona: (id: string) => void;
    setActivePersonaId: (id: string | null) => void;

    setShowThoughts: (show: boolean) => void;
    setImmersiveMode: (immersive: boolean) => void;
    setLorebookAutoExtract: (enabled: boolean) => void;
    setBackgroundProvider: (provider: 'auto' | 'nanogpt' | 'openrouter-free') => void;
    setBackgroundModel: (model: string | null) => void;
    setNanogptBackgroundModel: (model: string | null) => void;
    setEnableScratchpad: (enabled: boolean) => void;
    setShowUsageBadge: (enabled: boolean) => void;
    setWeeklyBudgetUsd: (usd: number | null) => void;
    addWeeklySpend: (cost: number) => void;
    setEnableTroupeMode: (enabled: boolean) => void;
    setEnableDirectedSceneMode: (enabled: boolean) => void;
    setDirectedAuditMode: (mode: 'shadow' | 'enforce') => void;
    setMaxSceneSpeakers: (max: number) => void;
    setSceneReflectionConcurrency: (max: number) => void;
    setEnableRelationshipAnalyst: (enabled: boolean) => void;
    setEnableMomentum: (enabled: boolean) => void;
    setEnableHierarchicalSummaries: (enabled: boolean) => void;
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

/**
 * Persisted-shape migrations. v1 briefly renamed the "Palier Flex" toggle to `useBatchMode`;
 * v2 restores `useFlexTier` (Flex and the Batch API are different products — a batch is
 * chosen by picking a `:batch` model, not by a toggle). A v1 store gets its value back; a
 * v0 store is already in the right shape.
 */
export function migrateSettings(persisted: unknown, version: number): unknown {
    if (!persisted || typeof persisted !== 'object') return persisted;
    const state = persisted as Record<string, unknown>;
    if (version < 2) {
        const restoreFlex = (obj: Record<string, unknown>) => {
            if ('useBatchMode' in obj) {
                if (obj.useFlexTier === undefined) obj.useFlexTier = obj.useBatchMode;
                delete obj.useBatchMode;
            }
        };
        restoreFlex(state);
        if (Array.isArray(state.presets)) {
            state.presets = state.presets.map((preset) => {
                if (!preset || typeof preset !== 'object') return preset;
                const copy = { ...(preset as Record<string, unknown>) };
                restoreFlex(copy);
                return copy;
            });
        }
    }
    return state;
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
            enableReasoning: false,
            useFlexTier: false,
            personas: [],
            activePersonaId: null,
            presets: [],
            activePresetId: null,
            activeEngineId: IMMERSIVE_NEXUS_KEY,
            customEngines: [],
            showThoughts: true,
            immersiveMode: false,
            lorebookAutoExtract: true,
            backgroundProvider: 'auto',
            backgroundModel: null,
            nanogptBackgroundModel: null,
            enableScratchpad: false,
            showUsageBadge: true,
            weeklyBudgetUsd: null,
            weeklySpend: { weekStart: '', cost: 0 },
            enableTroupeMode: true,
            // Experimental until the deterministic and human evaluation gates are complete.
            enableDirectedSceneMode: false,
            directedAuditMode: 'shadow',
            maxSceneSpeakers: 5,
            sceneReflectionConcurrency: 4,
            enableRelationshipAnalyst: true,
            enableMomentum: true,
            enableHierarchicalSummaries: true,
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

            setShowThoughts: (showThoughts) => set({ showThoughts }),
            setImmersiveMode: (immersiveMode) => set({ immersiveMode }),
            setLorebookAutoExtract: (lorebookAutoExtract) => set({ lorebookAutoExtract }),
            setBackgroundProvider: (backgroundProvider) => set({ backgroundProvider }),
            setBackgroundModel: (backgroundModel) => set({ backgroundModel }),
            setNanogptBackgroundModel: (nanogptBackgroundModel) => set({ nanogptBackgroundModel }),
            setEnableScratchpad: (enableScratchpad) => set({ enableScratchpad }),
            setShowUsageBadge: (showUsageBadge) => set({ showUsageBadge }),
            setWeeklyBudgetUsd: (weeklyBudgetUsd) => set({ weeklyBudgetUsd }),
            addWeeklySpend: (cost) =>
                set((state) => {
                    const week = currentWeekStart();
                    const prev = state.weeklySpend.weekStart === week ? state.weeklySpend.cost : 0;
                    return { weeklySpend: { weekStart: week, cost: prev + cost } };
                }),
            setEnableTroupeMode: (enableTroupeMode) => set({ enableTroupeMode }),
            setEnableDirectedSceneMode: (enableDirectedSceneMode) =>
                set({ enableDirectedSceneMode }),
            setDirectedAuditMode: (directedAuditMode) => set({ directedAuditMode }),
            setMaxSceneSpeakers: (maxSceneSpeakers) =>
                set({ maxSceneSpeakers: Math.max(1, Math.min(8, Math.round(maxSceneSpeakers))) }),
            setSceneReflectionConcurrency: (sceneReflectionConcurrency) =>
                set({
                    sceneReflectionConcurrency: Math.max(
                        1,
                        Math.min(8, Math.round(sceneReflectionConcurrency))
                    ),
                }),
            setEnableRelationshipAnalyst: (enableRelationshipAnalyst) =>
                set({ enableRelationshipAnalyst }),
            setEnableMomentum: (enableMomentum) => set({ enableMomentum }),
            setEnableHierarchicalSummaries: (enableHierarchicalSummaries) =>
                set({ enableHierarchicalSummaries }),
            setUseCanonCodex: (useCanonCodex) => set({ useCanonCodex }),
            setUseCanonAutoFetch: (useCanonAutoFetch) => set({ useCanonAutoFetch }),

            // Preset Actions
            addPreset: (preset) =>
                set((state) => ({
                    presets: [...state.presets, preset],
                })),

            updatePreset: (id, updates) =>
                set((state) => ({
                    presets: state.presets.map((p) =>
                        p.id === id
                            ? // Editing a built-in marks it userModified so the reconciler
                              // never silently overwrites the user's changes on a version bump.
                              {
                                  ...p,
                                  ...updates,
                                  userModified: p.builtinKey ? true : p.userModified,
                              }
                            : p
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

                    // Map the original seeded ids to stable keys (the order BEFORE "Immersive
                    // RP" was inserted), so a renamed preset still gets matched by id and isn't
                    // duplicated. Name is only a fallback for installs that lost the ids.
                    const idToKey: Record<string, string> = {
                        'default-0': 'balanced',
                        'default-1': 'creative',
                        'default-2': 'precise',
                    };
                    const nameToKey: Record<string, string> = {
                        Balanced: 'balanced',
                        Creative: 'creative',
                        Precise: 'precise',
                        'Immersive RP': 'immersive-rp',
                    };

                    let changed = false;
                    const reconciled = state.presets.map((p) => {
                        if (!p.builtinKey && p.isDefault) {
                            const key = idToKey[p.id] || nameToKey[p.name];
                            if (key) {
                                changed = true;
                                return { ...p, builtinKey: key, builtinVersion: 1 };
                            }
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
            name: SETTINGS_KEY,
            storage: createJSONStorage(() => {
                if (typeof window === 'undefined') throw new Error('Browser storage only');
                return createSafeSettingsStorage(() => window.localStorage);
            }),
            // NOTE: everything persisted here is genuinely needed across reloads
            // (nanogptModels is only refetched when the key is saved) — no partialize.
            version: SETTINGS_VERSION,
            migrate: (persisted, version) => migrateSettings(persisted, version),
        }
    )
);
