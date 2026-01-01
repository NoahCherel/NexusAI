'use client';

import { useState } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ChevronUp, Plus, Trash2, Edit2, User } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PersonaSelector() {
    const { personas, activePersonaId, setActivePersonaId, addPersona, updatePersona, deletePersona } = useSettingsStore();
    const [open, setOpen] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingPersona, setEditingPersona] = useState<{ id?: string; name: string; bio: string; avatar: string } | null>(null);

    const activePersona = personas.find((p) => p.id === activePersonaId);
    const displayName = activePersona?.name || 'You';
    const displayAvatar = activePersona?.avatar;

    const openCreateDialog = () => {
        setEditingPersona({ name: '', bio: '', avatar: '' });
        setDialogOpen(true);
        setOpen(false);
    };

    const openEditDialog = (persona: typeof personas[0]) => {
        setEditingPersona({ id: persona.id, name: persona.name, bio: persona.bio, avatar: persona.avatar || '' });
        setDialogOpen(true);
        setOpen(false);
    };

    const handleSave = () => {
        if (!editingPersona || !editingPersona.name.trim()) return;

        if (editingPersona.id) {
            // Update existing
            updatePersona(editingPersona.id, {
                name: editingPersona.name.trim(),
                bio: editingPersona.bio,
                avatar: editingPersona.avatar,
            });
        } else {
            // Create new
            const id = crypto.randomUUID();
            addPersona({
                id,
                name: editingPersona.name.trim(),
                bio: editingPersona.bio,
                avatar: editingPersona.avatar,
            });
            setActivePersonaId(id);
        }
        setDialogOpen(false);
        setEditingPersona(null);
    };

    const handleDelete = (id: string) => {
        deletePersona(id);
        if (activePersonaId === id) {
            setActivePersonaId(null);
        }
    };

    return (
        <>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                        <Avatar className="h-5 w-5 border border-border/50">
                            <AvatarImage src={displayAvatar} className="object-cover" />
                            <AvatarFallback className="text-[9px] bg-primary/10 text-primary">
                                {displayName[0].toUpperCase()}
                            </AvatarFallback>
                        </Avatar>
                        <span className="max-w-[80px] truncate">{displayName}</span>
                        <ChevronUp className="h-3 w-3 opacity-50" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[220px] p-2" align="start" side="top" sideOffset={8}>
                    <div className="space-y-1">
                        <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            Select Persona
                        </div>
                        {personas.map((persona) => (
                            <div
                                key={persona.id}
                                className={cn(
                                    "flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-muted transition-colors group",
                                    activePersonaId === persona.id && "bg-muted"
                                )}
                            >
                                <div
                                    className="flex-1 flex items-center gap-2"
                                    onClick={() => { setActivePersonaId(persona.id); setOpen(false); }}
                                >
                                    <Avatar className="h-5 w-5">
                                        <AvatarImage src={persona.avatar} />
                                        <AvatarFallback className="text-[9px]">{persona.name[0].toUpperCase()}</AvatarFallback>
                                    </Avatar>
                                    <div className="flex-1 min-w-0">
                                        <span className="text-xs font-medium truncate block">{persona.name}</span>
                                        {persona.bio && <span className="text-[10px] text-muted-foreground truncate block">{persona.bio}</span>}
                                    </div>
                                </div>
                                <div className="hidden group-hover:flex items-center gap-0.5">
                                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => openEditDialog(persona)}>
                                        <Edit2 className="h-2.5 w-2.5" />
                                    </Button>
                                    <Button variant="ghost" size="icon" className="h-5 w-5 hover:text-destructive" onClick={() => handleDelete(persona.id)}>
                                        <Trash2 className="h-2.5 w-2.5" />
                                    </Button>
                                </div>
                            </div>
                        ))}

                        {personas.length === 0 && (
                            <div className="px-2 py-3 text-xs text-muted-foreground italic text-center">
                                No personas yet
                            </div>
                        )}

                        <Button variant="ghost" size="sm" className="w-full justify-start gap-2 h-7 text-xs" onClick={openCreateDialog}>
                            <Plus className="h-3 w-3" />
                            New Persona
                        </Button>
                    </div>
                </PopoverContent>
            </Popover>

            {/* Create/Edit Dialog */}
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{editingPersona?.id ? 'Edit Persona' : 'Create Persona'}</DialogTitle>
                        <DialogDescription>
                            Configure your persona's identity. The AI will adopt this persona during the conversation.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Name</label>
                            <Input
                                placeholder="Your character name..."
                                value={editingPersona?.name || ''}
                                onChange={(e) => setEditingPersona(prev => prev ? { ...prev, name: e.target.value } : null)}
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Biography / Description</label>
                            <textarea
                                className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                placeholder="Describe your persona... (The AI will see this as your character)"
                                value={editingPersona?.bio || ''}
                                onChange={(e) => setEditingPersona(prev => prev ? { ...prev, bio: e.target.value } : null)}
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Avatar URL (optional)</label>
                            <Input
                                placeholder="https://example.com/avatar.png"
                                value={editingPersona?.avatar || ''}
                                onChange={(e) => setEditingPersona(prev => prev ? { ...prev, avatar: e.target.value } : null)}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSave} disabled={!editingPersona?.name.trim()}>
                            {editingPersona?.id ? 'Save Changes' : 'Create'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
