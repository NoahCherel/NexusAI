'use client';

import { useEffect, useState } from 'react';
import { Hourglass } from 'lucide-react';
import { BATCH_STEP_LABELS, formatElapsed, type BatchWaitStep } from '@/lib/ai/batch-client';
import { cn } from '@/lib/utils';

interface BatchWaitLineProps {
    /** What the reply is waiting for. */
    label: string;
    step?: BatchWaitStep;
    submittedAt: number;
    className?: string;
}

/**
 * « Réponse en file d'attente OpenRouter (batch) · en cours · 2:14 » — the waiting state
 * of a batched generation, with a live elapsed timer. Used under a bubble (visible reply)
 * and next to the input (impersonation draft).
 */
export function BatchWaitLine({ label, step, submittedAt, className }: BatchWaitLineProps) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    return (
        <div
            className={cn(
                'flex items-center gap-2 text-xs text-muted-foreground font-normal not-italic',
                className
            )}
            role="status"
            aria-live="polite"
        >
            <Hourglass className="h-3.5 w-3.5 shrink-0 animate-pulse" />
            <span className="truncate">
                {label}
                {step ? ` · ${BATCH_STEP_LABELS[step]}` : ''}
                {' · '}
                <span className="font-mono tabular-nums">{formatElapsed(now - submittedAt)}</span>
            </span>
        </div>
    );
}
