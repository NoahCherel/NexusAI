'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Folder, FolderOpen } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CharacterCard } from '@/components/character/CharacterCard';
import type { CharacterWithMemory } from '@/lib/db';
import { cn } from '@/lib/utils';

interface CharacterFolderProps {
    name: string;
    members: CharacterWithMemory[];
    activeCharacterId: string | null;
    onSelect: (id: string) => void;
    onEdit: (character: CharacterWithMemory) => void;
    onDelete: (id: string) => void;
    onExport?: (character: CharacterWithMemory) => void;
    getLastPlayed?: (id: string) => string | null;
    isCollapsed?: boolean;
}

function initials(c: CharacterWithMemory) {
    return (c.displayName || c.name).slice(0, 2).toUpperCase();
}

/** Up to 3 overlapping member avatars used as the folder's "cover". */
function AvatarStack({ members, size = 'md' }: { members: CharacterWithMemory[]; size?: 'sm' | 'md' }) {
    const dim = size === 'sm' ? 'w-9 h-9' : 'w-10 h-10';
    return (
        <div className="flex -space-x-3 shrink-0">
            {members.slice(0, 3).map((m) => (
                <Avatar
                    key={m.id}
                    className={cn(
                        dim,
                        'rounded-lg border-2 border-card shadow-sm ring-1 ring-border/40'
                    )}
                >
                    <AvatarImage src={m.avatar} alt={m.name} className="object-cover" />
                    <AvatarFallback className="rounded-lg bg-muted text-muted-foreground text-[10px] font-bold">
                        {initials(m)}
                    </AvatarFallback>
                </Avatar>
            ))}
        </div>
    );
}

export function CharacterFolder({
    name,
    members,
    activeCharacterId,
    onSelect,
    onEdit,
    onDelete,
    onExport,
    getLastPlayed,
    isCollapsed = false,
}: CharacterFolderProps) {
    const containsActive = members.some((m) => m.id === activeCharacterId);
    // Open by default when the active variant lives inside this folder; the user's manual
    // toggle (if any) then takes precedence over that default.
    const [manualOpen, setManualOpen] = useState<boolean | null>(null);
    const isExpanded = manualOpen ?? containsActive;

    // Collapsed sidebar: a single stacked icon that opens a picker menu.
    if (isCollapsed) {
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        className={cn(
                            'relative mx-auto flex aspect-square w-12 items-center justify-center rounded-xl border-2 transition-all duration-200',
                            containsActive
                                ? 'border-primary bg-primary/10 shadow-[0_0_15px_rgba(var(--primary),0.2)]'
                                : 'border-transparent hover:border-border/60'
                        )}
                        title={`${name} (${members.length})`}
                    >
                        <AvatarStack members={members} size="sm" />
                        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-background bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                            {members.length}
                        </span>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="right" className="w-56">
                    <DropdownMenuLabel className="flex items-center gap-2">
                        <Folder className="h-3.5 w-3.5" /> {name}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {members.map((m) => (
                        <DropdownMenuItem
                            key={m.id}
                            onClick={() => onSelect(m.id)}
                            className={cn('gap-2', m.id === activeCharacterId && 'text-primary')}
                        >
                            <Avatar className="h-6 w-6 rounded-md shrink-0">
                                <AvatarImage src={m.avatar} alt={m.name} className="object-cover" />
                                <AvatarFallback className="rounded-md bg-muted text-[9px] font-bold">
                                    {initials(m)}
                                </AvatarFallback>
                            </Avatar>
                            <span className="truncate">{m.displayName || m.name}</span>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <div className="w-full">
            {/* Folder header (toggles the openable widget) */}
            <motion.button
                whileTap={{ scale: 0.99 }}
                onClick={() => setManualOpen(!isExpanded)}
                className={cn(
                    'flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition-all duration-200',
                    containsActive
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-border/30 bg-card/40 hover:border-border/60 hover:bg-card/60'
                )}
            >
                <AvatarStack members={members} />

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        {isExpanded ? (
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary/80" />
                        ) : (
                            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <h3
                            className={cn(
                                'truncate text-sm font-bold leading-none',
                                containsActive ? 'text-primary' : 'text-foreground'
                            )}
                        >
                            {name}
                        </h3>
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground/70">
                        {members.length} {members.length > 1 ? 'variantes' : 'variante'}
                    </p>
                </div>

                <motion.div animate={{ rotate: isExpanded ? 0 : -90 }} className="shrink-0">
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </motion.div>
            </motion.button>

            {/* Members (revealed when open) */}
            <AnimatePresence initial={false}>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                    >
                        <div className="ml-3 mt-2 space-y-2 border-l-2 border-border/30 pl-3">
                            {members.map((m) => (
                                <CharacterCard
                                    key={m.id}
                                    character={m}
                                    isActive={m.id === activeCharacterId}
                                    onClick={() => onSelect(m.id)}
                                    onEdit={() => onEdit(m)}
                                    onDelete={() => onDelete(m.id)}
                                    onExport={onExport ? () => onExport(m) : undefined}
                                    isCollapsed={false}
                                    lastPlayed={getLastPlayed?.(m.id) ?? null}
                                />
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
