import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lorebook, LorebookEntry } from '@/types/character';

interface LorebookState {
    // Current editing state
    activeLorebook: Lorebook | null;

    // Actions
    setActiveLorebook: (lorebook: Lorebook | null) => void;
    updateLorebook: (lorebook: Lorebook) => void;
    addEntry: (entry: LorebookEntry) => void;
    updateEntry: (index: number, entry: LorebookEntry) => void;
    deleteEntry: (index: number) => void;

    // Import/Export
    importLorebook: (json: string) => boolean;
}

export const useLorebookStore = create<LorebookState>()(
    persist(
        (set) => ({
            activeLorebook: null,

            setActiveLorebook: (lorebook) => set({ activeLorebook: lorebook }),

            updateLorebook: (lorebook) => set({ activeLorebook: lorebook }),

            addEntry: (entry) => set((state) => {
                if (!state.activeLorebook) return {};
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
                return {
                    activeLorebook: {
                        ...state.activeLorebook,
                        entries: newEntries
                    }
                };
            }),

            deleteEntry: (index) => set((state) => {
                if (!state.activeLorebook) return {};
                return {
                    activeLorebook: {
                        ...state.activeLorebook,
                        entries: state.activeLorebook.entries.filter((_, i) => i !== index)
                    }
                };
            }),

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
        }),
        {
            name: 'nexusai-lorebook-storage',
        }
    )
);
