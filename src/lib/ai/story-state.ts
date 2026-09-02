import type { CanonDossier } from '@/types/canon';
import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type { CharacterRef, SceneTransition, StoryParticipant, StoryState } from '@/types/scene';
import { getAllCharacters, getCanonDossiersByWork, getStoryState } from '@/lib/db';
import { resolveWork } from '@/lib/ai/canon-context';

const normalizeName = (value: string) => value.trim().toLocaleLowerCase();

export interface ResolvedCharacterProfile {
    ref: CharacterRef;
    description: string;
    personality?: string;
    scenario?: string;
    canon?: CanonDossier;
}

export class AmbiguousCharacterError extends Error {
    constructor(
        readonly characterName: string,
        readonly candidates: CharacterRef[]
    ) {
        super(`Nom ambigu « ${characterName} » : choisissez le profil à utiliser.`);
        this.name = 'AmbiguousCharacterError';
    }
}

function cardProfile(
    card: CharacterCard,
    source: 'root-card' | 'character-card'
): ResolvedCharacterProfile {
    return {
        ref: {
            id: `card:${card.id}`,
            source,
            sourceId: card.id,
            displayName: card.displayName || card.name,
            aliases: card.displayName && card.displayName !== card.name ? [card.name] : undefined,
            readiness: 'ready',
        },
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
    };
}

function canonProfile(work: string, dossier: CanonDossier): ResolvedCharacterProfile {
    return {
        ref: {
            id: `canon:${normalizeName(work)}:${normalizeName(dossier.character)}`,
            source: 'canon-dossier',
            sourceId: `${normalizeName(work)}::${normalizeName(dossier.character)}`,
            displayName: dossier.character,
            readiness: dossier.stub ? 'stub' : 'ready',
        },
        description: [dossier.identity, dossier.backstory].filter(Boolean).join('\n'),
        canon: dossier,
    };
}

function adHocProfile(name: string): ResolvedCharacterProfile {
    return {
        ref: {
            id: `adhoc:${normalizeName(name)}`,
            source: 'ad-hoc',
            displayName: name.trim(),
            readiness: 'stub',
        },
        description: '',
    };
}

/** Ready offstage profiles the beat director may admit into the current scene. */
export async function resolveSceneEntryCandidates(
    rootCharacter: CharacterCard
): Promise<ResolvedCharacterProfile[]> {
    const work = resolveWork(rootCharacter);
    const [cards, dossiers] = await Promise.all([
        getAllCharacters(),
        work ? getCanonDossiersByWork(work) : Promise.resolve([]),
    ]);
    const cardNames = new Map<string, CharacterCard[]>();
    for (const card of cards) {
        const name = normalizeName(card.displayName || card.name);
        cardNames.set(name, [...(cardNames.get(name) ?? []), card]);
    }

    const profiles: ResolvedCharacterProfile[] = [];
    for (const group of cardNames.values()) {
        // Ambiguous names need a user choice; do not silently advertise either card.
        if (group.length !== 1) continue;
        const card = group[0];
        profiles.push(
            cardProfile(card, card.id === rootCharacter.id ? 'root-card' : 'character-card')
        );
    }
    const namesWithCards = new Set(
        profiles.map((profile) => normalizeName(profile.ref.displayName))
    );
    for (const dossier of dossiers) {
        if (dossier.stub || namesWithCards.has(normalizeName(dossier.character))) continue;
        profiles.push(canonProfile(work, dossier));
    }
    return profiles;
}

