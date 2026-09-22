'use client';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

function subscribe(onChange: () => void) {
    const query = window.matchMedia('(max-width: 639px)');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

export function ResponsiveSceneControls({
    open,
    onOpenChange,
    children,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
}) {
    const mobile = useSyncExternalStore(
        subscribe,
        () => window.matchMedia('(max-width: 639px)').matches,
        () => false
    );
    if (!mobile) return children;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="mobile-editor max-sm:translate-x-0 max-sm:translate-y-0 overflow-y-auto">
                <DialogTitle>Contrôles de scène</DialogTitle>
                {children}
            </DialogContent>
        </Dialog>
    );
}
