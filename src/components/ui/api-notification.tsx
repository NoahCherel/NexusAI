'use client';

import { create } from 'zustand';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Check, X, Brain, Book, Sparkles } from 'lucide-react';

export type NotificationType = 'loading' | 'success' | 'error';

export interface APINotification {
    id: string;
    type: NotificationType;
    message: string;
    icon?: 'memory' | 'lorebook' | 'world';
}

interface NotificationStore {
    notifications: APINotification[];
    addNotification: (message: string, icon?: APINotification['icon']) => string;
    updateNotification: (id: string, type: NotificationType, message?: string) => void;
    removeNotification: (id: string) => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
    notifications: [],

    addNotification: (message, icon) => {
        const id = crypto.randomUUID();
        set((state) => ({
            notifications: [...state.notifications, { id, type: 'loading', message, icon }],
        }));
        return id;
    },

    updateNotification: (id, type, message) => {
        set((state) => ({
            notifications: state.notifications.map((n) =>
                n.id === id ? { ...n, type, message: message || n.message } : n
            ),
        }));
        // Auto-remove after success/error
        if (type !== 'loading') {
            setTimeout(() => {
                set((state) => ({
                    notifications: state.notifications.filter((n) => n.id !== id),
                }));
            }, 3000);
        }
    },

    removeNotification: (id) => {
        set((state) => ({
            notifications: state.notifications.filter((n) => n.id !== id),
        }));
    },
}));

// Component to render notifications
export function APINotificationToast() {
    const { notifications } = useNotificationStore();

    const getIcon = (notification: APINotification) => {
        if (notification.type === 'loading') {
            return <Loader2 className="w-4 h-4 animate-spin" />;
        }
        if (notification.type === 'success') {
            return <Check className="w-4 h-4 text-green-500" />;
        }
        if (notification.type === 'error') {
            return <X className="w-4 h-4 text-red-500" />;
        }

        switch (notification.icon) {
            case 'memory':
                return <Brain className="w-4 h-4" />;
            case 'lorebook':
                return <Book className="w-4 h-4" />;
            case 'world':
                return <Sparkles className="w-4 h-4" />;
            default:
                return <Loader2 className="w-4 h-4 animate-spin" />;
        }
    };

    return (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
            <AnimatePresence mode="popLayout">
                {notifications.map((notification) => (
                    <motion.div
                        key={notification.id}
                        initial={{ opacity: 0, y: 20, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -10, scale: 0.9 }}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg backdrop-blur-md border ${
                            notification.type === 'loading'
                                ? 'bg-card/90 border-border/50'
                                : notification.type === 'success'
                                  ? 'bg-green-500/10 border-green-500/30'
                                  : 'bg-red-500/10 border-red-500/30'
                        }`}
                    >
                        {getIcon(notification)}
                        <span className="text-sm font-medium">{notification.message}</span>
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    );
}

// Helper functions to use in API calls
export function notifyAPIStart(message: string, icon?: APINotification['icon']): string {
    return useNotificationStore.getState().addNotification(message, icon);
}

export function notifyAPISuccess(id: string, message?: string): void {
    useNotificationStore.getState().updateNotification(id, 'success', message);
}

export function notifyAPIError(id: string, message?: string): void {
    useNotificationStore.getState().updateNotification(id, 'error', message);
}
