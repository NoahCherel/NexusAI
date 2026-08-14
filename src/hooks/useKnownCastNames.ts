'use client';

/**
 * The pool of character names we can plausibly suggest for this conversation: the card's
 * canonCast, the canon dossiers of its work (loaded async), and every name already seen in the
 * relationship system.
 *
 * Free-text entry always wins — these are typo-proofing suggestions, not a closed list. That
 * distinction matters: an OC card has no canonCast and no dossiers, so a UI that only offers
 * this pool can't create anything at all.
 */

import { useEffect, useMemo, useState } from 'react';
import { USER_REL_KEY } from '@/types/chat';
import type { CharacterCard } from '@/types/character';
import type { Conversation } from '@/types/chat';
import { resolveWork } from '@/lib/ai/canon-context';
import { getCanonDossiersByWork } from '@/lib/db';

export function useKnownCastNames(
    character: CharacterCard | null | undefined,
    conversation: Conversation | undefined
): string[] {
    const work = character ? resolveWork(character) : '';
    // Tagged with the work it was loaded for, so switching cards discards the stale list
    // without needing a reset setState in the effect body.
    const [loaded, setLoaded] = useState<{ work: string; names: string[] }>({
        work: '',
        names: [],
    });

    useEffect(() => {
        if (!work) return;
        let cancelled = false;
        getCanonDossiersByWork(work)
            .then((dossiers) => {
                if (!cancelled) setLoaded({ work, names: dossiers.map((d) => d.character) });
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [work]);

    return useMemo(() => {
        const all = [
            ...(character?.name ? [character.name] : []),
            ...(character?.canonCast ?? []),
            ...(loaded.work === work ? loaded.names : []),
            ...(conversation?.relationships ?? [])
                .flatMap((r) => [r.from, r.to])
                .filter((n) => n !== USER_REL_KEY),
        ];
        const seen = new Set<string>();
        return all.filter((n) => {
            const k = n.trim().toLowerCase();
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    }, [character, loaded, work, conversation]);
}
