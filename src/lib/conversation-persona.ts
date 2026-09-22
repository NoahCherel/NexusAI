import type { Conversation, Message } from '@/types/chat';
import type { Persona } from '@/stores/settings-store';

/** Attribution is by stable id only. Missing ids are retained for later recovery. */
export function resolvePersonaId(
    conversation: Conversation | undefined,
    messages: Message[],
    fallback: string | null
): string | null {
    if (conversation?.lastPersonaId === null || typeof conversation?.lastPersonaId === 'string')
        return conversation.lastPersonaId;
    const attributed = messages
        .filter(
            (m) =>
                m.conversationId === conversation?.id &&
                m.role === 'user' &&
                m.speaker?.kind === 'user' &&
                !!m.speaker.personaId
        )
        .sort(
            (a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
                b.messageOrder - a.messageOrder
        )[0];
    return attributed ? attributed.speaker!.personaId! : fallback;
}

export function resolveConversationPersona(
    conversation: Conversation | undefined,
    messages: Message[],
    personas: Persona[],
    fallback: string | null
) {
    const id = resolvePersonaId(conversation, messages, fallback);
    const persona = personas.find((p) => p.id === id);
    return { id, persona, unavailable: !!id && !persona };
}
