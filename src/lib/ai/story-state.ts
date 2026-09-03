import type { CanonDossier } from '@/types/canon';
import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type {
    CharacterIntent,
    CharacterRef,
    DirectedSceneDecision,
    SceneTransition,
    StoryCharacterState,
    StoryParticipant,
    StoryState,
    ToneBounds,
    CompositionResult,
} from '@/types/scene';
import { getAllCharacters, getCanonDossiersByWork, getStoryState } from '@/lib/db';
import { nameMatchesText, resolveWork } from '@/lib/ai/canon-context';

const normalizeName = (value: string) => value.trim().toLocaleLowerCase();

export interface ResolvedCharacterProfile {
    ref: CharacterRef;
    description: string;
    personality?: string;
    scenario?: string;
    canon?: CanonDossier;
}

export interface CharacterRegistry {
    profiles: ResolvedCharacterProfile[];
    byId: Map<string, ResolvedCharacterProfile>;
    fingerprint: string;
}

export const DEFAULT_TONE_BOUNDS: ToneBounds = {
    humor: [0, 4],
    darkness: [0, 4],
    intimacy: [0, 4],
    intensity: [0, 4],
    forbidden: [],
};

const clampTone = (range: [number, number] | undefined): [number, number] => {
    const min = Math.max(0, Math.min(4, Math.round(range?.[0] ?? 0)));
    const max = Math.max(min, Math.min(4, Math.round(range?.[1] ?? 4)));
    return [min, max];
};

/** Pure lazy migration for records written before directed narrative V2. */
export function normalizeStoryState(state: StoryState): StoryState {
    const tone = state.scene.tone;
    const characters = Object.fromEntries(
        Object.entries(state.characters ?? {}).map(([id, character]) => [
            id,
            { ...character, commitments: character.commitments ?? [] },
        ])
    );
    for (const participant of state.scene.participants) {
        characters[participant.character.id] ??= {
            ref: participant.character,
            commitments: [],
        };
    }
    return {
        ...state,
        scene: {
            ...state.scene,
            tone: {
                humor: clampTone(tone?.humor),
                darkness: clampTone(tone?.darkness),
                intimacy: clampTone(tone?.intimacy),
                intensity: clampTone(tone?.intensity),
                forbidden: (tone?.forbidden ?? []).filter(Boolean),
            },
            rhythm: state.scene.rhythm ?? 'adaptive',
        },
        plot: {
            ...state.plot,
            canonPosition: state.plot.canonPosition ?? state.plot.currentBeat,
            steps: state.plot.steps ?? [],
            castingNeeds: state.plot.castingNeeds ?? [],
            planRevision: state.plot.planRevision ?? 0,
            committedBeatCount: state.plot.committedBeatCount ?? 0,
        },
        characters,
        locks: state.locks ?? {},
    };
}

function generatedProfile(character: StoryCharacterState): ResolvedCharacterProfile {
    return {
        ref: character.ref,
        description: character.publicProfile?.description ?? '',
        personality: character.publicProfile?.personality,
        scenario: character.publicProfile?.scenario,
    };
}

function registryFingerprint(profiles: ResolvedCharacterProfile[]): string {
    const input = profiles
        .map((profile) => `${profile.ref.id}:${profile.ref.readiness}:${profile.description}`)
        .sort()
        .join('|');
    let hash = 2166136261;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `registry:${(hash >>> 0).toString(16)}`;
}

export function buildCharacterRegistry(params: {
    profiles: ResolvedCharacterProfile[];
    state?: StoryState;
    provisional?: StoryCharacterState[];
}): CharacterRegistry {
    const normalized = params.state ? normalizeStoryState(params.state) : undefined;
    const generated = [
        ...Object.values(normalized?.characters ?? {}),
        ...(params.provisional ?? []),
    ].filter((entry) => entry.ref.source === 'generated' && entry.ref.readiness === 'ready');
    const profiles = Array.from(
        new Map(
            [...params.profiles, ...generated.map(generatedProfile)].map(
                (profile) => [profile.ref.id, profile] as const
            )
        ).values()
    );
    return {
        profiles,
        byId: new Map(profiles.map((profile) => [profile.ref.id, profile])),
        fingerprint: registryFingerprint(profiles),
    };
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
    overrides: Record<string, CharacterRef> = {},
    persistedCharacters: Record<string, StoryCharacterState> = {}
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
        if (ref.source === 'generated') {
            const generated = persistedCharacters[ref.id];
            if (generated) return generatedProfile(generated);
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
        const generated = Object.values(persistedCharacters).find(
            (candidate) => normalizeName(candidate.ref.displayName) === name
        );
        if (generated) return generatedProfile(generated);
        return adHocProfile(rawName);
    });
}

