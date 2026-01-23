'use client';

import { useState } from 'react';
import { useCharacterStore } from '@/stores';
import { CharacterCard } from '@/components/character/CharacterCard';
import { CharacterEditor } from '@/components/character/CharacterEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Search, Plus, PanelLeftClose, PanelLeftOpen, Settings, Users, Upload } from 'lucide-react';

import { CharacterImporter } from '@/components/character/CharacterImporter';
import { cn } from '@/lib/utils';
import { exportToJson } from '@/lib/export-utils';
import { useChatStore } from '@/stores/chat-store';
import type { CharacterCard as CharacterCardType } from '@/types';

interface SidebarProps {
    isCollapsed: boolean;
    onToggle: () => void;
    onSettingsClick: () => void;
}

export function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
    const { characters, activeCharacterId, setActiveCharacterId, removeCharacter } =
        useCharacterStore();
    const [searchTerm, setSearchTerm] = useState('');
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [editingCharacter, setEditingCharacter] = useState<CharacterCardType | null>(null);

    const filteredCharacters = characters.filter(
        (c) =>
            c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.tags?.some((t) => t.toLowerCase().includes(searchTerm.toLowerCase()))
    );

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

    const { getConversationMessages, conversations: allConversations } = useChatStore();

    const handleExport = async (character: CharacterCardType) => {
        // Find most recent conversation for this character
        const charConvs = allConversations
            .filter((c) => c.characterId === character.id)
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

        if (charConvs.length === 0) {
            alert('No conversation found for this character.');
            return;
        }

        const latestConv = charConvs[0];
        const messages = await getConversationMessages(latestConv.id);

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
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
                thought: m.thought,
                createdAt: m.createdAt,
                isActiveBranch: m.isActiveBranch,
            })),
            exportedAt: new Date().toISOString(),
        };

        exportToJson(exportData, `Conversation_${character.name}_${new Date().toISOString().split('T')[0]}`);
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
                        <div
                            className={cn(
                                'space-y-3 pb-10 transition-all duration-300 w-full overflow-hidden',
                                isCollapsed ? 'px-2 pt-4' : 'px-4 pt-4'
                            )}
                        >
                            {filteredCharacters.length === 0
                                ? !isCollapsed && (
                                    <div className="text-center py-12 px-4">
                                        <p className="text-muted-foreground text-sm">
                                            No characters found
                                        </p>
                                    </div>
                                )
                                : filteredCharacters.map((char) => (
                                    <CharacterCard
                                        key={char.id}
                                        character={char}
                                        isActive={char.id === activeCharacterId}
                                        onClick={() => setActiveCharacterId(char.id)}
                                        onEdit={() => handleEdit(char)}
                                        onDelete={() => removeCharacter(char.id)}
                                        onExport={() => handleExport(char)}
                                        isCollapsed={isCollapsed}
                                    />
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
        </>
    );
}
