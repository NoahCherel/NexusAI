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
    // Now with consolidation: merges with existing entries that share keywords
    addAIEntry: async (entry) => {
        const state = get();
        if (!state.activeLorebook || !state.activeCharacterId) return;

        // Check if any existing entry shares a keyword with the new entry
        const existingEntryIndex = state.activeLorebook.entries.findIndex((existing) =>
            existing.keys.some((existingKey) =>
                entry.keys.some(
                    (newKey) => newKey.toLowerCase() === existingKey.toLowerCase()
                )
            )
        );

        let updatedLorebook: Lorebook;
        let historyType: 'ai_add' | 'ai_merge' = 'ai_add';
        let finalEntry: LorebookEntry;

        if (existingEntryIndex !== -1) {
            // Merge with existing entry
            const existingEntry = state.activeLorebook.entries[existingEntryIndex];
            
            // Combine keys (deduplicated, case-insensitive)
            const combinedKeys = [...existingEntry.keys];
            for (const newKey of entry.keys) {
                if (!combinedKeys.some((k) => k.toLowerCase() === newKey.toLowerCase())) {
                    combinedKeys.push(newKey);
                }
            }

            // Append new content to existing content
            const mergedContent = existingEntry.content.trim() + '\n' + entry.content.trim();

            finalEntry = {
                ...existingEntry,
                keys: combinedKeys,
                content: mergedContent,
                priority: Math.max(existingEntry.priority || 10, entry.priority || 10),
                category: entry.category || existingEntry.category,
            };

            // Update the entry in place
            const newEntries = [...state.activeLorebook.entries];
            newEntries[existingEntryIndex] = finalEntry;

            updatedLorebook = {
                ...state.activeLorebook,
                entries: newEntries,
            };
            historyType = 'ai_merge';

            console.log(`[Lorebook] Merged entry for keys: ${combinedKeys.join(', ')}`);
        } else {
            // No existing entry found, create new one
            finalEntry = entry;
            updatedLorebook = {
                ...state.activeLorebook,
                entries: [...state.activeLorebook.entries, entry],
            };
            console.log(`[Lorebook] Added new entry for keys: ${entry.keys.join(', ')}`);
        }

        // Get the last history entry for chain linking
        const lastHistoryEntry = state.history[state.history.length - 1];

        // Create blockchain-style history entry
        const historyEntry: LorebookHistoryEntry = {
            id: generateId(),
            characterId: state.activeCharacterId,
            timestamp: Date.now(),
            type: historyType,
            entryData: finalEntry,
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
        // We import dynamically to avoid circular dependency
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
