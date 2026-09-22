'use client';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/** Shared focus trap and Escape/return behavior for the existing full-screen editors. */
export function EditorOverlay({
    open,
    onClose,
    title,
    children,
}: {
    open: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
}) {
    return (
        <Dialog
            open={open}
            onOpenChange={(value) => {
                if (!value) onClose();
            }}
        >
            <DialogContent
                showCloseButton={false}
                aria-describedby={undefined}
                className="editor-overlay top-0 left-0 translate-x-0 translate-y-0 border-0 bg-transparent p-0 shadow-none"
            >
                <DialogTitle className="sr-only">{title}</DialogTitle>
                {children}
            </DialogContent>
        </Dialog>
    );
}
