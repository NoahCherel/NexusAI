'use client';

import { Book, Brain, Clapperboard, Eye, GitBranch, Heart as HeartIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PersonaSelector, ModelSelector } from '@/components/chat';
import { NanoGPTUsageBadge } from '@/components/layout/NanoGPTUsage';

interface ChatToolbarProps {
    onOpenLorebook: () => void;
    /** Relations panel — the page decides dialog (desktop) vs sheet (mobile). */
    onOpenRelations: () => void;
    onOpenTree: () => void;
    onOpenMemory: () => void;
    onOpenCanon: () => void;
    onContextPreview: () => void;
}

/** Row of quick-access tools above the chat input (hidden in immersive mode). */
export function ChatToolbar({
    onOpenLorebook,
    onOpenRelations,
    onOpenTree,
    onOpenMemory,
    onOpenCanon,
    onContextPreview,
}: ChatToolbarProps) {
    return (
        <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar pb-1">
            <PersonaSelector />
            <ModelSelector />
            <NanoGPTUsageBadge />

            <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10 p-0 text-muted-foreground hover:text-foreground shrink-0"
                onClick={onOpenLorebook}
                title="Lorebook"
            >
                <Book className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10 p-0 text-muted-foreground hover:text-foreground shrink-0"
                onClick={onOpenRelations}
                title="Relations"
            >
                <HeartIcon className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10 p-0 text-muted-foreground hover:text-foreground shrink-0"
                onClick={onOpenTree}
                title="View Branch Tree"
            >
                <GitBranch className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10 p-0 text-muted-foreground hover:text-foreground shrink-0"
                onClick={onOpenMemory}
                title="Long-Term Memory"
            >
                <Brain className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10 p-0 text-muted-foreground hover:text-foreground shrink-0"
                onClick={onOpenCanon}
                title="Canon Codex (Arc + Casting + Directeur)"
            >
                <Clapperboard className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10 p-0 text-muted-foreground hover:text-foreground shrink-0"
                onClick={onContextPreview}
                title="Context Preview"
            >
                <Eye className="h-4 w-4" />
            </Button>
        </div>
    );
}
