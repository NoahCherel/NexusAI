'use client';

import { useState, useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ChevronUp, Plus, Trash2, Edit2, Search, User, Check, X, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export function PersonaSelector() {
    const {
        personas,
        activePersonaId,
        setActivePersonaId,
        addPersona,
        updatePersona,
        deletePersona,
    } = useSettingsStore();

    const [open, setOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
    const [isMobile, setIsMobile] = useState(false);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

    // Form state for the right pane editor
    const [editingPersona, setEditingPersona] = useState<{
        id?: string;
        name: string;
        displayName?: string;
        bio: string;
        avatar: string;
    } | null>(null);

    const activePersona = personas.find((p) => p.id === activePersonaId);
    const displayName = activePersona?.displayName || activePersona?.name || 'You';
    const displayAvatar = activePersona?.avatar;

    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 1024);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // When the dialog opens, default to the active persona if none selected
    useEffect(() => {
        if (open && !selectedPersonaId) {
            setSelectedPersonaId(activePersonaId);
        }
    }, [open, activePersonaId, selectedPersonaId]);

    // Keep the editor state in sync with the selected persona
    useEffect(() => {
        if (selectedPersonaId) {
            const persona = personas.find((p) => p.id === selectedPersonaId);
            if (persona) {
                setEditingPersona({
                    id: persona.id,
                    name: persona.name,
                    displayName: persona.displayName || '',
                    bio: persona.bio || '',
                    avatar: persona.avatar || '',
                });
            } else {
                setEditingPersona(null);
            }
        } else {
            setEditingPersona(null);
        }
    }, [selectedPersonaId, personas]);

    const handleCreateNew = () => {
        const id = crypto.randomUUID();
        const newPersona = {
            id,
            name: 'New Persona',
            bio: '',
            avatar: '',
        };
        addPersona(newPersona);
        setSearchQuery('');
        setSelectedPersonaId(id);
    };

    const handleSave = () => {
        if (!editingPersona || !editingPersona.name.trim() || !editingPersona.id) return;

        updatePersona(editingPersona.id, {
            name: editingPersona.name.trim(),
            displayName: editingPersona.displayName?.trim(),
            bio: editingPersona.bio,
            avatar: editingPersona.avatar,
        });
        toast.success('Persona saved successfully');
    };

    const confirmDelete = () => {
        if (selectedPersonaId) {
            deletePersona(selectedPersonaId);
            if (activePersonaId === selectedPersonaId) {
                setActivePersonaId(null);
            }
            setSelectedPersonaId(null);
            setConfirmDeleteOpen(false);
            toast.success('Persona deleted');
        }
    };

    const filteredPersonas = personas
        .filter(
            (p) =>
                p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                (p.displayName || '').toLowerCase().includes(searchQuery.toLowerCase())
        )
        .sort((a, b) => {
            if (a.id === activePersonaId) return -1;
            if (b.id === activePersonaId) return 1;
            return a.name.localeCompare(b.name);
        });

    const currentPersona = personas.find((p) => p.id === selectedPersonaId);
    const showEditorOnMobile = isMobile && selectedPersonaId !== null;

    return (
        <>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(true)}
            >
                <Avatar className="h-5 w-5 border border-border/50 shrink-0">
                    <AvatarImage src={displayAvatar} className="object-cover" />
                    <AvatarFallback className="text-[9px] bg-primary/10 text-primary">
                        {displayName[0].toUpperCase()}
                    </AvatarFallback>
                </Avatar>
                <span className="max-w-[80px] truncate hidden sm:inline-block">{displayName}</span>
                <ChevronUp className="h-3 w-3 opacity-50 hidden sm:block shrink-0" />
            </Button>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-4xl h-[80vh] p-0 flex flex-col overflow-hidden glass-heavy border-primary/20">
                    <DialogTitle className="sr-only">Persona Selector</DialogTitle>

                    {/* Header */}
                    <div className="flex items-center justify-between p-3 sm:p-4 border-b bg-muted/30 backdrop-blur-md shrink-0">
                        <div className="flex items-center gap-2 overflow-hidden">
                            {showEditorOnMobile && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setSelectedPersonaId(null)}
                                    className="mr-1 h-8 w-8 shrink-0"
                                >
                                    <ChevronLeft className="w-5 h-5" />
                                </Button>
                            )}
                            <User className="w-5 h-5 text-primary shrink-0" />
                            <h2 className="font-bold text-sm sm:text-base truncate">
                                {isMobile && currentPersona
                                    ? currentPersona.displayName || currentPersona.name
                                    : 'Persona Manager'}
                            </h2>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setOpen(false)}
                            className="h-8 w-8 text-muted-foreground hover:text-primary"
                        >
                            <X className="w-4 h-4" />
                        </Button>
                    </div>

                    <div className="flex flex-1 min-h-0 relative">
                        {/* Sidebar List */}
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
                                        placeholder="Search personas..."
                                        className="pl-9 h-9 text-xs bg-background/50 border-border/50 focus-visible:ring-primary/20"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                    />
                                </div>
                                <Button
                                    onClick={handleCreateNew}
                                    size="sm"
                                    className="w-full text-xs gap-2 font-semibold h-9 shadow-sm"
                                >
                                    <Plus className="w-3.5 h-3.5" /> New Persona
                                </Button>
                            </div>

                            <ScrollArea className="flex-1 min-h-0 custom-scrollbar">
                                <div className="flex flex-col p-2 gap-1.5 pt-3">
                                    {filteredPersonas.map((persona) => (
                                        <div
                                            key={persona.id}
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => setSelectedPersonaId(persona.id)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    setSelectedPersonaId(persona.id);
                                                }
                                            }}
                                            className={cn(
                                                'text-left p-2 rounded-lg text-xs transition-all flex items-center justify-between group h-12 shrink-0 cursor-pointer',
                                                selectedPersonaId === persona.id
                                                    ? 'bg-primary/90 text-primary-foreground shadow-md shadow-primary/20 translate-x-1'
                                                    : 'hover:bg-muted/80 text-muted-foreground hover:text-foreground'
                                            )}
                                        >
                                            <div className="flex items-center gap-2 min-w-0 flex-1 pl-1">
                                                <Avatar className="h-6 w-6 shrink-0 border border-border/50">
                                                    <AvatarImage src={persona.avatar} />
                                                    <AvatarFallback
                                                        className={cn(
                                                            'text-[10px]',
                                                            selectedPersonaId === persona.id
                                                                ? 'text-primary'
                                                                : 'bg-primary/10 text-primary'
                                                        )}
                                                    >
                                                        {persona.name[0].toUpperCase()}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <div className="flex flex-col min-w-0 flex-1 pr-2">
                                                    <span className="font-semibold truncate">
                                                        {persona.displayName || persona.name}
                                                    </span>
                                                    {persona.displayName && (
                                                        <span className="text-[10px] opacity-70 truncate">
                                                            {persona.name}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            {activePersonaId === persona.id && (
                                                <div className="shrink-0 flex items-center mr-2">
                                                    <Check className="w-4 h-4 text-green-500" />
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                    {filteredPersonas.length === 0 && (
                                        <div className="text-center py-12 px-6">
                                            <div className="bg-muted/20 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                                <Search className="w-6 h-6 opacity-20" />
                                            </div>
                                            <p className="text-muted-foreground text-xs font-medium">
                                                No personas found
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </ScrollArea>
                        </div>

                        {/* Editor Area */}
                        <div
                            className={cn(
                                'flex-1 flex flex-col transition-all duration-300 bg-background/50',
                                !showEditorOnMobile && isMobile ? 'hidden' : 'flex'
                            )}
                        >
                            {currentPersona && editingPersona ? (
                                <div className="flex-1 flex flex-col p-4 sm:p-6 gap-6 overflow-y-auto custom-scrollbar">
                                    <div className="flex items-center gap-4 border-b border-border/50 pb-6 shrink-0">
                                        <div className="relative group">
                                            <Avatar className="h-16 w-16 sm:h-20 sm:w-20 border-2 border-primary/20 ring-4 ring-muted">
                                                <AvatarImage
                                                    src={editingPersona.avatar}
                                                    className="object-cover"
                                                />
                                                <AvatarFallback className="text-xl bg-primary/10 text-primary font-bold">
                                                    {editingPersona.name[0].toUpperCase()}
                                                </AvatarFallback>
                                            </Avatar>
                                        </div>
                                        <div className="flex-1 min-w-0 flex flex-col gap-1.5 justify-center">
                                            <h3 className="text-lg sm:text-xl font-bold truncate">
                                                {editingPersona.displayName || editingPersona.name}
                                            </h3>
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    size="sm"
                                                    variant={
                                                        activePersonaId === currentPersona.id
                                                            ? 'secondary'
                                                            : 'default'
                                                    }
                                                    className="text-xs h-7 px-3 w-fit"
                                                    onClick={() => {
                                                        setActivePersonaId(currentPersona.id);
                                                        toast.success(
                                                            `Active persona set to ${currentPersona.displayName ||
                                                            currentPersona.name
                                                            }`
                                                        );
                                                    }}
                                                    disabled={activePersonaId === currentPersona.id}
                                                >
                                                    {activePersonaId === currentPersona.id ? (
                                                        <>
                                                            <Check className="w-3.5 h-3.5 mr-1" />{' '}
                                                            Active
                                                        </>
                                                    ) : (
                                                        'Set as Active'
                                                    )}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="space-y-4 shrink-0 max-w-2xl">
                                        <div className="grid sm:grid-cols-2 gap-4">
                                            <div className="space-y-2">
                                                <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                                    Character Name
                                                </label>
                                                <Input
                                                    className="bg-muted/5 focus-visible:ring-primary/20 h-10 font-medium"
                                                    value={editingPersona.name}
                                                    onChange={(e) =>
                                                        setEditingPersona((prev) =>
                                                            prev
                                                                ? {
                                                                    ...prev,
                                                                    name: e.target.value,
                                                                }
                                                                : null
                                                        )
                                                    }
                                                    onBlur={handleSave}
                                                    placeholder="e.g. System AI"
                                                />
                                                <p className="text-[10px] text-muted-foreground mt-1">
                                                    The name the AI understands as its identity.
                                                </p>
                                            </div>
                                            <div className="space-y-2">
                                                <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                                    Display Name (Optional)
                                                </label>
                                                <Input
                                                    className="bg-muted/5 focus-visible:ring-primary/20 h-10 font-medium"
                                                    value={editingPersona.displayName}
                                                    onChange={(e) =>
                                                        setEditingPersona((prev) =>
                                                            prev
                                                                ? {
                                                                    ...prev,
                                                                    displayName: e.target.value,
                                                                }
                                                                : null
                                                        )
                                                    }
                                                    onBlur={handleSave}
                                                    placeholder="e.g. Helpful Assistant Mode"
                                                />
                                                <p className="text-[10px] text-muted-foreground mt-1">
                                                    Shown in the UI, overrides Character Name.
                                                </p>
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                                Avatar URL
                                            </label>
                                            <Input
                                                className="bg-muted/5 focus-visible:ring-primary/20 h-10 text-sm font-mono"
                                                value={editingPersona.avatar}
                                                onChange={(e) =>
                                                    setEditingPersona((prev) =>
                                                        prev
                                                            ? {
                                                                ...prev,
                                                                avatar: e.target.value,
                                                            }
                                                            : null
                                                    )
                                                }
                                                onBlur={handleSave}
                                                placeholder="https://example.com/image.png"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex-1 flex flex-col gap-3 min-h-[250px] max-w-2xl">
                                        <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70 shrink-0">
                                            Biography & System Prompt
                                        </label>
                                        <Textarea
                                            className="flex-1 min-h-[200px] resize-none font-sans text-sm leading-relaxed p-4 bg-muted/5 focus-visible:ring-primary/20"
                                            value={editingPersona.bio}
                                            onChange={(e) =>
                                                setEditingPersona((prev) =>
                                                    prev ? { ...prev, bio: e.target.value } : null
                                                )
                                            }
                                            onBlur={handleSave}
                                            placeholder="Write how the persona should behave, its personality, background story..."
                                        />
                                    </div>

                                    <div className="flex items-center justify-between border-t border-border/50 pt-6 mt-4 shrink-0 max-w-2xl">
                                        <div />
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="text-destructive hover:bg-destructive/10 hover:text-destructive h-9 px-4 font-semibold"
                                            onClick={() => setConfirmDeleteOpen(true)}
                                        >
                                            <Trash2 className="w-4 h-4 mr-2" /> Delete Persona
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex-1 flex items-center justify-center bg-muted/5">
                                    <div className="text-center space-y-4 max-w-xs px-6">
                                        <div className="bg-primary/5 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto rotate-12">
                                            <User className="w-8 h-8 text-primary/40" />
                                        </div>
                                        <div className="space-y-1">
                                            <h3 className="font-bold">No Persona Selected</h3>
                                            <p className="text-xs text-muted-foreground leading-relaxed">
                                                Select a persona from the list or create a new one.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Delete Confirmation Dialog */}
            <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
                <DialogContent className="sm:max-w-[400px] border-destructive/20 glass-heavy">
                    <DialogHeader>
                        <div className="w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Trash2 className="w-6 h-6 text-destructive" />
                        </div>
                        <DialogTitle className="text-center">Delete Persona?</DialogTitle>
                        <DialogDescription className="text-center pt-2">
                            This action cannot be undone. You are about to delete{' '}
                            <span className="font-bold text-foreground">
                                &quot;{currentPersona?.name}&quot;
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
                            onClick={confirmDelete}
                        >
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
