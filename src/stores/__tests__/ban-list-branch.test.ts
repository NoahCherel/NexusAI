import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message, Conversation } from '@/types';

// The store imports these from @/lib/db at module load; stub them so the actions can run
// in node without IndexedDB. We assert against the saveMessage spy for persistence.
vi.mock('@/lib/db', () => ({
    saveConversation: vi.fn(() => Promise.resolve()),
    getConversationsByCharacter: vi.fn(() => Promise.resolve([])),
    saveMessage: vi.fn(() => Promise.resolve()),
    getConversationMessages: vi.fn(() => Promise.resolve([])),
    deleteMessagedb: vi.fn(() => Promise.resolve()),
}));

import { useChatStore } from '@/stores/chat-store';
import { saveMessage } from '@/lib/db';

const CONV = 'conv-1';

const msg = (
    id: string,
    parentId: string | null,
    order: number,
    isActiveBranch = true
): Message => ({
    id,
    conversationId: CONV,
    parentId,
    role: id.startsWith('u') ? 'user' : 'assistant',
    content: id,
    isActiveBranch,
    createdAt: new Date(`2026-01-01T00:0${order}:00.000Z`),
    messageOrder: order,
    regenerationIndex: 0,
});

const conversation = (banList?: string[]): Conversation => ({
    id: CONV,
    characterId: 'char-1',
    title: 'Test',
    worldState: { inventory: [], location: '', relationships: {} },
    banList,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

const seed = (messages: Message[], banList?: string[]) =>
    useChatStore.setState({
        conversations: [conversation(banList)],
        messages,
        activeConversationId: CONV,
    });

describe('branch-aware Style Guard ban list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useChatStore.setState({ conversations: [], messages: [], activeConversationId: null });
    });

    it('falls back to conversation.banList when no message carries a snapshot', () => {
        seed([msg('u1', null, 1), msg('a1', 'u1', 2)], ['legacy rule']);
        expect(useChatStore.getState().getActiveBranchBanList(CONV)).toEqual(['legacy rule']);
    });

    it('returns [] when there is neither a snapshot nor a conversation-level list', () => {
        seed([msg('u1', null, 1)]);
        expect(useChatStore.getState().getActiveBranchBanList(CONV)).toEqual([]);
    });

    it('snapshots the ban list onto the active branch tip and reads it back', () => {
        seed([msg('u1', null, 1), msg('a1', 'u1', 2)]);
        useChatStore.getState().setBanList(CONV, ['avoid purple prose']);

        // Persisted onto the leaf message, not the conversation.
        expect(saveMessage).toHaveBeenCalledTimes(1);
        const persisted = vi.mocked(saveMessage).mock.calls[0][0] as Message;
        expect(persisted.id).toBe('a1');
        expect(persisted.banListSnapshot).toEqual(['avoid purple prose']);

        expect(useChatStore.getState().getActiveBranchBanList(CONV)).toEqual(['avoid purple prose']);
    });

    it('keeps one branch’s rules out of a sibling branch', () => {
        // u1 -> a1 (branch A), u1 -> a2 (branch B). Start on A.
        seed([
            msg('u1', null, 1),
            msg('a1', 'u1', 2, true),
            msg('a2', 'u1', 2, false),
        ]);
        useChatStore.getState().setBanList(CONV, ['rule from A']);
        expect(useChatStore.getState().getActiveBranchBanList(CONV)).toEqual(['rule from A']);

        // Switch the active branch to the sibling (simulating navigateToSibling).
        useChatStore.setState((s) => ({
            messages: s.messages.map((m) => {
                if (m.id === 'a1') return { ...m, isActiveBranch: false };
                if (m.id === 'a2') return { ...m, isActiveBranch: true };
                return m;
            }),
        }));

        // Branch B never received the snapshot — it must not inherit A's rule.
        expect(useChatStore.getState().getActiveBranchBanList(CONV)).toEqual([]);
    });

    it('inherits a parent snapshot on a freshly appended (snapshot-less) tip', () => {
        seed([msg('u1', null, 1), msg('a1', 'u1', 2)]);
        useChatStore.getState().setBanList(CONV, ['inherited rule']);

        // A new turn arrives with no snapshot of its own.
        useChatStore.setState((s) => ({ messages: [...s.messages, msg('u2', 'a1', 3)] }));

        expect(useChatStore.getState().getActiveBranchBanList(CONV)).toEqual(['inherited rule']);
    });
});
