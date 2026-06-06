'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog';
import { Clapperboard, UserPlus, Loader2, Sparkles } from 'lucide-react';
import { useCharacterStore } from '@/stores/character-store';
import { useChatStore } from '@/stores/chat-store';
import { createCanonCharacter, proposeScenes } from '@/lib/ai/director';
import type { CanonDossier } from '@/types/canon';

interface DirectorPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

export function DirectorPanel({ isOpen, onClose }: DirectorPanelProps) {
    const { getActiveCharacter } = useCharacterStore();
    const { conversations, activeConversationId, updateArc } = useChatStore();
    const character = getActiveCharacter();
    const conversation = conversations.find((c) => c.id === activeConversationId);

    const [name, setName] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [createdDossier, setCreatedDossier] = useState<CanonDossier | null>(null);
    const [createStatus, setCreateStatus] = useState('');

    const [isProposing, setIsProposing] = useState(false);
    const [scenes, setScenes] = useState<string[]>([]);

    const handleCreate = async () => {
        if (!character || !name.trim()) return;
        setIsCreating(true);
        setCreateStatus('Récupération du canon (web)…');
        setCreatedDossier(null);
        try {
            const dossier = await createCanonCharacter(character, conversation, name.trim());
            if (dossier) {
                setCreatedDossier(dossier);
                setCreateStatus(`${dossier.character} ajouté au casting (canon à ${dossier.timelineCap}).`);
                setName('');
            } else {
                setCreateStatus('Échec — vérifie l’œuvre et ta clé OpenRouter.');
            }
        } catch {
            setCreateStatus('Échec de la récupération.');
        } finally {
            setIsCreating(false);
        }
    };

    const handlePropose = async () => {
        if (!character) return;
        setIsProposing(true);
        setScenes([]);
        try {
            setScenes(await proposeScenes(character, conversation));
        } finally {
            setIsProposing(false);
        }
    };

    const applySceneAsNextBeat = (scene: string) => {
        if (!activeConversationId) return;
        updateArc(activeConversationId, {
            ...(conversation?.arc || {}),
            enabled: true,
            nextBeat: scene,
        });
        setCreateStatus('Scène définie comme prochain beat (onglet Arc).');
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="w-[calc(100vw-2rem)] max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Clapperboard className="w-5 h-5 text-primary" />
                        Directeur
                    </DialogTitle>
                    <DialogDescription>
                        Instancie des personnages canoniques au sein de cette carte-œuvre et propose la
                        suite, en respectant le canon.
                    </DialogDescription>
                </DialogHeader>

                {/* Create canonical character */}
                <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-primary">
                        <UserPlus className="w-4 h-4" />
                        Faire entrer un personnage canonique
                    </div>
                    <div className="flex gap-2">
                        <Input
                            placeholder="Nom canonique (ex. Rukia Kuchiki)"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                            className="text-sm"
                        />
                        <Button onClick={handleCreate} disabled={isCreating || !name.trim()} size="sm">
                            {isCreating ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                'Créer'
                            )}
                        </Button>
                    </div>
                    {createStatus && (
                        <p className="text-xs text-muted-foreground">{createStatus}</p>
                    )}
                    {createdDossier && (
                        <div className="text-xs bg-muted/30 rounded-lg p-3 space-y-1">
                            <p className="font-medium">{createdDossier.character}</p>
                            <p className="text-muted-foreground line-clamp-4">
                                {createdDossier.identity}
                            </p>
                        </div>
                    )}
                </div>

                {/* Propose scenes */}
                <div className="space-y-3 border-t pt-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-medium text-primary">
                            <Sparkles className="w-4 h-4" />
                            Proposer la suite (3 scènes)
                        </div>
                        <Button
                            onClick={handlePropose}
                            disabled={isProposing}
                            variant="outline"
                            size="sm"
                        >
                            {isProposing ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                'Proposer'
                            )}
                        </Button>
                    </div>
                    <div className="space-y-2">
                        {scenes.map((scene, i) => (
                            <button
                                key={i}
                                onClick={() => applySceneAsNextBeat(scene)}
                                className="w-full text-left text-sm bg-muted/30 hover:bg-muted/60 rounded-lg p-3 transition-colors"
                                title="Définir comme prochain beat"
                            >
                                {scene}
                            </button>
                        ))}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
