'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import { Send, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface ChatInputProps {
    onSend: (message: string) => void;
    isLoading?: boolean;
    placeholder?: string;
    disabled?: boolean;
}

export function ChatInput({
    onSend,
    isLoading = false,
    placeholder = 'Écrivez votre message...',
    disabled = false,
}: ChatInputProps) {
    const [message, setMessage] = useState('');
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
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex gap-2 items-end p-4 bg-background border-t border-border"
        >
            <div className="flex-1 relative">
                <Textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    disabled={disabled || isLoading}
                    className="min-h-[44px] max-h-[200px] resize-none pr-12 bg-card"
                    rows={1}
                />
            </div>

            <Button
                onClick={handleSend}
                disabled={!message.trim() || isLoading || disabled}
                size="icon"
                className="shrink-0 h-11 w-11"
            >
                {isLoading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                    <Send className="h-5 w-5" />
                )}
            </Button>
        </motion.div>
    );
}
