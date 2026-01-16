import { create } from 'zustand';
import type { Lorebook, LorebookEntry } from '@/types/character';
import {
    addLorebookHistoryEntry,
    getLorebookHistory,
    type LorebookHistoryEntry
} from '@/lib/db';

interface LorebookState {
    // Current editing state
    activeLorebook: Lorebook | null;
    activeCharacterId: string | null;
    history: LorebookHistoryEntry[];
    isLoadingHistory: boolean;

    // Actions
    setActiveLorebook: (lorebook: Lorebook | null, characterId?: string) => void;
    updateLorebook: (lorebook: Lorebook) => void;
    addEntry: (entry: LorebookEntry) => void;
    updateEntry: (index: number, entry: LorebookEntry) => void;
    deleteEntry: (index: number) => void;

    // History actions (blockchain-style)
    loadHistory: (characterId: string) => Promise<void>;
    addAIEntry: (entry: LorebookEntry) => Promise<void>;

    // Import/Export
    importLorebook: (json: string) => boolean;
}

const generateId = () => crypto.randomUUID();

export const useLorebookStore = create<LorebookState>()((set, get) => ({
    activeLorebook: null,
    activeCharacterId: null,
    history: [],
    isLoadingHistory: false,

    setActiveLorebook: (lorebook, characterId) => set({
        activeLorebook: lorebook,
        activeCharacterId: characterId || null
    }),

    updateLorebook: (lorebook) => set({ activeLorebook: lorebook }),

    addEntry: (entry) => set((state) => {
        if (!state.activeLorebook) return {};

        // For user-added entries, we could optionally log to history
        // But per requirements, only AI additions are tracked in blockchain style

        return {
            activeLorebook: {
                ...state.activeLorebook,
                entries: [...state.activeLorebook.entries, entry]
            }
        };
    }),

    updateEntry: (index, entry) => set((state) => {
        if (!state.activeLorebook) return {};
        const newEntries = [...state.activeLorebook.entries];
        newEntries[index] = entry;

        // Log user edits to history for full audit trail
        const characterId = state.activeCharacterId;
        if (characterId) {
            const historyEntry: LorebookHistoryEntry = {
                id: generateId(),
                characterId,
                timestamp: Date.now(),
                type: 'user_edit',
                entryData: entry,
            };
            addLorebookHistoryEntry(historyEntry).catch(console.error);
        }

        return {
            activeLorebook: {
                ...state.activeLorebook,
                entries: newEntries
            }
        };
    }),

    deleteEntry: (index) => set((state) => {
        if (!state.activeLorebook) return {};

        const deletedEntry = state.activeLorebook.entries[index];
        const characterId = state.activeCharacterId;

        // Log deletion to history (preserves previous state in chain)
        if (characterId && deletedEntry) {
            const historyEntry: LorebookHistoryEntry = {
                id: generateId(),
                characterId,
                timestamp: Date.now(),
                type: 'user_delete',
                entryData: deletedEntry,
            };
            addLorebookHistoryEntry(historyEntry).catch(console.error);
        }

        return {
            activeLorebook: {
                ...state.activeLorebook,
                entries: state.activeLorebook.entries.filter((_, i) => i !== index)
            }
        };
    }),

    // Load blockchain-style history from IndexedDB
    loadHistory: async (characterId) => {
        set({ isLoadingHistory: true });
        try {
            const history = await getLorebookHistory(characterId);
            set({ history, isLoadingHistory: false });
        } catch (error) {
            console.error('Failed to load lorebook history:', error);
            set({ isLoadingHistory: false });
        }
    },

    // AI-generated entry (append-only, blockchain-style)
    addAIEntry: async (entry) => {
        const state = get();
        if (!state.activeLorebook || !state.activeCharacterId) return;

        // Get the last history entry for chain linking
        const lastHistoryEntry = state.history[state.history.length - 1];

        // Create blockchain-style history entry
        const historyEntry: LorebookHistoryEntry = {
            id: generateId(),
            characterId: state.activeCharacterId,
            timestamp: Date.now(),
            type: 'ai_add',
            entryData: entry,
            previousEntryId: lastHistoryEntry?.id,
        };

        // Persist to IndexedDB first (immutable append)
        await addLorebookHistoryEntry(historyEntry);

        // Update local state
        set((s) => ({
            activeLorebook: s.activeLorebook ? {
                ...s.activeLorebook,
                entries: [...s.activeLorebook.entries, entry]
            } : null,
            history: [...s.history, historyEntry]
        }));
    },

    importLorebook: (json) => {
        try {
            const parsed = JSON.parse(json);
            // Basic validation
            if (!Array.isArray(parsed.entries)) return false;

            set({ activeLorebook: parsed });
            return true;
        } catch (e) {
            console.error("Failed to import lorebook", e);
            return false;
        }
    }
}));
