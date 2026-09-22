'use client';

import type { Conversation } from '@/types/chat';
import type { Persona } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

interface ConversationPickerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    characterName: string;
    conversations: Conversation[];
    personas: Persona[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onNew: () => void;
}

export function ConversationPicker({
    open,
    onOpenChange,
    characterName,
    conversations,
    personas,
    activeId,
    onSelect,
    onNew,
}: ConversationPickerProps) {
    const sorted = [...conversations].sort(
        (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="mobile-picker max-sm:translate-x-0 max-sm:translate-y-0 flex max-h-[80vh] w-[min(30rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0">
                <div className="shrink-0 border-b p-4 pr-12">
                    <DialogTitle className="text-base">Discussions</DialogTitle>
                    <DialogDescription className="truncate">{characterName}</DialogDescription>
                </div>
                <div className="shrink-0 p-3">
                    <Button className="w-full" onClick={onNew}>
                        Nouvelle discussion
                    </Button>
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
                    {sorted.map((conversation) => {
                        const persona = personas.find((p) => p.id === conversation.lastPersonaId);
                        const personaName =
                            persona?.displayName ||
                            persona?.name ||
                            (conversation.lastPersonaId
                                ? 'Persona indisponible'
                                : conversation.lastPersonaId === null
                                  ? 'Aucun persona'
                                  : 'Persona à retrouver à l’ouverture');
                        return (
                            <button
                                key={conversation.id}
                                type="button"
                                aria-current={conversation.id === activeId ? 'true' : undefined}
                                onClick={() => onSelect(conversation.id)}
                                className="w-full rounded-lg border border-border/50 bg-card/50 p-3 text-left hover:bg-muted/60 aria-[current=true]:border-primary"
                            >
                                <span className="block break-words font-medium">
                                    {conversation.title}
                                </span>
                                <span className="block text-sm text-muted-foreground">
                                    {personaName} ·{' '}
                                    {new Date(conversation.updatedAt).toLocaleDateString('fr-FR', {
                                        day: 'numeric',
                                        month: 'short',
                                        year: 'numeric',
                                    })}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </DialogContent>
        </Dialog>
    );
}