export function createInitialStoryState(params: {
    conversation: Conversation;
    profiles: ResolvedCharacterProfile[];
    anchorMessageId?: string;
}): StoryState {
    return normalizeStoryState({
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
            tone: DEFAULT_TONE_BOUNDS,
            rhythm: 'adaptive',
        },
        plot: {
            arcWork: params.conversation.arc?.work,
            currentBeat: params.conversation.arc?.currentPosition,
            objective: params.conversation.arc?.nextBeat,
            openThreads: [],
            nextMoves: [],
            canonPosition: params.conversation.arc?.currentPosition,
            steps: [],
            castingNeeds: [],
            planRevision: 0,
            committedBeatCount: 0,
        },
        characters: Object.fromEntries(
            params.profiles.map((profile) => [
                profile.ref.id,
                { ref: profile.ref, commitments: [] } satisfies StoryCharacterState,
            ])
        ),
        locks: {},
        createdAt: Date.now(),
    });
}

/** The SceneBar is an explicit user control, so its roster is authoritative and bypasses locks. */
export function reconcileStoryStateRoster(
    state: StoryState,
    profiles: ResolvedCharacterProfile[]
): StoryState {
    state = normalizeStoryState(state);
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
    const characters = { ...(state.characters ?? {}) };
    for (const profile of profiles) {
        characters[profile.ref.id] ??= { ref: profile.ref, commitments: [] };
    }
    return { ...state, scene: { ...state.scene, participants }, characters };
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
        if (state) return normalizeStoryState(state);
    }
    const fallback = conversation.activeStoryStateRevisionId
        ? await getStoryState(conversation.activeStoryStateRevisionId)
        : undefined;
    // The denormalised cache may belong to a beat this branch no longer contains (a regenerate
    // drops the discarded beat, a branch switch changes the path): a revision anchored on a
    // message outside the supplied branch is not this branch's state. Legacy revisions with
    // no anchor keep the historical fallback.
    if (
        fallback?.anchorMessageId &&
        !activeBranch.some((message) => message.id === fallback.anchorMessageId)
    ) {
        return undefined;
    }
    return fallback ? normalizeStoryState(fallback) : undefined;
}

const isLocked = (state: StoryState, path: string, origin: SceneTransition['origin']) =>
    origin === 'planned' && !!state.locks[path];

