'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ResponseControls } from '@/components/settings/ResponseControls';
import { Book, Brain, Clapperboard, Eye, GitBranch, Heart as HeartIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PersonaSelector, ModelSelector } from '@/components/chat';
import { NanoGPTUsageBadge } from '@/components/layout/NanoGPTUsage';
import { OpenRouterBudgetBadge } from '@/components/layout/OpenRouterBudget';

interface ChatToolbarProps {
    onOpenScene: () => void;
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
    onOpenScene,
    onOpenLorebook,
    onOpenRelations,
    onOpenTree,
    onOpenMemory,
    onOpenCanon,
    onContextPreview,
}: ChatToolbarProps) {
    const [aiOpen, setAiOpen] = useState(false);
    return (
        <>
            <div className="sm:hidden flex items-center gap-1 min-w-0">
                <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(44px,.6fr)_minmax(58px,.8fr)] items-center gap-1 min-w-0 flex-1">
                    <PersonaSelector />
                    <Button variant="ghost" onClick={() => setAiOpen(true)}>
                        IA
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost">Outils</Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {[
                                ['Mémoire', onOpenMemory],
                                ['Lorebook', onOpenLorebook],
                                ['Relations', onOpenRelations],
                                ['Contrôles de scène', onOpenScene],
                                ['Scène et univers', onOpenCanon],
                                ['Branches', onOpenTree],
                                ['Aperçu du contexte', onContextPreview],
                            ].map(([label, action]) => (
                                <DropdownMenuItem
                                    key={label as string}
                                    onClick={action as () => void}
                                >
                                    {label as string}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <NanoGPTUsageBadge />
                <OpenRouterBudgetBadge />
            </div>
            <Dialog open={aiOpen} onOpenChange={setAiOpen}>
                <DialogContent className="max-w-md overflow-y-auto">
                    <DialogTitle>IA</DialogTitle>
                    <ResponseControls showEngine={false} />
                </DialogContent>
            </Dialog>
            <div className="hidden sm:flex items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar pb-1">
                <PersonaSelector />
                <ModelSelector />
                <NanoGPTUsageBadge />
                <OpenRouterBudgetBadge />

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
                    title="Arbre des branches"
                >
                    <GitBranch className="h-4 w-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10 p-0 text-muted-foreground hover:text-foreground shrink-0"
                    onClick={onOpenMemory}
                    title="Mémoire long terme"
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
                    title="Aperçu du contexte"
                >
                    <Eye className="h-4 w-4" />
                </Button>
            </div>
        </>
    );
}
