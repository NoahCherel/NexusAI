'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Loader2, Check, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

// Animation variants
const sendButtonVariants = {
    idle: { scale: 1 },
    hover: { scale: 1.05 },
    tap: { scale: 0.9 },
    sending: {
        scale: [1, 1.1, 1],
        transition: { duration: 0.3 }
    }
};

const iconVariants = {
    hidden: { opacity: 0, scale: 0.5, rotate: -45 },
    visible: {
        opacity: 1,
        scale: 1,
        rotate: 0,
        transition: { type: 'spring', stiffness: 300, damping: 20 }
    },
    exit: {
        opacity: 0,
        scale: 0.5,
        rotate: 45,
        transition: { duration: 0.15 }
    }
};

const containerVariants = {
    initial: { opacity: 0, y: 20 },
    animate: {
        opacity: 1,
        y: 0,
        transition: { type: 'spring', stiffness: 300, damping: 25 }
    }
};

interface ChatInputProps {
    onSend: (message: string) => void;
    onStop?: () => void;
    isLoading?: boolean;
    placeholder?: string;
    disabled?: boolean;
}

export function ChatInput({
    onSend,
    onStop,
    isLoading = false,
    placeholder = 'Écrivez votre message...',
    disabled = false,
}: ChatInputProps) {
    const [message, setMessage] = useState('');
    const [isFocused, setIsFocused] = useState(false);
    const [justSent, setJustSent] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-resize textarea
    useEffect(() => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
        }
    }, [message]);

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

    return (
        <motion.div
            variants={containerVariants}
            initial="initial"
            animate="animate"
            className="flex gap-2 sm:gap-3 items-end"
        >
            {/* Textarea with focus ring animation */}
            <motion.div
                className="flex-1 relative"
                animate={{
                    boxShadow: isFocused
                        ? '0 0 0 2px hsl(var(--primary) / 0.3)'
                        : '0 0 0 0px transparent'
                }}
                transition={{ duration: 0.2 }}
                style={{ borderRadius: 'calc(var(--radius) + 2px)' }}
            >
                <Textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    placeholder={placeholder}
                    disabled={disabled || isLoading}
                    className="min-h-[48px] max-h-[200px] resize-none pr-4 bg-card/50 backdrop-blur-sm border-border/50 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors"
                    rows={1}
                />
            </motion.div>

            {/* Animated Send Button */}
            <motion.div
                variants={sendButtonVariants}
                initial="idle"
                whileHover={!isLoading && message.trim() ? "hover" : "idle"}
                whileTap={!isLoading && message.trim() ? "tap" : "idle"}
                animate={justSent ? "sending" : "idle"}
            >
                <Button
                    onClick={isLoading ? onStop : handleSend}
                    disabled={(!message.trim() && !isLoading) || disabled}
                    size="icon"
                    className="shrink-0 h-12 w-12 rounded-xl shadow-lg shadow-primary/20 transition-shadow hover:shadow-primary/40"
                >
                    <AnimatePresence mode="wait">
                        {isLoading ? (
                            <motion.div
                                key="loading"
                                variants={iconVariants}
                                initial="hidden"
                                animate="visible"
                                exit="exit"
                            >
                                <Square className="h-4 w-4 fill-current" />
                            </motion.div>
                        ) : justSent ? (
                            <motion.div
                                key="check"
                                variants={iconVariants}
                                initial="hidden"
                                animate="visible"
                                exit="exit"
                            >
                                <Check className="h-5 w-5" />
                            </motion.div>
                        ) : (
                            <motion.div
                                key="send"
                                variants={iconVariants}
                                initial="hidden"
                                animate="visible"
                                exit="exit"
                            >
                                <Send className="h-5 w-5" />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </Button>
            </motion.div>
        </motion.div>
    );
}
