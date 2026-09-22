import type { CharacterCard, Message } from '@/types';
import { useChatStore } from '@/stores/chat-store';
import { saveMessage } from '@/lib/db';

export async function startConversation(character: CharacterCard): Promise<string> {
    const store = useChatStore.getState();
    const id = await store.createConversation(
        character.id,
        `Discussion avec ${character.name}`,
        character.name
    );
    const base = Date.now();
    const greetings = character.first_mes
        ? [character.first_mes, ...(character.alternate_greetings || []).filter((g) => g?.trim())]
        : [];
    await Promise.all(
        greetings.map((content, i) =>
            saveMessage({
                id: crypto.randomUUID(),
                conversationId: id,
                parentId: null,
                role: 'assistant',
                content,
                isActiveBranch: i === 0,
                createdAt: new Date(base + i),
                messageOrder: 1,
                regenerationIndex: i,
            } satisfies Message)
        )
    );
    if (useChatStore.getState().activeConversationId === id) await store.loadMessages(id);
    return id;
}
