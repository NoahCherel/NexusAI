'use client';

import { motion, AnimatePresence, Variants } from 'framer-motion';
import {
    ChevronDown,
    GitBranch,
    RefreshCw,
    Edit2,
    Trash2,
    ChevronLeft,
    ChevronRight,
    Eye,
    EyeOff,
} from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ActionTooltip } from '@/components/ui/action-tooltip';
import { ChatFormatter } from '@/components/chat/ChatFormatter';

// Animation variants for premium feel
const bubbleVariants: Variants = {
    hidden: {
        opacity: 0,
        y: 20,
        scale: 0.95,
    },
    visible: {
        opacity: 1,
        y: 0,
        scale: 1,
        transition: {
            type: 'spring',
            stiffness: 260,
            damping: 20,
            mass: 0.8,
        },
    },
    exit: {
        opacity: 0,
        scale: 0.9,
        y: -10,
        transition: { duration: 0.2 },
    },
};

const contentVariants = {
    rest: {
        boxShadow: '0 0 0 rgba(0,0,0,0)',
        y: 0,
    },
    hover: {
        boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
        y: -1,
        transition: { duration: 0.2 },
    },
};

const buttonVariants = {
    rest: { scale: 1 },
    hover: { scale: 1.05 },
    tap: { scale: 0.9 },
};

interface ChatBubbleProps {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    thought?: string;
    avatar?: string;
    name?: string;
    showThoughts?: boolean;
    onEdit?: (id: string, newContent: string) => void;
    onRegenerate?: (id: string) => void;
    onBranch?: (id: string) => void;
    onDelete?: (id: string) => void;

