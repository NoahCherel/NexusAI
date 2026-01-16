'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, Save, User, FileText, MessageSquare, Tags, Sparkles } from 'lucide-react';
import { useCharacterStore } from '@/stores/character-store';
import type { CharacterCard } from '@/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface CharacterEditorProps {
    isOpen: boolean;
    onClose: () => void;
    character?: CharacterCard | null; // null = create new, CharacterCard = edit existing
}

export function CharacterEditor({ isOpen, onClose, character }: CharacterEditorProps) {
    const { addCharacter, updateCharacter } = useCharacterStore();
    const isEditing = !!character;

    const [formData, setFormData] = useState({
        name: '',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: '',
        tags: '',
        avatar: '',
    });

    const [isSaving, setIsSaving] = useState(false);

    // Populate form when editing
    useEffect(() => {
        if (character) {
            setFormData({
                name: character.name || '',
                description: character.description || '',
                personality: character.personality || '',
                scenario: character.scenario || '',
                first_mes: character.first_mes || '',
                mes_example: character.mes_example || '',
                system_prompt: character.system_prompt || '',
                tags: character.tags?.join(', ') || '',
                avatar: character.avatar || '',
            });
        } else {
            // Reset for new character
            setFormData({
                name: '',
                description: '',
                personality: '',
                scenario: '',
                first_mes: '',
                mes_example: '',
                system_prompt: '',
                tags: '',
                avatar: '',
            });
        }
    }, [character, isOpen]);

    const handleSave = async () => {
        if (!formData.name.trim()) return;

        setIsSaving(true);
        try {
            const tags = formData.tags
                .split(',')
                .map(t => t.trim())
                .filter(t => t.length > 0);

            if (isEditing && character) {
                // Update existing character
                await updateCharacter(character.id, {
                    name: formData.name,
                    description: formData.description,
                    personality: formData.personality,
                    scenario: formData.scenario,
                    first_mes: formData.first_mes,
                    mes_example: formData.mes_example,
                    system_prompt: formData.system_prompt,
                    tags,
                    avatar: formData.avatar,
                });
            } else {
                // Create new character
                const newCharacter: CharacterCard = {
                    id: crypto.randomUUID(),
                    name: formData.name,
                    description: formData.description,
                    personality: formData.personality,
                    scenario: formData.scenario,
                    first_mes: formData.first_mes,
                    mes_example: formData.mes_example,
                    system_prompt: formData.system_prompt,
                    tags,
                    avatar: formData.avatar,
                    creator: 'User',
                    creator_notes: '',
                    character_version: '1.0',
                    post_history_instructions: '',
                    alternate_greetings: [],
                    character_book: { entries: [] },
                    extensions: {},
                };
                await addCharacter(newCharacter);
            }
            onClose();
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl max-h-[90vh] p-0 overflow-hidden flex flex-col">
                <DialogHeader className="p-4 border-b bg-muted/30 shrink-0">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                                <User className="w-5 h-5 text-primary" />
                            </div>
                            <DialogTitle className="text-lg font-bold">
                                {isEditing ? 'Edit Character' : 'Create Character'}
                            </DialogTitle>
                        </div>
                    </div>
                </DialogHeader>

                <div className="flex-1 overflow-y-auto px-4">
                    <div className="space-y-4 py-4">
                        {/* Name */}
                        <div className="space-y-2">
                            <Label htmlFor="name" className="flex items-center gap-2 text-sm font-medium">
                                <User className="w-4 h-4" /> Name *
                            </Label>
                            <Input
                                id="name"
                                value={formData.name}
                                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                                placeholder="Character name"
                                className="bg-background/50"
                            />
                        </div>

                        {/* Description */}
                        <div className="space-y-2">
                            <Label htmlFor="description" className="flex items-center gap-2 text-sm font-medium">
                                <FileText className="w-4 h-4" /> Description
                            </Label>
                            <Textarea
                                id="description"
                                value={formData.description}
                                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                                placeholder="Character description and backstory..."
                                className="min-h-[80px] bg-background/50"
                            />
                        </div>

                        {/* Personality */}
                        <div className="space-y-2">
                            <Label htmlFor="personality" className="flex items-center gap-2 text-sm font-medium">
                                <Sparkles className="w-4 h-4" /> Personality
                            </Label>
                            <Textarea
                                id="personality"
                                value={formData.personality}
                                onChange={(e) => setFormData(prev => ({ ...prev, personality: e.target.value }))}
                                placeholder="Personality traits, quirks, mannerisms..."
                                className="min-h-[80px] bg-background/50"
                            />
                        </div>

                        {/* Scenario */}
                        <div className="space-y-2">
                            <Label htmlFor="scenario" className="text-sm font-medium">Scenario</Label>
                            <Textarea
                                id="scenario"
                                value={formData.scenario}
                                onChange={(e) => setFormData(prev => ({ ...prev, scenario: e.target.value }))}
                                placeholder="The setting or situation for the roleplay..."
                                className="min-h-[60px] bg-background/50"
                            />
                        </div>

                        {/* First Message */}
                        <div className="space-y-2">
                            <Label htmlFor="first_mes" className="flex items-center gap-2 text-sm font-medium">
                                <MessageSquare className="w-4 h-4" /> First Message
                            </Label>
                            <Textarea
                                id="first_mes"
                                value={formData.first_mes}
                                onChange={(e) => setFormData(prev => ({ ...prev, first_mes: e.target.value }))}
                                placeholder="The character's opening message..."
                                className="min-h-[100px] bg-background/50"
                            />
                        </div>

                        {/* Example Messages */}
                        <div className="space-y-2">
                            <Label htmlFor="mes_example" className="text-sm font-medium">Example Messages</Label>
                            <Textarea
                                id="mes_example"
                                value={formData.mes_example}
                                onChange={(e) => setFormData(prev => ({ ...prev, mes_example: e.target.value }))}
                                placeholder="Example dialogue format ({{user}}: / {{char}}:)..."
                                className="min-h-[80px] bg-background/50 font-mono text-xs"
                            />
                        </div>

                        {/* System Prompt */}
                        <div className="space-y-2">
                            <Label htmlFor="system_prompt" className="text-sm font-medium">System Prompt Override</Label>
                            <Textarea
                                id="system_prompt"
                                value={formData.system_prompt}
                                onChange={(e) => setFormData(prev => ({ ...prev, system_prompt: e.target.value }))}
                                placeholder="Custom system prompt (optional)..."
                                className="min-h-[60px] bg-background/50"
                            />
                        </div>

                        {/* Tags */}
                        <div className="space-y-2">
                            <Label htmlFor="tags" className="flex items-center gap-2 text-sm font-medium">
                                <Tags className="w-4 h-4" /> Tags
                            </Label>
                            <Input
                                id="tags"
                                value={formData.tags}
                                onChange={(e) => setFormData(prev => ({ ...prev, tags: e.target.value }))}
                                placeholder="fantasy, romance, adventure (comma separated)"
                                className="bg-background/50"
                            />
                        </div>

                        {/* Avatar URL */}
                        <div className="space-y-2">
                            <Label htmlFor="avatar" className="text-sm font-medium">Avatar URL</Label>
                            <Input
                                id="avatar"
                                value={formData.avatar}
                                onChange={(e) => setFormData(prev => ({ ...prev, avatar: e.target.value }))}
                                placeholder="https://example.com/avatar.png"
                                className="bg-background/50"
                            />
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t bg-muted/10 flex gap-2 shrink-0">
                    <Button variant="ghost" className="flex-1" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        className="flex-1 gap-2"
                        onClick={handleSave}
                        disabled={!formData.name.trim() || isSaving}
                    >
                        <Save className="w-4 h-4" />
                        {isSaving ? 'Saving...' : (isEditing ? 'Save Changes' : 'Create Character')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
