'use client';

import { Button } from '@/components/ui/button';
import { X, GitBranch, Construction } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface TreeVisualizationProps {
    isOpen: boolean;
    onClose: () => void;
}

export function TreeVisualization({ isOpen, onClose }: TreeVisualizationProps) {
    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-center justify-center p-4"
            >
                <div className="bg-card border p-8 rounded-xl shadow-xl max-w-md w-full text-center space-y-4">
                    <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                        <Construction className="h-6 w-6 text-primary" />
                    </div>
                    <div className="space-y-2">
                        <h2 className="text-xl font-bold flex items-center justify-center gap-2">
                            Overview Coming Soon
                        </h2>
                        <p className="text-muted-foreground text-sm">
                            We are rebuilding the conversation visualizer to be faster and cleaner.
                            Stay tuned!
                        </p>
                    </div>
                    <Button onClick={onClose} className="w-full">
                        Close
                    </Button>
                </div>
            </motion.div>
        </AnimatePresence>
    );
}
