import { create } from 'zustand';
import { LorebookCategory, type Lorebook, type LorebookEntry } from '@/types/character';
import { addLorebookHistoryEntry, getLorebookHistory, type LorebookHistoryEntry } from '@/lib/db';

// Pending suggestion from AI extraction
export interface LorebookSuggestion {
    id: string;
    keys: string[];
    content: string;
    category?: 'character' | 'location' | 'notion';
    timestamp: number;
}

interface LorebookState {
    // Current editing state
    activeLorebook: Lorebook | null;
    activeCharacterId: string | null;
    history: LorebookHistoryEntry[];
    isLoadingHistory: boolean;

    // Pending suggestions queue
    pendingSuggestions: LorebookSuggestion[];

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

    // Suggestion actions
    addSuggestion: (suggestion: Omit<LorebookSuggestion, 'id' | 'timestamp'>) => void;
    addSuggestions: (suggestions: Omit<LorebookSuggestion, 'id' | 'timestamp'>[]) => void;
    acceptSuggestion: (id: string) => Promise<void>;
    rejectSuggestion: (id: string) => void;
    clearSuggestions: () => void;

    // Import/Export
    importLorebook: (json: string) => boolean;
}

const generateId = () => crypto.randomUUID();

export const useLorebookStore = create<LorebookState>()((set, get) => ({
    activeLorebook: null,
    activeCharacterId: null,
    history: [],
    isLoadingHistory: false,
    pendingSuggestions: [],

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
    // If entry matches existing keys, APPEND the new content to the existing entry
    addAIEntry: async (entry) => {
        const state = get();
        if (!state.activeLorebook || !state.activeCharacterId) return;

        // Check if any existing entry shares a key with the new entry
        const currentEntries = [...state.activeLorebook.entries];
        const existingEntryIndex = currentEntries.findIndex((existing) =>
            existing.keys.some((existingKey) =>
                entry.keys.some((newKey) => newKey.toLowerCase() === existingKey.toLowerCase())
            )
        );

        let historyType: 'ai_add' | 'ai_append' = 'ai_add';
        let finalEntry: LorebookEntry;

        if (existingEntryIndex !== -1) {
            // APPEND to existing entry (never overwrite)
            const existingEntry = currentEntries[existingEntryIndex];

            // Append new content to the end
            const appendedContent = existingEntry.content.trim() + '\n\n' + entry.content.trim();

            finalEntry = {
                ...existingEntry,
                content: appendedContent,
                priority: Math.max(existingEntry.priority || 10, entry.priority || 10),
            };

            currentEntries[existingEntryIndex] = finalEntry;
            historyType = 'ai_append';
        } else {
            // New entry
            finalEntry = entry;
            currentEntries.push(entry);
        }

        const updatedLorebook: Lorebook = {
            ...state.activeLorebook,
            entries: currentEntries,
        };

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
        const { useCharacterStore } = await import('@/stores/character-store');
        const charStore = useCharacterStore.getState();
        if (state.activeCharacterId) {
            await charStore.updateCharacter(state.activeCharacterId, {
                character_book: updatedLorebook,
            });
        }
    },

    // Batch add AI entries atomically (prevents race conditions)
    // If an entry matches existing keys, APPEND the new content to the existing entry
    addAIEntries: async (entries) => {
        const state = get();
        if (!state.activeLorebook || !state.activeCharacterId || entries.length === 0) return;

        // Work with a copy of current entries
        const currentEntries = [...state.activeLorebook.entries];
        const historyEntries: LorebookHistoryEntry[] = [];
        const lastHistoryEntry = state.history[state.history.length - 1];
        let previousId = lastHistoryEntry?.id;

        for (const entry of entries) {
            // Check if any existing entry shares a key with the new entry
            const existingEntryIndex = currentEntries.findIndex((existing) =>
                existing.keys.some((existingKey) =>
                    entry.keys.some((newKey) => newKey.toLowerCase() === existingKey.toLowerCase())
                )
            );

            let historyType: 'ai_add' | 'ai_append' = 'ai_add';
            let finalEntry: typeof entry;

            if (existingEntryIndex !== -1) {
                // APPEND to existing entry (never overwrite)
                const existingEntry = currentEntries[existingEntryIndex];

                // Append new content to the end
                const appendedContent =
                    existingEntry.content.trim() + '\n\n' + entry.content.trim();

                finalEntry = {
                    ...existingEntry,
                    content: appendedContent,
                    // Keep the higher priority
                    priority: Math.max(existingEntry.priority || 10, entry.priority || 10),
                };

                // Update the entry in place
                currentEntries[existingEntryIndex] = finalEntry;
                historyType = 'ai_append';
            } else {
                // New entry - add to list
                finalEntry = entry;
                currentEntries.push(entry);
            }

            // Create history entry
            const historyEntry: LorebookHistoryEntry = {
                id: generateId(),
                characterId: state.activeCharacterId!,
                timestamp: Date.now(),
                type: historyType,
                entryData: finalEntry,
                previousEntryId: previousId,
            };
            historyEntries.push(historyEntry);
            previousId = historyEntry.id;
        }

        const updatedLorebook: Lorebook = {
            ...state.activeLorebook,
            entries: currentEntries,
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

    // Suggestion actions
    addSuggestion: (suggestion) => {
        const newSuggestion: LorebookSuggestion = {
            ...suggestion,
            id: generateId(),
            timestamp: Date.now(),
        };
        set((s) => ({
            pendingSuggestions: [...s.pendingSuggestions, newSuggestion],
        }));
    },

    addSuggestions: (suggestions) => {
        const newSuggestions: LorebookSuggestion[] = suggestions.map((s) => ({
            ...s,
            id: generateId(),
            timestamp: Date.now(),
        }));
        set((s) => ({
            pendingSuggestions: [...s.pendingSuggestions, ...newSuggestions],
        }));
    },

    acceptSuggestion: async (id) => {
        const state = get();
        const suggestion = state.pendingSuggestions.find((s) => s.id === id);
        if (!suggestion || !state.activeLorebook || !state.activeCharacterId) return;

        const currentEntries = [...state.activeLorebook.entries];

        // Find matching entry - pick the one where matching key is LEFTMOST (key order = importance)
        let bestMatchIndex = -1;
        let bestMatchKeyPosition = Infinity;

        for (let i = 0; i < currentEntries.length; i++) {
            const entry = currentEntries[i];
            for (const suggestionKey of suggestion.keys) {
                const keyIndex = entry.keys.findIndex(
                    (k) => k.toLowerCase() === suggestionKey.toLowerCase()
                );
                if (keyIndex !== -1 && keyIndex < bestMatchKeyPosition) {
                    bestMatchIndex = i;
                    bestMatchKeyPosition = keyIndex;
                }
            }
        }

        let finalEntry: LorebookEntry;
        let historyType: 'ai_add' | 'ai_append' = 'ai_add';

        if (bestMatchIndex !== -1) {
            // Append to existing entry
            const existingEntry = currentEntries[bestMatchIndex];
            const appendedContent =
                existingEntry.content.trim() + '\n\n' + suggestion.content.trim();

            finalEntry = {
                ...existingEntry,
                content: appendedContent,
            };
            currentEntries[bestMatchIndex] = finalEntry;
            historyType = 'ai_append';
        } else {
            // Create new entry
            finalEntry = {
                keys: suggestion.keys,
                content: suggestion.content,
                enabled: true,
                priority: 10,
                category: suggestion.category as LorebookCategory,
            };
            currentEntries.push(finalEntry);
        }

        const updatedLorebook: Lorebook = {
            ...state.activeLorebook,
            entries: currentEntries,
        };

        // Create history entry
        const lastHistoryEntry = state.history[state.history.length - 1];
        const historyEntry: LorebookHistoryEntry = {
            id: generateId(),
            characterId: state.activeCharacterId,
            timestamp: Date.now(),
            type: historyType,
            entryData: finalEntry,
            previousEntryId: lastHistoryEntry?.id,
        };

        await addLorebookHistoryEntry(historyEntry);

        // Update state - remove from suggestions, update lorebook
        set((s) => ({
            activeLorebook: updatedLorebook,
            history: [...s.history, historyEntry],
            pendingSuggestions: s.pendingSuggestions.filter((s) => s.id !== id),
        }));

        // Persist to character
        const { useCharacterStore } = await import('@/stores/character-store');
        const charStore = useCharacterStore.getState();
        await charStore.updateCharacter(state.activeCharacterId, {
            character_book: updatedLorebook,
        });
    },

    rejectSuggestion: (id) => {
        set((s) => ({
            pendingSuggestions: s.pendingSuggestions.filter((s) => s.id !== id),
        }));
    },

    clearSuggestions: () => {
        set({ pendingSuggestions: [] });
    },
}));
