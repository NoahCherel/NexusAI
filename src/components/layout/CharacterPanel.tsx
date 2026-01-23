'use client';

import { useState } from 'react';
import { useCharacterStore } from '@/stores';
import { CharacterCard } from '@/components/character/CharacterCard';
import { CharacterEditor } from '@/components/character/CharacterEditor';
import { CharacterImporter } from '@/components/character/CharacterImporter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Search, Plus, Users, Upload } from 'lucide-react';
import { exportToJson } from '@/lib/export-utils';
import { useChatStore } from '@/stores/chat-store';
import type { CharacterCard as CharacterCardType } from '@/types';

interface CharacterPanelProps {
    trigger?: React.ReactNode;
}

export function CharacterPanel({ trigger }: CharacterPanelProps) {
    const [isOpen, setIsOpen] = useState(false);
    const { characters, activeCharacterId, setActiveCharacterId, removeCharacter } = useCharacterStore();
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

    const handleSelectCharacter = (id: string) => {
        setActiveCharacterId(id);
        setIsOpen(false);
    };

    const { getConversationMessages, conversations: allConversations } = useChatStore();

    const handleExport = async (character: CharacterCardType) => {
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

    const defaultTrigger = (
        <Button variant="ghost" size="icon" className="h-9 w-9">
            <Users className="w-5 h-5" />
        </Button>
    );

    return (
        <>
            <Sheet open={isOpen} onOpenChange={setIsOpen}>
                <SheetTrigger asChild>
                    {trigger || defaultTrigger}
                </SheetTrigger>
                <SheetContent side="left" className="w-[320px] sm:w-[380px] max-w-[90vw] p-0 flex flex-col overflow-x-hidden">
                    <SheetHeader className="p-4 pb-2 border-b border-border/40">
                        <SheetTitle className="flex items-center gap-2">
                            <div className="p-1.5 bg-primary/10 rounded-md">
                                <Users className="w-5 h-5 text-primary" />
                            </div>
                            Characters
                        </SheetTitle>
                    </SheetHeader>

                    <div className="px-4 py-3 space-y-3">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                placeholder="Search characters..."
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

                    <ScrollArea className="flex-1 w-full">
                        <div className="px-4 pb-6 space-y-2 w-full max-w-full">
                            {filteredCharacters.length === 0 ? (
                                <div className="text-center py-12 px-4">
                                    <p className="text-muted-foreground text-sm">
                                        No characters found
                                    </p>
                                </div>
                            ) : (
                                filteredCharacters.map((char) => (
                                    <div key={char.id} className="w-full max-w-full overflow-hidden">
                                        <CharacterCard
                                            character={char}
                                            isActive={char.id === activeCharacterId}
                                            onClick={() => handleSelectCharacter(char.id)}
                                            onEdit={() => handleEdit(char)}
                                            onDelete={() => removeCharacter(char.id)}
                                            onExport={() => handleExport(char)}
                                            isCollapsed={false}
                                        />
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
        </>
    );
}
