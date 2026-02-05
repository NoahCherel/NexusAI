'use client';

import { motion } from 'framer-motion';
import { MoreVertical, Trash2, Edit, Download } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CharacterCard as CharacterCardType } from '@/types';
import { cn } from '@/lib/utils';

interface CharacterCardProps {
    character: CharacterCardType;
    isActive?: boolean;
    isCollapsed?: boolean;
    onClick?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
    onExport?: () => void;
}

export function CharacterCard({
    character,
    isActive = false,
    isCollapsed = false,
    onClick,
    onEdit,
    onDelete,
    onExport,
}: CharacterCardProps) {
    if (isCollapsed) {
        return (
            <motion.div
                layout
                whileHover={{ scale: 1.05, backgroundColor: 'rgba(var(--primary), 0.1)' }}
                whileTap={{ scale: 0.95 }}
                className={cn(
                    'relative cursor-pointer rounded-xl flex items-center justify-center transition-all duration-200 aspect-square w-12 mx-auto border-2',
                    isActive
                        ? 'border-primary bg-primary/10 shadow-[0_0_15px_rgba(var(--primary),0.2)]'
                        : 'border-transparent hover:border-border/60 bg-transparent'
                )}
                onClick={onClick}
            >
                <Avatar className="w-10 h-10 rounded-lg shrink-0 border border-border/50 shadow-sm">
                    <AvatarImage
                        src={character.avatar}
                        alt={character.name}
                        className="object-cover"
                    />
                    <AvatarFallback className="rounded-lg bg-muted text-muted-foreground text-[10px] font-bold">
                        {(character.displayName || character.name).slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                </Avatar>
                {isActive && (
                    <motion.div
                        layoutId="active-dot"
                        className="absolute -right-1 -top-1 w-3 h-3 bg-primary rounded-full border-2 border-background shadow-sm"
                    />
                )}
            </motion.div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            className={cn(
                'relative group cursor-pointer rounded-xl border-2 transition-all duration-200 box-border',
                isActive
                    ? 'border-primary/60 bg-primary/10 shadow-sm'
                    : 'border-border/30 hover:border-border/60 bg-card/40 hover:bg-card/60 backdrop-blur-sm'
            )}
            onClick={onClick}
            style={{ width: '100%', maxWidth: '100%' }}
        >
            {/* Card contents */}
            <div className="p-3 flex gap-3 items-start w-full overflow-hidden">
                <Avatar className="w-12 h-12 rounded-lg shrink-0 border border-border/50 shadow-sm text-xs">
                    <AvatarImage
                        src={character.avatar}
                        alt={character.name}
                        className="object-cover"
                    />
                    <AvatarFallback className="rounded-lg bg-muted text-muted-foreground font-medium">
                        {character.name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0 flex flex-col gap-1 overflow-hidden">
                    <div className="flex items-center justify-between gap-2 min-w-0 overflow-hidden">
                        <h3
                            className={cn(
                                'font-bold text-sm leading-none pt-0.5 flex-1 min-w-0',
                                isActive ? 'text-primary' : 'text-foreground'
                            )}
                        >
                            {(character.displayName?.length || 0) > 16
                                ? character.displayName!.slice(0, 16) + '...'
                                : character.displayName || (character.name.length > 16 ? character.name.slice(0, 16) + '...' : character.name)}
                        </h3>
                    </div>

                    <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed opacity-80 break-words overflow-hidden min-w-0">
                        {(character.description || character.personality || 'No description').length > 16
                            ? (character.description || character.personality || 'No description').slice(0, 16) + '...'
                            : (character.description || character.personality || 'No description')}
                    </p>

                    {/* Tags */}
                    {character.tags && character.tags.length > 0 && (
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                            {character.tags.slice(0, 2).map((tag, i) => (
                                <span
                                    key={i}
                                    className="text-[9px] px-1.5 py-0.5 rounded-md bg-primary/5 text-primary/70 border border-primary/10 font-medium"
                                >
                                    {tag}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* Hover Actions */}
                <div className="shrink-0 flex items-start">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity -mr-1 -mt-1 text-muted-foreground hover:text-foreground"
                            >
                                <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                            {onEdit && (
                                <DropdownMenuItem
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit?.();
                                    }}
                                >
                                    <Edit className="h-4 w-4 mr-2" />
                                    Edit
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete?.();
                                }}
                            >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                            </DropdownMenuItem>
                            {onExport && (
                                <DropdownMenuItem
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onExport?.();
                                    }}
                                >
                                    <Download className="h-4 w-4 mr-2" />
                                    Export JSON
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            {/* Active Indication: Left highlight */}
            {isActive && (
                <div className="absolute left-0 top-3 bottom-3 w-1 bg-primary rounded-r-full" />
            )}
        </motion.div>
    );
}
