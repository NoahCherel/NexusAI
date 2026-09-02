'use client';

/**
 * Conversation import/export (JSON) — extracted verbatim from the chat page. The export
 * bundles the character card subset + latest conversation + messages; the import recreates
 * (or reuses) the character and rebuilds a single-branch conversation.
 */

import type { CharacterCard } from '@/types/character';
import type { DirectedRelationship, Conversation, Message as ChatMessage } from '@/types/chat';
import type { CharacterRef, SceneBeatRecord, SceneTransition, StoryState } from '@/types/scene';
import type { MemorySummary } from '@/types/rag';
import { useChatStore, useCharacterStore } from '@/stores';
import {
    commitStoryStateRevision,
    getConversationMessages as getStoredConversationMessages,
    getSceneBeatsByConversation,
    getStoryStatesByConversation,
    getSummariesByConversation,
    saveSceneBeat,
    saveMessage,
    saveStoryState,
    saveSummary,
} from '@/lib/db';
import { useNotificationStore } from '@/components/ui/api-notification';

/**
 * Re-key an imported Chronicle onto the freshly created conversation.
 *
 * Every summary gets a new id, so `childIds` has to travel through the same old→new table:
 * left as-is it would point at ids that do not exist here, and an Arc would render as though
 * it covered no Sections at all. Children that did not make it into the export are dropped
 * rather than left dangling.
 */
export function remapSummariesForImport(
    summaries: MemorySummary[],
    conversationId: string,
    branchPath: string[]
): MemorySummary[] {
    const idMap = new Map(summaries.map((s) => [s.id, crypto.randomUUID()]));
    return summaries.map((s) => ({
        ...s,
        id: idMap.get(s.id)!,
        conversationId,
        childIds: (s.childIds ?? [])
            .map((childId) => idMap.get(childId))
            .filter((x): x is string => !!x),
        branchPath,
    }));
}

/** In-app toast replacing the old blocking window.alert(). */
function notify(message: string, status: 'success' | 'error' = 'error'): void {
    const { addNotification, updateNotification } = useNotificationStore.getState();
    const id = addNotification(message, 'world');
    updateNotification(id, status, message);
}