    // Branching props
    currentBranchIndex?: number; // 1-based index
    totalBranches?: number;
    onNavigateBranch?: (id: string, direction: 'prev' | 'next') => void;
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
    currentBranchIndex = 0,
    totalBranches = 0,
    onNavigateBranch,
}: ChatBubbleProps) {
    const [isThoughtOpen, setIsThoughtOpen] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(content);
    const [showPreview, setShowPreview] = useState(false);
    const isUser = role === 'user';

    const handleStartEdit = () => {
        setEditContent(content);
        setIsEditing(true);
    };

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (isEditing && textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
        }
    }, [isEditing, editContent]);

    const handleSaveEdit = () => {
        onEdit?.(id, editContent);
        setIsEditing(false);
    };

    return (
        <motion.div
            variants={bubbleVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            layout
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
                            aria-label="Toggle thoughts"
                            onClick={() => setIsThoughtOpen(!isThoughtOpen)}
                        >
                            <ChevronDown
                                className={`w-3 h-3 transition-transform duration-200 ${isThoughtOpen ? 'rotate-180' : ''
                                    }`}
                            />
                            Thoughts
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
                    <div className="w-[300px] sm:w-[500px] max-w-full bg-background border border-primary/20 rounded-xl p-3 shadow-lg">
                        <textarea
                            ref={textareaRef}
                            className="w-full bg-transparent resize-none outline-none text-base text-foreground placeholder:text-muted-foreground min-h-[80px] overflow-hidden"
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            placeholder="Type your message..."
                            autoFocus
                        />

                        {/* Live Preview */}
                        {showPreview && (
                            <div className="mt-3 pt-3 border-t border-border/40">
                                <span className="text-[10px] text-muted-foreground uppercase font-bold block mb-2 tracking-wider">
                                    Preview
                                </span>
                                <div className="text-sm text-foreground/90 bg-card/50 p-3 rounded-lg border border-border/30">
                                    <ChatFormatter content={editContent || '...'} />
                                </div>
                            </div>
                        )}

                        <div className="flex justify-end gap-2 mt-2 pt-2 border-t border-border/50">
                            <button
                                onClick={() => setShowPreview(!showPreview)}
                                className="mr-auto text-xs flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted rounded-md transition-colors font-medium text-muted-foreground hover:text-foreground"
                                title="Toggle Preview"
                            >
                                {showPreview ? (
                                    <EyeOff className="w-3.5 h-3.5" />
                                ) : (
                                    <Eye className="w-3.5 h-3.5" />
                                )}
                                {showPreview ? 'Hide Preview' : 'Show Preview'}
                            </button>

                            <button
                                onClick={() => setIsEditing(false)}
                                className="text-xs px-3 py-1.5 hover:bg-muted rounded-md transition-colors font-medium text-muted-foreground hover:text-foreground"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveEdit}
                                className="text-xs bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 transition-colors font-medium shadow-sm"
                            >
                                Save
                            </button>
                        </div>
                    </div>
                ) : (
                    <motion.div
                        variants={contentVariants}
                        initial="rest"
                        whileHover="hover"
                        className={`rounded-2xl px-4 py-3 whitespace-pre-wrap break-words cursor-default transition-colors ${isUser
                                ? 'bg-primary text-primary-foreground rounded-br-sm hover:bg-primary/95'
                                : 'bg-card border border-border rounded-bl-sm hover:bg-card/80'
                            }`}
                    >
                        {!content && !isUser ? (
                            <div className="flex gap-1 py-2">
                                <span className="w-1.5 h-1.5 bg-foreground/30 rounded-full animate-bounce" />
                                <span className="w-1.5 h-1.5 bg-foreground/30 rounded-full animate-bounce [animation-delay:0.1s]" />
                                <span className="w-1.5 h-1.5 bg-foreground/30 rounded-full animate-bounce [animation-delay:0.2s]" />
                            </div>
                        ) : (
                            <ChatFormatter content={content} />
                        )}
                    </motion.div>
                )}

                {/* Action buttons (always rendered to prevent layout shift, toggled via opacity) */}
                <div
                    className={`flex gap-1 mt-1 transition-opacity duration-200 ${!isEditing && isHovered ? 'opacity-100' : 'opacity-0'
                        } ${isUser ? 'flex-row-reverse' : ''}`}
                    // Keep it physically present but allow pointer events only when visible
                    style={{ pointerEvents: !isEditing && isHovered ? 'auto' : 'none' }}
                >
                    <ActionTooltip label="Edit">
                        <motion.div
                            variants={buttonVariants}
                            initial="rest"
                            whileHover="hover"
                            whileTap="tap"
                        >
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={handleStartEdit}
                            >
                                <Edit2 className="h-3.5 w-3.5" />
                            </Button>
                        </motion.div>
                    </ActionTooltip>

                    {!isUser && (
                        <>
                            <ActionTooltip label="Regenerate">
                                <motion.div
                                    variants={buttonVariants}
                                    initial="rest"
                                    whileHover="hover"
                                    whileTap="tap"
                                >
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                        onClick={() => onRegenerate?.(id)}
                                    >
                                        <RefreshCw className="h-3.5 w-3.5" />
                                    </Button>
                                </motion.div>
                            </ActionTooltip>
                            <ActionTooltip label="Create Branch">
                                <motion.div
                                    variants={buttonVariants}
                                    initial="rest"
                                    whileHover="hover"
                                    whileTap="tap"
                                >
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                        onClick={() => onBranch?.(id)}
                                    >
                                        <GitBranch className="h-3.5 w-3.5" />
                                    </Button>
                                </motion.div>
                            </ActionTooltip>
                        </>
                    )}

                    <ActionTooltip label="Delete">
                        <motion.div
                            variants={buttonVariants}
                            initial="rest"
                            whileHover="hover"
                            whileTap="tap"
                        >
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={() => onDelete?.(id)}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </motion.div>
                    </ActionTooltip>

                    {/* Branch Navigation */}
                    {totalBranches > 1 && (
                        <div className="flex items-center gap-1 ml-auto bg-muted/50 rounded-md px-1 h-7">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5"
                                disabled={currentBranchIndex <= 1}
                                onClick={() => onNavigateBranch?.(id, 'prev')}
                            >
                                <ChevronLeft className="h-3 w-3" />
                            </Button>
                            <span className="text-[10px] text-muted-foreground font-mono px-1">
                                {currentBranchIndex}/{totalBranches}
                            </span>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5"
                                disabled={currentBranchIndex >= totalBranches}
                                onClick={() => onNavigateBranch?.(id, 'next')}
                            >
                                <ChevronRight className="h-3 w-3" />
                            </Button>
                        </div>
                    )}
                </div>
            </div>
        </motion.div>
    );
}
