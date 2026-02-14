'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { motion, AnimatePresence, Variants } from 'framer-motion';
import { Send, Check, Square, User, Plus, StopCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// Animation variants
const containerVariants: Variants = {
    initial: { opacity: 0, y: 20 },
    animate: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.3, ease: 'easeOut' },
    },
};

interface ChatInputProps {
    onSend: (message: string) => void;
    onStop?: () => void;
    isLoading?: boolean;
    placeholder?: string;
    disabled?: boolean;
    onImpersonate?: () => Promise<string | void>;
    onDraftChange?: (draft: string) => void;
}

export function ChatInput({
    onSend,
    onStop,
    isLoading = false,
    placeholder = 'Écrivez votre message...',
    disabled = false,
    onImpersonate,
    onDraftChange,
}: ChatInputProps) {
    const [message, setMessage] = useState('');
    const [isFocused, setIsFocused] = useState(false);
    const [justSent, setJustSent] = useState(false);
    const [isImpersonating, setIsImpersonating] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-resize textarea
    useEffect(() => {
        adjustHeight();
    }, [message]);

    const adjustHeight = () => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            // Reduce max height on small screens to avoid very tall input bars
            const maxHeight = typeof window !== 'undefined' && window.innerWidth < 640 ? 80 : 200;
            textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
        }
    };

    const handleSend = () => {
        if (message.trim() && !isLoading && !disabled) {
            onSend(message.trim());
            setMessage('');
            setJustSent(true);

            // Reset justSent after animation
            setTimeout(() => setJustSent(false), 600);

            if (textareaRef.current) {
                textareaRef.current.style.height = 'auto';
            }
        }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        // Send on Enter (without Shift)
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleImpersonateClick = async () => {
        if (!onImpersonate) return;
        setIsImpersonating(true);
        try {
            const text = await onImpersonate();
            if (text && typeof text === 'string') {
                setMessage(text);
                adjustHeight();
            }
        } finally {
            setIsImpersonating(false);
        }
    };

    return (
        <motion.div
            variants={containerVariants}
            initial="initial"
            animate="animate"
            className="w-full max-w-4xl mx-auto p-2"
        >
            <div className="flex items-end gap-2 bg-white/5 p-2 rounded-xl border border-white/10 shadow-sm backdrop-blur-sm relative transition-colors focus-within:bg-white/10 focus-within:border-white/20">
                {/* Action Menu */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 shrink-0 text-muted-foreground hover:text-foreground mb-[1px] rounded-lg"
                            title="Actions"
                        >
                            <Plus className="h-5 w-5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56 mb-2">
                        {onImpersonate && (
                            <DropdownMenuItem
                                onClick={handleImpersonateClick}
                                disabled={isImpersonating || isLoading}
                            >
                                <User className="mr-2 h-4 w-4" />
                                <span>
                                    {isImpersonating ? 'Impersonating...' : 'Impersonate Me'}
                                </span>
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>

                <Textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => {
                        setMessage(e.target.value);
                        onDraftChange?.(e.target.value);
                    }}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    placeholder={placeholder}
                    className="flex-1 min-h-[40px] max-h-[80px] sm:max-h-[200px] resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 py-2.5 px-3 leading-relaxed custom-scrollbar placeholder:text-muted-foreground/50"
                    disabled={isLoading || disabled}
                    rows={1}
                />

                <Button
                    onClick={isLoading ? onStop : handleSend}
                    disabled={(!message.trim() && !isLoading) || disabled}
                    size="icon"
                    className={cn(
                        'h-10 w-10 shrink-0 mb-[1px] transition-all duration-200 rounded-lg',
                        message.trim() || isLoading
                            ? 'opacity-100 scale-100'
                            : 'opacity-50 scale-95'
                    )}
                >
                    {isLoading ? (
                        <StopCircle className="h-5 w-5 animate-pulse" />
                    ) : (
                        <Send className="h-5 w-5" />
                    )}
                </Button>
            </div>
        </motion.div>
    );
}
