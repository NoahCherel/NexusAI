import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CharacterCard } from '@/types';

interface CharacterState {
    characters: CharacterCard[];
    activeCharacterId: string | null;

    // Actions
    addCharacter: (character: CharacterCard) => void;
    updateCharacter: (id: string, updates: Partial<CharacterCard>) => void;
    removeCharacter: (id: string) => void;
    setActiveCharacter: (id: string | null) => void;
    getActiveCharacter: () => CharacterCard | null;
}

export const useCharacterStore = create<CharacterState>()(
    persist(
        (set, get) => ({
            characters: [],
            activeCharacterId: null,

            addCharacter: (character) =>
                set((state) => ({
                    characters: [...state.characters, character],
                })),

            updateCharacter: (id, updates) =>
                set((state) => ({
                    characters: state.characters.map((c) =>
                        c.id === id ? { ...c, ...updates } : c
                    ),
                })),

            removeCharacter: (id) =>
                set((state) => ({
                    characters: state.characters.filter((c) => c.id !== id),
                    activeCharacterId:
                        state.activeCharacterId === id ? null : state.activeCharacterId,
                })),

            setActiveCharacter: (id) => set({ activeCharacterId: id }),

            getActiveCharacter: () => {
                const state = get();
                return (
                    state.characters.find((c) => c.id === state.activeCharacterId) ?? null
                );
            },
        }),
        {
            name: 'nexusai-characters',
        }
    )
);
