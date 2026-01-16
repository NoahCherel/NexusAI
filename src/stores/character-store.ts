import { create } from 'zustand';
import type { CharacterCard } from '@/types';
import {
    saveCharacter,
    getAllCharacters,
    deleteCharacter as dbDeleteCharacter,
    type CharacterWithMemory,
} from '@/lib/db';

interface CharacterState {
    characters: CharacterWithMemory[];
    activeCharacterId: string | null;
    isLoading: boolean;

    // Actions
    loadCharacters: () => Promise<void>;
    addCharacter: (character: CharacterCard) => Promise<void>;
    updateCharacter: (id: string, updates: Partial<CharacterWithMemory>) => Promise<void>;
    removeCharacter: (id: string) => Promise<void>;
    setActiveCharacter: (id: string | null) => void;
    setActiveCharacterId: (id: string | null) => void; // Alias for compatibility
    getActiveCharacter: () => CharacterWithMemory | null;
    updateLongTermMemory: (id: string, memory: string[]) => Promise<void>;
}

export const useCharacterStore = create<CharacterState>()((set, get) => ({
    characters: [],
    activeCharacterId: null,
    isLoading: true,

    // Load all characters from IndexedDB on init
    loadCharacters: async () => {
        try {
            console.log('[CharacterStore] Loading characters from IndexedDB...');
            const characters = await getAllCharacters();
            console.log(
                '[CharacterStore] Loaded characters:',
                characters.length,
                characters.map((c) => c.name)
            );

            // Restore active character from localStorage
            let activeId = get().activeCharacterId;
            if (typeof window !== 'undefined') {
                const persistedId = localStorage.getItem('nexusai_active_char');
                console.log(
                    '[CharacterStore] Checking localStorage for nexusai_active_char:',
                    persistedId
                );
                if (persistedId && characters.some((c) => c.id === persistedId)) {
                    activeId = persistedId;
                    console.log('[CharacterStore] Restoring activeCharacterId:', activeId);
                } else {
                    console.log('[CharacterStore] No valid active character found in localStorage');
                }
            }

            set({ characters, activeCharacterId: activeId, isLoading: false });
        } catch (error) {
            console.error('[CharacterStore] Failed to load characters:', error);
            set({ isLoading: false });
        }
    },

    addCharacter: async (character) => {
        const charWithMemory: CharacterWithMemory = {
            ...character,
            longTermMemory: [],
        };

        await saveCharacter(charWithMemory);
        set((state) => ({
            characters: [...state.characters, charWithMemory],
        }));
    },

    updateCharacter: async (id, updates) => {
        const existingChar = get().characters.find((c) => c.id === id);
        if (!existingChar) return;

        const updatedChar = { ...existingChar, ...updates };
        await saveCharacter(updatedChar);

        set((state) => ({
            characters: state.characters.map((c) => (c.id === id ? updatedChar : c)),
        }));
    },

    removeCharacter: async (id) => {
        await dbDeleteCharacter(id);
        set((state) => ({
            characters: state.characters.filter((c) => c.id !== id),
            activeCharacterId: state.activeCharacterId === id ? null : state.activeCharacterId,
        }));
        if (typeof window !== 'undefined' && get().activeCharacterId === id) {
            localStorage.removeItem('nexusai_active_char');
        }
    },

    setActiveCharacter: (id) => {
        set({ activeCharacterId: id });
        if (typeof window !== 'undefined') {
            if (id) localStorage.setItem('nexusai_active_char', id);
            else localStorage.removeItem('nexusai_active_char');
        }
    },
    setActiveCharacterId: (id) => {
        // Alias
        set({ activeCharacterId: id });
        if (typeof window !== 'undefined') {
            if (id) localStorage.setItem('nexusai_active_char', id);
            else localStorage.removeItem('nexusai_active_char');
        }
    },

    getActiveCharacter: () => {
        const state = get();
        return state.characters.find((c) => c.id === state.activeCharacterId) ?? null;
    },

    // Long-term memory helpers
    updateLongTermMemory: async (id, memory) => {
        const existingChar = get().characters.find((c) => c.id === id);
        if (!existingChar) return;

        const updatedChar = { ...existingChar, longTermMemory: memory };
        await saveCharacter(updatedChar);

        set((state) => ({
            characters: state.characters.map((c) => (c.id === id ? updatedChar : c)),
        }));
    },
}));
