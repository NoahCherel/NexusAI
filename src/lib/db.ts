import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { CharacterCard, Conversation, Message, LorebookEntry } from '@/types';

// Database version - increment when schema changes
// Database version - increment when schema changes
const DB_VERSION = 4;
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
                        const conv = cursor.value as unknown as {
                            messages?: Message[];
                            id: string;
                        } & Record<string, unknown>; // Old conversation type
                        if (conv.messages && Array.isArray(conv.messages)) {
                            console.log(
                                `[DB Migration] Migrating ${conv.messages.length} messages for conversation ${conv.id}`
                            );
                            for (const msg of conv.messages) {
                                await msgStore.put(msg);
                            }
                            // Update conversation to remove messages property
                            // eslint-disable-next-line @typescript-eslint/no-unused-vars
                            const { messages, ...convData } = conv;
                            // We need to cast convData to ANY because cursor.update expects a Conversation object,
                            // but during migration we might have a slightly different shape or we are modifying it.
                            // In IDB update follows the store structure.
                            // However, typescript thinks cursor.update demands a full Conversation.
                            // Since we are just removing a property from an existing valid object, it is safe to cast.
                            await cursor.update(convData as unknown as Conversation);
                        }
                        cursor = await cursor.continue();
                    }
                } catch (e) {
                    console.error('[DB Migration] Error migrating messages:', e);
                }
            }

            // Migration from v3 to v4: Add messageOrder and regenerationIndex
            if (oldVersion >= 1 && oldVersion < 4) {
                try {
                    console.log(
                        '[DB Migration v3→v4] Assigning messageOrder and regenerationIndex...'
                    );
                    const msgStore = transaction.objectStore('messages');
                    const conversationStore = transaction.objectStore('conversations');

                    // Get all conversations
                    const conversations = await conversationStore.getAll();

                    for (const conversation of conversations) {
                        // Get all messages for this conversation
                        const messages = await msgStore
                            .index('by-conversation')
                            .getAll(conversation.id);

                        // Build tree structure
                        const messageMap = new Map<string, Message>();
                        const rootMessages: Message[] = [];

                        messages.forEach((msg) => {
                            messageMap.set(msg.id, msg);
                            if (!msg.parentId) rootMessages.push(msg);
                        });

                        // Helper to walk tree and assign order/index
                        const walkTree = async (
                            message: Message,
                            depth: number,
                            siblings: Message[]
                        ): Promise<void> => {
                            // Assign messageOrder based on depth
                            const messageOrder = depth + 1;

                            // Find position among siblings to determine regenerationIndex
                            const regenerationIndex = siblings.findIndex(
                                (s) => s.id === message.id
                            );

                            // Update message with new fields
                            const updatedMessage = {
                                ...message,
                                messageOrder,
                                regenerationIndex: regenerationIndex >= 0 ? regenerationIndex : 0,
                            };

                            await msgStore.put(updatedMessage);

                            // Find children
                            const children = messages.filter((m) => m.parentId === message.id);

                            // Group children by their parent (they are siblings)
                            for (const child of children) {
                                const childSiblings = messages.filter(
                                    (m) => m.parentId === child.parentId
                                );
                                await walkTree(child, depth + 1, childSiblings);
                            }
                        };

                        // Process each root message
                        for (const root of rootMessages) {
                            const rootSiblings = messages.filter((m) => !m.parentId);
                            await walkTree(root, 0, rootSiblings);
                        }
                    }

                    console.log('[DB Migration v3→v4] Migration complete');
                } catch (e) {
                    console.error('[DB Migration] Error migrating to v4:', e);
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
        console.log(
            `[DB] Character has lorebook with ${character.character_book.entries.length} entries`
        );
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { messages, ...convData } = conversation as unknown as {
        messages?: unknown;
    } & Conversation;
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
    return (result as { value: unknown } | undefined)?.value as T | undefined;
}

// Utility: Export all data (for backup)
export async function exportAllData(): Promise<{
    characters: CharacterWithMemory[];
    conversations: Conversation[];
    messages: Message[];
    lorebookHistory: LorebookHistoryEntry[];
}> {
    const db = await initDB();
    return {
        characters: await db.getAll('characters'),
        conversations: await db.getAll('conversations'),
        messages: await db.getAll('messages'),
        lorebookHistory: await db.getAll('lorebookHistory'),
    };
}
