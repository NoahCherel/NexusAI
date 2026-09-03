import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Conversation, Message, SceneBeatRecord, StoryState } from '@/types';
import {
    commitSceneBeat,
    getConversation,
    getConversationMessages,
    getSceneBeat,
    getStoryState,
    initDB,
    markRunningSceneBeatsInterrupted,
    saveConversation,
    saveMessage,
    saveSceneBeat,
} from '@/lib/db';

function fixture(prefix: string) {
    const conversation: Conversation = {
        id: `${prefix}-conversation`,
        characterId: `${prefix}-character`,
        title: 'Atomic scene test',
        sceneMode: true,
        sceneStyle: 'composed-turns',
        sceneRoster: ['Alice'],
        createdAt: new Date(0),
        updatedAt: new Date(0),
    };
    const trigger: Message = {
        id: `${prefix}-trigger`,
        conversationId: conversation.id,
        parentId: null,
        role: 'user',
        content: 'Alice entre.',
        isActiveBranch: true,
        createdAt: new Date(1),
        messageOrder: 1,
        regenerationIndex: 0,
    };
    const state: StoryState = {
        id: `${prefix}-state`,
        conversationId: conversation.id,
        revision: 1,
        source: 'generated',
        anchorMessageId: `${prefix}-output`,
        scene: {
            participants: [
                {
                    character: {
                        id: 'card:alice',
                        source: 'character-card',
                        sourceId: 'alice',
                        displayName: 'Alice',
                        readiness: 'ready',
                    },
                    presence: 'onstage',
                    agency: 'active',
                },
            ],
        },
        plot: { openThreads: [], nextMoves: [] },
        locks: {},
        createdAt: 1,
    };
    const beat: SceneBeatRecord = {
        id: `${prefix}-beat`,
        conversationId: conversation.id,
        triggerMessageId: trigger.id,
        branchTipId: `${prefix}-output`,
        generationId: `${prefix}-generation`,
        committedStoryStateRevisionId: state.id,
        status: 'committed',
        intents: [],
        outputMessageIds: [`${prefix}-output`],
        errors: [],
        timings: {},
        createdAt: 1,
        updatedAt: 1,
    };
    const output: Message = {
        id: `${prefix}-output`,
        conversationId: conversation.id,
        parentId: trigger.id,
        role: 'assistant',
        content: 'Alice franchit le seuil.',
        isActiveBranch: true,
        createdAt: new Date(2),
        messageOrder: 2,
        regenerationIndex: 0,
        sceneBeatId: beat.id,
        storyStateRevisionId: state.id,
    };
    return { conversation, trigger, state, beat, output };
}

