'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { motion, Variants } from 'framer-motion';
import { Send, User, StopCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

import { cn } from '@/lib/utils';
import { BatchWaitLine } from '@/components/chat/BatchWaitLine';
import type { BatchWaitStep } from '@/lib/ai/batch-client';

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
    onSend: (message: string, onCommitted?: () => void) => void | Promise<void>;
    draftText?: string;
    onStop?: () => void;
    isLoading?: boolean;
    placeholder?: string;
    disabled?: boolean;
    /**
     * Draft the player's next message. Receives the current input-box text when there is
     * one: the draft is then an outline the generated message must enact, not free writing.
     */
    onImpersonate?: (draft?: string) => Promise<string | void>;
    onDraftChange?: (draft: string) => void;
    /** OpenRouter Batch mode: an impersonation draft still waiting for its batch. */
    batchWait?: { step: BatchWaitStep; submittedAt: number } | null;
}

export function ChatInput({
    onSend,
    draftText = '',
    onStop,
    isLoading = false,
    placeholder = 'Écrivez votre message...',
    disabled = false,
    onImpersonate,
    onDraftChange,
    batchWait = null,
}: ChatInputProps) {
    const message = draftText;
    const [sendError, setSendError] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const setMessage = (text: string) => onDraftChange?.(text);
    const [isImpersonating, setIsImpersonating] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const latestDraft = useRef(message);
    const mounted = useRef(true);
    useEffect(() => {
        latestDraft.current = message;
    }, [message]);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

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

    const handleSend = async () => {
        if (!message.trim() || isLoading || isSaving || disabled) return;
        setIsSaving(true);
        setSendError('');
        try {
            await onSend(message.trim(), () => setIsSaving(false));
        } catch {
            setSendError('Enregistrement impossible. Votre brouillon est conservé.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        // Send on Enter (without Shift)
        if (
            e.key === 'Enter' &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            e.keyCode !== 229 &&
            window.innerWidth >= 640
        ) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleImpersonateClick = async () => {
        if (!onImpersonate) return;
        // The outline is only replaced once a draft actually comes back: an empty result or a
        // failed generation must leave what the player wrote untouched.
        const outline = message.trim();
        setIsImpersonating(true);
        try {
            const text = await onImpersonate(outline || undefined);
            if (
                text &&
                typeof text === 'string' &&
                mounted.current &&
                latestDraft.current.trim() === outline
            ) {
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
            {sendError && (
                <p role="alert" className="text-sm text-destructive">
                    {sendError}
                </p>
            )}
            {batchWait && (
                <BatchWaitLine
                    label="Brouillon en attente (batch)"
                    step={batchWait.step}
                    submittedAt={batchWait.submittedAt}
                    className="px-3 pb-1.5"
                />
            )}
            <div className="flex items-end gap-2 bg-white/5 p-2 rounded-xl border border-white/10 shadow-sm backdrop-blur-sm relative transition-colors focus-within:bg-white/10 focus-within:border-white/20">
                {onImpersonate && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="inline-flex shrink-0"
                        aria-label="Rédiger pour moi"
                        title="Rédiger pour moi"
                        disabled={isImpersonating || isLoading || disabled}
                        onClick={handleImpersonateClick}
                    >
                        <User className="h-5 w-5" />
                    </Button>
                )}

                <Textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => {
                        setMessage(e.target.value);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className="flex-1 min-h-[40px] max-h-[80px] sm:max-h-[200px] resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 py-2.5 px-3 leading-relaxed custom-scrollbar placeholder:text-muted-foreground/50"
                    disabled={isSaving}
                    rows={1}
                />

                <Button
                    aria-label={isLoading ? 'Arrêter' : 'Envoyer'}
                    onClick={isLoading ? onStop : handleSend}
                    disabled={
                        (!message.trim() && !isLoading) || (!isLoading && (disabled || isSaving))
                    }
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