/** Resolve once per beat; IDs, not names, are authoritative after this boundary. */
export async function resolveSceneCharacters(
    roster: Array<string | CharacterRef>,
    rootCharacter: CharacterCard,
    overrides: Record<string, CharacterRef> = {}
): Promise<ResolvedCharacterProfile[]> {
    const [cards, dossiers] = await Promise.all([
        getAllCharacters(),
        resolveWork(rootCharacter)
            ? getCanonDossiersByWork(resolveWork(rootCharacter))
            : Promise.resolve([]),
    ]);
    const work = resolveWork(rootCharacter);

    const resolveExplicit = (ref: CharacterRef): ResolvedCharacterProfile | undefined => {
        if (ref.source === 'root-card' && ref.sourceId === rootCharacter.id) {
            return cardProfile(rootCharacter, 'root-card');
        }
        if (ref.source === 'character-card' && ref.sourceId) {
            const exactCard = cards.find((card) => card.id === ref.sourceId);
            if (exactCard) return cardProfile(exactCard, 'character-card');
        }
        if (ref.source === 'canon-dossier') {
            const exactDossier = dossiers.find(
                (candidate) =>
                    `canon:${normalizeName(work)}:${normalizeName(candidate.character)}` === ref.id
            );
            if (exactDossier) return canonProfile(work, exactDossier);
        }
        if (ref.source === 'ad-hoc') return adHocProfile(ref.displayName);
        return undefined;
    };

    return roster.map((entry) => {
        if (typeof entry !== 'string') {
            const explicit = resolveExplicit(entry);
            if (explicit) return explicit;
        }

        const rawName = typeof entry === 'string' ? entry : entry.displayName;
        const name = normalizeName(rawName);
        const chosen = overrides[name] ? resolveExplicit(overrides[name]) : undefined;
        if (chosen) return chosen;
        // A separate card wins over a dossier. The open root card is intentionally handled
        // later so a dedicated ensemble character card can override a broad RPG root card.
        const separateCards = cards.filter(
            (card) =>
                card.id !== rootCharacter.id &&
                [card.name, card.displayName].some(
                    (candidate) => candidate && normalizeName(candidate) === name
                )
        );
        if (separateCards.length > 1) {
            throw new AmbiguousCharacterError(
                rawName,
                separateCards.map((card) => cardProfile(card, 'character-card').ref)
            );
        }
        if (separateCards[0]) return cardProfile(separateCards[0], 'character-card');

        const dossier = dossiers.find((candidate) => normalizeName(candidate.character) === name);
        if (dossier) return canonProfile(work, dossier);

        if (
            [rootCharacter.name, rootCharacter.displayName].some(
                (candidate) => candidate && normalizeName(candidate) === name
            )
        ) {
            return cardProfile(rootCharacter, 'root-card');
        }
        return adHocProfile(rawName);
    });
}

export function createInitialStoryState(params: {
    conversation: Conversation;
    profiles: ResolvedCharacterProfile[];
    anchorMessageId?: string;
}): StoryState {
    return {
        id: crypto.randomUUID(),
        conversationId: params.conversation.id,
        revision: 1,
        source: 'migration',
        anchorMessageId: params.anchorMessageId,
        scene: {
            participants: params.profiles.map<StoryParticipant>((profile) => ({
                character: profile.ref,
                presence: 'onstage',
                agency: profile.ref.readiness === 'ready' ? 'active' : 'limited',
            })),
        },
        plot: {
            arcWork: params.conversation.arc?.work,
            currentBeat: params.conversation.arc?.currentPosition,
            objective: params.conversation.arc?.nextBeat,
            openThreads: [],
            nextMoves: [],
        },
        locks: {},
        createdAt: Date.now(),
    };
}

/** The SceneBar is an explicit user control, so its roster is authoritative and bypasses locks. */
export function reconcileStoryStateRoster(
    state: StoryState,
    profiles: ResolvedCharacterProfile[]
): StoryState {
    const wanted = new Set(profiles.map((profile) => profile.ref.id));
    const participants = state.scene.participants.map((participant) => ({
        ...participant,
        presence: wanted.has(participant.character.id)
            ? participant.presence
            : ('offstage' as const),
    }));
    for (const profile of profiles) {
        const existing = participants.find(
            (participant) => participant.character.id === profile.ref.id
        );
        if (existing) {
            existing.character = profile.ref;
            if (existing.presence === 'offstage') existing.presence = 'onstage';
        } else {
            participants.push({
                character: profile.ref,
                presence: 'onstage',
                agency: profile.ref.readiness === 'ready' ? 'active' : 'limited',
            });
        }
    }
    return { ...state, scene: { ...state.scene, participants } };
}

