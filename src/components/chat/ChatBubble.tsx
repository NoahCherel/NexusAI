'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Edit, GitBranch, RefreshCw, Copy, Check, Edit2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { ActionTooltip } from '@/components/ui/action-tooltip';
import { ChatFormatter } from '@/components/chat/ChatFormatter';

interface ChatBubbleProps {
    id: string; // Add ID for actions
    role: 'user' | 'assistant';
    content: string;
    thought?: string; // Chain of Thought content
    avatar?: string;
    name?: string;
    showThoughts?: boolean;
    onEdit?: (id: string, newContent: string) => void;
    onRegenerate?: (id: string) => void;
    onBranch?: (id: string) => void;
    onDelete?: (id: string) => void;
}

export function ChatBubble({
    id,
    role,
    content,
    thought,
    avatar,
    name,
    showThoughts = true,
    onEdit,
    onRegenerate,
    onBranch,
    onDelete,
}: ChatBubbleProps) {
    const [isThoughtOpen, setIsThoughtOpen] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(content);
    const isUser = role === 'user';

    const handleSaveEdit = () => {
        onEdit?.(id, editContent);
        setIsEditing(false);
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className={`flex gap-3 group ${isUser ? 'flex-row-reverse' : ''}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {/* Avatar */}
            <Avatar className="w-10 h-10 shrink-0">
                <AvatarImage src={avatar} alt={name} />
                <AvatarFallback className={isUser ? 'bg-primary' : 'bg-secondary'}>
                    {name?.[0]?.toUpperCase() || (isUser ? 'U' : 'AI')}
                </AvatarFallback>
            </Avatar>

            <div
                className={`flex flex-col gap-1 max-w-[85%] ${isUser ? 'items-end' : 'items-start'
                    }`}
            >
                {/* Name */}
                <div className="flex items-center gap-2 px-1">
                    {name && (
                        <span className="text-xs font-semibold text-muted-foreground">{name}</span>
                    )}
                    {/* Thought Button */}
                    {thought && showThoughts && (
                        <button
                            onClick={() => setIsThoughtOpen(!isThoughtOpen)}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-muted/50 px-2 py-0.5 rounded-md transition-colors"
                        >
                            <ChevronDown
                                className={`w-3 h-3 transition-transform duration-200 ${isThoughtOpen ? 'rotate-180' : ''
                                    }`}
                            />
                            Pensées
                        </button>
                    )}
                </div>

                <AnimatePresence>
                    {isThoughtOpen && thought && showThoughts && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden w-full"
                        >
                            <div className="text-xs bg-muted/50 border border-border/50 rounded-lg p-3 italic text-muted-foreground mb-2">
                                {thought}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Main Content */}
                {isEditing ? (
                    <div className={`w-full min-w-[300px] p-2 bg-card border rounded-xl ${isUser ? 'rounded-br-sm' : 'rounded-bl-sm'}`}>
                        <textarea
                            className="w-full bg-transparent resize-none outline-none text-sm p-1 min-h-[100px]"
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                        />
                        <div className="flex justify-end gap-2 mt-2">
                            <button onClick={() => setIsEditing(false)} className="text-xs px-2 py-1 hover:bg-muted rounded transition-colors">Annuler</button>
                            <button onClick={handleSaveEdit} className="text-xs bg-primary text-primary-foreground px-2 py-1 rounded hover:bg-primary/90 transition-colors">Sauvegarder</button>
                        </div>
                    </div>
                ) : (
                    <div
                        className={`rounded-2xl px-4 py-3 whitespace-pre-wrap break-words ${isUser
                            ? 'bg-primary text-primary-foreground rounded-br-sm'
                            : 'bg-card border border-border rounded-bl-sm'
                            }`}
                    >
                        <ChatFormatter content={content} />
                    </div>
                )}

                {/* Action buttons (always rendered to prevent layout shift, toggled via opacity) */}
                <div
                    className={`flex gap-1 mt-1 transition-opacity duration-200 ${!isEditing && isHovered ? 'opacity-100' : 'opacity-0'
                        } ${isUser ? 'flex-row-reverse' : ''}`}
                    // Keep it physically present but allow pointer events only when visible
                    style={{ pointerEvents: !isEditing && isHovered ? 'auto' : 'none' }}
                >
                    <ActionTooltip label="Modifier">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => setIsEditing(true)}
                        >
                            <Edit2 className="h-3.5 w-3.5" />
                        </Button>
                    </ActionTooltip>

                    {!isUser && (
                        <>
                            <ActionTooltip label="Régénérer">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    onClick={() => onRegenerate?.(id)}
                                >
                                    <RefreshCw className="h-3.5 w-3.5" />
                                </Button>
                            </ActionTooltip>
                            <ActionTooltip label="Créer une branche">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    onClick={() => onBranch?.(id)}
                                >
                                    <GitBranch className="h-3.5 w-3.5" />
                                </Button>
                            </ActionTooltip>
                        </>
                    )}

                    <ActionTooltip label="Supprimer">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={() => onDelete?.(id)}
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                    </ActionTooltip>
                </div>
            </div>
        </motion.div>
    );
}
