'use client';

/**
 * Scene Mode (Troupe) control bar: per-conversation 🎬 toggle, on-stage roster chips
 * (click removes), and "advance the scene" (a Director beat with no player input —
 * narration / NPC initiative / time passing).
 */

import { useState } from 'react';
import { Clapperboard, Play, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useChatStore } from '@/stores/chat-store';
import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import { getActiveCanonNames } from '@/lib/ai/canon-context';

export function SceneBar({
    conversation,
    character,
    messages,
    isSceneRunning,
    onAdvanceScene,
}: {
    conversation: Conversation | undefined;
    character: CharacterCard;
    messages: Message[];
    isSceneRunning: boolean;
    onAdvanceScene: () => void;
}) {
    const { setSceneMode, setSceneRoster } = useChatStore();
    const [newName, setNewName] = useState('');
    const [showAdd, setShowAdd] = useState(false);

    if (!conversation) return null;
    const sceneOn = !!conversation.sceneMode;
    const roster = conversation.sceneRoster ?? [];

    const toggleScene = () => {
        if (!sceneOn) {
            // Seed the roster: canon names active in the recent scene, else the whole
            // canonCast (capped), else the card's main character.
            if (roster.length === 0) {
                const active = getActiveCanonNames(character, conversation, messages, 20);
                const seed =
                    active.length > 0
                        ? active
                        : (character.canonCast ?? []).slice(0, 4).length > 0
                          ? (character.canonCast ?? []).slice(0, 4)
                          : [character.name];
                setSceneRoster(conversation.id, seed);
            }
            setSceneMode(conversation.id, true);
        } else {
            setSceneMode(conversation.id, false);
        }
    };

    const removeFromRoster = (name: string) => {
        setSceneRoster(
            conversation.id,
            roster.filter((n) => n !== name)
        );
    };

    const addToRoster = () => {
        const name = newName.trim();
        if (name && !roster.some((n) => n.toLowerCase() === name.toLowerCase())) {
            setSceneRoster(conversation.id, [...roster, name]);
        }
        setNewName('');
        setShowAdd(false);
    };

    return (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/40 bg-card/30 flex-wrap">
            <Button
                variant={sceneOn ? 'default' : 'ghost'}
                size="sm"
                className="h-7 gap-1.5 text-xs shrink-0"
                onClick={toggleScene}
                title="Mode Troupe : narrateur IA + une réponse par personnage en scène"
            >
                <Clapperboard className="w-3.5 h-3.5" />
                Troupe
            </Button>

            {sceneOn && (
                <>
                    {roster.map((name) => (
                        <span
                            key={name}
                            className="inline-flex items-center gap-1 px-2 h-6 rounded-full bg-primary/10 text-primary text-[11px]"
                        >
                            {name}
                            <button
                                onClick={() => removeFromRoster(name)}
                                className="hover:text-destructive"
                                title={`Retirer ${name} de la scène`}
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}

                    {showAdd ? (
                        <Input
                            autoFocus
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') addToRoster();
                                if (e.key === 'Escape') setShowAdd(false);
                            }}
                            onBlur={addToRoster}
                            placeholder="Nom…"
                            className="h-6 w-28 text-[11px] px-2"
                        />
                    ) : (
                        <button
                            onClick={() => setShowAdd(true)}
                            className="text-[11px] text-muted-foreground hover:text-foreground px-1"
                        >
                            + ajouter
                        </button>
                    )}

                    <div className="flex-1" />
                    <Button
                        variant="secondary"
                        size="sm"
                        className="h-7 gap-1.5 text-xs shrink-0"
                        disabled={isSceneRunning || roster.length === 0}
                        onClick={onAdvanceScene}
                        title="Le narrateur fait avancer la scène sans message du joueur"
                    >
                        {isSceneRunning ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Play className="w-3.5 h-3.5" />
                        )}
                        Faire avancer la scène
                    </Button>
                </>
            )}
        </div>
    );
}
