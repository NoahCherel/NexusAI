'use client';

/**
 * Scene Mode (Troupe) control bar: per-conversation 🎬 toggle, on-stage roster chips
 * (click removes), and "advance the scene" (a Director beat with no player input —
 * narration / NPC initiative / time passing).
 */

import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, Play, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useChatStore } from '@/stores/chat-store';
import { USER_REL_KEY } from '@/types/chat';
import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import { getActiveCanonNames, resolveWork } from '@/lib/ai/canon-context';
import { getCanonDossiersByWork } from '@/lib/db';

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
    const { setSceneMode, setSceneRoster, setSceneStyle } = useChatStore();
    const [newName, setNewName] = useState('');
    const [showAdd, setShowAdd] = useState(false);
    // Known character names for typo-proof roster additions: canonCast + canon dossiers
    // of the work + names seen in the relationship system.
    const [dossierNames, setDossierNames] = useState<string[]>([]);
    useEffect(() => {
        const work = character ? resolveWork(character) : undefined;
        if (!work) return;
        let cancelled = false;
        getCanonDossiersByWork(work)
            .then((dossiers) => {
                if (!cancelled) setDossierNames(dossiers.map((d) => d.character));
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [character]);

    const rosterSource = conversation?.sceneRoster;
    const roster = useMemo(() => rosterSource ?? [], [rosterSource]);
    const knownNames = useMemo(() => {
        const inRoster = new Set(roster.map((n) => n.toLowerCase()));
        const all = [
            ...(character.canonCast ?? []),
            ...dossierNames,
            ...(conversation?.relationships ?? [])
                .flatMap((r) => [r.from, r.to])
                .filter((n) => n !== USER_REL_KEY),
        ];
        const seen = new Set<string>();
        return all.filter((n) => {
            const k = n.toLowerCase();
            if (inRoster.has(k) || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    }, [character, dossierNames, conversation?.relationships, roster]);

    const suggestions = useMemo(() => {
        const q = newName.trim().toLowerCase();
        const pool = q ? knownNames.filter((n) => n.toLowerCase().includes(q)) : knownNames;
        return pool.slice(0, 6);
    }, [newName, knownNames]);

    if (!conversation) return null;
    const sceneOn = !!conversation.sceneMode;

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

    const addToRoster = (name: string) => {
        const clean = name.trim();
        if (clean && !roster.some((n) => n.toLowerCase() === clean.toLowerCase())) {
            setSceneRoster(conversation.id, [...roster, clean]);
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
                    {/* Rendering style: separate streamed turns vs one unified passage */}
                    <div className="inline-flex rounded-md border border-border/50 overflow-hidden shrink-0">
                        <button
                            onClick={() => setSceneStyle(conversation.id, 'turns')}
                            className={`px-2 h-6 pointer-coarse:h-9 pointer-coarse:px-3 text-[10px] font-medium transition-colors ${
                                (conversation.sceneStyle ?? 'turns') === 'turns'
                                    ? 'bg-primary/15 text-primary'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                            title="Une bulle par personnage, régénération réplique par réplique"
                        >
                            Tours
                        </button>
                        <button
                            onClick={() => setSceneStyle(conversation.id, 'unified')}
                            className={`px-2 h-6 pointer-coarse:h-9 pointer-coarse:px-3 text-[10px] font-medium transition-colors ${
                                conversation.sceneStyle === 'unified'
                                    ? 'bg-primary/15 text-primary'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                            title="Un seul message fluide qui entrelace narration et répliques (moins cher)"
                        >
                            Unifiée
                        </button>
                    </div>

                    {roster.map((name) => (
                        <span
                            key={name}
                            className="inline-flex items-center gap-1 px-2 h-6 pointer-coarse:h-9 rounded-full bg-primary/10 text-primary text-[11px]"
                        >
                            {name}
                            <button
                                onClick={() => removeFromRoster(name)}
                                className="hover:text-destructive pointer-coarse:p-2 pointer-coarse:-m-1"
                                title={`Retirer ${name} de la scène`}
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}

                    {showAdd ? (
                        <span className="relative inline-block">
                            <Input
                                autoFocus
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        // Enter picks the top suggestion (typo-proof) when
                                        // one matches, else the raw text.
                                        addToRoster(suggestions[0] ?? newName);
                                    }
                                    if (e.key === 'Escape') setShowAdd(false);
                                }}
                                onBlur={() => {
                                    // Delay so a suggestion mousedown can win over blur.
                                    setTimeout(() => setShowAdd(false), 150);
                                }}
                                placeholder="Nom…"
                                className="h-6 pointer-coarse:h-9 w-32 text-[11px] px-2"
                            />
                            {suggestions.length > 0 && (
                                <div className="absolute bottom-full left-0 mb-1 z-50 min-w-40 rounded-lg border border-border/60 bg-popover shadow-xl overflow-hidden">
                                    {suggestions.map((name) => (
                                        <button
                                            key={name}
                                            // mousedown (not click) so it fires before the
                                            // input's blur closes the list.
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                addToRoster(name);
                                            }}
                                            className="block w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-primary/10 hover:text-primary"
                                        >
                                            {name}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </span>
                    ) : (
                        <button
                            onClick={() => setShowAdd(true)}
                            className="text-[11px] text-muted-foreground hover:text-foreground px-1 pointer-coarse:h-9 pointer-coarse:px-3"
                        >
                            + ajouter
                        </button>
                    )}

                    <div className="flex-1" />
                    <Button
                        variant="secondary"
                        size="sm"
                        className="h-7 gap-1.5 text-xs shrink-0 max-sm:w-full max-sm:h-9"
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
