'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { MessageCircle, Settings, Upload, Sparkles, Menu, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { CharacterCard } from '@/components/character/CharacterCard';
import { CharacterImporter } from '@/components/character/CharacterImporter';
import { CharacterEditor } from '@/components/character/CharacterEditor';
import { useCharacterStore, useChatStore } from '@/stores';
import { exportToJson } from '@/lib/export-utils';
import type { CharacterCard as CharacterCardType } from '@/types';

interface MobileSidebarProps {
    onCharacterSelect?: (characterId: string) => void;
    onSettingsClick?: () => void;
}

const sidebarVariants = {
    hidden: { x: '-100%', opacity: 0 },
    visible: {
        x: 0,
        opacity: 1,
        transition: { type: 'spring' as const, stiffness: 300, damping: 30 },
    },
    exit: {
        x: '-100%',
        opacity: 0,
        transition: { duration: 0.2 },
    },
};

const itemVariants = {
    hidden: { opacity: 0, x: -20 },
    visible: (i: number) => ({
        opacity: 1,
        x: 0,
        transition: { delay: i * 0.05, type: 'spring' as const, stiffness: 300, damping: 25 },
    }),
};

export function MobileSidebar({ onCharacterSelect, onSettingsClick }: MobileSidebarProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [editingCharacter, setEditingCharacter] = useState<CharacterCardType | null>(null);
    const { characters, activeCharacterId, setActiveCharacter, removeCharacter } =
        useCharacterStore();

    const handleCharacterClick = (characterId: string) => {
        setActiveCharacter(characterId);
        onCharacterSelect?.(characterId);
        setIsOpen(false); // Close sidebar after selection on mobile
    };

    const handleSettingsClick = () => {
        onSettingsClick?.();
        setIsOpen(false);
    };

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
            alert('Aucune conversation trouvée pour ce personnage.');
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
        <Sheet open={isOpen} onOpenChange={setIsOpen}>
            <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-10 w-10">
                    <Menu className="h-5 w-5" />
                </Button>
            </SheetTrigger>
            <SheetContent
                side="left"
                className="w-[300px] sm:w-[350px] p-0 glass-heavy border-r border-white/5 flex flex-col"
            >
                <motion.div
                    variants={sidebarVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className="flex flex-col h-full"
                >
                    {/* Header */}
                    <SheetHeader className="p-4 border-b border-white/5">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shrink-0">
                                <Sparkles className="w-5 h-5 text-primary-foreground" />
                            </div>
                            <div>
                                <SheetTitle className="text-left">NexusAI</SheetTitle>
                                <p className="text-xs text-muted-foreground">Roleplay Platform</p>
                            </div>
                        </div>
                    </SheetHeader>

                    {/* Import/New Buttons */}
                    <motion.div className="p-3 flex gap-2" variants={itemVariants} custom={0}>
                        <CharacterImporter
                            trigger={
                                <Button variant="outline" className="flex-1 gap-2 hover-lift">
                                    <Upload className="h-4 w-4" />
                                    Import
                                </Button>
                            }
                        />
                        <Button
                            variant="outline"
                            className="flex-1 gap-2 hover-lift"
                            onClick={handleCreateNew}
                        >
                            <Plus className="h-4 w-4" />
                            New
                        </Button>
                    </motion.div>

                    <Separator className="bg-white/5" />

                    <div className="flex-1 min-h-0 px-3 overflow-hidden">
                        <ScrollArea className="h-full">
                            <div className="space-y-2 py-3 pr-2">
                                {characters.length === 0 ? (
                                    <motion.div
                                        className="text-center py-8 text-muted-foreground text-sm"
                                        variants={itemVariants}
                                        custom={1}
                                    >
                                        <MessageCircle className="w-12 h-12 mx-auto mb-3 opacity-50" />
                                        <p>Aucun personnage</p>
                                        <p className="text-xs mt-1">
                                            Importez un Character Card pour commencer
                                        </p>
                                    </motion.div>
                                ) : (
                                    characters.map((character, index) => (
                                        <motion.div
                                            key={character.id}
                                            variants={itemVariants}
                                            custom={index + 1}
                                        >
                                            <CharacterCard
                                                character={character}
                                                isActive={activeCharacterId === character.id}
                                                onClick={() => handleCharacterClick(character.id)}
                                                onEdit={() => handleEdit(character)}
                                                onDelete={() => removeCharacter(character.id)}
                                                onExport={() => handleExport(character)}
                                            />
                                        </motion.div>
                                    ))
                                )}
                            </div>
                        </ScrollArea>
                    </div>

                    {/* Footer - Settings */}
                    <Separator className="bg-white/5" />
                    <motion.div
                        className="p-3"
                        variants={itemVariants}
                        custom={characters.length + 2}
                    >
                        <Button
                            variant="ghost"
                            className="w-full gap-2 justify-start hover-lift"
                            onClick={handleSettingsClick}
                        >
                            <Settings className="h-4 w-4" />
                            Paramètres
                        </Button>
                    </motion.div>
                </motion.div>
            </SheetContent>

            {/* Character Editor Dialog */}
            <CharacterEditor
                isOpen={isEditorOpen}
                onClose={handleCloseEditor}
                character={editingCharacter}
            />
        </Sheet>
    );
}
