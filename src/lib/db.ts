import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type {
    CharacterCard,
    Conversation,
    Message,
    LorebookEntry,
    StoryState,
    SceneBeatRecord,
} from '@/types';
import type { MemorySummary } from '@/types/rag';
import type { CanonDossier, ArcOutline } from '@/types/canon';

// Database version - increment when schema changes
const DB_VERSION = 9;
const DB_NAME = 'nexusai-db';

// Lorebook history entry for blockchain-style tracking
export interface LorebookHistoryEntry {
    id: string;
    characterId: string;
    timestamp: number;
    type: 'ai_add' | 'ai_append' | 'ai_merge' | 'user_edit' | 'user_delete' | 'initial';
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
    summaries: {
        key: string;
        value: MemorySummary;
        indexes: { 'by-conversation': string; 'by-level': number };
    };
    canon: {
        key: string; // `${work}::${character}` lowercased
        value: CanonDossier;
        indexes: { 'by-work': string };
    };
    arcOutlines: {
        key: string; // `work` lowercased
        value: ArcOutline;
    };
    storyStates: {
        key: string;
        value: StoryState;
        indexes: { 'by-conversation': string; 'by-anchor': string };
    };
    sceneBeats: {
        key: string;
        value: SceneBeatRecord;
        indexes: { 'by-conversation': string; 'by-trigger': string };
    };
}

let dbInstance: IDBPDatabase<NexusAIDB> | null = null;

