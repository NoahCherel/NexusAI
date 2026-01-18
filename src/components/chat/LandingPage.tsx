import { Bot, Sparkles, MessageSquare, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

export function LandingPage({ onImportClick }: { onImportClick: () => void }) {
    return (
        <div className="flex-1 h-full flex flex-col items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-8 relative overflow-hidden">
            {/* Background Decorations */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl opacity-20 animate-pulse" />
                <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl opacity-20 animate-pulse delay-1000" />
            </div>

            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="z-10 flex flex-col items-center max-w-2xl text-center space-y-8"
            >
                {/* Logo / Icon */}
                <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center shadow-2xl shadow-primary/20 mb-4">
                    <Bot className="w-12 h-12 text-white" />
                </div>

                {/* Title & Description */}
                <div className="space-y-4">
                    <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
                        Welcome to NexusAI
                    </h1>
                    <p className="text-xl text-muted-foreground leading-relaxed max-w-lg mx-auto">
                        Your advanced diverse roleplay companion. Select a character from the
                        sidebar or import a new one to begin your journey.
                    </p>
                </div>

                {/* Actions intentionally removed on landing to keep import in sidebar only */}
            </motion.div>

            {/* Features / Hints */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.8, duration: 1 }}
                className="absolute bottom-12 flex gap-8 text-sm text-muted-foreground/60"
            >
                <div className="flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    <span>Immersive Chat</span>
                </div>
                <div className="flex items-center gap-2">
                    <Bot className="w-4 h-4" />
                    <span>Smart Memory</span>
                </div>
                <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4" />
                    <span>Dynamic World</span>
                </div>
            </motion.div>
        </div>
    );
}
