import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import { saveCharacter, saveStoryState } from '@/lib/db';
import {
    AmbiguousCharacterError,
    createInitialStoryState,
    getStoryStateForBranch,
    resolveSceneCharacters,
} from '@/lib/ai/story-state';

const character = (id: string, name: string, description: string): CharacterCard => ({
    id,
    name,
    description,
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
});

describe('stable scene character resolution', () => {
    it('requires an explicit choice for duplicate card names and reuses that choice', async () => {
        const suffix = crypto.randomUUID();
        const name = `Alex ${suffix}`;
        const first = character(`alex-first-${suffix}`, name, 'Premier profil');
        const second = character(`alex-second-${suffix}`, name, 'Second profil');
        const root = character(`root-${suffix}`, `Root ${suffix}`, 'Carte principale');
        await Promise.all([
            saveCharacter({ ...first, longTermMemory: [] }),
            saveCharacter({ ...second, longTermMemory: [] }),
        ]);

        let ambiguity: AmbiguousCharacterError | undefined;
        try {
            await resolveSceneCharacters([name], root);
        } catch (error) {
            if (error instanceof AmbiguousCharacterError) ambiguity = error;
        }
        expect(ambiguity?.characterName).toBe(name);
        expect(ambiguity?.candidates).toHaveLength(2);

        const selected = ambiguity!.candidates.find(
            (candidate) => candidate.sourceId === second.id
        )!;
        const resolved = await resolveSceneCharacters([name], root, {
            [name.toLocaleLowerCase()]: selected,
        });
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            description: 'Second profil',
            ref: { sourceId: second.id },
        });
    });

    it('migrates the legacy roster and arc cursor into the first immutable story state', () => {
        const suffix = crypto.randomUUID();
        const root = character(`root-migration-${suffix}`, 'Alice', 'Carte principale');
        const conversation: Conversation = {
            id: `conversation-migration-${suffix}`,
            characterId: root.id,
            title: 'Migration',
            sceneRoster: ['Alice'],
            arc: {
                work: 'Œuvre test',
                currentPosition: 'Chapitre 3',
                nextBeat: 'La confrontation',
            },
            createdAt: new Date(0),
            updatedAt: new Date(0),
        };
        const profile = {
            ref: {
                id: `card:${root.id}`,
                source: 'root-card' as const,
                sourceId: root.id,
                displayName: 'Alice',
                readiness: 'ready' as const,
            },
            description: root.description,
        };
        const state = createInitialStoryState({
            conversation,
            profiles: [profile],
            anchorMessageId: 'legacy-tip',
        });
        expect(state).toMatchObject({
            revision: 1,
            source: 'migration',
            anchorMessageId: 'legacy-tip',
            scene: { participants: [{ presence: 'onstage', agency: 'active' }] },
            plot: {
                arcWork: 'Œuvre test',
                currentBeat: 'Chapitre 3',
                objective: 'La confrontation',
            },
        });
    });

    it('restores the nearest story revision from the selected branch', async () => {
        const suffix = crypto.randomUUID();
        const root = character(`root-branch-${suffix}`, 'Alice', 'Carte principale');
        const conversation: Conversation = {
            id: `conversation-branch-${suffix}`,
            characterId: root.id,
            title: 'Branches',
            activeStoryStateRevisionId: `state-right-${suffix}`,
            createdAt: new Date(0),
            updatedAt: new Date(0),
        };
        const profile = {
            ref: {
                id: `card:${root.id}`,
                source: 'root-card' as const,
                sourceId: root.id,
                displayName: 'Alice',
                readiness: 'ready' as const,
            },
            description: root.description,
        };
        const base = createInitialStoryState({ conversation, profiles: [profile] });
        const left = {
            ...base,
            id: `state-left-${suffix}`,
            scene: { ...base.scene, location: 'Porte gauche' },
        };
        const right = {
            ...base,
            id: `state-right-${suffix}`,
            scene: { ...base.scene, location: 'Porte droite' },
        };
        await Promise.all([saveStoryState(left), saveStoryState(right)]);
        const message = (id: string, storyStateRevisionId: string): Message => ({
            id,
            conversationId: conversation.id,
            parentId: null,
            role: 'user',
            content: id,
            isActiveBranch: true,
            createdAt: new Date(0),
            messageOrder: 1,
            regenerationIndex: 0,
            storyStateRevisionId,
        });

        await expect(
            getStoryStateForBranch(conversation, [message('left-tip', left.id)])
        ).resolves.toMatchObject({ id: left.id, scene: { location: 'Porte gauche' } });
        await expect(
            getStoryStateForBranch(conversation, [message('right-tip', right.id)])
        ).resolves.toMatchObject({ id: right.id, scene: { location: 'Porte droite' } });
    });
});
