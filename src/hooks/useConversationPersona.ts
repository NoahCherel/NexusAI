'use client';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { resolveConversationPersona } from '@/lib/conversation-persona';

export function useConversationPersona() {
    const { conversations, activeConversationId, messages } = useChatStore();
    const { personas, activePersonaId } = useSettingsStore();
    return resolveConversationPersona(
        conversations.find((c) => c.id === activeConversationId),
        messages,
        personas,
        activePersonaId
    );
}

export function getConversationPersona(conversationId: string | null) {
    const chat = useChatStore.getState();
    const settings = useSettingsStore.getState();
    const conversation = chat.conversations.find((c) => c.id === conversationId);
    if (conversationId && !conversation)
        return { id: null, persona: undefined, unavailable: false };
    return resolveConversationPersona(
        conversation,
        chat.messages,
        settings.personas,
        settings.activePersonaId
    );
}