/** Export the most recent conversation of a character as a JSON download. */
export async function exportConversationForCharacter(
    character: CharacterCard,
    options: { includeBackstage?: boolean } = {}
): Promise<void> {
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
    const messages = await getStoredConversationMessages(latestConv.id);
    const [storyStates, sceneBeats] = await Promise.all([
        getStoryStatesByConversation(latestConv.id),
        getSceneBeatsByConversation(latestConv.id),
    ]);

    const exportData = {
        character: {
            id: character.id,
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
            // Hand-authored data now: bonds are created in the Relations panel, not
            // regenerated from the cast each beat. Dropping them here loses real user work.
            relationships: latestConv.relationships,
            storyGuidance: latestConv.storyGuidance,
            arc: latestConv.arc,
            rpJournal: latestConv.rpJournal,
            sceneMode: latestConv.sceneMode,
            sceneRoster: latestConv.sceneRoster,
            sceneStyle: latestConv.sceneStyle,
            activeStoryStateRevisionId: latestConv.activeStoryStateRevisionId,
            sceneCharacterOverrides: latestConv.sceneCharacterOverrides,
            // Same reasoning for the Chronicle: it IS the long-term memory (nothing else
            // remembers what left the context window), it can be edited by hand, and
            // rebuilding it costs dozens of background calls.
            summaries: await getSummariesByConversation(latestConv.id),
        },
        messages: messages.map((m) => ({
            id: m.id,
            parentId: m.parentId,
            role: m.role,
            content: m.content,
            thought: m.thought,
            createdAt: m.createdAt,
            isActiveBranch: m.isActiveBranch,
            messageOrder: m.messageOrder,
            regenerationIndex: m.regenerationIndex,
            speaker: m.speaker,
            sceneEnsemble: m.sceneEnsemble,
            sceneBeatId: m.sceneBeatId,
            sceneTurnIndex: m.sceneTurnIndex,
            characterRef: m.characterRef,
            storyStateRevisionId: m.storyStateRevisionId,
        })),
        storyStates,
        // Normal/shareable exports omit private intentions. The explicit complete-backup
        // action preserves them for personal archival and faithful retry restoration.
        sceneBeats: options.includeBackstage
            ? sceneBeats
            : sceneBeats.map((beat) => ({ ...beat, intents: [] })),
        privateBackstageIncluded: !!options.includeBackstage,
        exportedAt: new Date().toISOString(),
    };

    const { exportToJson } = await import('@/lib/export-utils');
    exportToJson(
        exportData,
        `Conversation_${character.name}_${options.includeBackstage ? 'Coulisses_' : ''}${new Date().toISOString().split('T')[0]}`
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
                        `Le personnage « ${data.character.name} » existe déjà. Importer la conversation pour ce personnage ?`
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

            // Create new conversation. The character name seeds the player↔character bond
            // only when the export carries no relationships of its own.
            const chatStore = useChatStore.getState();
            const importedRels = Array.isArray(data.conversation.relationships)
                ? (data.conversation.relationships as DirectedRelationship[])
                : undefined;
            const convId = await chatStore.createConversation(
                characterId,
                data.conversation.title ||
                    `Discussion importée - ${new Date().toLocaleDateString()}`,
                importedRels ? undefined : data.character.name
            );
            if (importedRels) {
                useChatStore.getState().setRelationships(convId, importedRels);
            }
            const importedConversation = data.conversation as Partial<Conversation>;
            if (importedConversation.storyGuidance) {
                useChatStore
                    .getState()
                    .updateStoryGuidance(convId, importedConversation.storyGuidance);
            }
            if (importedConversation.arc) {
                useChatStore.getState().updateArc(convId, importedConversation.arc);
            }
            if (Array.isArray(importedConversation.sceneRoster)) {
                useChatStore.getState().setSceneRoster(convId, importedConversation.sceneRoster);
            }
            if (
                importedConversation.sceneStyle === 'turns' ||
                importedConversation.sceneStyle === 'composed-turns' ||
                importedConversation.sceneStyle === 'unified'
            ) {
                useChatStore.getState().setSceneStyle(convId, importedConversation.sceneStyle);
            }
            if (typeof importedConversation.sceneMode === 'boolean') {
                useChatStore.getState().setSceneMode(convId, importedConversation.sceneMode);
            }

            // Modern exports preserve the complete message tree and active-branch flags.
            // Legacy exports had no parentId, so only those are rebuilt as one linear branch.
            let prevId: string | null = null;
            const messageIds: string[] = data.messages.map(() => crypto.randomUUID());
            const oldMessageIds: string[] = data.messages.map(
                (msg: { id?: string }, index: number) =>
                    typeof msg.id === 'string' ? msg.id : `legacy-message-${index}`
            );
            const messageIdMap = new Map<string, string>(
                oldMessageIds.map((oldId: string, index: number) => [oldId, messageIds[index]])
            );
            const importedStates = Array.isArray(data.storyStates)
                ? (data.storyStates as StoryState[])
                : [];
            const importedBeats = Array.isArray(data.sceneBeats)
                ? (data.sceneBeats as SceneBeatRecord[])
                : [];
            const stateIdMap = new Map<string, string>(
                importedStates.map((state) => [state.id, crypto.randomUUID()])
            );
            const beatIdMap = new Map<string, string>(
                importedBeats.map((beat) => [beat.id, crypto.randomUUID()])
            );
            // The imported root card receives a fresh local id. Keep every structured beat
            // reference aligned with it; otherwise the next beat would see two copies of the
            // same protagonist (`card:old-id` in state, `card:new-id` from resolution).
            const characterRefIdMap = new Map<string, string>();
            if (typeof data.character.id === 'string') {
                characterRefIdMap.set(`card:${data.character.id}`, `card:${characterId}`);
            }
            const remapCharacterRef = (ref: CharacterRef): CharacterRef => {
                if (ref.source !== 'root-card') return ref;
                const id = `card:${characterId}`;
                characterRefIdMap.set(ref.id, id);
                return { ...ref, id, sourceId: characterId };
            };
            for (const state of importedStates) {
                for (const participant of state.scene.participants) {
                    remapCharacterRef(participant.character);
                }
            }
            for (const msg of data.messages) {
                if (msg.characterRef) remapCharacterRef(msg.characterRef as CharacterRef);
            }
            const remapRefId = (id: string | undefined) =>
                id ? (characterRefIdMap.get(id) ?? id) : undefined;
            const remapTransition = (transition: SceneTransition): SceneTransition => ({
                ...transition,
                characterRefId: remapRefId(transition.characterRefId),
            });
            for (const [name, ref] of Object.entries(
                importedConversation.sceneCharacterOverrides ?? {}
            )) {
                useChatStore
                    .getState()
                    .setSceneCharacterOverride(
                        convId,
                        name,
                        remapCharacterRef(ref as CharacterRef)
                    );
            }
            const remapLocks = (locks: StoryState['locks']): StoryState['locks'] =>
                Object.fromEntries(
                    Object.entries(locks).map(([path, enabled]) => {
                        let nextPath = path;
                        for (const [oldId, newId] of characterRefIdMap) {
                            nextPath = nextPath.replace(
                                `/scene/participants/${oldId}/`,
                                `/scene/participants/${newId}/`
                            );
                        }
                        return [nextPath, enabled];
                    })
                );
            for (let i = 0; i < data.messages.length; i++) {
                const msg = data.messages[i];
                const msgId = messageIds[i];
                const importedMessage: ChatMessage = {
                    id: msgId,
                    conversationId: convId,
                    parentId:
                        typeof msg.parentId === 'string'
                            ? (messageIdMap.get(msg.parentId) ?? prevId)
                            : msg.parentId === null
                              ? null
                              : prevId,
                    role: msg.role,
                    content: msg.content,
                    thought: msg.thought,
                    isActiveBranch:
                        typeof msg.isActiveBranch === 'boolean' ? msg.isActiveBranch : true,
                    createdAt: new Date(msg.createdAt || new Date()),
                    messageOrder: typeof msg.messageOrder === 'number' ? msg.messageOrder : i + 1,
                    regenerationIndex:
                        typeof msg.regenerationIndex === 'number' ? msg.regenerationIndex : 0,
                    speaker: msg.speaker,
                    sceneEnsemble: msg.sceneEnsemble,
                    sceneBeatId: msg.sceneBeatId
                        ? (beatIdMap.get(msg.sceneBeatId) ?? msg.sceneBeatId)
                        : undefined,
                    sceneTurnIndex: msg.sceneTurnIndex,
                    characterRef: msg.characterRef
                        ? remapCharacterRef(msg.characterRef as CharacterRef)
                        : undefined,
                    storyStateRevisionId: msg.storyStateRevisionId
                        ? stateIdMap.get(msg.storyStateRevisionId)
                        : undefined,
                };
                await saveMessage(importedMessage);
                prevId = msgId;
            }

            for (const state of importedStates) {
                await saveStoryState({
                    ...state,
                    id: stateIdMap.get(state.id)!,
                    conversationId: convId,
                    parentRevisionId: state.parentRevisionId
                        ? stateIdMap.get(state.parentRevisionId)
                        : undefined,
                    anchorMessageId: state.anchorMessageId
                        ? messageIdMap.get(state.anchorMessageId)
                        : undefined,
                    sourceBeatId: state.sourceBeatId
                        ? beatIdMap.get(state.sourceBeatId)
                        : undefined,
                    scene: {
                        ...state.scene,
                        participants: state.scene.participants.map((participant) => ({
                            ...participant,
                            character: remapCharacterRef(participant.character),
                        })),
                    },
                    knowledge: state.knowledge?.map((fact) => ({
                        ...fact,
                        knownBy: fact.knownBy.map((id) => remapRefId(id) ?? id),
                    })),
                    locks: remapLocks(state.locks),
                });
            }
            for (const beat of importedBeats) {
                await saveSceneBeat({
                    ...beat,
                    id: beatIdMap.get(beat.id)!,
                    conversationId: convId,
                    triggerMessageId: messageIdMap.get(beat.triggerMessageId) ?? messageIds[0],
                    branchTipId: messageIdMap.get(beat.branchTipId) ?? messageIds[0],
                    baseStoryStateRevisionId: beat.baseStoryStateRevisionId
                        ? stateIdMap.get(beat.baseStoryStateRevisionId)
                        : undefined,
                    observedStoryStateRevisionId: beat.observedStoryStateRevisionId
                        ? stateIdMap.get(beat.observedStoryStateRevisionId)
                        : undefined,
                    committedStoryStateRevisionId: beat.committedStoryStateRevisionId
                        ? stateIdMap.get(beat.committedStoryStateRevisionId)
                        : undefined,
                    outputMessageIds: beat.outputMessageIds
                        .map((id) => messageIdMap.get(id))
                        .filter((id): id is string => !!id),
                    decision: beat.decision
                        ? {
                              ...beat.decision,
                              participants: beat.decision.participants.map((participant) => ({
                                  ...participant,
                                  characterRefId:
                                      remapRefId(participant.characterRefId) ??
                                      participant.characterRefId,
                              })),
                              observedTransitions:
                                  beat.decision.observedTransitions.map(remapTransition),
                              plannedTransitions:
                                  beat.decision.plannedTransitions.map(remapTransition),
                          }
                        : undefined,
                    composition: beat.composition
                        ? {
                              ...beat.composition,
                              effects: beat.composition.effects?.map(remapTransition),
                              turns: beat.composition.turns.map((turn) => ({
                                  ...turn,
                                  characterRefId:
                                      remapRefId(turn.characterRefId) ?? turn.characterRefId,
                                  effects: turn.effects?.map(remapTransition),
                              })),
                          }
                        : undefined,
                    intents: data.privateBackstageIncluded
                        ? beat.intents.map((intent) => ({
                              ...intent,
                              characterRefId:
                                  remapRefId(intent.characterRefId) ?? intent.characterRefId,
                          }))
                        : [],
                });
            }

            const importedActiveStateId = importedConversation.activeStoryStateRevisionId
                ? stateIdMap.get(importedConversation.activeStoryStateRevisionId)
                : undefined;
            if (importedActiveStateId) {
                const activeState = importedStates.find(
                    (state) => state.id === importedConversation.activeStoryStateRevisionId
                );
                const anchorMessageId = activeState?.anchorMessageId
                    ? messageIdMap.get(activeState.anchorMessageId)
                    : undefined;
                if (activeState && anchorMessageId) {
                    const restoredState: StoryState = {
                        ...activeState,
                        id: importedActiveStateId,
                        conversationId: convId,
                        parentRevisionId: activeState.parentRevisionId
                            ? stateIdMap.get(activeState.parentRevisionId)
                            : undefined,
                        anchorMessageId,
                        sourceBeatId: activeState.sourceBeatId
                            ? beatIdMap.get(activeState.sourceBeatId)
                            : undefined,
                        scene: {
                            ...activeState.scene,
                            participants: activeState.scene.participants.map((participant) => ({
                                ...participant,
                                character: remapCharacterRef(participant.character),
                            })),
                        },
                        knowledge: activeState.knowledge?.map((fact) => ({
                            ...fact,
                            knownBy: fact.knownBy.map((id) => remapRefId(id) ?? id),
                        })),
                        locks: remapLocks(activeState.locks),
                    };
                    await commitStoryStateRevision(restoredState, anchorMessageId);
                    useChatStore.getState().applyStoryStateRevision({
                        conversationId: convId,
                        messageId: anchorMessageId,
                        storyStateRevisionId: importedActiveStateId,
                        roster: restoredState.scene.participants
                            .filter((participant) => participant.presence !== 'offstage')
                            .map((participant) => participant.character.displayName),
                    });
                }
            }

            // Restore the Chronicle. Every id is minted fresh, so `childIds` must be remapped
            // through the same old→new table or the nesting breaks: an Arc would point at
            // summary ids that no longer exist and render as if it covered nothing.
            const importedSummaries = Array.isArray(data.conversation.summaries)
                ? (data.conversation.summaries as MemorySummary[])
                : [];
            if (importedSummaries.length > 0) {
                // The import rebuilds a single straight branch, so every summary belongs to it.
                let restored = 0;
                for (const s of remapSummariesForImport(importedSummaries, convId, messageIds)) {
                    try {
                        await saveSummary(s);
                        restored++;
                    } catch (err) {
                        console.error('[Import] Failed to restore a summary:', err);
                    }
                }
                console.log(`[Import] Restored ${restored} Chronicle entries`);
            }

            // NOTE: legacy exports may carry a conversation.worldState — deliberately ignored
            // (the scalar world-state system is removed).

            // Switch to the imported conversation
            useChatStore.getState().setActiveConversation(convId);

            notify(
                `Conversation « ${data.conversation.title} » importée (${data.messages.length} messages` +
                    (importedSummaries.length > 0 ? `, ${importedSummaries.length} résumés` : '') +
                    ').',
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
