'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
    MessageCircle,
    Settings,
    Upload,
    ChevronLeft,
    ChevronRight,
    Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { CharacterCard } from '@/components/character/CharacterCard';
import { CharacterImporter } from '@/components/character/CharacterImporter';
import { useCharacterStore } from '@/stores';

interface SidebarProps {
    onCharacterSelect?: (characterId: string) => void;
    onSettingsClick?: () => void;
}

export function Sidebar({ onCharacterSelect, onSettingsClick }: SidebarProps) {
    const [isCollapsed, setIsCollapsed] = useState(false);
    const { characters, activeCharacterId, setActiveCharacter, removeCharacter } =
        useCharacterStore();

    return (
        <motion.aside
            initial={false}
            animate={{ width: isCollapsed ? 72 : 320 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="relative h-full bg-card border-r border-border flex flex-col"
        >
            {/* Header */}
            <div className="p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shrink-0">
                    <Sparkles className="w-5 h-5 text-primary-foreground" />
                </div>
                {!isCollapsed && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                    >
                        <h1 className="font-bold text-lg">NexusAI</h1>
                        <p className="text-xs text-muted-foreground">Roleplay Platform</p>
                    </motion.div>
                )}
            </div>

            <Separator />

            {/* Import Button */}
            <div className="p-3">
                <CharacterImporter
                    trigger={
                        <Button
                            variant="outline"
                            className={`w-full gap-2 ${isCollapsed ? 'px-0' : ''}`}
                        >
                            <Upload className="h-4 w-4" />
                            {!isCollapsed && 'Importer'}
                        </Button>
                    }
                />
            </div>

            {/* Character List */}
            <ScrollArea className="flex-1 px-4 pr-5">
                <div className="space-y-3 pb-6">
                    {characters.length === 0 ? (
                        !isCollapsed && (
                            <div className="text-center py-8 text-muted-foreground text-sm">
                                <MessageCircle className="w-12 h-12 mx-auto mb-3 opacity-50" />
                                <p>Aucun personnage</p>
                                <p className="text-xs mt-1">
                                    Importez un Character Card pour commencer
                                </p>
                            </div>
                        )
                    ) : (
                        characters.map((character) =>
                            isCollapsed ? (
                                <Button
                                    key={character.id}
                                    variant={activeCharacterId === character.id ? 'secondary' : 'ghost'}
                                    size="icon"
                                    className="w-full"
                                    onClick={() => {
                                        setActiveCharacter(character.id);
                                        onCharacterSelect?.(character.id);
                                    }}
                                    title={character.name}
                                >
                                    {character.name.slice(0, 2).toUpperCase()}
                                </Button>
                            ) : (
                                <CharacterCard
                                    key={character.id}
                                    character={character}
                                    isActive={activeCharacterId === character.id}
                                    onClick={() => {
                                        setActiveCharacter(character.id);
                                        onCharacterSelect?.(character.id);
                                    }}
                                    onDelete={() => removeCharacter(character.id)}
                                />
                            )
                        )
                    )}
                </div>
            </ScrollArea>

            {/* Footer - Settings */}
            <Separator />
            <div className="p-3">
                <Button
                    variant="ghost"
                    className={`w-full gap-2 justify-start ${isCollapsed ? 'px-0 justify-center' : ''}`}
                    onClick={onSettingsClick}
                >
                    <Settings className="h-4 w-4" />
                    {!isCollapsed && 'Paramètres'}
                </Button>
            </div>

            {/* Collapse Toggle */}
            <Button
                variant="ghost"
                size="icon"
                className="absolute -right-3 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full border bg-background shadow-sm"
                onClick={() => setIsCollapsed(!isCollapsed)}
            >
                {isCollapsed ? (
                    <ChevronRight className="h-3 w-3" />
                ) : (
                    <ChevronLeft className="h-3 w-3" />
                )}
            </Button>
        </motion.aside>
    );
}
