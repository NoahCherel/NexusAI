import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { CharacterCard, Conversation, Message, LorebookEntry } from '@/types';

// Database version - increment when schema changes
const DB_VERSION = 1;
const DB_NAME = 'nexusai-db';

// Lorebook history entry for blockchain-style tracking
export interface LorebookHistoryEntry {
    id: string;
    characterId: string;
    timestamp: number;
    type: 'ai_add' | 'user_edit' | 'user_delete' | 'initial';
    entryData: LorebookEntry;
    previousEntryId?: string;
}

// Extended character with long-term memory
export interface CharacterWithMemory extends CharacterCard {
    longTermMemory: string[];
}

// Database schema
interface NexusAIDB extends DBSchema {
    characters: {
        key: string;
        value: CharacterWithMemory;
        indexes: { 'by-name': string };
    };
    conversations: {
        key: string;
        value: Conversation & { messages: Message[] };
        indexes: { 'by-character': string };
    };
    lorebookHistory: {
        key: string;
        value: LorebookHistoryEntry;
        indexes: { 'by-character': string; 'by-timestamp': number };
    };
    settings: {
        key: string;
        value: unknown;
    };
}

let dbInstance: IDBPDatabase<NexusAIDB> | null = null;

// Initialize database
export async function initDB(): Promise<IDBPDatabase<NexusAIDB>> {
    if (dbInstance) return dbInstance;

    dbInstance = await openDB<NexusAIDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
            // Characters store
            if (!db.objectStoreNames.contains('characters')) {
                const charStore = db.createObjectStore('characters', { keyPath: 'id' });
                charStore.createIndex('by-name', 'name');
            }

            // Conversations store (includes all messages/branches)
            if (!db.objectStoreNames.contains('conversations')) {
                const convStore = db.createObjectStore('conversations', { keyPath: 'id' });
                convStore.createIndex('by-character', 'characterId');
            }

            // Lorebook history (append-only blockchain-style)
            if (!db.objectStoreNames.contains('lorebookHistory')) {
                const loreStore = db.createObjectStore('lorebookHistory', { keyPath: 'id' });
                loreStore.createIndex('by-character', 'characterId');
                loreStore.createIndex('by-timestamp', 'timestamp');
            }

            // Settings store
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }
        },
    });

    return dbInstance;
}

// Character operations
export async function saveCharacter(character: CharacterWithMemory): Promise<void> {
    const db = await initDB();
    await db.put('characters', character);
}

export async function getCharacter(id: string): Promise<CharacterWithMemory | undefined> {
    const db = await initDB();
    return db.get('characters', id);
}

export async function getAllCharacters(): Promise<CharacterWithMemory[]> {
    const db = await initDB();
    return db.getAll('characters');
}

export async function deleteCharacter(id: string): Promise<void> {
    const db = await initDB();
    await db.delete('characters', id);
}

// Conversation operations
export async function saveConversation(conversation: Conversation & { messages: Message[] }): Promise<void> {
    const db = await initDB();
    await db.put('conversations', conversation);
}

export async function getConversation(id: string): Promise<(Conversation & { messages: Message[] }) | undefined> {
    const db = await initDB();
    return db.get('conversations', id);
}

export async function getConversationsByCharacter(characterId: string): Promise<(Conversation & { messages: Message[] })[]> {
    const db = await initDB();
    return db.getAllFromIndex('conversations', 'by-character', characterId);
}

export async function deleteConversation(id: string): Promise<void> {
    const db = await initDB();
    await db.delete('conversations', id);
}

// Lorebook history operations (append-only)
export async function addLorebookHistoryEntry(entry: LorebookHistoryEntry): Promise<void> {
    const db = await initDB();
    await db.add('lorebookHistory', entry);
}

export async function getLorebookHistory(characterId: string): Promise<LorebookHistoryEntry[]> {
    const db = await initDB();
    return db.getAllFromIndex('lorebookHistory', 'by-character', characterId);
}

// Settings operations
export async function saveSetting(key: string, value: unknown): Promise<void> {
    const db = await initDB();
    await db.put('settings', { key, value });
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
    const db = await initDB();
    const result = await db.get('settings', key);
    return result?.value as T | undefined;
}

// Utility: Export all data (for backup)
export async function exportAllData(): Promise<{
    characters: CharacterWithMemory[];
    conversations: (Conversation & { messages: Message[] })[];
    lorebookHistory: LorebookHistoryEntry[];
}> {
    const db = await initDB();
    return {
        characters: await db.getAll('characters'),
        conversations: await db.getAll('conversations'),
        lorebookHistory: await db.getAll('lorebookHistory'),
    };
}
