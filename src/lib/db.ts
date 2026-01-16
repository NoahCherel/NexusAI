import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { CharacterCard, Conversation, Message, LorebookEntry } from '@/types';

// Database version - increment when schema changes
// Database version - increment when schema changes
const DB_VERSION = 3;
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
        value: Conversation; // Messages are now stored separately
        indexes: { 'by-character': string };
    };
    messages: {
        key: string;
        value: Message;
        indexes: { 'by-conversation': string };
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
        async upgrade(db, oldVersion, newVersion, transaction) {
            console.log(`[DB] Upgrading from ${oldVersion} to ${newVersion}`);

            // Characters store
            if (!db.objectStoreNames.contains('characters')) {
                const charStore = db.createObjectStore('characters', { keyPath: 'id' });
                charStore.createIndex('by-name', 'name');
            }

            // Conversations store
            if (!db.objectStoreNames.contains('conversations')) {
                const convStore = db.createObjectStore('conversations', { keyPath: 'id' });
                convStore.createIndex('by-character', 'characterId');
            }

            // Messages store (New in v3)
            if (!db.objectStoreNames.contains('messages')) {
                const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
                msgStore.createIndex('by-conversation', 'conversationId');
            }

            // Migration from v2 (embedded messages) to v3 (separate messages)
            if (oldVersion >= 1 && oldVersion < 3) {
                // We need to migrate messages from conversations to messages store
                // Note: 'conversations' store might contain objects with 'messages' property
                // We can't easily iterate and modify in 'upgrade' without transaction issues potentially,
                // but IDB 'upgrade' transaction covers all stores.

                // However, we can't use getAll on the *transaction* for the store being upgraded efficiently if we change schema
                // Actually, we can just iterate the existing conversations store.

                try {
                    const convStore = transaction.objectStore('conversations');
                    const msgStore = transaction.objectStore('messages');

                    // We need to type cast because the old type had messages
                    const curs = await convStore.openCursor();
                    let cursor = curs;

                    while (cursor) {
                        const conv = cursor.value as any; // Old conversation type
                        if (conv.messages && Array.isArray(conv.messages)) {
                            console.log(`[DB Migration] Migrating ${conv.messages.length} messages for conversation ${conv.id}`);
                            for (const msg of conv.messages) {
                                await msgStore.put(msg);
                            }
                            // Update conversation to remove messages property
                            const { messages, ...convData } = conv;
                            await cursor.update(convData);
                        }
                        cursor = await cursor.continue();
                    }
                } catch (e) {
                    console.error('[DB Migration] Error migrating messages:', e);
                }
            }

            // Lorebook history
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
    console.log(`[DB] Saving character: ${character.name} (${character.id})`);
    if (character.character_book) {
        console.log(`[DB] Character has lorebook with ${character.character_book.entries.length} entries`);
    }
    const db = await initDB();
    await db.put('characters', character);
    console.log(`[DB] Character saved successfully`);
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

// Conversation operations (Metadata only)
export async function saveConversation(conversation: Conversation): Promise<void> {
    const db = await initDB();
    // Ensure we don't save messages in the conversation object if they accidentally leak in
    const { messages, ...convData } = conversation as any;
    await db.put('conversations', convData);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
    const db = await initDB();
    return db.get('conversations', id);
}

export async function getConversationsByCharacter(characterId: string): Promise<Conversation[]> {
    const db = await initDB();
    return db.getAllFromIndex('conversations', 'by-character', characterId);
}

export async function deleteConversation(id: string): Promise<void> {
    const db = await initDB();
    await db.delete('conversations', id);
    // Delete associated messages
    const tx = db.transaction('messages', 'readwrite');
    const index = tx.store.index('by-conversation');
    let cursor = await index.openKeyCursor(IDBKeyRange.only(id));
    while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
    }
    await tx.done;
}

// Message operations
export async function saveMessage(message: Message): Promise<void> {
    const db = await initDB();
    await db.put('messages', message);
}

export async function getConversationMessages(conversationId: string): Promise<Message[]> {
    const db = await initDB();
    return db.getAllFromIndex('messages', 'by-conversation', conversationId);
}

export async function deleteMessagedb(id: string): Promise<void> {
    const db = await initDB();
    await db.delete('messages', id);
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
