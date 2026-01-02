'use client';

import { useState, useEffect } from 'react';
import { useLorebookStore, useCharacterStore } from '@/stores';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Trash2, Save, X, Search, Book, ChevronLeft } from 'lucide-react';
import type { LorebookEntry } from '@/types';
import { cn } from '@/lib/utils';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';

export function LorebookEditor({ onClose }: { onClose: () => void }) {
    const {
        activeLorebook,
        addEntry,
        updateEntry,
        deleteEntry,
        setActiveLorebook
    } = useLorebookStore();

    const [selectedEntryIndex, setSelectedEntryIndex] = useState<number | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [isMobile, setIsMobile] = useState(false);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

    // Character Store Integration
    const { getActiveCharacter, updateCharacter } = useCharacterStore();
    const character = getActiveCharacter();

    // Check for mobile on mount and resize
    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 1024);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    const handleSaveToCharacter = () => {
        if (character && activeLorebook) {
            updateCharacter(character.id, {
                character_book: activeLorebook
            });
        }
    };

    const handleAddEntry = () => {
        const newEntry: LorebookEntry = {
            keys: ['new keyword'],
            content: 'Description here...',
            enabled: true,
            priority: 10,
        };
        addEntry(newEntry);
        setSelectedEntryIndex((activeLorebook?.entries.length || 0));
    };

    const filteredEntries = activeLorebook?.entries.map((entry, index) => ({ entry, index }))
        .filter(({ entry }) =>
            entry.keys.some(k => k.toLowerCase().includes(searchQuery.toLowerCase())) ||
            entry.content.toLowerCase().includes(searchQuery.toLowerCase())
        ) || [];

    const currentEntry = selectedEntryIndex !== null && activeLorebook?.entries[selectedEntryIndex]
        ? activeLorebook.entries[selectedEntryIndex]
        : null;

    // Mobile logic: if an entry is selected on mobile, we show the editor view.
    const showEditorOnMobile = isMobile && selectedEntryIndex !== null;

    return (
        <div className="flex flex-col h-full bg-background border rounded-lg overflow-hidden shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between p-3 sm:p-4 border-b bg-muted/30 backdrop-blur-md">
                <div className="flex items-center gap-2 overflow-hidden">
                    {showEditorOnMobile && (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSelectedEntryIndex(null)}
                            className="mr-1 h-8 w-8 shrink-0"
                        >
                            <ChevronLeft className="w-5 h-5" />
                        </Button>
                    )}
                    <Book className="w-5 h-5 text-primary shrink-0" />
                    <h2 className="font-bold text-sm sm:text-base truncate">
                        {isMobile && currentEntry
                            ? (currentEntry.keys[0] || 'Entry Details')
                            : 'Lorebook Editor'}
                    </h2>
                </div>
                <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                    {character && (
                        <Button variant="outline" size="sm" onClick={handleSaveToCharacter} className="h-8 gap-2 px-2 sm:px-3 border-primary/20 bg-primary/5 text-primary hover:bg-primary/10">
                            <Save className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Save to {character.name}</span>
                            <span className="sm:hidden">Save</span>
                        </Button>
                    )}
                    <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
                        <X className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            <div className="flex flex-1 min-h-0 relative">
                {/* Sidebar List - Hidden on mobile when entry is selected */}
                <div className={cn(
                    "w-full lg:w-72 border-r flex flex-col bg-muted/10 transition-all duration-300",
                    showEditorOnMobile ? "hidden lg:flex" : "flex"
                )}>
                    <div className="p-3 border-b space-y-2 bg-muted/5">
                        <div className="relative">
                            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground outline-none" />
                            <Input
                                placeholder="Search keys..."
                                className="pl-9 h-9 text-xs bg-background/50 border-border/50 focus-visible:ring-primary/20"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <Button onClick={handleAddEntry} size="sm" className="w-full text-xs gap-2 font-semibold h-9 shadow-sm">
                            <Plus className="w-3.5 h-3.5" /> New Entry
                        </Button>
                    </div>

                    <ScrollArea className="flex-1">
                        <div className="flex flex-col p-2 gap-1.5 pt-3">
                            {filteredEntries.map(({ entry, index }) => (
                                <button
                                    key={index}
                                    onClick={() => setSelectedEntryIndex(index)}
                                    className={cn(
                                        "text-left p-2.5 rounded-lg text-xs sm:text-sm transition-all flex items-center justify-between group h-11",
                                        selectedEntryIndex === index
                                            ? "bg-primary text-primary-foreground shadow-md shadow-primary/20 translate-x-1"
                                            : "hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    <span className="truncate font-semibold px-1">
                                        {entry.keys[0] || 'Untitled'}
                                    </span>
                                    <div className="flex items-center gap-1.5 opacity-60">
                                        {entry.keys.length > 1 && (
                                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-black/10">
                                                +{entry.keys.length - 1}
                                            </span>
                                        )}
                                        {!entry.enabled && <div className="w-1.5 h-1.5 rounded-full bg-destructive" />}
                                    </div>
                                </button>
                            ))}
                            {filteredEntries.length === 0 && (
                                <div className="text-center py-12 px-6">
                                    <div className="bg-muted/20 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                        <Search className="w-6 h-6 opacity-20" />
                                    </div>
                                    <p className="text-muted-foreground text-xs font-medium">No lore entries found</p>
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                </div>

                {/* Editor Area - Hidden on mobile when no entry selected IF we want to force list first */}
                <div className={cn(
                    "flex-1 flex flex-col transition-all duration-300",
                    !showEditorOnMobile && isMobile ? "hidden" : "flex"
                )}>
                    {currentEntry ? (
                        <div className="flex-1 flex flex-col p-4 sm:p-6 gap-6 overflow-y-auto">
                            <div className="space-y-3">
                                <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                    Keywords (comma separated)
                                </label>
                                <Input
                                    className="bg-muted/5 focus-visible:ring-primary/20 h-10 font-medium"
                                    value={currentEntry.keys.join(', ')}
                                    onChange={(e) => updateEntry(selectedEntryIndex!, {
                                        ...currentEntry,
                                        keys: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                                    })}
                                    placeholder="e.g. Castle, King, Magic"
                                />
                            </div>

                            <div className="flex-1 flex flex-col gap-3 min-h-0">
                                <div className="flex items-center justify-between">
                                    <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                        Entry Content
                                    </label>
                                    <span className="text-[10px] text-muted-foreground font-mono">
                                        {currentEntry.content.length} chars
                                    </span>
                                </div>
                                <Textarea
                                    className="flex-1 min-h-[250px] sm:min-h-[300px] resize-none font-sans text-sm leading-relaxed p-4 bg-muted/5 focus-visible:ring-primary/20"
                                    value={currentEntry.content}
                                    onChange={(e) => updateEntry(selectedEntryIndex!, {
                                        ...currentEntry,
                                        content: e.target.value
                                    })}
                                    placeholder="Describe the lore item here..."
                                />
                            </div>

                            <div className="flex items-center justify-between border-t border-border/50 pt-6 mt-4">
                                <div className="flex items-center gap-3">
                                    <label className="flex items-center gap-3 cursor-pointer group">
                                        <input
                                            type="checkbox"
                                            checked={currentEntry.enabled}
                                            onChange={(e) => updateEntry(selectedEntryIndex!, {
                                                ...currentEntry,
                                                enabled: e.target.checked
                                            })}
                                            className="w-4 h-4 rounded border-border/50 bg-muted/20 text-primary shadow-sm focus:ring-primary/20 cursor-pointer"
                                        />
                                        <span className="text-sm font-semibold opacity-80 group-hover:opacity-100 transition-opacity">Enabled</span>
                                    </label>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive hover:bg-destructive/10 hover:text-destructive h-9 px-4 font-semibold"
                                    onClick={() => setConfirmDeleteOpen(true)}
                                >
                                    <Trash2 className="w-4 h-4 mr-2" /> Delete
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 flex items-center justify-center bg-muted/5">
                            <div className="text-center space-y-4 max-w-xs px-6">
                                <div className="bg-primary/5 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto rotate-12">
                                    <Book className="w-8 h-8 text-primary/40" />
                                </div>
                                <div className="space-y-1">
                                    <h3 className="font-bold">No Lore Selected</h3>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        Select an entry from the list or create a new one to define keys and world info.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Delete Confirmation Dialog */}
            <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
                <DialogContent className="sm:max-w-[400px] border-destructive/20 glass-heavy">
                    <DialogHeader>
                        <div className="w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Trash2 className="w-6 h-6 text-destructive" />
                        </div>
                        <DialogTitle className="text-center">Delete Lore Entry?</DialogTitle>
                        <DialogDescription className="text-center pt-2">
                            This action cannot be undone. You are about to delete <span className="font-bold text-foreground">"{currentEntry?.keys[0] || 'this entry'}"</span>.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="flex-row gap-2 mt-4">
                        <Button
                            variant="ghost"
                            className="flex-1"
                            onClick={() => setConfirmDeleteOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            className="flex-1 shadow-lg shadow-destructive/20"
                            onClick={() => {
                                if (selectedEntryIndex !== null) {
                                    deleteEntry(selectedEntryIndex);
                                    setSelectedEntryIndex(null);
                                    setConfirmDeleteOpen(false);
                                }
                            }}
                        >
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
