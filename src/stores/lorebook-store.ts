import { create } from 'zustand';
import type { Lorebook, LorebookEntry } from '@/types/character';
import { addLorebookHistoryEntry, getLorebookHistory, type LorebookHistoryEntry } from '@/lib/db';

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
    addAIEntries: (entries: LorebookEntry[]) => Promise<void>; // Batch add

    // Import/Export
    importLorebook: (json: string) => boolean;
}

const generateId = () => crypto.randomUUID();

export const useLorebookStore = create<LorebookState>()((set, get) => ({
    activeLorebook: null,
    activeCharacterId: null,
    history: [],
    isLoadingHistory: false,

    setActiveLorebook: (lorebook, characterId) =>
        set({
            activeLorebook: lorebook,
            activeCharacterId: characterId || null,
        }),

    updateLorebook: (lorebook) => set({ activeLorebook: lorebook }),

    addEntry: (entry) => {
        const state = get();
        if (!state.activeLorebook) return;

        const updatedLorebook = {
            ...state.activeLorebook,
            entries: [...state.activeLorebook.entries, entry],
        };

        set({ activeLorebook: updatedLorebook });

        // Auto-persist to character's character_book
        if (state.activeCharacterId) {
            import('@/stores/character-store').then(({ useCharacterStore }) => {
                useCharacterStore.getState().updateCharacter(state.activeCharacterId!, {
                    character_book: updatedLorebook,
                });
            });
        }
    },

    updateEntry: (index, entry) => {
        const state = get();
        if (!state.activeLorebook) return;

        const newEntries = [...state.activeLorebook.entries];
        newEntries[index] = entry;

        const updatedLorebook = {
            ...state.activeLorebook,
            entries: newEntries,
        };

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

        set({ activeLorebook: updatedLorebook });

        // Auto-persist to character's character_book
        if (characterId) {
            import('@/stores/character-store').then(({ useCharacterStore }) => {
                useCharacterStore.getState().updateCharacter(characterId, {
                    character_book: updatedLorebook,
                });
            });
        }
    },

    deleteEntry: (index) => {
        const state = get();
        if (!state.activeLorebook) return;

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

        const updatedLorebook = {
            ...state.activeLorebook,
            entries: state.activeLorebook.entries.filter((_, i) => i !== index),
        };

        set({ activeLorebook: updatedLorebook });

        // Auto-persist to character's character_book
        if (characterId) {
            import('@/stores/character-store').then(({ useCharacterStore }) => {
                useCharacterStore.getState().updateCharacter(characterId, {
                    character_book: updatedLorebook,
                });
            });
        }
    },

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

        // Simply append the new entry
        const updatedLorebook: Lorebook = {
            ...state.activeLorebook,
            entries: [...state.activeLorebook.entries, entry],
        };

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
            activeLorebook: updatedLorebook,
            history: [...s.history, historyEntry],
        }));

        // IMPORTANT: Also update the character's character_book in IndexedDB for persistence
        const { useCharacterStore } = await import('@/stores/character-store');
        const charStore = useCharacterStore.getState();
        if (state.activeCharacterId) {
            await charStore.updateCharacter(state.activeCharacterId, {
                character_book: updatedLorebook,
            });
        }
    },

    // Batch add AI entries atomically (prevents race conditions)
    addAIEntries: async (entries) => {
        const state = get();
        if (!state.activeLorebook || !state.activeCharacterId || entries.length === 0) return;

        // Simply append all new entries
        const newEntries = [...state.activeLorebook.entries, ...entries];
        const historyEntries: LorebookHistoryEntry[] = [];
        const lastHistoryEntry = state.history[state.history.length - 1];
        let previousId = lastHistoryEntry?.id;

        // Create history entries for each new entry
        for (const entry of entries) {
            const historyEntry: LorebookHistoryEntry = {
                id: generateId(),
                characterId: state.activeCharacterId!,
                timestamp: Date.now(),
                type: 'ai_add',
                entryData: entry,
                previousEntryId: previousId,
            };
            historyEntries.push(historyEntry);
            previousId = historyEntry.id;
        }

        const updatedLorebook: Lorebook = {
            ...state.activeLorebook,
            entries: newEntries,
        };

        // Persist history entries to IndexedDB
        for (const historyEntry of historyEntries) {
            await addLorebookHistoryEntry(historyEntry);
        }

        // Update local state atomically
        set((s) => ({
            activeLorebook: updatedLorebook,
            history: [...s.history, ...historyEntries],
        }));

        // Persist to character's character_book
        const { useCharacterStore } = await import('@/stores/character-store');
        const charStore = useCharacterStore.getState();
        if (state.activeCharacterId) {
            await charStore.updateCharacter(state.activeCharacterId, {
                character_book: updatedLorebook,
            });
        }
    },

    importLorebook: (json) => {
        try {
            const parsed = JSON.parse(json);
            // Basic validation
            if (!Array.isArray(parsed.entries)) return false;

            set({ activeLorebook: parsed });
            return true;
        } catch (e) {
            console.error('Failed to import lorebook', e);
            return false;
        }
    },
}));
