'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Save, User, FileText, MessageSquare, Tags, Sparkles, Folder } from 'lucide-react';
import { useCharacterStore } from '@/stores/character-store';
import { populateCanonRoster } from '@/lib/ai/director';
import { listFolders } from '@/lib/character-folders';
import type { CharacterCard } from '@/types';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog';

interface CharacterEditorProps {
    isOpen: boolean;
    onClose: () => void;
    character?: CharacterCard | null; // null = create new, CharacterCard = edit existing
}

export function CharacterEditor({ isOpen, onClose, character }: CharacterEditorProps) {
    const { addCharacter, updateCharacter, characters } = useCharacterStore();
    const isEditing = !!character;
    const existingFolders = listFolders(characters);

    const [formData, setFormData] = useState({
        name: '',
        displayName: '',
        folder: '',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: '',
        tags: '',
        avatar: '',
        work: '',
    });

    const [isSaving, setIsSaving] = useState(false);

    // Populate form when editing
    useEffect(() => {
        if (character) {
            setFormData({
                name: character.name || '',
                displayName: character.displayName || '',
                folder: character.folder || '',
                description: character.description || '',
                personality: character.personality || '',
                scenario: character.scenario || '',
                first_mes: character.first_mes || '',
                mes_example: character.mes_example || '',
                system_prompt: character.system_prompt || '',
                tags: character.tags?.join(', ') || '',
                avatar: character.avatar || '',
                work: character.work || '',
            });
        } else {
            // Reset for new character
            setFormData({
                name: '',
                displayName: '',
                folder: '',
                description: '',
                personality: '',
                scenario: '',
                first_mes: '',
                mes_example: '',
                system_prompt: '',
                tags: '',
                avatar: '',
                work: '',
            });
        }
    }, [character, isOpen]);

    const handleSave = async () => {
        if (!formData.name.trim()) return;

        setIsSaving(true);
        try {
            const tags = formData.tags
                .split(',')
                .map((t) => t.trim())
                .filter((t) => t.length > 0);

            const workNow = formData.work.trim();
            const folderNow = formData.folder.trim() || undefined;
            const workChanged = isEditing ? workNow !== (character?.work || '') : !!workNow;
            let savedCard: CharacterCard;

            if (isEditing && character) {
                // Update existing character
                savedCard = {
                    ...character,
                    name: formData.name,
                    displayName: formData.displayName,
                    folder: folderNow,
                    description: formData.description,
                    personality: formData.personality,
                    scenario: formData.scenario,
                    first_mes: formData.first_mes,
                    mes_example: formData.mes_example,
                    system_prompt: formData.system_prompt,
                    tags,
                    avatar: formData.avatar,
                    work: workNow || undefined,
                };
                await updateCharacter(character.id, {
                    name: savedCard.name,
                    displayName: savedCard.displayName,
                    folder: savedCard.folder,
                    description: savedCard.description,
                    personality: savedCard.personality,
                    scenario: savedCard.scenario,
                    first_mes: savedCard.first_mes,
                    mes_example: savedCard.mes_example,
                    system_prompt: savedCard.system_prompt,
                    tags,
                    avatar: savedCard.avatar,
                    work: savedCard.work,
                });
            } else {
                // Create new character
                savedCard = {
                    id: crypto.randomUUID(),
                    name: formData.name,
                    displayName: formData.displayName,
                    folder: folderNow,
                    description: formData.description,
                    personality: formData.personality,
                    scenario: formData.scenario,
                    first_mes: formData.first_mes,
                    mes_example: formData.mes_example,
                    system_prompt: formData.system_prompt,
                    tags,
                    avatar: formData.avatar,
                    work: workNow || undefined,
                    creator: 'User',
                    creator_notes: '',
                    character_book: { entries: [] },
                };
                await addCharacter(savedCard);
            }

            // Auto pre-fill the canon cast roster when the Work is set/changed (one cheap web call).
            if (workNow && workChanged) {
                populateCanonRoster(savedCard)
                    .then((n) => console.log(`[Canon] Roster pre-filled: ${n} characters for ${workNow}`))
                    .catch((e) => console.error('[Canon] Roster pre-fill failed:', e));
            }

            onClose();
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl max-h-[90vh] p-0 overflow-hidden flex flex-col max-sm:w-screen max-sm:max-w-none max-sm:h-dvh max-sm:max-h-none max-sm:rounded-none max-sm:border-0 max-sm:top-0 max-sm:left-0 max-sm:translate-x-0 max-sm:translate-y-0">
                <DialogHeader className="p-4 border-b bg-muted/30 shrink-0">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                                <User className="w-5 h-5 text-primary" />
                            </div>
                            <DialogTitle className="text-lg font-bold">
                                {isEditing ? 'Modifier le personnage' : 'Créer un personnage'}
                            </DialogTitle>
                        </div>
                    </div>
                </DialogHeader>
                <DialogDescription className="sr-only">
                    {isEditing
                        ? 'Modifiez votre carte de personnage ici.'
                        : 'Créez une nouvelle carte de personnage.'}
                </DialogDescription>

                <div className="flex-1 overflow-y-auto px-4">
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label
                                htmlFor="name"
                                className="flex items-center gap-2 text-sm font-medium"
                            >
                                <User className="w-4 h-4" /> Nom *
                            </Label>
                            <Input
                                id="name"
                                value={formData.name}
                                onChange={(e) =>
                                    setFormData((prev) => ({ ...prev, name: e.target.value }))
                                }
                                placeholder="Nom du personnage (utilisé dans le chat)"
                                className="bg-background/50"
                            />
                        </div>

                        {/* Display Name */}
                        <div className="space-y-2">
                            <Label
                                htmlFor="displayName"
                                className="flex items-center gap-2 text-sm font-medium"
                            >
                                <Tags className="w-4 h-4" /> Étiquette système (optionnel)
                            </Label>
                            <Input
                                id="displayName"
                                value={formData.displayName}
                                onChange={(e) =>
                                    setFormData((prev) => ({
                                        ...prev,
                                        displayName: e.target.value,
                                    }))
                                }
                                placeholder="Étiquette d'interface (ex. 'Goku (Super)') — visible uniquement par vous"
                                className="bg-background/50"
                            />
                        </div>

                        {/* Folder */}
                        <div className="space-y-2">
                            <Label
                                htmlFor="folder"
                                className="flex items-center gap-2 text-sm font-medium"
                            >
                                <Folder className="w-4 h-4" /> Dossier (optionnel)
                            </Label>
                            <Input
                                id="folder"
                                list="folder-suggestions"
                                value={formData.folder}
                                onChange={(e) =>
                                    setFormData((prev) => ({ ...prev, folder: e.target.value }))
                                }
                                placeholder="Regroupe les variantes (ex. 'Goku') dans un widget ouvrable"
                                className="bg-background/50"
                            />
                            {existingFolders.length > 0 && (
                                <datalist id="folder-suggestions">
                                    {existingFolders.map((f) => (
                                        <option key={f} value={f} />
                                    ))}
                                </datalist>
                            )}
                        </div>

                        {/* Description */}
                        <div className="space-y-2">
                            <Label
                                htmlFor="description"
                                className="flex items-center gap-2 text-sm font-medium"
                            >
                                <FileText className="w-4 h-4" /> Description
                            </Label>
                            <Textarea
                                id="description"
                                value={formData.description}
                                onChange={(e) =>
                                    setFormData((prev) => ({
                                        ...prev,
                                        description: e.target.value,
                                    }))
                                }
                                placeholder="Description et passé du personnage…"
                                className="min-h-[80px] bg-background/50"
                            />
                        </div>

                        {/* Personality */}
                        <div className="space-y-2">
                            <Label
                                htmlFor="personality"
                                className="flex items-center gap-2 text-sm font-medium"
                            >
                                <Sparkles className="w-4 h-4" /> Personnalité
                            </Label>
                            <Textarea
                                id="personality"
                                value={formData.personality}
                                onChange={(e) =>
                                    setFormData((prev) => ({
                                        ...prev,
                                        personality: e.target.value,
                                    }))
                                }
                                placeholder="Traits de personnalité, manies, tics de langage…"
                                className="min-h-[80px] bg-background/50"
                            />
                        </div>

                        {/* Scenario */}
                        <div className="space-y-2">
                            <Label htmlFor="scenario" className="text-sm font-medium">
                                Scénario
                            </Label>
                            <Textarea
                                id="scenario"
                                value={formData.scenario}
                                onChange={(e) =>
                                    setFormData((prev) => ({ ...prev, scenario: e.target.value }))
                                }
                                placeholder="Le cadre ou la situation du roleplay…"
                                className="min-h-[60px] bg-background/50"
                            />
                        </div>

                        {/* First Message */}
                        <div className="space-y-2">
                            <Label
                                htmlFor="first_mes"
                                className="flex items-center gap-2 text-sm font-medium"
                            >
                                <MessageSquare className="w-4 h-4" /> Premier message
                            </Label>
                            <Textarea
                                id="first_mes"
                                value={formData.first_mes}
                                onChange={(e) =>
                                    setFormData((prev) => ({ ...prev, first_mes: e.target.value }))
                                }
                                placeholder="Le message d'ouverture du personnage…"
                                className="min-h-[100px] bg-background/50"
                            />
                        </div>

                        {/* Example Messages */}
                        <div className="space-y-2">
                            <Label htmlFor="mes_example" className="text-sm font-medium">
                                Dialogues d&apos;exemple
                            </Label>
                            <Textarea
                                id="mes_example"
                                value={formData.mes_example}
                                onChange={(e) =>
                                    setFormData((prev) => ({
                                        ...prev,
                                        mes_example: e.target.value,
                                    }))
                                }
                                placeholder="Format de dialogue d'exemple ({{user}}: / {{char}}:)…"
                                className="min-h-[80px] bg-background/50 font-mono text-xs"
                            />
                        </div>

                        {/* System Prompt */}
                        <div className="space-y-2">
                            <Label htmlFor="system_prompt" className="text-sm font-medium">
                                System prompt de la carte
                            </Label>
                            <Textarea
                                id="system_prompt"
                                value={formData.system_prompt}
                                onChange={(e) =>
                                    setFormData((prev) => ({
                                        ...prev,
                                        system_prompt: e.target.value,
                                    }))
                                }
                                placeholder="System prompt personnalisé (optionnel)…"
                                className="min-h-[60px] bg-background/50"
                            />
                            <p className="text-xs text-muted-foreground">
                                Réellement injecté à la place du template du preset.{' '}
                                {'{{original}}'} insère le template du preset à cet endroit.
                            </p>
                        </div>

                        {/* Tags */}
                        <div className="space-y-2">
                            <Label
                                htmlFor="tags"
                                className="flex items-center gap-2 text-sm font-medium"
                            >
                                <Tags className="w-4 h-4" /> Tags
                            </Label>
                            <Input
                                id="tags"
                                value={formData.tags}
                                onChange={(e) =>
                                    setFormData((prev) => ({ ...prev, tags: e.target.value }))
                                }
                                placeholder="fantasy, romance, adventure (séparés par des virgules)"
                                className="bg-background/50"
                            />
                        </div>

                        {/* Work (for whole-work RPG cards: enables the Canon Codex) */}
                        <div className="space-y-2">
                            <Label
                                htmlFor="work"
                                className="flex items-center gap-2 text-sm font-medium"
                            >
                                <FileText className="w-4 h-4" /> Œuvre (canon)
                            </Label>
                            <Input
                                id="work"
                                value={formData.work}
                                onChange={(e) =>
                                    setFormData((prev) => ({ ...prev, work: e.target.value }))
                                }
                                placeholder="ex. Naruto, Bleach — active la récupération du canon (laisser vide pour auto-déduire)"
                                className="bg-background/50"
                            />
                        </div>

                        {/* Avatar URL */}
                        <div className="space-y-2">
                            <Label htmlFor="avatar" className="text-sm font-medium">
                                Avatar URL
                            </Label>
                            <Input
                                id="avatar"
                                value={formData.avatar}
                                onChange={(e) =>
                                    setFormData((prev) => ({ ...prev, avatar: e.target.value }))
                                }
                                placeholder="https://example.com/avatar.png"
                                className="bg-background/50"
                            />
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t bg-muted/10 flex gap-2 shrink-0">
                    <Button variant="ghost" className="flex-1" onClick={onClose}>
                        Annuler
                    </Button>
                    <Button
                        className="flex-1 gap-2"
                        onClick={handleSave}
                        disabled={!formData.name.trim() || isSaving}
                    >
                        <Save className="w-4 h-4" />
                        {isSaving ? 'Enregistrement…' : isEditing ? 'Enregistrer' : 'Créer'}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
