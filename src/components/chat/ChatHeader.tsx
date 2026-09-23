'use client';

import { motion } from 'framer-motion';
import {
    ArrowLeft,
    Settings2,
    MoreVertical,
    Edit,
    Trash2,
    Download,
    Upload,
    Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CharacterPanel } from '@/components/layout';
import type { CharacterCard } from '@/types/character';

interface ChatHeaderProps {
    character: CharacterCard;
    conversationTitle?: string;
    onBack?: () => void;
    onOpenConversations: () => void;
    activeModel: string;
    onEditCharacter: () => void;
    onImportConversation: () => void;
    onExportConversation: () => void;
    onDeleteCharacter: () => void;
    onOpenSettings: () => void;
}

/** Chat page header: character identity + actions menu. Hidden in immersive mode. */
export function ChatHeader({
    character,
    conversationTitle,
    onBack,
    onOpenConversations,
    activeModel,
    onEditCharacter,
    onImportConversation,
    onExportConversation,
    onDeleteCharacter,
    onOpenSettings,
}: ChatHeaderProps) {
    return (
        <motion.header
            initial={{ y: -60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -60, opacity: 0 }}
            transition={{
                type: 'spring' as const,
                stiffness: 300,
                damping: 30,
            }}
            className="h-14 border-b border-white/5 flex items-center px-4 justify-between glass-heavy sticky top-0 z-30 shrink-0"
        >
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                {/* Character Panel Button */}
                <Button
                    className="sm:hidden shrink-0"
                    variant="ghost"
                    size="icon"
                    aria-label="Retour aux personnages"
                    onClick={onBack}
                >
                    <ArrowLeft />
                </Button>
                <div className="max-sm:hidden">
                    <CharacterPanel
                        trigger={
                            <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8">
                                <Users className="h-4 w-4" />
                            </Button>
                        }
                    />
                </div>
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden shrink-0">
                    {character.avatar ? (
                        <div className="w-8 h-8 rounded-full overflow-hidden border border-border/50 shrink-0">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={character.avatar}
                                alt={character.name}
                                className="w-full h-full object-cover"
                            />
                        </div>
                    ) : (
                        <span className="font-semibold text-xs text-primary">
                            {character.name.slice(0, 2).toUpperCase()}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onOpenConversations}
                    aria-label="Choisir une discussion"
                    className="flex h-11 min-w-0 flex-col justify-center text-left hover:text-primary"
                >
                    <h2 className="block truncate text-xs font-semibold sm:text-sm">
                        {character.name}
                    </h2>
                    <span className="block truncate text-[10px] text-muted-foreground">
                        {conversationTitle || activeModel}
                    </span>
                </button>
            </div>

            <div className="flex items-center gap-1 sm:gap-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8">
                            <MoreVertical className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={onOpenConversations}>
                            Changer de discussion
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onEditCharacter}>
                            <Edit className="h-4 w-4 mr-2" />
                            Modifier le personnage
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onImportConversation}>
                            <Upload className="h-4 w-4 mr-2" />
                            Importer une discussion
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onExportConversation}>
                            <Download className="h-4 w-4 mr-2" />
                            Exporter la discussion
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={onDeleteCharacter}
                            className="text-destructive focus:text-destructive"
                        >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Supprimer le personnage
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={onOpenSettings}
                    className="max-sm:hidden shrink-0 h-8 w-8"
                >
                    <Settings2 className="h-4 w-4" />
                </Button>
            </div>
        </motion.header>
    );
}
