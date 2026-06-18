'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useCharacterStore } from '@/stores';
import type { CharacterCard } from '@/types';
import { cn } from '@/lib/utils';

type DraggableCharacter = Pick<CharacterCard, 'id' | 'name' | 'displayName' | 'avatar' | 'folder'>;

interface DragState {
    character: DraggableCharacter;
    x: number;
    y: number;
    targetFolder: string | null;
}

function getFolderAtPoint(x: number, y: number) {
    const element = document.elementFromPoint(x, y);
    return (
        element
            ?.closest<HTMLElement>('[data-character-folder-drop-target]')
            ?.getAttribute('data-character-folder-drop-target') || null
    );
}

function initials(character: DraggableCharacter) {
    return (character.displayName || character.name).slice(0, 2).toUpperCase();
}

export function useCharacterFolderDrag() {
    const updateCharacter = useCharacterStore((state) => state.updateCharacter);
    const [dragState, setDragState] = useState<DragState | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const previousUserSelect = useRef<string>('');
    const portalRoot = typeof document === 'undefined' ? null : document.body;

    const finishDrag = useCallback(
        async (shouldCommit: boolean) => {
            const drag = dragRef.current;
            if (!drag) return;

            dragRef.current = null;
            setDragState(null);
            document.body.style.userSelect = previousUserSelect.current;

            const nextFolder = drag.targetFolder?.trim();
            if (!shouldCommit || !nextFolder || nextFolder === drag.character.folder) return;

            await updateCharacter(drag.character.id, { folder: nextFolder });
        },
        [updateCharacter]
    );

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;

            event.preventDefault();
            const targetFolder = getFolderAtPoint(event.clientX, event.clientY);
            const nextDrag = {
                ...drag,
                x: event.clientX,
                y: event.clientY,
                targetFolder,
            };
            dragRef.current = nextDrag;
            setDragState(nextDrag);
        };

        const handlePointerUp = () => void finishDrag(true);
        const handlePointerCancel = () => void finishDrag(false);

        window.addEventListener('pointermove', handlePointerMove, { passive: false });
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerCancel);

        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerCancel);
        };
    }, [finishDrag]);

    const startCharacterDrag = useCallback(
        (character: DraggableCharacter, event: React.PointerEvent<HTMLElement>) => {
            if (event.button !== 0 && event.pointerType === 'mouse') return;

            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture?.(event.pointerId);

            previousUserSelect.current = document.body.style.userSelect;
            document.body.style.userSelect = 'none';

            const targetFolder = getFolderAtPoint(event.clientX, event.clientY);
            const nextDrag = {
                character,
                x: event.clientX,
                y: event.clientY,
                targetFolder,
            };

            dragRef.current = nextDrag;
            setDragState(nextDrag);
        },
        []
    );

    const isDragging = Boolean(dragState);
    const draggedCharacterId = dragState?.character.id ?? null;
    const targetFolder = dragState?.targetFolder ?? null;

    const DragOverlay =
        dragState && portalRoot
            ? createPortal(
                  <div
                      className="pointer-events-none fixed z-[100] flex max-w-[220px] items-center gap-2 rounded-lg border border-primary/40 bg-background/95 px-3 py-2 shadow-xl backdrop-blur-md"
                      style={{
                          left: dragState.x,
                          top: dragState.y,
                          transform: 'translate3d(12px, 12px, 0)',
                      }}
                  >
                      <Avatar className="h-8 w-8 rounded-md border border-border/50">
                          <AvatarImage
                              src={dragState.character.avatar}
                              alt={dragState.character.name}
                              className="object-cover"
                          />
                          <AvatarFallback className="rounded-md bg-muted text-[10px] font-bold">
                              {initials(dragState.character)}
                          </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                          <p className="truncate text-xs font-semibold">
                              {dragState.character.displayName || dragState.character.name}
                          </p>
                          <p
                              className={cn(
                                  'flex items-center gap-1 truncate text-[10px]',
                                  dragState.targetFolder &&
                                      dragState.targetFolder !== dragState.character.folder
                                      ? 'text-primary'
                                      : 'text-muted-foreground'
                              )}
                          >
                              <Folder className="h-3 w-3 shrink-0" />
                              {dragState.targetFolder || 'Choose a folder'}
                          </p>
                      </div>
                  </div>,
                  portalRoot
              )
            : null;

    return {
        DragOverlay,
        draggedCharacterId,
        isDragging,
        startCharacterDrag,
        targetFolder,
    };
}
