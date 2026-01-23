'use client';

import { useEffect, useRef } from 'react';
import { useCharacterStore } from '@/stores/character-store';
import { useChatStore } from '@/stores/chat-store';
import { initDB } from '@/lib/db';

/**
 * Hook to initialize IndexedDB and load data on app start.
 * Should be called once in the root layout or main page.
 */
export function useAppInitialization() {
    const initialized = useRef(false);
    const { loadCharacters, isLoading: isLoadingCharacters } = useCharacterStore();
    const { loadConversations } = useChatStore();
    const { activeCharacterId } = useCharacterStore();

    useEffect(() => {
        if (initialized.current) return;
        initialized.current = true;

        const init = async () => {
            try {
                await initDB();
                await loadCharacters();
            } catch (error) {
                console.error('App initialization failed:', error);
            }
        };

        init();
    }, [loadCharacters]);

    // Load conversations when active character changes
    useEffect(() => {
        if (activeCharacterId) {
            loadConversations(activeCharacterId);
        }
    }, [activeCharacterId, loadConversations]);

    return { isLoadingCharacters };
}
