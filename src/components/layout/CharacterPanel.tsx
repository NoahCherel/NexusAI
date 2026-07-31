'use client';

import { useState, useEffect, useCallback } from 'react';
import { useCharacterStore } from '@/stores';
import { CharacterCard } from '@/components/character/CharacterCard';
import { CharacterFolder } from '@/components/character/CharacterFolder';
import { CharacterEditor } from '@/components/character/CharacterEditor';
import { CharacterImporter } from '@/components/character/CharacterImporter';
import { buildCharacterGroups } from '@/lib/character-folders';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Search, Plus, Users, Upload, ArrowUpDown, Clock, SortAsc } from 'lucide-react';
import { exportToJson } from '@/lib/export-utils';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { useChatStore } from '@/stores/chat-store';
import { useCharacterFolderDrag } from '@/hooks/useCharacterFolderDrag';
import { getConversationsByCharacter } from '@/lib/db';
import type { CharacterCard as CharacterCardType } from '@/types';
import { exportConversationForCharacter } from '@/lib/conversation-transfer';

interface CharacterPanelProps {
    trigger?: React.ReactNode;
}

export function CharacterPanel({ trigger }: CharacterPanelProps) {
    const [isOpen, setIsOpen] = useState(false);
    const { characters, activeCharacterId, setActiveCharacterId, removeCharacter } =
        useCharacterStore();
    const [searchTerm, setSearchTerm] = useState('');
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [editingCharacter, setEditingCharacter] = useState<CharacterCardType | null>(null);
    const [sortOption, setSortOption] = useState<'name' | 'recent'>('recent');
    const { DragOverlay, draggedCharacterId, isDragging, startCharacterDrag, targetFolder } =
        useCharacterFolderDrag();

    const { getConversationMessages, conversations: allConversations } = useChatStore();

    // Cache of last activity timestamps per character (loaded from DB for all characters)
    const [lastActivityMap, setLastActivityMap] = useState<Record<string, number>>({});

    const loadLastActivities = useCallback(async () => {
        const map: Record<string, number> = {};
        for (const char of characters) {
            try {
                const convs = await getConversationsByCharacter(char.id);
                if (convs.length > 0) {
                    const latest = convs.reduce((best, c) => {
                        const t = new Date(c.updatedAt).getTime();
                        return t > best ? t : best;
                    }, 0);
                    map[char.id] = latest;
                }
            } catch {
                // ignore
            }
        }
        setLastActivityMap(map);
    }, [characters]);

    useEffect(() => {
        if (isOpen) {
            loadLastActivities();
        }
    }, [isOpen, loadLastActivities]);

    // Helper to get last activity time for a character
    const getLastActivity = (characterId: string) => {
        return lastActivityMap[characterId] || 0;
    };

    // Format relative time for display
    const formatLastPlayed = (characterId: string): string | null => {
        const ts = getLastActivity(characterId);
        if (!ts) return null;
        const now = Date.now();
        const diff = now - ts;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        if (minutes < 1) return 'à l’instant';
        if (minutes < 60) return `il y a ${minutes} min`;
        if (hours < 24) return `il y a ${hours} h`;
        if (days < 7) return `il y a ${days} j`;
        return new Date(ts).toLocaleDateString();
    };

    const filteredCharacters = characters.filter(
        (c) =>
            c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.displayName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.folder?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.tags?.some((t) => t.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    const characterGroups = buildCharacterGroups(filteredCharacters, {
        sort: sortOption,
        getActivity: getLastActivity,
    });

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

    const handleSelectCharacter = (id: string) => {
        setActiveCharacterId(id);
        setIsOpen(false);
    };

    const handleExport = async (character: CharacterCardType) => {
        await exportConversationForCharacter(character);
    };

    const defaultTrigger = (
        <Button variant="ghost" size="icon" className="h-9 w-9">
            <Users className="w-5 h-5" />
        </Button>
    );

    return (
        <>
            <Sheet open={isOpen} onOpenChange={setIsOpen}>
                <SheetTrigger asChild>{trigger || defaultTrigger}</SheetTrigger>
                <SheetContent
                    side="left"
                    className="w-[320px] sm:w-[380px] max-w-[90vw] p-0 flex flex-col overflow-x-hidden"
                >
                    <SheetHeader className="p-4 pb-2 border-b border-border/40">
                        <SheetTitle className="flex items-center gap-2">
                            <div className="p-1.5 bg-primary/10 rounded-md">
                                <Users className="w-5 h-5 text-primary" />
                            </div>
                            Personnages
                        </SheetTitle>
                    </SheetHeader>

                    <div className="px-4 py-3 space-y-3">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                placeholder="Rechercher des personnages…"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="pl-9 bg-background/40 border-border/40 h-9"
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
                                        <Upload className="w-4 h-4" /> Importer
                                    </Button>
                                }
                            />
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5 flex-1 h-9 border-primary/20 bg-primary/5 text-primary hover:bg-primary/10"
                                onClick={handleCreateNew}
                            >
                                <Plus className="w-4 h-4" /> Nouveau
                            </Button>
                        </div>
                        <div className="flex justify-end">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
                                    >
                                        <ArrowUpDown className="w-3 h-3" />
                                        Tri : {sortOption === 'recent' ? 'Récents' : 'Nom'}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                    <DropdownMenuLabel>Trier par</DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => setSortOption('name')}>
                                        <SortAsc className="w-4 h-4 mr-2" />
                                        Nom (A-Z)
                                        {sortOption === 'name' && (
                                            <Clock className="w-3 h-3 ml-auto opacity-0" />
                                        )}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => setSortOption('recent')}>
                                        <Clock className="w-4 h-4 mr-2" />
                                        Activité récente
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>

                    <ScrollArea className="flex-1 w-full">
                        <div className="px-4 pb-6 space-y-2 w-full max-w-full">
                            {characterGroups.length === 0 ? (
                                <div className="text-center py-12 px-4">
                                    <p className="text-muted-foreground text-sm">
                                        Aucun personnage trouvé
                                    </p>
                                </div>
                            ) : (
                                characterGroups.map((group) => (
                                    <div
                                        key={group.key}
                                        className="w-full max-w-full overflow-hidden"
                                    >
                                        {group.type === 'folder' ? (
                                            <CharacterFolder
                                                name={group.name}
                                                members={group.members}
                                                activeCharacterId={activeCharacterId}
                                                onSelect={handleSelectCharacter}
                                                onEdit={handleEdit}
                                                onDelete={removeCharacter}
                                                onExport={handleExport}
                                                onCharacterDragStart={startCharacterDrag}
                                                draggedCharacterId={draggedCharacterId}
                                                isDropTargetActive={isDragging}
                                                isDropTargetOver={targetFolder === group.name}
                                                getLastPlayed={formatLastPlayed}
                                            />
                                        ) : (
                                            <CharacterCard
                                                character={group.character}
                                                isActive={group.character.id === activeCharacterId}
                                                onClick={() =>
                                                    handleSelectCharacter(group.character.id)
                                                }
                                                onEdit={() => handleEdit(group.character)}
                                                onDelete={() => removeCharacter(group.character.id)}
                                                onExport={() => handleExport(group.character)}
                                                onDragHandlePointerDown={startCharacterDrag}
                                                isDragging={
                                                    draggedCharacterId === group.character.id
                                                }
                                                isCollapsed={false}
                                                lastPlayed={formatLastPlayed(group.character.id)}
                                            />
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </ScrollArea>
                </SheetContent>
            </Sheet>

            <CharacterEditor
                isOpen={isEditorOpen}
                onClose={handleCloseEditor}
                character={editingCharacter}
            />
            {DragOverlay}
        </>
    );
}
