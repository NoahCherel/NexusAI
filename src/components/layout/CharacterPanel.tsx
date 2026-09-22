'use client';

import { startConversation } from '@/lib/start-conversation';
import { useState, useEffect, useCallback } from 'react';
import { useCharacterStore } from '@/stores';
import { CharacterCard } from '@/components/character/CharacterCard';
import { CharacterFolder } from '@/components/character/CharacterFolder';
import { CharacterEditor } from '@/components/character/CharacterEditor';
import { CharacterImporter } from '@/components/character/CharacterImporter';
import { buildCharacterGroups } from '@/lib/character-folders';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Search, Plus, Users, Upload, ArrowUpDown, Clock, SortAsc } from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { useCharacterFolderDrag } from '@/hooks/useCharacterFolderDrag';
import { getAllConversations } from '@/lib/db';
import type { CharacterCard as CharacterCardType } from '@/types';
import { exportConversationForCharacter } from '@/lib/conversation-transfer';

interface CharacterPanelProps {
    trigger?: React.ReactNode;
    embedded?: boolean;
    onSelected?: (id: string, createNew?: boolean) => void;
}

export function CharacterPanel({ trigger, embedded = false, onSelected }: CharacterPanelProps) {
    const [isOpen, setIsOpen] = useState(embedded);
    const [limit, setLimit] = useState(50);
    const [deleteId, setDeleteId] = useState<string | null>(null);
    const Content = embedded ? 'section' : SheetContent;
    const { characters, activeCharacterId, setActiveCharacterId, removeCharacter } =
        useCharacterStore();
    const [searchTerm, setSearchTerm] = useState('');
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [editingCharacter, setEditingCharacter] = useState<CharacterCardType | null>(null);
    const [sortOption, setSortOption] = useState<'name' | 'recent'>('recent');
    const { DragOverlay, draggedCharacterId, isDragging, startCharacterDrag, targetFolder } =
        useCharacterFolderDrag();

    // Cache of last activity timestamps per character (loaded from DB for all characters)
    const [lastActivityMap, setLastActivityMap] = useState<Record<string, number>>({});
    const [relativeTimeNow, setRelativeTimeNow] = useState(0);

    const loadLastActivities = useCallback(async () => {
        const map: Record<string, number> = {};
        try {
            const rows = await getAllConversations();
            for (const row of rows)
                map[row.characterId] = Math.max(
                    map[row.characterId] || 0,
                    +new Date(row.updatedAt)
                );
        } catch {
            /* The character library remains usable if activity metadata is unavailable. */
        }
        setLastActivityMap(map);
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        const timer = window.setTimeout(() => {
            setRelativeTimeNow(Date.now());
            void loadLastActivities();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [isOpen, loadLastActivities]);

    // Helper to get last activity time for a character
    const getLastActivity = (characterId: string) => {
        return lastActivityMap[characterId] || 0;
    };

    // Format relative time for display
    const formatLastPlayed = (characterId: string): string | null => {
        const ts = getLastActivity(characterId);
        if (!ts) return null;
        const diff = relativeTimeNow - ts;
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
        if (onSelected) onSelected(id);
        else setActiveCharacterId(id);
        setIsOpen(false);
    };

    const handleNewDiscussion = async (card: CharacterCardType) => {
        if (onSelected) onSelected(card.id, true);
        else {
            await startConversation(card);
            setActiveCharacterId(card.id);
            setIsOpen(false);
        }
    };
    const handleExport = async (character: CharacterCardType) => {
        await exportConversationForCharacter(character);
    };

    const handleExportBackstage = async (character: CharacterCardType) => {
        await exportConversationForCharacter(character, { includeBackstage: true });
    };

    const defaultTrigger = (
        <Button variant="ghost" size="icon" className="h-9 w-9">
            <Users className="w-5 h-5" />
        </Button>
    );

    return (
        <>
            <Sheet
                open={isOpen}
                onOpenChange={(open) => {
                    setIsOpen(open);
                    if (open) setRelativeTimeNow(Date.now());
                }}
            >
                {!embedded && <SheetTrigger asChild>{trigger || defaultTrigger}</SheetTrigger>}
                <Content
                    {...(!embedded ? { side: 'left' as const } : {})}
                    className={
                        embedded
                            ? 'h-full w-full min-h-0 flex flex-col overflow-hidden'
                            : 'w-[320px] sm:w-[380px] max-w-[90vw] p-0 flex flex-col overflow-x-hidden'
                    }
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

                    <ScrollArea className="character-scroll flex-1 w-full min-w-0">
                        <div className="px-4 pb-6 space-y-2 w-full max-w-full">
                            {characterGroups.length === 0 ? (
                                <div className="text-center py-12 px-4">
                                    <p className="text-muted-foreground text-sm">
                                        Aucun personnage trouvé
                                    </p>
                                </div>
                            ) : (
                                characterGroups.slice(0, limit).map((group) => (
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
                                                onNewDiscussion={handleNewDiscussion}
                                                onEdit={handleEdit}
                                                onDelete={setDeleteId}
                                                onExport={handleExport}
                                                onExportBackstage={handleExportBackstage}
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
                                                onNewDiscussion={() =>
                                                    void handleNewDiscussion(group.character)
                                                }
                                                onEdit={() => handleEdit(group.character)}
                                                onDelete={() => setDeleteId(group.character.id)}
                                                onExport={() => handleExport(group.character)}
                                                onExportBackstage={() =>
                                                    handleExportBackstage(group.character)
                                                }
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
                    {characterGroups.length > limit && (
                        <Button variant="outline" onClick={() => setLimit((n) => n + 50)}>
                            Afficher plus de personnages
                        </Button>
                    )}
                </Content>
            </Sheet>

            <CharacterEditor
                isOpen={isEditorOpen}
                onClose={handleCloseEditor}
                character={editingCharacter}
            />
            <ConfirmDialog
                open={!!deleteId}
                onOpenChange={(open) => {
                    if (!open) setDeleteId(null);
                }}
                title="Supprimer ce personnage ?"
                description="Cette suppression est définitive. Exportez une sauvegarde si vous souhaitez conserver ce personnage."
                confirmLabel="Supprimer"
                destructive
                onConfirm={() => {
                    if (deleteId) void removeCharacter(deleteId);
                }}
            />
            {DragOverlay}
        </>
    );
}