/** Resolve the nearest state snapshot on the supplied active branch. */
export async function getStoryStateForBranch(
    conversation: Conversation,
    activeBranch: Message[]
): Promise<StoryState | undefined> {
    for (let index = activeBranch.length - 1; index >= 0; index--) {
        const revisionId = activeBranch[index].storyStateRevisionId;
        if (!revisionId) continue;
        const state = await getStoryState(revisionId);
        if (state) return state;
    }
    return conversation.activeStoryStateRevisionId
        ? getStoryState(conversation.activeStoryStateRevisionId)
        : undefined;
}

const isLocked = (state: StoryState, path: string, origin: SceneTransition['origin']) =>
    origin === 'planned' && !!state.locks[path];

/** Pure transition reducer. Planned AI effects respect locks; observed user facts outrank them. */
export function applyStoryTransitions(
    state: StoryState,
    transitions: SceneTransition[],
    knownCharacters: CharacterRef[] = []
): StoryState {
    let location = state.scene.location;
    let summary = state.scene.summary;
    const participants = state.scene.participants.map((participant) => ({ ...participant }));

    const findParticipant = (transition: SceneTransition) => {
        const byId = transition.characterRefId
            ? participants.find((p) => p.character.id === transition.characterRefId)
            : undefined;
        if (byId) return byId;
        const wanted = normalizeName(transition.characterName || '');
        return participants.find(
            (p) =>
                normalizeName(p.character.displayName) === wanted ||
                p.character.aliases?.some((alias) => normalizeName(alias) === wanted)
        );
    };

    for (const transition of transitions) {
        if (transition.type === 'location') {
            if (
                !isLocked(state, '/scene/location', transition.origin) &&
                transition.value?.trim()
            ) {
                location = transition.value.trim();
            }
            continue;
        }
        if (transition.type === 'event') {
            if (!isLocked(state, '/scene/summary', transition.origin) && transition.value?.trim()) {
                summary = transition.value.trim();
            }
            continue;
        }

        let participant = findParticipant(transition);
        if (!participant && transition.type === 'enter') {
            const ref = knownCharacters.find(
                (candidate) =>
                    candidate.id === transition.characterRefId ||
                    normalizeName(candidate.displayName) ===
                        normalizeName(transition.characterName || '')
            );
            // An unresolved/stub AI entrant is never silently promoted into the active cast.
            if (!ref || (transition.origin === 'planned' && ref.readiness !== 'ready')) continue;
            participant = { character: ref, presence: 'offstage', agency: 'active' };
            participants.push(participant);
        }
        if (!participant) continue;

        const basePath = `/scene/participants/${participant.character.id}`;
        if (transition.type === 'enter') {
            if (!isLocked(state, `${basePath}/presence`, transition.origin)) {
                participant.presence = transition.presence ?? 'onstage';
            }
        } else if (transition.type === 'exit') {
            if (!isLocked(state, `${basePath}/presence`, transition.origin)) {
                participant.presence = 'offstage';
            }
        } else if (transition.type === 'presence' && transition.presence) {
            if (!isLocked(state, `${basePath}/presence`, transition.origin)) {
                participant.presence = transition.presence;
            }
        } else if (transition.type === 'agency' && transition.agency) {
            if (!isLocked(state, `${basePath}/agency`, transition.origin)) {
                participant.agency = transition.agency;
            }
        }
    }

    return {
        ...state,
        scene: { ...state.scene, location, summary, participants },
    };
}

export function createStoryStateRevision(params: {
    previous: StoryState;
    next: StoryState;
    source: StoryState['source'];
    anchorMessageId: string;
    sourceBeatId?: string;
}): StoryState {
    return {
        ...params.next,
        id: crypto.randomUUID(),
        parentRevisionId: params.previous.id,
        revision: params.previous.revision + 1,
        source: params.source,
        anchorMessageId: params.anchorMessageId,
        sourceBeatId: params.sourceBeatId,
        createdAt: Date.now(),
    };
}

export function storyRoster(state: StoryState): string[] {
    return state.scene.participants
        .filter((participant) => participant.presence !== 'offstage')
        .map((participant) => participant.character.displayName);
}
