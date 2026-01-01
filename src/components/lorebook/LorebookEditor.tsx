'use client';

import { useState } from 'react';
import { useLorebookStore, useCharacterStore } from '@/stores';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Trash2, Save, X, Search, Book } from 'lucide-react';
import type { LorebookEntry } from '@/types';

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

    // Character Store Integration
    const { getActiveCharacter, updateCharacter } = useCharacterStore();
    const character = getActiveCharacter();

    const handleSaveToCharacter = () => {
        if (character && activeLorebook) {
            updateCharacter(character.id, {
                character_book: activeLorebook
            });
        }
    };

    // New Entry Template
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

    return (
        <div className="flex flex-col h-full bg-background border rounded-lg overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b bg-muted/30">
                <div className="flex items-center gap-2">
                    <Book className="w-5 h-5 text-primary" />
                    <h2 className="font-semibold">Lorebook Editor</h2>
                </div>
                <div className="flex items-center gap-2">
                    {character && (
                        <Button variant="outline" size="sm" onClick={handleSaveToCharacter} className="h-8 gap-2">
                            <Save className="w-3.5 h-3.5" />
                            Save to {character.name}
                        </Button>
                    )}
                    <Button variant="ghost" size="icon" onClick={onClose}>
                        <X className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            <div className="flex flex-1 min-h-0">
                {/* Sidebar List */}
                <div className="w-64 border-r flex flex-col bg-muted/10">
                    <div className="p-2 border-b space-y-2">
                        <div className="relative">
                            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                            <Input
                                placeholder="Search keys..."
                                className="pl-8 h-8 text-xs bg-background"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <Button onClick={handleAddEntry} size="sm" className="w-full text-xs gap-1">
                            <Plus className="w-3 h-3" /> New Entry
                        </Button>
                    </div>

                    <ScrollArea className="flex-1">
                        <div className="flex flex-col p-2 gap-1">
                            {filteredEntries.map(({ entry, index }) => (
                                <button
                                    key={index}
                                    onClick={() => setSelectedEntryIndex(index)}
                                    className={`text-left p-2 rounded-md text-sm transition-colors flex items-center justify-between group ${selectedEntryIndex === index
                                        ? 'bg-primary text-primary-foreground'
                                        : 'hover:bg-muted'
                                        }`}
                                >
                                    <span className="truncate font-medium">
                                        {entry.keys[0] || 'Untitled'}
                                    </span>
                                    {entry.keys.length > 1 && (
                                        <span className="text-[10px] opacity-70">
                                            +{entry.keys.length - 1}
                                        </span>
                                    )}
                                </button>
                            ))}
                            {filteredEntries.length === 0 && (
                                <div className="text-center py-8 text-muted-foreground text-xs">
                                    No entries found
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                </div>

                {/* Editor Area */}
                <div className="flex-1 flex flex-col p-0">
                    {currentEntry ? (
                        <div className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto">
                            <div className="space-y-2">
                                <label className="text-xs font-semibold uppercase text-muted-foreground">
                                    Keywords (comma separated)
                                </label>
                                <Input
                                    value={currentEntry.keys.join(', ')}
                                    onChange={(e) => updateEntry(selectedEntryIndex!, {
                                        ...currentEntry,
                                        keys: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                                    })}
                                    placeholder="e.g. Castle, King, Magic"
                                />
                            </div>

                            <div className="flex-1 flex flex-col gap-2 min-h-0">
                                <label className="text-xs font-semibold uppercase text-muted-foreground">
                                    Content
                                </label>
                                <Textarea
                                    className="flex-1 min-h-[200px] resize-none font-mono text-sm leading-relaxed"
                                    value={currentEntry.content}
                                    onChange={(e) => updateEntry(selectedEntryIndex!, {
                                        ...currentEntry,
                                        content: e.target.value
                                    })}
                                    placeholder="Describe the lore item here..."
                                />
                            </div>

                            <div className="flex items-center justify-between border-t pt-4 mt-auto">
                                <div className="flex items-center gap-2">
                                    <label className="text-sm font-medium flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            checked={currentEntry.enabled}
                                            onChange={(e) => updateEntry(selectedEntryIndex!, {
                                                ...currentEntry,
                                                enabled: e.target.checked
                                            })}
                                            className="rounded border-primary text-primary focus:ring-primary"
                                        />
                                        Enabled
                                    </label>
                                </div>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => {
                                        deleteEntry(selectedEntryIndex!);
                                        setSelectedEntryIndex(null);
                                    }}
                                >
                                    <Trash2 className="w-4 h-4 mr-2" /> Delete
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-muted-foreground">
                            <div className="text-center space-y-2">
                                <Book className="w-12 h-12 mx-auto opacity-20" />
                                <p>Select an entry to edit</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
