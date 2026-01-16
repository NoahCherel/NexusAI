'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Brain, Plus, Trash2, Sparkles, Loader2, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useCharacterStore } from '@/stores/character-store';
import { useChatStore } from '@/stores/chat-store';
import { generateMemorySummary, formatMemoryEntry } from '@/lib/memory-summarizer';
import { cn } from '@/lib/utils';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';

interface MemoryPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

export function MemoryPanel({ isOpen, onClose }: MemoryPanelProps) {
    const { getActiveCharacter, updateLongTermMemory } = useCharacterStore();
    const { getActiveBranchMessages, conversations, activeConversationId } = useChatStore();

    const character = getActiveCharacter();
    const [newMemory, setNewMemory] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
    const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);

    if (!character) return null;

    const memories = character.longTermMemory || [];
    const conversation = conversations.find(c => c.id === activeConversationId);

    const handleAddMemory = async () => {
        if (!newMemory.trim()) return;

        const formattedEntry = formatMemoryEntry(newMemory.trim());
        const updated = [...memories, formattedEntry];
        await updateLongTermMemory(character.id, updated);
        setNewMemory('');
    };

    const handleDeleteMemory = async (index: number) => {
        const updated = memories.filter((_, i) => i !== index);
        await updateLongTermMemory(character.id, updated);
        setConfirmDeleteIndex(null);
    };

    const handleGenerateSummary = async () => {
        if (!conversation) return;

        setIsGenerating(true);
        try {
            const messages = getActiveBranchMessages(activeConversationId!);
            const formattedMessages = messages.map(m => ({
                role: m.role,
                content: m.content,
            }));

            const summary = await generateMemorySummary(
                formattedMessages,
                conversation.worldState,
                character.name
            );

            const formattedEntry = formatMemoryEntry(summary);
            const updated = [...memories, formattedEntry];
            await updateLongTermMemory(character.id, updated);
        } catch (error) {
            console.error('Failed to generate summary:', error);
        } finally {
            setIsGenerating(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-lg mx-4 bg-background border border-border/50 rounded-2xl shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b bg-muted/30">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                            <Brain className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <h2 className="font-bold text-sm">Long-Term Memory</h2>
                            <p className="text-xs text-muted-foreground">{character.name}'s persistent context</p>
                        </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
                        <X className="w-4 h-4" />
                    </Button>
                </div>

                {/* Memory List */}
                <ScrollArea className="h-[300px]">
                    <div className="p-4 space-y-2">
                        {memories.length === 0 ? (
                            <div className="text-center py-8">
                                <Brain className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                                <p className="text-sm text-muted-foreground">No memories yet</p>
                                <p className="text-xs text-muted-foreground/70 mt-1">
                                    Add notes or generate AI summaries
                                </p>
                            </div>
                        ) : (
                            memories.map((memory, index) => (
                                <div
                                    key={index}
                                    className="p-3 rounded-lg bg-muted/30 border border-border/30 group"
                                >
                                    <div
                                        className="flex items-start justify-between cursor-pointer"
                                        onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
                                    >
                                        <p className={cn(
                                            "text-xs flex-1 pr-2",
                                            expandedIndex !== index && "line-clamp-2"
                                        )}>
                                            {memory}
                                        </p>
                                        <div className="flex items-center gap-1 shrink-0">
                                            {expandedIndex === index ? (
                                                <ChevronUp className="w-3 h-3 text-muted-foreground" />
                                            ) : (
                                                <ChevronDown className="w-3 h-3 text-muted-foreground" />
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setConfirmDeleteIndex(index);
                                                }}
                                            >
                                                <Trash2 className="w-3 h-3 text-destructive" />
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </ScrollArea>

                {/* Add Memory */}
                <div className="p-4 border-t bg-muted/10 space-y-3">
                    <Textarea
                        placeholder="Add a memory note..."
                        value={newMemory}
                        onChange={(e) => setNewMemory(e.target.value)}
                        className="min-h-[60px] resize-none text-sm"
                    />
                    <div className="flex gap-2">
                        <Button
                            onClick={handleAddMemory}
                            disabled={!newMemory.trim()}
                            size="sm"
                            className="flex-1 gap-2"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Add Note
                        </Button>
                        <Button
                            onClick={handleGenerateSummary}
                            disabled={isGenerating || !conversation}
                            variant="outline"
                            size="sm"
                            className="flex-1 gap-2"
                        >
                            {isGenerating ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                                <Sparkles className="w-3.5 h-3.5" />
                            )}
                            AI Summary
                        </Button>
                    </div>
                </div>

                {/* Delete Confirmation Dialog */}
                <Dialog open={confirmDeleteIndex !== null} onOpenChange={() => setConfirmDeleteIndex(null)}>
                    <DialogContent className="sm:max-w-[350px]">
                        <DialogHeader>
                            <DialogTitle>Delete Memory?</DialogTitle>
                            <DialogDescription>
                                This action cannot be undone.
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter className="flex-row gap-2">
                            <Button variant="ghost" className="flex-1" onClick={() => setConfirmDeleteIndex(null)}>
                                Cancel
                            </Button>
                            <Button
                                variant="destructive"
                                className="flex-1"
                                onClick={() => confirmDeleteIndex !== null && handleDeleteMemory(confirmDeleteIndex)}
                            >
                                Delete
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </div>
    );
}
