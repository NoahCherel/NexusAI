'use client';

/**
 * Conversation import/export (JSON) — extracted verbatim from the chat page. The export
 * bundles the character card subset + latest conversation + messages; the import recreates
 * (or reuses) the character and rebuilds a single-branch conversation.
 */

import type { CharacterCard } from '@/types/character';
import { useChatStore, useCharacterStore } from '@/stores';
import { useNotificationStore } from '@/components/ui/api-notification';

/** In-app toast replacing the old blocking window.alert(). */
function notify(message: string, status: 'success' | 'error' = 'error'): void {
    const { addNotification, updateNotification } = useNotificationStore.getState();
    const id = addNotification(message, 'world');
    updateNotification(id, status, message);
}

/** Export the most recent conversation of a character as a JSON download. */
export async function exportConversationForCharacter(character: CharacterCard): Promise<void> {
    const conversations = useChatStore.getState().conversations;

    // Find most recent conversation for this character
    const charConvs = conversations
        .filter((c) => c.characterId === character.id)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    if (charConvs.length === 0) {
        notify('Aucune conversation à exporter pour ce personnage.');
        return;
    }

    const latestConv = charConvs[0];
    const messages = await useChatStore.getState().getConversationMessages(latestConv.id);

    const exportData = {
        character: {
            name: character.name,
            description: character.description,
            personality: character.personality,
            scenario: character.scenario,
            first_mes: character.first_mes,
            mes_example: character.mes_example,
        },
        conversation: {
            title: latestConv.title,
            createdAt: latestConv.createdAt,
            updatedAt: latestConv.updatedAt,
            worldState: latestConv.worldState,
        },
        messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
            thought: m.thought,
            createdAt: m.createdAt,
            isActiveBranch: m.isActiveBranch,
        })),
        exportedAt: new Date().toISOString(),
    };

    const { exportToJson } = await import('@/lib/export-utils');
    exportToJson(
        exportData,
        `Conversation_${character.name}_${new Date().toISOString().split('T')[0]}`
    );
}

/** Open a file picker and import a previously exported conversation JSON. */
export function importConversationFromFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';

    input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            // Validate structure
            if (!data.character || !data.conversation || !Array.isArray(data.messages)) {
                notify("Format d'export de conversation invalide.");
                return;
            }

            // Check if character already exists by name
            const existingChar = useCharacterStore
                .getState()
                .characters.find((c) => c.name === data.character.name);

            let characterId: string;

            if (existingChar) {
                // Use existing character
                characterId = existingChar.id;
                if (
                    !confirm(
                        `Character "${data.character.name}" already exists. Import conversation for this character?`
                    )
                ) {
                    return;
                }
            } else {
                // Create new character from imported data
                characterId = crypto.randomUUID();
                const newCharacter = {
                    id: characterId,
                    name: data.character.name,
                    description: data.character.description || '',
                    personality: data.character.personality || '',
                    scenario: data.character.scenario || '',
                    first_mes: data.character.first_mes || '',
                    mes_example: data.character.mes_example || '',
                    createdAt: new Date(),
                };
                await useCharacterStore.getState().addCharacter(newCharacter);
            }

            // Create new conversation
            const chatStore = useChatStore.getState();
            const convId = await chatStore.createConversation(
                characterId,
                data.conversation.title || `Imported Chat - ${new Date().toLocaleDateString()}`
            );

            // Import messages as ONE chained branch. parentId must link each message to
            // the previous one: with every message at the root, they'd all be siblings —
            // addMessage deactivates prior sibling branches, leaving only the last message
            // visible (and root messages are swipable greeting alternates).
            let prevId: string | null = null;
            for (let i = 0; i < data.messages.length; i++) {
                const msg = data.messages[i];
                const msgId = crypto.randomUUID();
                useChatStore.getState().addMessage({
                    id: msgId,
                    conversationId: convId,
                    parentId: prevId,
                    role: msg.role,
                    content: msg.content,
                    thought: msg.thought,
                    isActiveBranch: true,
                    createdAt: new Date(msg.createdAt || new Date()),
                    messageOrder: i + 1,
                    regenerationIndex: 0,
                });
                prevId = msgId;
            }

            // Update world state if present
            if (data.conversation.worldState) {
                useChatStore.getState().updateWorldState(convId, data.conversation.worldState);
            }

            // Switch to the imported conversation
            useChatStore.getState().setActiveConversation(convId);

            notify(
                `Conversation « ${data.conversation.title} » importée (${data.messages.length} messages).`,
                'success'
            );
        } catch (error) {
            console.error('Import error:', error);
            notify(
                `Import de conversation échoué : ${error instanceof Error ? error.message : 'erreur inconnue'}`
            );
        }
    };

    input.click();
}