// Initialize database
export async function initDB(): Promise<IDBPDatabase<NexusAIDB>> {
    if (dbInstance) return dbInstance;

    dbInstance = await openDB<NexusAIDB>(DB_NAME, DB_VERSION, {
        async upgrade(db, oldVersion, newVersion, transaction) {
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
                try {
                    const convStore = transaction.objectStore('conversations');
                    const msgStore = transaction.objectStore('messages');

                    const curs = await convStore.openCursor();
                    let cursor = curs;

                    while (cursor) {
                        const conv = cursor.value as unknown as {
                            messages?: Message[];
                            id: string;
                        } & Record<string, unknown>;
                        if (conv.messages && Array.isArray(conv.messages)) {
                            for (const msg of conv.messages) {
                                await msgStore.put(msg);
                            }
                            // eslint-disable-next-line @typescript-eslint/no-unused-vars
                            const { messages, ...convData } = conv;
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
                    const msgStore = transaction.objectStore('messages');
                    const conversationStore = transaction.objectStore('conversations');

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

            // Summaries — the Chronicle (v5)
            if (!db.objectStoreNames.contains('summaries')) {
                const sumStore = db.createObjectStore('summaries', { keyPath: 'id' });
                sumStore.createIndex('by-conversation', 'conversationId');
                sumStore.createIndex('by-level', 'level');
            }

            // v8 NO LONGER DROPS ANYTHING.
            //
            // It used to call `deleteObjectStore` on `facts` and `vectors` to reclaim disk.
            // That is not worth the risk: an upgrade callback that throws aborts the whole
            // versionchange transaction, and the app then fails to open the database at all —
            // an empty screen over intact data, indistinguishable from data loss.
            //
            // The two stores are simply left in place, unread and unwritten. They cost disk
            // space and nothing else. Reclaiming that space, if ever wanted, belongs behind an
            // explicit user action with a backup taken first — never in a silent migration
            // that runs the moment someone reloads the page.
            //
            // The version bump itself is kept: IndexedDB cannot open a database at a LOWER
            // version than the one already on disk, so going back to 7 would lock out every
            // client that already reached 8.

            // Canon Codex stores (v6) — additive, no data transform.
            // Out-of-line keys: canon = `${work}::${character}`, arcOutlines = `work`.
            if (!db.objectStoreNames.contains('canon')) {
                const canonStore = db.createObjectStore('canon');
                canonStore.createIndex('by-work', 'work');
            }
            if (!db.objectStoreNames.contains('arcOutlines')) {
                db.createObjectStore('arcOutlines');
            }

            // Directed ensemble mode (v9). Both stores are additive: old conversations are
            // lazily seeded from `sceneRoster` when the mode is first opened, so the upgrade
            // never performs a risky full-database rewrite.
            if (!db.objectStoreNames.contains('storyStates')) {
                const stateStore = db.createObjectStore('storyStates', { keyPath: 'id' });
                stateStore.createIndex('by-conversation', 'conversationId');
                stateStore.createIndex('by-anchor', 'anchorMessageId');
            }
            if (!db.objectStoreNames.contains('sceneBeats')) {
                const beatStore = db.createObjectStore('sceneBeats', { keyPath: 'id' });
                beatStore.createIndex('by-conversation', 'conversationId');
                beatStore.createIndex('by-trigger', 'triggerMessageId');
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
    let cursor = await index.openCursor(IDBKeyRange.only(id));
    while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
    }
    await tx.done;
    // And its Chronicle — these used to survive their conversation forever.
    await deleteSummariesByConversation(id);
    await deleteIndexedConversationRows('storyStates', id);
    await deleteIndexedConversationRows('sceneBeats', id);
}

async function deleteIndexedConversationRows(
    storeName: 'storyStates' | 'sceneBeats',
    conversationId: string
): Promise<void> {
    const db = await initDB();
    const tx = db.transaction(storeName, 'readwrite');
    let cursor = await tx.store.index('by-conversation').openCursor(conversationId);
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

// ============ Directed scene state / beat journal (v9) ============

export async function saveStoryState(state: StoryState): Promise<void> {
    const db = await initDB();
    await db.put('storyStates', state);
}

export async function getStoryState(id: string): Promise<StoryState | undefined> {
    const db = await initDB();
    return db.get('storyStates', id);
}

export async function getStoryStatesByConversation(conversationId: string): Promise<StoryState[]> {
    const db = await initDB();
    return db.getAllFromIndex('storyStates', 'by-conversation', conversationId);
}

export async function saveSceneBeat(beat: SceneBeatRecord): Promise<void> {
    const db = await initDB();
    await db.put('sceneBeats', beat);
}

export async function getSceneBeat(id: string): Promise<SceneBeatRecord | undefined> {
    const db = await initDB();
    return db.get('sceneBeats', id);
}

export async function getSceneBeatsByConversation(
    conversationId: string
): Promise<SceneBeatRecord[]> {
    const db = await initDB();
    return db.getAllFromIndex('sceneBeats', 'by-conversation', conversationId);
}

/**
 * Attach an immutable state revision to its anchor message. Observed user-authored facts use
 * this before composition, so they survive a later reflection/composer failure without
 * exposing any partial assistant output.
 */
export async function commitStoryStateRevision(
    state: StoryState,
    anchorMessageId: string
): Promise<Message | undefined> {
    const db = await initDB();
    const tx = db.transaction(['storyStates', 'messages', 'conversations'], 'readwrite');
    await tx.objectStore('storyStates').put({ ...state, anchorMessageId });
    const message = await tx.objectStore('messages').get(anchorMessageId);
    const updatedMessage = message ? { ...message, storyStateRevisionId: state.id } : undefined;
    if (updatedMessage) await tx.objectStore('messages').put(updatedMessage);
    const conversation = await tx.objectStore('conversations').get(state.conversationId);
    if (conversation) {
        const activeRoster = state.scene.participants
            .filter((participant) => participant.presence !== 'offstage')
            .map((participant) => participant.character.displayName);
        await tx.objectStore('conversations').put({
            ...conversation,
            activeStoryStateRevisionId: state.id,
            sceneRoster: activeRoster,
        });
    }
    await tx.done;
    return updatedMessage;
}

/** All-or-nothing visible beat commit: state, beat journal and transcript share one IDB tx. */
export async function commitSceneBeat(params: {
    beat: SceneBeatRecord;
    storyState: StoryState;
    messages: Message[];
}): Promise<void> {
    const db = await initDB();
    const tx = db.transaction(
        ['sceneBeats', 'storyStates', 'messages', 'conversations'],
        'readwrite'
    );
    try {
        const firstMessage = params.messages[0];
        const existingMessages = await tx
            .objectStore('messages')
            .index('by-conversation')
            .getAll(params.beat.conversationId);
        const newIds = new Set(params.messages.map((message) => message.id));
        const children = new Map<string, Message[]>();
        for (const message of existingMessages) {
            if (!message.parentId) continue;
            const group = children.get(message.parentId) ?? [];
            group.push(message);
            children.set(message.parentId, group);
        }
        const deactivate = new Set<string>();
        const queue = existingMessages
            .filter(
                (message) => message.parentId === firstMessage.parentId && !newIds.has(message.id)
            )
            .map((message) => message.id);
        while (queue.length > 0) {
            const id = queue.pop()!;
            if (deactivate.has(id)) continue;
            deactivate.add(id);
            for (const child of children.get(id) ?? []) queue.push(child.id);
        }
        for (const message of existingMessages) {
            if (deactivate.has(message.id) && message.isActiveBranch) {
                await tx.objectStore('messages').put({ ...message, isActiveBranch: false });
            }
        }
        await tx.objectStore('storyStates').put(params.storyState);
        await tx.objectStore('sceneBeats').put(params.beat);
        for (const message of params.messages) await tx.objectStore('messages').put(message);
        const conversation = await tx.objectStore('conversations').get(params.beat.conversationId);
        if (conversation) {
            const activeRoster = params.storyState.scene.participants
                .filter((p) => p.presence !== 'offstage')
                .map((p) => p.character.displayName);
            await tx.objectStore('conversations').put({
                ...conversation,
                activeStoryStateRevisionId: params.storyState.id,
                sceneRoster: activeRoster,
                updatedAt: new Date(),
            });
        }
        await tx.done;
    } catch (error) {
        // Request errors normally abort IDB transactions automatically. Explicitly abort as
        // well for synchronous structured-clone failures so earlier queued writes cannot commit.
        try {
            tx.abort();
        } catch {
            // Already committed/aborted by IndexedDB.
        }
        try {
            await tx.done;
        } catch {
            // Preserve the original error below.
        }
        throw error;
    }
}

/** A crashed/reloaded tab cannot resume promises; expose a truthful, retryable state. */
export async function markRunningSceneBeatsInterrupted(conversationId?: string): Promise<void> {
    const db = await initDB();
    const beats = conversationId
        ? await db.getAllFromIndex('sceneBeats', 'by-conversation', conversationId)
        : await db.getAll('sceneBeats');
    const running = new Set(['directing', 'reflecting', 'composing', 'validating']);
    if (!beats.some((beat) => running.has(beat.status))) return;
    const tx = db.transaction('sceneBeats', 'readwrite');
    for (const beat of beats) {
        if (!running.has(beat.status)) continue;
        await tx.store.put({
            ...beat,
            status: 'interrupted',
            errors: [
                ...beat.errors,
                {
                    stage: 'commit',
                    message: 'Génération interrompue par le rechargement.',
                    retryable: true,
                },
            ],
            updatedAt: Date.now(),
        });
    }
    await tx.done;
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

// ============ Chronicle (summary) operations ============

/** Upsert — also the update path: read, patch, save back. */
export async function saveSummary(summary: MemorySummary): Promise<void> {
    const db = await initDB();
    await db.put('summaries', summary);
}

export async function deleteSummary(id: string): Promise<void> {
    const db = await initDB();
    await db.delete('summaries', id);
}

export async function getSummariesByConversation(conversationId: string): Promise<MemorySummary[]> {
    const db = await initDB();
    return db.getAllFromIndex('summaries', 'by-conversation', conversationId);
}

export async function deleteSummariesByConversation(conversationId: string): Promise<void> {
    const db = await initDB();
    const tx = db.transaction('summaries', 'readwrite');
    const index = tx.store.index('by-conversation');
    let cursor = await index.openCursor(IDBKeyRange.only(conversationId));
    while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
    }
    await tx.done;
}

// ============ Canon Codex Operations ============

/** Normalize a name fragment for use in storage keys (case-insensitive, trimmed). */
export function canonKey(work: string, character: string): string {
    return `${work.trim().toLowerCase()}::${character.trim().toLowerCase()}`;
}

export async function saveCanonDossier(dossier: CanonDossier): Promise<void> {
    const db = await initDB();
    // Always normalize the `work` field stored in the dossier so the `by-work` index value
    // matches what `getCanonDossiersByWork` queries (which lowercases). Without this the
    // index lookup misses on any work name that has uppercase letters.
    const normalized: CanonDossier = { ...dossier, work: dossier.work.trim().toLowerCase() };
    await db.put('canon', normalized, canonKey(dossier.work, dossier.character));
}

export async function getCanonDossier(
    work: string,
    character: string
): Promise<CanonDossier | undefined> {
    const db = await initDB();
    return db.get('canon', canonKey(work, character));
}

export async function getCanonDossiersByWork(work: string): Promise<CanonDossier[]> {
    const db = await initDB();
    const key = work.trim().toLowerCase();
    const indexed = await db.getAllFromIndex('canon', 'by-work', key);
    if (indexed.length > 0) return indexed;

    // Self-heal: any dossier saved before `saveCanonDossier` normalized `work` will sit in
    // the store with mixed-case `work` and be invisible to the index. Scan all entries,
    // case-insensitively filter, and re-save them normalized so future reads hit the index.
    const all = await db.getAll('canon');
    const recovered = all.filter((d) => d.work.trim().toLowerCase() === key);
    if (recovered.length === 0) return [];
    console.warn(
        `[Canon] Recovered ${recovered.length} dossiers for "${work}" with un-normalized work field. Healing.`
    );
    const tx = db.transaction('canon', 'readwrite');
    for (const d of recovered) {
        await tx.store.put({ ...d, work: key }, canonKey(d.work, d.character));
    }
    await tx.done;
    return recovered.map((d) => ({ ...d, work: key }));
}

export async function deleteCanonDossier(work: string, character: string): Promise<void> {
    const db = await initDB();
    await db.delete('canon', canonKey(work, character));
}

export async function saveArcOutline(outline: ArcOutline): Promise<void> {
    const db = await initDB();
    await db.put('arcOutlines', outline, outline.work.trim().toLowerCase());
}

export async function getArcOutline(work: string): Promise<ArcOutline | undefined> {
    const db = await initDB();
    return db.get('arcOutlines', work.trim().toLowerCase());
}

// Utility: Export all data (for backup)
export async function exportAllData(): Promise<{
    characters: CharacterWithMemory[];
    conversations: Conversation[];
    messages: Message[];
    lorebookHistory: LorebookHistoryEntry[];
    storyStates: StoryState[];
    sceneBeats: SceneBeatRecord[];
}> {
    const db = await initDB();
    return {
        characters: await db.getAll('characters'),
        conversations: await db.getAll('conversations'),
        messages: await db.getAll('messages'),
        lorebookHistory: await db.getAll('lorebookHistory'),
        storyStates: await db.getAll('storyStates'),
        sceneBeats: await db.getAll('sceneBeats'),
    };
}
