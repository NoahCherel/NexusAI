'use client';

import { motion } from 'framer-motion';
import { MessageCircle, MoreVertical, Trash2, Edit } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CharacterCard as CharacterCardType } from '@/types';

interface CharacterCardProps {
    character: CharacterCardType;
    isActive?: boolean;
    onClick?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
}

export function CharacterCard({
    character,
    isActive = false,
    onClick,
    onEdit,
    onDelete,
}: CharacterCardProps) {
    return (
        <motion.div
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`relative group cursor-pointer rounded-xl border transition-all ${isActive
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/50 bg-card'
                }`}
            onClick={onClick}
        >
            {/* Card content */}
            <div className="p-4 flex gap-3">
                {/* Avatar */}
                <Avatar className="w-16 h-16 rounded-lg shrink-0">
                    <AvatarImage src={character.avatar} alt={character.name} className="object-cover" />
                    <AvatarFallback className="rounded-lg text-lg">
                        {character.name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                </Avatar>

                {/* Info */}
                <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate">{character.name}</h3>
                    <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                        {character.description || character.personality || 'Pas de description'}
                    </p>

                    {/* Tags */}
                    {character.tags && character.tags.length > 0 && (
                        <div className="flex gap-1 mt-2 flex-wrap">
                            {character.tags.slice(0, 3).map((tag, i) => (
                                <Badge key={i} variant="secondary" className="text-xs">
                                    {tag}
                                </Badge>
                            ))}
                            {character.tags.length > 3 && (
                                <Badge variant="outline" className="text-xs">
                                    +{character.tags.length - 3}
                                </Badge>
                            )}
                        </div>
                    )}
                </div>

                {/* Actions */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        >
                            <MoreVertical className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit?.(); }}>
                            <Edit className="h-4 w-4 mr-2" />
                            Modifier
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            className="text-destructive"
                            onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
                        >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Supprimer
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* Active indicator */}
            {isActive && (
                <motion.div
                    layoutId="activeIndicator"
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r"
                />
            )}
        </motion.div>
    );
}
