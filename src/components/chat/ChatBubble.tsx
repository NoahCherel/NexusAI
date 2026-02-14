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
    AlertTriangle,
    ArrowRight,
} from 'lucide-react';
import { useState, useRef, useEffect, memo } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ActionTooltip } from '@/components/ui/action-tooltip';
import { ChatFormatter } from '@/components/chat/ChatFormatter';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

// Animation variants for premium feel
const bubbleVariants: Variants = {
    hidden: {
        opacity: 0,
    },
    visible: {
        opacity: 1,
        transition: {
            duration: 0.3,
            ease: 'easeOut',
        },
    },
    exit: {
        opacity: 0,
        transition: { duration: 0.2 },
    },
};

const contentVariants = {
    rest: {
        y: 0,
    },
    hover: {
        y: 0,
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
    onContinue?: (id: string) => void;
    onBranch?: (id: string) => void;
    onDelete?: (id: string) => void;

    // Branching props
    currentBranchIndex?: number; // 1-based index
    totalBranches?: number;
    onNavigateBranch?: (id: string, direction: 'prev' | 'next') => void;
}

export const ChatBubble = memo(function ChatBubble({
    id,
    role,
    content,
    thought,
    avatar,
    name,
    showThoughts = true,
    onEdit,
    onRegenerate,
    onContinue,
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
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const isUser = role === 'user';

    const handleStartEdit = () => {
        setEditContent(content);
        setIsEditing(true);
    };

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (isEditing && textareaRef.current) {
            // Save cursor position before resize
            const { selectionStart, selectionEnd } = textareaRef.current;
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
            // Restore cursor position after resize
            textareaRef.current.selectionStart = selectionStart;
            textareaRef.current.selectionEnd = selectionEnd;
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
            layout={isEditing ? false : "position"}
            className="flex gap-3 group items-start py-4 border-b border-white/[0.03] last:border-0"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {/* Avatar */}
            <Avatar className="w-8 h-8 shrink-0 mt-0.5">
                <AvatarImage src={avatar} alt={name} />
                <AvatarFallback className={isUser ? 'bg-primary' : 'bg-secondary'}>
                    {name?.[0]?.toUpperCase() || (isUser ? 'U' : 'AI')}
                </AvatarFallback>
            </Avatar>

            <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                {/* Name */}
                <div className="flex items-center gap-2 px-1">
                    {name && (
                        <span className="text-sm font-bold text-foreground/90">{name}</span>
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
                            <div className="text-sm bg-muted/30 border-l-2 border-primary/30 pl-3 py-1 italic text-muted-foreground mb-2">
                                {thought}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Main Content */}
                {isEditing ? (
                    <div className="w-[300px] sm:w-[500px] max-w-full bg-[#242525] border border-white/10 rounded-xl p-3 shadow-2xl">
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
                                <div className="text-sm text-foreground/90 bg-white/5 p-3 rounded-lg border border-white/5">
                                    <ChatFormatter content={editContent || '...'} isUser={isUser} />
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
                        className={`text-sm sm:text-base leading-relaxed whitespace-pre-wrap break-words min-h-[1.5em] ${isUser ? 'text-foreground' : 'text-foreground/90 font-medium'
                            }`}
                    >
                        {!content && !isUser ? (
                            <div className="flex gap-1 py-1">
                                <span className="w-1 h-1 bg-foreground/40 rounded-full" />
                                <span className="w-1 h-1 bg-foreground/40 rounded-full opacity-60" />
                                <span className="w-1 h-1 bg-foreground/40 rounded-full opacity-30" />
                            </div>
                        ) : (
                            <ChatFormatter content={content} isUser={isUser} />
                        )}
                    </motion.div>
                )}

                {/* Action buttons (always rendered to prevent layout shift, toggled via opacity) */}
                <div
                    className={`flex gap-1 mt-1 transition-opacity duration-200 ${!isEditing && isHovered ? 'opacity-100' : 'opacity-0'
                        }`}
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
                            <ActionTooltip label="Continue">
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
                                        onClick={() => onContinue?.(id)}
                                    >
                                        <ArrowRight className="h-3.5 w-3.5" />
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
                                onClick={() => setIsDeleteDialogOpen(true)}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </motion.div>
                    </ActionTooltip>

                    <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
                        <DialogContent className="sm:max-w-[425px]">
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2 text-destructive">
                                    <AlertTriangle className="h-5 w-5" />
                                    Delete Message?
                                </DialogTitle>
                                <DialogDescription>
                                    This will delete this message and all subsequent messages in
                                    this branch. This action cannot be undone.
                                </DialogDescription>
                            </DialogHeader>
                            <DialogFooter className="gap-2 sm:gap-0">
                                <Button
                                    variant="ghost"
                                    onClick={() => setIsDeleteDialogOpen(false)}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="destructive"
                                    onClick={() => {
                                        onDelete?.(id);
                                        setIsDeleteDialogOpen(false);
                                    }}
                                >
                                    Delete Forever
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>

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
});