describe('commitSceneBeat atomic IndexedDB transaction', () => {
    it('upgrades an existing v8 database with both directed-scene stores', async () => {
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open('nexusai-db', 8);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                request.result.close();
                resolve();
            };
        });
        const db = await initDB();
        expect(db.objectStoreNames.contains('storyStates')).toBe(true);
        expect(db.objectStoreNames.contains('sceneBeats')).toBe(true);
    });

    it('commits state, beat, bubbles and conversation projection together', async () => {
        const data = fixture(crypto.randomUUID());
        await saveConversation(data.conversation);
        await saveMessage(data.trigger);

        await commitSceneBeat({
            beat: data.beat,
            storyState: data.state,
            messages: [data.output],
        });

        expect(await getSceneBeat(data.beat.id)).toMatchObject({ status: 'committed' });
        expect(await getStoryState(data.state.id)).toMatchObject({ id: data.state.id });
        expect((await getConversationMessages(data.conversation.id)).map((m) => m.id)).toContain(
            data.output.id
        );
        expect(await getConversation(data.conversation.id)).toMatchObject({
            activeStoryStateRevisionId: data.state.id,
            sceneRoster: ['Alice'],
        });
    });

    it('rolls back earlier writes and sibling deactivation after a clone failure', async () => {
        const data = fixture(crypto.randomUUID());
        const previous: Message = {
            ...data.output,
            id: `${data.output.id}-previous`,
            sceneBeatId: undefined,
            storyStateRevisionId: undefined,
        };
        await saveConversation(data.conversation);
        await saveMessage(data.trigger);
        await saveMessage(previous);

        const uncloneable = {
            ...data.output,
            // Functions cannot be structured-cloned by IndexedDB. This fails after the
            // transaction has queued sibling deactivation, state and beat writes.
            content: (() => 'not cloneable') as unknown as string,
        };
        await expect(
            commitSceneBeat({
                beat: data.beat,
                storyState: data.state,
                messages: [uncloneable],
            })
        ).rejects.toBeDefined();

        expect(await getSceneBeat(data.beat.id)).toBeUndefined();
        expect(await getStoryState(data.state.id)).toBeUndefined();
        const messages = await getConversationMessages(data.conversation.id);
        expect(messages.find((message) => message.id === previous.id)?.isActiveBranch).toBe(true);
        expect(messages.some((message) => message.id === data.output.id)).toBe(false);
    });

    it('rejects a stale branch tip without publishing a partial beat', async () => {
        const data = fixture(crypto.randomUUID());
        const newer: Message = {
            ...data.trigger,
            id: `${data.trigger.id}-newer`,
            parentId: data.trigger.id,
            content: 'Une nouvelle action joueur arrive.',
            messageOrder: 2,
        };
        await saveConversation(data.conversation);
        await saveMessage(data.trigger);
        await saveMessage(newer);

        await expect(
            commitSceneBeat({
                beat: data.beat,
                storyState: data.state,
                messages: [data.output],
                expectedBranchTipId: data.trigger.id,
            })
        ).rejects.toMatchObject({ name: 'StaleBeatError' });

        expect(await getSceneBeat(data.beat.id)).toBeUndefined();
        expect(await getStoryState(data.state.id)).toBeUndefined();
        expect(
            (await getConversationMessages(data.conversation.id)).some(
                (message) => message.id === data.output.id
            )
        ).toBe(false);
    });

    it('never writes the Arc Compass: the user and the planner own it', async () => {
        const data = fixture(crypto.randomUUID());
        data.conversation.arc = { currentPosition: 'édition utilisateur' };
        data.state.plot.canonPosition = 'position générée';
        await saveConversation(data.conversation);
        await saveMessage(data.trigger);

        await commitSceneBeat({
            beat: data.beat,
            storyState: data.state,
            messages: [data.output],
            expectedBranchTipId: data.trigger.id,
        });

        expect((await getConversation(data.conversation.id))?.arc?.currentPosition).toBe(
            'édition utilisateur'
        );
    });

    it('accepts a regenerate: the only newer revision sits on the beat being replaced', async () => {
        const data = fixture(crypto.randomUUID());
        await saveConversation(data.conversation);
        await saveMessage(data.trigger);
        await commitSceneBeat({
            beat: data.beat,
            storyState: data.state,
            messages: [{ ...data.output, storyStateRevisionId: data.state.id }],
            expectedBranchTipId: data.trigger.id,
        });
        expect((await getConversation(data.conversation.id))?.activeStoryStateRevisionId).toBe(
            data.state.id
        );

        // The regenerated take starts from the branch BEFORE the discarded beat: no revision.
        const regenState: StoryState = { ...data.state, id: `${data.state.id}-regen` };
        const regenOutput: Message = {
            ...data.output,
            id: `${data.output.id}-regen`,
            storyStateRevisionId: regenState.id,
        };
        await commitSceneBeat({
            beat: {
                ...data.beat,
                id: `${data.beat.id}-regen`,
                committedStoryStateRevisionId: regenState.id,
                outputMessageIds: [regenOutput.id],
            },
            storyState: regenState,
            messages: [regenOutput],
            expectedBranchTipId: data.trigger.id,
            expectedStoryStateRevisionId: undefined,
        });

        const conversation = await getConversation(data.conversation.id);
        expect(conversation?.activeStoryStateRevisionId).toBe(regenState.id);
        const messages = await getConversationMessages(data.conversation.id);
        expect(messages.find((message) => message.id === data.output.id)?.isActiveBranch).toBe(
            false
        );
        expect(messages.find((message) => message.id === regenOutput.id)?.isActiveBranch).toBe(
            true
        );
    });

    it('rejects a commit when the branch itself gained a revision during generation', async () => {
        const data = fixture(crypto.randomUUID());
        await saveConversation(data.conversation);
        await saveMessage({ ...data.trigger, storyStateRevisionId: 'landed-meanwhile' });

        await expect(
            commitSceneBeat({
                beat: data.beat,
                storyState: data.state,
                messages: [data.output],
                expectedBranchTipId: data.trigger.id,
                expectedStoryStateRevisionId: undefined,
            })
        ).rejects.toMatchObject({ name: 'StaleBeatError' });
        expect(await getSceneBeat(data.beat.id)).toBeUndefined();
    });

    it('turns an in-flight beat into a retryable interruption after reload', async () => {
        const data = fixture(crypto.randomUUID());
        await saveSceneBeat({ ...data.beat, status: 'reflecting' });
        await markRunningSceneBeatsInterrupted(data.conversation.id);
        const interrupted = await getSceneBeat(data.beat.id);
        expect(interrupted?.status).toBe('interrupted');
        expect(interrupted?.errors.at(-1)).toMatchObject({ retryable: true, stage: 'commit' });
    });
});
