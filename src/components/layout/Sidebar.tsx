'use client';

import { useEffect, useState } from 'react';
import { useCharacterStore } from '@/stores';
import { CharacterCard } from '@/components/character/CharacterCard';
import { CharacterFolder } from '@/components/character/CharacterFolder';
import { CharacterEditor } from '@/components/character/CharacterEditor';
import { buildCharacterGroups } from '@/lib/character-folders';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Search, Plus, PanelLeftClose, PanelLeftOpen, Users, Upload } from 'lucide-react';

import { CharacterImporter } from '@/components/character/CharacterImporter';
import { cn } from '@/lib/utils';
import { useCharacterFolderDrag } from '@/hooks/useCharacterFolderDrag';
import type { CharacterCard as CharacterCardType } from '@/types';
import { exportConversationForCharacter } from '@/lib/conversation-transfer';
import { searchConversations, type ConversationSearchHit } from '@/lib/conversation-search';
import { useChatStore } from '@/stores/chat-store';

interface SidebarProps {
    isCollapsed: boolean;
    onToggle: () => void;
    onSettingsClick: () => void;
}

export function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
    const { characters, activeCharacterId, setActiveCharacterId, removeCharacter } =
        useCharacterStore();
    const [searchTerm, setSearchTerm] = useState('');
    // Debounced full-text search across conversation titles + message contents.
    const [conversationHits, setConversationHits] = useState<ConversationSearchHit[]>([]);
    useEffect(() => {
        let cancelled = false;
        const t = setTimeout(() => {
            if (searchTerm.trim().length < 3) {
                if (!cancelled) setConversationHits([]);
                return;
            }
            searchConversations(searchTerm)
                .then((hits) => {
                    if (!cancelled) setConversationHits(hits);
                })
                .catch(() => {});
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(t);
        };
    }, [searchTerm]);
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [editingCharacter, setEditingCharacter] = useState<CharacterCardType | null>(null);
    const { DragOverlay, draggedCharacterId, isDragging, startCharacterDrag, targetFolder } =
        useCharacterFolderDrag();

    const filteredCharacters = characters.filter(
        (c) =>
            c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.displayName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.folder?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.tags?.some((t) => t.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    const characterGroups = buildCharacterGroups(filteredCharacters, { sort: 'name' });

    const handleEdit = (character: CharacterCardType) => {
        setEditingCharacter(character);
        setIsEditorOpen(true);
    };

    const handleCreateNew = () => {
        setEditingCharacter(null);
        setIsEditorOpen(true);
    };

    const handleCloseEditor = () => {
        setIsEditorOpen(false);
        setEditingCharacter(null);
    };

    const handleExport = async (character: CharacterCardType) => {
        await exportConversationForCharacter(character);
    };

    return (
        <>
            <div
                className={cn(
                    'relative h-full bg-card/60 backdrop-blur-lg border-r border-border/40 flex flex-col transition-all duration-300 ease-in-out',
                    isCollapsed ? 'w-20' : 'w-80'
                )}
            >
                {/* Header */}
                <div
                    className={cn(
                        'p-4 flex items-center h-16',
                        isCollapsed ? 'justify-center' : 'justify-between'
                    )}
                >
                    {!isCollapsed && (
                        <div className="flex items-center gap-2">
                            <div className="p-1.5 bg-primary/10 rounded-md">
                                <Users className="w-5 h-5 text-primary" />
                            </div>
                            <span className="font-bold text-lg tracking-tight">NexusAI</span>
                        </div>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onToggle}
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    >
                        {isCollapsed ? (
                            <PanelLeftOpen className="w-4 h-4" />
                        ) : (
                            <PanelLeftClose className="w-4 h-4" />
                        )}
                    </Button>
                </div>

                {/* Search & Actions */}
                {!isCollapsed ? (
                    <div className="px-4 pb-4 space-y-3">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                placeholder="Filter characters..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="pl-9 bg-background/40 border-border/40 focus-visible:ring-primary/20 backdrop-blur-sm h-9"
                            />
                        </div>
                        <div className="flex gap-2">
                            <CharacterImporter
                                trigger={
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-1.5 flex-1 h-9 border-primary/20 bg-primary/5 text-primary hover:bg-primary/10"
                                    >
                                        <Upload className="w-4 h-4" /> Import
                                    </Button>
                                }
                            />
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5 flex-1 h-9 border-primary/20 bg-primary/5 text-primary hover:bg-primary/10"
                                onClick={handleCreateNew}
                            >
                                <Plus className="w-4 h-4" /> New
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="px-2 pb-4 flex flex-col items-center gap-2">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 text-muted-foreground hover:bg-primary/5"
                        >
                            <Search className="w-4 h-4" />
                        </Button>
                        <div className="w-8 h-px bg-border/40 my-1" />
                        <CharacterImporter isCollapsed={true} />
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 text-muted-foreground hover:bg-primary/5"
                            onClick={handleCreateNew}
                        >
                            <Plus className="w-4 h-4" />
                        </Button>
                    </div>
                )}

                <Separator className="bg-border/40" />

                {/* List */}
                <div className="flex-1 min-h-0 overflow-hidden">
                    <ScrollArea className="h-full w-full">
                        {/* Full-text hits in conversations (titles + messages) */}
                        {!isCollapsed && conversationHits.length > 0 && (
                            <div className="px-4 pt-4 space-y-1.5">
                                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                                    Conversations
                                </p>
                                {conversationHits.map((hit) => (
                                    <button
                                        key={hit.conversationId}
                                        className="w-full text-left p-2 rounded-lg border border-border/40 bg-card/40 hover:bg-card/80 transition-colors"
                                        onClick={() => {
                                            setActiveCharacterId(hit.characterId);
                                            useChatStore
                                                .getState()
                                                .setActiveConversation(hit.conversationId);
                                        }}
                                    >
                                        <p className="text-xs font-medium truncate">
                                            {hit.title}
                                            <span className="text-muted-foreground font-normal">
                                                {' '}
                                                · {hit.matchCount} match
                                                {hit.matchCount > 1 ? 's' : ''}
                                            </span>
                                        </p>
                                        <p className="text-[11px] text-muted-foreground line-clamp-2">
                                            {hit.snippet}
                                        </p>
                                    </button>
                                ))}
                            </div>
                        )}
                        <div
                            className={cn(
                                'space-y-3 pb-10 transition-all duration-300 w-full',
                                isCollapsed ? 'px-2 pt-4' : 'px-4 pt-4'
                            )}
                        >
                            {characterGroups.length === 0
                                ? !isCollapsed && (
                                      <div className="text-center py-12 px-4">
                                          <p className="text-muted-foreground text-sm">
                                              No characters found
                                          </p>
                                      </div>
                                  )
                                : characterGroups.map((group) => (
                                      <div
                                          key={group.key}
                                          className="w-full max-w-full overflow-hidden"
                                      >
                                          {group.type === 'folder' ? (
                                              <CharacterFolder
                                                  name={group.name}
                                                  members={group.members}
                                                  activeCharacterId={activeCharacterId}
                                                  onSelect={setActiveCharacterId}
                                                  onEdit={handleEdit}
                                                  onDelete={removeCharacter}
                                                  onExport={handleExport}
                                                  onCharacterDragStart={startCharacterDrag}
                                                  draggedCharacterId={draggedCharacterId}
                                                  isDropTargetActive={isDragging}
                                                  isDropTargetOver={targetFolder === group.name}
                                                  isCollapsed={isCollapsed}
                                              />
                                          ) : (
                                              <CharacterCard
                                                  character={group.character}
                                                  isActive={
                                                      group.character.id === activeCharacterId
                                                  }
                                                  onClick={() =>
                                                      setActiveCharacterId(group.character.id)
                                                  }
                                                  onEdit={() => handleEdit(group.character)}
                                                  onDelete={() =>
                                                      removeCharacter(group.character.id)
                                                  }
                                                  onExport={() => handleExport(group.character)}
                                                  onDragHandlePointerDown={
                                                      isCollapsed ? undefined : startCharacterDrag
                                                  }
                                                  isDragging={
                                                      draggedCharacterId === group.character.id
                                                  }
                                                  isCollapsed={isCollapsed}
                                              />
                                          )}
                                      </div>
                                  ))}
                        </div>
                    </ScrollArea>
                </div>
            </div>

            {/* Character Editor Dialog */}
            <CharacterEditor
                isOpen={isEditorOpen}
                onClose={handleCloseEditor}
                character={editingCharacter}
            />
            {DragOverlay}
        </>
    );
}
