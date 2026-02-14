'use client';

import { useState, useEffect } from 'react';
import { useLorebookStore, useCharacterStore, useSettingsStore } from '@/stores';
import { decryptApiKey } from '@/lib/crypto';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Trash2, Save, X, Search, Book, ChevronLeft, Sparkles, Loader2, Check, Inbox, Upload, Download } from 'lucide-react';
import type { LorebookEntry, Lorebook } from '@/types';
import { toast } from 'sonner';
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
    const { activeLorebook, addEntry, updateEntry, deleteEntry, pendingSuggestions, acceptSuggestion, rejectSuggestion, clearSuggestions, updateLorebook } =
        useLorebookStore();

    const [selectedEntryIndex, setSelectedEntryIndex] = useState<number | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [isMobile, setIsMobile] = useState(false);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [viewMode, setViewMode] = useState<'entries' | 'suggestions'>('entries');
    const [keysRawText, setKeysRawText] = useState('');

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

    // Sync raw keys text when selected entry changes
    useEffect(() => {
        if (selectedEntryIndex !== null && activeLorebook?.entries[selectedEntryIndex]) {
            setKeysRawText(activeLorebook.entries[selectedEntryIndex].keys.join(', '));
        }
    }, [selectedEntryIndex, activeLorebook]);

    const handleSaveToCharacter = () => {
        if (character && activeLorebook) {
            updateCharacter(character.id, {
                character_book: activeLorebook,
            });
        }
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const json = JSON.parse(event.target?.result as string);

                // Basic validation
                if (!json || typeof json !== 'object' || !Array.isArray(json.entries)) {
                    throw new Error('Invalid lorebook format');
                }

                // If importing into existing lorebook, preserve name if not present in import
                const newLorebook: Lorebook = {
                    ...activeLorebook, // Keep existing metadata by default
                    ...json, // Overwrite with imported data
                    entries: json.entries, // Ensure entries are taken from import
                };

                updateLorebook(newLorebook);
                toast.success('Lorebook imported successfully');
            } catch (error) {
                console.error('Import failed:', error);
                toast.error('Failed to import lorebook: Invalid JSON');
            }
        };
        reader.readAsText(file);

        // Reset input
        e.target.value = '';
    };

    const handleExport = () => {
        if (!activeLorebook) return;

        const jsonString = JSON.stringify(activeLorebook, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `lorebook-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toast.success('Lorebook exported');
    };

    const handleAddEntry = () => {
        const newEntry: LorebookEntry = {
            keys: ['new keyword'],
            content: 'Description here...',
            enabled: true,
            priority: 10,
        };
        addEntry(newEntry);
        setSelectedEntryIndex(activeLorebook?.entries.length || 0);
    };

    const handleSummarize = async () => {
        if (selectedEntryIndex === null || isSummarizing) return;

        // Get the entry directly from the store
        const entry = activeLorebook?.entries[selectedEntryIndex];
        if (!entry) return;

        setIsSummarizing(true);
        try {
            // Get API key from settings
            const { apiKeys } = useSettingsStore.getState();
            const keyConfig = apiKeys.find((k) => k.provider === 'openrouter');
            let apiKey = '';
            if (keyConfig) {
                apiKey = await decryptApiKey(keyConfig.encryptedKey);
            }

            // Direct call to OpenRouter API
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': window.location.origin,
                },
                body: JSON.stringify({
                    model: 'deepseek/deepseek-r1-0528:free',
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a lorebook entry summarizer. Condense the following text while keeping ALL essential information: character traits, relationships, abilities, appearance, and key facts. Be concise but complete. Output ONLY the condensed text, nothing else.',
                        },
                        {
                            role: 'user',
                            content: `Summarize this lorebook entry:\n\n${entry.content}`,
                        },
                    ],
                    temperature: 0.3,
                    max_tokens: 2000,
                    stream: true,
                }),
            });

            if (!response.ok) throw new Error('Summarization failed');

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader');

            const decoder = new TextDecoder();
            let summary = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter((line) => line.startsWith('data: '));

                for (const line of lines) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) summary += content;
                    } catch {
                        // Ignore parsing errors
                    }
                }
            }

            // Clean up summary (remove thoughts if any)
            const cleanSummary = summary.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

            if (cleanSummary && cleanSummary.length < entry.content.length) {
                updateEntry(selectedEntryIndex, {
                    ...entry,
                    content: cleanSummary,
                });
            }
        } catch (error) {
            console.error('Summarization error:', error);
        } finally {
            setIsSummarizing(false);
        }
    };

    const filteredEntries =
        activeLorebook?.entries
            .map((entry, index) => ({ entry, index }))
            .filter(
                ({ entry }) =>
                    entry.keys.some((k) => k.toLowerCase().includes(searchQuery.toLowerCase())) ||
                    entry.content.toLowerCase().includes(searchQuery.toLowerCase())
            ) || [];

    const currentEntry =
        selectedEntryIndex !== null && activeLorebook?.entries[selectedEntryIndex]
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
                            ? currentEntry.keys[0] || 'Entry Details'
                            : 'Lorebook Editor'}
                    </h2>
                </div>
                <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                    <div className="flex items-center border-r pr-2 mr-2 gap-1 border-border/40">
                        <label className="cursor-pointer">
                            <input
                                type="file"
                                className="hidden"
                                accept=".json"
                                onChange={handleImport}
                            />
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-primary"
                                title="Import Lorebook JSON"
                                asChild
                            >
                                <span>
                                    <Upload className="w-4 h-4" />
                                </span>
                            </Button>
                        </label>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleExport}
                            className="h-8 w-8 text-muted-foreground hover:text-primary"
                            title="Export to JSON"
                        >
                            <Download className="w-4 h-4" />
                        </Button>
                    </div>


                    <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
                        <X className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            <div className="flex flex-1 min-h-0 relative">
                {/* Sidebar List - Hidden on mobile when entry is selected */}
                <div
                    className={cn(
                        'w-full lg:w-72 border-r flex flex-col bg-muted/10 transition-all duration-300',
                        showEditorOnMobile ? 'hidden lg:flex' : 'flex'
                    )}
                >
                    <div className="p-3 border-b space-y-2 bg-muted/5">
                        <div className="relative">
                            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground outline-none" />
                            <Input
                                placeholder="Search keys..."
                                className="pl-9 h-9 text-xs bg-background/50 border-border/50 focus-visible:ring-primary/20"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <Button
                            onClick={handleAddEntry}
                            size="sm"
                            className="w-full text-xs gap-2 font-semibold h-9 shadow-sm"
                        >
                            <Plus className="w-3.5 h-3.5" /> New Entry
                        </Button>
                    </div>

                    <div className="flex border-b border-border/50">
                        <button
                            onClick={() => setViewMode('entries')}
                            className={cn(
                                'flex-1 py-2 text-xs font-medium border-b-2 transition-colors',
                                viewMode === 'entries'
                                    ? 'border-primary text-primary bg-primary/5'
                                    : 'border-transparent text-muted-foreground hover:bg-muted/50'
                            )}
                        >
                            <span className="flex items-center justify-center gap-2">
                                <Book className="w-3.5 h-3.5" /> Entries ({activeLorebook?.entries.length || 0})
                            </span>
                        </button>
                        <button
                            onClick={() => setViewMode('suggestions')}
                            className={cn(
                                'flex-1 py-2 text-xs font-medium border-b-2 transition-colors',
                                viewMode === 'suggestions'
                                    ? 'border-primary text-primary bg-primary/5'
                                    : 'border-transparent text-muted-foreground hover:bg-muted/50'
                            )}
                        >
                            <span className="flex items-center justify-center gap-2 relative">
                                <Inbox className="w-3.5 h-3.5" /> Suggestions
                                {pendingSuggestions.length > 0 && (
                                    <span className="absolute -top-0.5 -right-3 min-w-[14px] h-3.5 px-0.5 rounded-full bg-primary text-[9px] text-primary-foreground flex items-center justify-center leading-none">
                                        {pendingSuggestions.length}
                                    </span>
                                )}
                            </span>
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
                        {viewMode === 'entries' ? (
                            <div className="flex flex-col p-2 gap-1.5 pt-3">
                                {filteredEntries.map(({ entry, index }) => (
                                    <div
                                        key={index}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => setSelectedEntryIndex(index)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                setSelectedEntryIndex(index);
                                            }
                                        }}
                                        className={cn(
                                            'text-left p-2.5 rounded-lg text-xs sm:text-sm transition-all flex items-center justify-between group h-11 shrink-0 cursor-pointer',
                                            selectedEntryIndex === index
                                                ? 'bg-primary text-primary-foreground shadow-md shadow-primary/20 translate-x-1'
                                                : 'hover:bg-muted/80 text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        <span className="truncate font-semibold px-1 flex-1">
                                            {entry.keys[0] || 'Untitled'}
                                        </span>
                                        <div className="flex items-center gap-1.5 opacity-60">
                                            {entry.keys.length > 1 && (
                                                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-black/10">
                                                    +{entry.keys.length - 1}
                                                </span>
                                            )}
                                            {!entry.enabled && (
                                                <div className="w-1.5 h-1.5 rounded-full bg-destructive" />
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 opacity-60 hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    deleteEntry(index);
                                                    if (selectedEntryIndex === index) {
                                                        setSelectedEntryIndex(null);
                                                    }
                                                }}
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                                {filteredEntries.length === 0 && (
                                    <div className="text-center py-12 px-6">
                                        <div className="bg-muted/20 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                            <Search className="w-6 h-6 opacity-20" />
                                        </div>
                                        <p className="text-muted-foreground text-xs font-medium">
                                            No lore entries found
                                        </p>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="flex flex-col p-2 gap-2 pt-3">
                                <div className="flex items-center justify-between px-2 mb-1">
                                    <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
                                        Pending Review
                                    </p>
                                    {pendingSuggestions.length > 0 && (
                                        <div className="flex gap-1.5">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={async () => {
                                                    for (const s of pendingSuggestions) {
                                                        await acceptSuggestion(s.id);
                                                    }
                                                    toast.success(`Accepted ${pendingSuggestions.length} suggestions`);
                                                }}
                                                className="h-6 text-[9px] gap-1 text-green-500 hover:text-green-600 hover:bg-green-500/10 border-green-500/20 px-2"
                                            >
                                                <Check className="w-2.5 h-2.5" /> Accept All
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => {
                                                    clearSuggestions();
                                                    toast.success('All suggestions rejected');
                                                }}
                                                className="h-6 text-[9px] gap-1 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/20 px-2"
                                            >
                                                <X className="w-2.5 h-2.5" /> Reject All
                                            </Button>
                                        </div>
                                    )}
                                </div>
                                {pendingSuggestions.map((suggestion) => (
                                    <div
                                        key={suggestion.id}
                                        className="bg-card border rounded-lg p-3 space-y-2 text-sm shadow-sm"
                                    >
                                        <div className="flex flex-wrap gap-1">
                                            {suggestion.keys.map((k, i) => (
                                                <span key={i} className="bg-primary/10 text-primary text-[10px] font-bold px-1.5 py-0.5 rounded">
                                                    {k}
                                                </span>
                                            ))}
                                        </div>
                                        <p className="text-muted-foreground text-xs line-clamp-4">
                                            {suggestion.content}
                                        </p>
                                        <div className="flex items-center gap-2 pt-1 border-t border-border/40 mt-2">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => acceptSuggestion(suggestion.id)}
                                                className="h-7 text-[10px] gap-1 flex-1 text-green-500 hover:text-green-600 hover:bg-green-500/10 border-green-500/20"
                                            >
                                                <Check className="w-3 h-3" /> Accept
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => rejectSuggestion(suggestion.id)}
                                                className="h-7 text-[10px] gap-1 flex-1 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/20"
                                            >
                                                <X className="w-3 h-3" /> Reject
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                                {pendingSuggestions.length === 0 && (
                                    <div className="text-center py-12 px-6">
                                        <div className="bg-muted/20 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                            <Inbox className="w-6 h-6 opacity-20" />
                                        </div>
                                        <p className="text-muted-foreground text-xs font-medium">
                                            No pending suggestions
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Editor Area - Hidden on mobile when no entry selected IF we want to force list first */}
                <div
                    className={cn(
                        'flex-1 flex flex-col transition-all duration-300',
                        !showEditorOnMobile && isMobile ? 'hidden' : 'flex'
                    )}
                >
                    {currentEntry ? (
                        <div className="flex-1 flex flex-col p-4 sm:p-6 gap-6 overflow-y-auto">
                            <div className="space-y-3">
                                <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                    Character Names / Triggers
                                </label>
                                <Input
                                    className="bg-muted/5 focus-visible:ring-primary/20 h-10 font-medium"
                                    value={keysRawText}
                                    onChange={(e) => setKeysRawText(e.target.value)}
                                    onBlur={() => {
                                        if (selectedEntryIndex !== null && currentEntry) {
                                            updateEntry(selectedEntryIndex, {
                                                ...currentEntry,
                                                keys: keysRawText
                                                    .split(',')
                                                    .map((s) => s.trim())
                                                    .filter(Boolean),
                                            });
                                        }
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && selectedEntryIndex !== null && currentEntry) {
                                            updateEntry(selectedEntryIndex, {
                                                ...currentEntry,
                                                keys: keysRawText
                                                    .split(',')
                                                    .map((s) => s.trim())
                                                    .filter(Boolean),
                                            });
                                        }
                                    }}
                                    placeholder="e.g. Erza, Natsu, Gray (comma-separated)"
                                />
                            </div>

                            <div className="flex-1 flex flex-col gap-3 min-h-0">
                                <div className="flex items-center justify-between">
                                    <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                        Character Description
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={handleSummarize}
                                            disabled={isSummarizing || currentEntry.content.length < 100}
                                            className="h-7 gap-1.5 text-xs text-primary/70 hover:text-primary hover:bg-primary/10"
                                            title="AI-powered summarization to reduce token usage"
                                        >
                                            {isSummarizing ? (
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            ) : (
                                                <Sparkles className="w-3.5 h-3.5" />
                                            )}
                                            Summarize
                                        </Button>
                                        <span className="text-[10px] text-muted-foreground font-mono">
                                            {currentEntry.content.length} chars
                                        </span>
                                    </div>
                                </div>
                                <Textarea
                                    className="flex-1 min-h-[250px] sm:min-h-[300px] resize-none font-sans text-sm leading-relaxed p-4 bg-muted/5 focus-visible:ring-primary/20"
                                    value={currentEntry.content}
                                    onChange={(e) =>
                                        updateEntry(selectedEntryIndex!, {
                                            ...currentEntry,
                                            content: e.target.value,
                                        })
                                    }
                                    placeholder="Describe the character's personality, appearance, abilities, and role in the story..."
                                />
                            </div>

                            <div className="flex items-center justify-between border-t border-border/50 pt-6 mt-4">
                                <div className="flex items-center gap-3">
                                    <label className="flex items-center gap-3 cursor-pointer group">
                                        <input
                                            type="checkbox"
                                            checked={currentEntry.enabled}
                                            onChange={(e) =>
                                                updateEntry(selectedEntryIndex!, {
                                                    ...currentEntry,
                                                    enabled: e.target.checked,
                                                })
                                            }
                                            className="w-4 h-4 rounded border-border/50 bg-muted/20 text-primary shadow-sm focus:ring-primary/20 cursor-pointer"
                                        />
                                        <span className="text-sm font-semibold opacity-80 group-hover:opacity-100 transition-opacity">
                                            Enabled
                                        </span>
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
                                        Select an entry from the list or create a new one to define
                                        keys and world info.
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
                            This action cannot be undone. You are about to delete{' '}
                            <span className="font-bold text-foreground">
                                &quot;{currentEntry?.keys[0] || 'this entry'}&quot;
                            </span>
                            .
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
        </div >
    );
}