/** Pure transition reducer. Planned AI effects respect locks; observed user facts outrank them. */
export function applyStoryTransitions(
    state: StoryState,
    transitions: SceneTransition[],
    knownCharacters: CharacterRef[] = []
): StoryState {
    state = normalizeStoryState(state);
    let location = state.scene.location;
    let time = state.scene.time;
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
        if (transition.type === 'time') {
            if (!isLocked(state, '/scene/time', transition.origin) && transition.value?.trim()) {
                time = transition.value.trim();
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

    const characters = { ...(state.characters ?? {}) };
    for (const participant of participants) {
        characters[participant.character.id] ??= {
            ref: participant.character,
            commitments: [],
        };
    }
    return {
        ...state,
        scene: { ...state.scene, location, time, summary, participants },
        characters,
    };
}

/** Applies only compact final motivation deltas and honours user locks and goal inertia. */
export function applyCharacterIntentDeltas(
    state: StoryState,
    intents: CharacterIntent[]
): StoryState {
    state = normalizeStoryState(state);
    const characters = { ...(state.characters ?? {}) };
    for (const intent of intents) {
        const current = characters[intent.characterRefId];
        if (!current || !intent.stateDelta) continue;
        const delta = intent.stateDelta;
        const base = `/characters/${intent.characterRefId}`;
        const next: StoryCharacterState = {
            ...current,
            commitments: [...current.commitments],
        };
        if (delta.stance && !state.locks[`${base}/stance`]) next.stance = delta.stance;
        if (delta.lastInitiative && !state.locks[`${base}/lastInitiative`]) {
            next.lastInitiative = delta.lastInitiative;
        }
        if (!state.locks[`${base}/privateGoal`]) {
            if (delta.clearPrivateGoal) next.privateGoal = undefined;
            else if (delta.privateGoal && (!current.privateGoal || delta.goalChangeReason)) {
                next.privateGoal = delta.privateGoal;
            }
        }
        if (!state.locks[`${base}/commitments`]) {
            const removed = new Set((delta.removeCommitments ?? []).map(normalizeName));
            next.commitments = next.commitments.filter((item) => !removed.has(normalizeName(item)));
            const addition = (delta.addCommitments ?? []).find(
                (item) =>
                    !next.commitments.some(
                        (existing) => normalizeName(existing) === normalizeName(item)
                    )
            );
            if (addition) next.commitments.push(addition);
        }
        characters[intent.characterRefId] = next;
    }
    return { ...state, characters };
}

export function applyCommittedNarrativeProgress(
    state: StoryState,
    composition: CompositionResult,
    decision?: Pick<DirectedSceneDecision, 'beatKind' | 'initiativeOwner'>
): StoryState {
    state = normalizeStoryState(state);
    const signals = composition.stepSignals ?? [];
    // A user lock on the steps freezes their status: evidence is still recorded, nothing
    // resolves or activates on its own.
    const stepsLocked = !!state.locks['/plot/steps'];
    const steps = (state.plot.steps ?? []).map((step) => {
        const evidence = signals
            .filter((signal) => signal.stepId === step.id)
            .map((signal) => signal.evidence);
        if (!evidence.length || step.status !== 'active') return step;
        return {
            ...step,
            status: stepsLocked ? step.status : ('resolved' as const),
            visibleEvidence: Array.from(new Set([...step.visibleEvidence, ...evidence])),
        };
    });
    const activeStep = steps.find((step) => step.status === 'active');
    const nextPlanned = steps.find(
        (step) =>
            step.status === 'planned' &&
            step.prerequisites.every((id) =>
                steps.some((candidate) => candidate.id === id && candidate.status === 'resolved')
            )
    );
    if (!stepsLocked && !activeStep && nextPlanned) nextPlanned.status = 'active';

    const characters = { ...(state.characters ?? {}) };
    const narration = composition.narration?.toLocaleLowerCase() ?? '';
    const visibleIds = new Set(composition.turns.map((turn) => turn.characterRefId));
    for (const [id, character] of Object.entries(characters)) {
        if (
            character.ref.source === 'generated' &&
            nameMatchesText(character.ref.displayName, narration)
        ) {
            visibleIds.add(id);
        }
    }
    for (const id of visibleIds) {
        const character = characters[id];
        if (!character || character.ref.source !== 'generated') continue;
        const meaningfulAppearances = (character.meaningfulAppearances ?? 0) + 1;
        characters[id] = {
            ...character,
            meaningfulAppearances,
            status:
                character.pinned || meaningfulAppearances >= 2
                    ? 'recurring'
                    : (character.status ?? 'cameo'),
        };
    }
    const RHYTHM_MEMORY = 6;
    const recentBeatKinds = decision?.beatKind
        ? [...(state.plot.recentBeatKinds ?? []), decision.beatKind].slice(-RHYTHM_MEMORY)
        : state.plot.recentBeatKinds;
    const recentInitiativeOwners = decision?.initiativeOwner
        ? [...(state.plot.recentInitiativeOwners ?? []), decision.initiativeOwner].slice(
              -RHYTHM_MEMORY
          )
        : state.plot.recentInitiativeOwners;
    // V2 has no post-beat continuity auditor: the writer's own one-sentence summary is the
    // scene memory, under the same lock the auditor honoured.
    const summary =
        composition.sceneSummary && !state.locks['/scene/summary']
            ? composition.sceneSummary
            : state.scene.summary;
    return {
        ...state,
        scene: { ...state.scene, summary },
        plot: {
            ...state.plot,
            steps,
            activeStepId: steps.find((step) => step.status === 'active')?.id,
            committedBeatCount: (state.plot.committedBeatCount ?? 0) + 1,
            recentBeatKinds,
            recentInitiativeOwners,
        },
        characters,
    };
}

export function createStoryStateRevision(params: {
    previous: StoryState;
    next: StoryState;
    source: StoryState['source'];
    anchorMessageId: string;
    sourceBeatId?: string;
}): StoryState {
    return normalizeStoryState({
        ...normalizeStoryState(params.next),
        id: crypto.randomUUID(),
        parentRevisionId: params.previous.id,
        revision: params.previous.revision + 1,
        source: params.source,
        anchorMessageId: params.anchorMessageId,
        sourceBeatId: params.sourceBeatId,
        createdAt: Date.now(),
    });
}

export function storyRoster(state: StoryState): string[] {
    return state.scene.participants
        .filter((participant) => participant.presence !== 'offstage')
        .map((participant) => participant.character.displayName);
}
