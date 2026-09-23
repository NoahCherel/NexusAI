'use client';
import { useEffect, useState } from 'react';

export function useMobileViewport() {
    const [keyboardOpen, setKeyboardOpen] = useState(false);
    useEffect(() => {
        const viewport = window.visualViewport;
        let fullHeight = window.innerHeight;
        const update = () => {
            const focused = document.activeElement?.matches(
                'input, textarea, [contenteditable="true"]'
            );
            if (!focused) fullHeight = window.innerHeight;
            // Zoom belongs to the reader; never resize the application to the zoomed viewport.
            if (viewport && viewport.scale !== 1) return;
            const visualHeight = viewport?.height ?? window.innerHeight;
            const keyboard = !!focused && fullHeight - visualHeight > 120;
            setKeyboardOpen(keyboard);
            document.documentElement.style.setProperty('--visible-height', `${visualHeight}px`);
            document.documentElement.style.setProperty(
                '--visible-top',
                `${viewport?.offsetTop ?? 0}px`
            );
            document.documentElement.dataset.keyboard = String(keyboard);
        };
        update();
        viewport?.addEventListener('resize', update);
        viewport?.addEventListener('scroll', update);
        window.addEventListener('resize', update);
        document.addEventListener('focusin', update);
        document.addEventListener('focusout', update);
        return () => {
            viewport?.removeEventListener('resize', update);
            viewport?.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
            document.removeEventListener('focusin', update);
            document.removeEventListener('focusout', update);
            delete document.documentElement.dataset.keyboard;
            document.documentElement.style.removeProperty('--visible-height');
            document.documentElement.style.removeProperty('--visible-top');
        };
    }, []);
    return keyboardOpen;
}
