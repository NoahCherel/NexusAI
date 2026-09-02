import type { DirectedRelationship, Message } from '@/types/chat';
import type {
    BackgroundRouteSnapshot,
    CharacterIntent,
    CompositionResult,
    DirectedParticipant,
    DirectedSceneDecision,
    SceneTransition,
    StoryState,
    StoryKnowledgeFact,
} from '@/types/scene';
import type { ResolvedCharacterProfile } from '@/lib/ai/story-state';
import { backgroundAICall } from '@/lib/ai/background-ai';
import { USER_REL_KEY } from '@/types/chat';

export class DirectedSceneError extends Error {
    constructor(
        message: string,
        readonly stage: 'route' | 'director' | 'reflection' | 'composer' | 'validation' | 'commit',
        readonly retryable = true
    ) {
        super(message);
        this.name = 'DirectedSceneError';
    }
}

/** Strict but provider-friendly: raw JSON or one JSON code fence, never surrounding chatter. */
export function parseSceneJson(raw: string): Record<string, unknown> {
    let candidate = raw.trim().replace(/^\uFEFF/, '');
    const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) candidate = fenced[1].trim();
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
        throw new DirectedSceneError(
            'La réponse structurée contient du texte hors JSON.',
            'validation'
        );
    }
    try {
        const parsed: unknown = JSON.parse(candidate);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        return parsed as Record<string, unknown>;
    } catch {
        throw new DirectedSceneError('JSON de scène invalide.', 'validation');
    }
}

const asText = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

function directorSystemPrompt(maxSpeakers: number): string {
    return `You are the BEAT DIRECTOR for an ensemble roleplay. Analyze what the user's latest message has ALREADY made true, then choose only the characters whose participation matters. You do not write dialogue or publish prose.

Return exactly one JSON object:
{
  "sceneGoal": "dramatic purpose",
  "narrationHint": "optional event or atmosphere for the composer",
  "pacing": "slow|steady|urgent",
  "observedTransitions": [{"type":"exit|enter|presence|agency|location|event","characterRefId":"id","presence":"onstage|remote|offstage","agency":"active|limited|none","value":"...","evidence":"short quote"}],
  "plannedTransitions": [{"type":"exit|enter|presence|agency|location|event","characterRefId":"id","presence":"onstage|remote|offstage","agency":"active|limited|none","value":"..."}],
  "participants": [{"characterRefId":"id","mode":"speak|act|silent","attention":"none|brief|full","reason":"why this character matters","direction":"goal/emotion/action"}]
}

Rules:
- At most ${maxSpeakers} participants with mode speak or act. Directly addressed characters take priority.
- "observedTransitions" contains ONLY completed or unambiguous facts in the latest USER message. Wanting, preparing or turning to leave is not an exit.
- An offstage character may participate only after an observed/planned entrance, or with remote presence.
- Use full attention only for a meaningful dilemma, initiative, revelation or conflict; brief for a reaction; none for incidental participation.
- A stub profile can only receive attention none.
- Never select the player. Never expose secrets. Use the supplied stable characterRefId values exactly.`;
}

function directorUserPrompt(params: {
    state: StoryState;
    profiles: ResolvedCharacterProfile[];
    recentMessages: Message[];
    userName: string;
    relationships?: DirectedRelationship[];
}): string {
    const latest = params.recentMessages.slice(-4).map((message) => ({
        role: message.role,
        speaker: message.speaker?.name ?? (message.role === 'user' ? params.userName : 'Narrator'),
        content: message.content.slice(0, 1_400),
    }));
    const profiles = params.profiles.map((profile) => {
        const participant = params.state.scene.participants.find(
            (candidate) => candidate.character.id === profile.ref.id
        );
        return {
            id: profile.ref.id,
            name: profile.ref.displayName,
            readiness: profile.ref.readiness,
            presence: participant?.presence ?? 'offstage',
            agency: participant?.agency ?? 'limited',
            identity: [profile.personality, profile.description]
                .filter(Boolean)
                .join(' ')
                .slice(0, 500),
        };
    });
    const relationships = (params.relationships ?? [])
        .filter((relationship) =>
            profiles.some(
                (profile) => profile.name === relationship.from || profile.name === relationship.to
            )
        )
        .slice(0, 12)
        .map((relationship) => ({
            from: relationship.from,
            to: relationship.to === USER_REL_KEY ? params.userName : relationship.to,
            trust: relationship.axes.trust,
            affection: relationship.axes.affection,
            respect: relationship.axes.respect,
        }));

    return JSON.stringify({
        player: params.userName,
        scene: {
            location: params.state.scene.location,
            time: params.state.scene.time,
            summary: params.state.scene.summary,
            objective: params.state.plot.objective,
            pressure: params.state.plot.pressure,
            openThreads: params.state.plot.openThreads,
            locks: Object.keys(params.state.locks),
        },
        profiles,
        relationships,
        recentMessages: latest,
    });
}

const TRANSITION_TYPES = new Set(['enter', 'exit', 'presence', 'agency', 'location', 'event']);
const PRESENCE = new Set(['onstage', 'remote', 'offstage']);
const AGENCY = new Set(['active', 'limited', 'none']);

function parseTransitions(
    value: unknown,
    origin: SceneTransition['origin'],
    refs: Map<string, ResolvedCharacterProfile>
): SceneTransition[] {
    if (!Array.isArray(value)) return [];
    const transitions: SceneTransition[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const type = asText(item.type);
        if (!type || !TRANSITION_TYPES.has(type)) continue;
        const characterRefId = asText(item.characterRefId);
        if (characterRefId && !refs.has(characterRefId)) continue;
        const presence = asText(item.presence);
        const agency = asText(item.agency);
        transitions.push({
            origin,
            type: type as SceneTransition['type'],
            characterRefId,
            characterName: characterRefId ? refs.get(characterRefId)?.ref.displayName : undefined,
            presence:
                presence && PRESENCE.has(presence)
                    ? (presence as SceneTransition['presence'])
                    : undefined,
            agency:
                agency && AGENCY.has(agency) ? (agency as SceneTransition['agency']) : undefined,
            value: asText(item.value),
            evidence: asText(item.evidence),
        });
    }
    return transitions;
}

export function parseDirectedDecision(
    raw: string,
    profiles: ResolvedCharacterProfile[],
    maxSpeakers: number
): DirectedSceneDecision {
    const parsed = parseSceneJson(raw);
    const refs = new Map(profiles.map((profile) => [profile.ref.id, profile]));
    const participants: DirectedParticipant[] = [];
    if (Array.isArray(parsed.participants)) {
        for (const entry of parsed.participants) {
            if (!entry || typeof entry !== 'object') continue;
            const item = entry as Record<string, unknown>;
            const characterRefId = asText(item.characterRefId);
            const profile = characterRefId ? refs.get(characterRefId) : undefined;
            if (!profile || participants.some((p) => p.characterRefId === characterRefId)) continue;
            const rawMode = asText(item.mode);
            const rawAttention = asText(item.attention);
            const mode = ['speak', 'act', 'silent'].includes(rawMode || '')
                ? (rawMode as DirectedParticipant['mode'])
                : 'silent';
            let attention = ['none', 'brief', 'full'].includes(rawAttention || '')
                ? (rawAttention as DirectedParticipant['attention'])
                : 'none';
            if (profile.ref.readiness !== 'ready') attention = 'none';
            participants.push({
                characterRefId: profile.ref.id,
                name: profile.ref.displayName,
                mode,
                attention,
                reason: asText(item.reason) ?? 'Présence utile à la scène.',
                direction: asText(item.direction),
            });
            if (participants.filter((p) => p.mode !== 'silent').length >= maxSpeakers) break;
        }
    }

    return {
        sceneGoal: asText(parsed.sceneGoal),
        narrationHint: asText(parsed.narrationHint),
        pacing: asText(parsed.pacing),
        participants,
        observedTransitions: parseTransitions(parsed.observedTransitions, 'observed', refs),
        plannedTransitions: parseTransitions(parsed.plannedTransitions, 'planned', refs),
    };
}

export async function directSceneBeat(params: {
    state: StoryState;
    profiles: ResolvedCharacterProfile[];
    recentMessages: Message[];
    userName: string;
    relationships?: DirectedRelationship[];
    maxSpeakers: number;
    route: BackgroundRouteSnapshot;
    signal?: AbortSignal;
}): Promise<DirectedSceneDecision> {
    const result = await backgroundAICall({
        systemPrompt: directorSystemPrompt(params.maxSpeakers),
        userPrompt: directorUserPrompt(params),
        temperature: 0.35,
        maxTokens: 900,
        maxRetries: 2,
        route: params.route,
        signal: params.signal,
        priority: 'scene',
    });
    if (!result) throw new DirectedSceneError('Le directeur de beat n’a pas répondu.', 'director');
    return parseDirectedDecision(result.content, params.profiles, params.maxSpeakers);
}

function reflectionSystemPrompt(
    profile: ResolvedCharacterProfile,
    attention: 'brief' | 'full'
): string {
    return `You are privately deciding the next beat for ${profile.ref.displayName}. Return a compact FINAL INTENT, not prose for the chat and not hidden chain-of-thought. Use only the character profile and facts supplied here. Never decide the player's actions.

Return exactly one JSON object:
{"perception":"what they notice","emotion":"current emotion","privateGoal":"what they want","observableAction":"physical action they may take","speechIntent":"what their line should accomplish, not the final line","target":"optional target","departureIntent":"stay|consider-leaving|leave","usableFacts":["facts they may reveal"]}

Depth: ${attention}. ${attention === 'brief' ? 'Be terse and reactive.' : 'Resolve the meaningful dilemma or initiative while staying in character.'}`;
}

export function parseCharacterIntent(params: {
    raw: string;
    profile: ResolvedCharacterProfile;
    attention: 'brief' | 'full';
}): CharacterIntent {
    const parsed = parseSceneJson(params.raw);
    const departure = asText(parsed.departureIntent);
    return {
        characterRefId: params.profile.ref.id,
        name: params.profile.ref.displayName,
        attention: params.attention,
        perception: asText(parsed.perception),
        emotion: asText(parsed.emotion),
        privateGoal: asText(parsed.privateGoal),
        observableAction: asText(parsed.observableAction),
        speechIntent: asText(parsed.speechIntent),
        target: asText(parsed.target),
        departureIntent: ['stay', 'consider-leaving', 'leave'].includes(departure || '')
            ? (departure as CharacterIntent['departureIntent'])
            : undefined,
        usableFacts: Array.isArray(parsed.usableFacts)
            ? parsed.usableFacts
                  .map(asText)
                  .filter((fact): fact is string => !!fact)
                  .slice(0, 8)
            : undefined,
    };
}

export async function reflectCharacter(params: {
    profile: ResolvedCharacterProfile;
    participant: DirectedParticipant;
    state: StoryState;
    latestUserMessage: Message;
    recentMessages?: Message[];
    relationships?: DirectedRelationship[];
    route: BackgroundRouteSnapshot;
    signal?: AbortSignal;
}): Promise<CharacterIntent> {
    if (params.participant.attention === 'none') {
        throw new DirectedSceneError(
            'Une réflexion a été demandée avec attention none.',
            'reflection',
            false
        );
    }
    const attention = params.participant.attention;
    const relationshipContext = params.state.scene.participants.map((participant) => ({
        name: participant.character.displayName,
        presence: participant.presence,
        agency: participant.agency,
    }));
    const userPrompt = JSON.stringify({
        character: {
            id: params.profile.ref.id,
            name: params.profile.ref.displayName,
            identity: params.profile.description.slice(0, attention === 'brief' ? 900 : 1_800),
            personality: params.profile.personality?.slice(0, 900),
            timelineCap: params.profile.canon?.timelineCap,
        },
        publicScene: {
            location: params.state.scene.location,
            summary: params.state.scene.summary,
            objective: params.state.plot.objective,
            participants: relationshipContext,
        },
        director: {
            goal: params.state.plot.objective,
            direction: params.participant.direction,
            mode: params.participant.mode,
        },
        relationships: (params.relationships ?? [])
            .filter(
                (relationship) =>
                    relationship.from === params.profile.ref.displayName ||
                    relationship.to === params.profile.ref.displayName
            )
            .slice(0, 10),
        recentPublicHistory: (params.recentMessages ?? []).slice(-8).map((message) => ({
            role: message.role,
            speaker: message.speaker?.name,
            content: message.content.slice(0, 1_200),
        })),
        knownFacts: (params.state.knowledge ?? [])
            .filter(
                (fact) =>
                    fact.visibility === 'public' || fact.knownBy.includes(params.profile.ref.id)
            )
            .map((fact) => ({ id: fact.id, text: fact.text })),
        latestUserMessage: params.latestUserMessage.content.slice(0, 1_600),
    });
    const result = await backgroundAICall({
        systemPrompt: reflectionSystemPrompt(params.profile, attention),
        userPrompt,
        temperature: 0.55,
        maxTokens: attention === 'brief' ? 180 : 420,
        maxRetries: 2,
        route: params.route,
        signal: params.signal,
        priority: 'scene',
    });
    if (!result) {
        throw new DirectedSceneError(
            `La réflexion de ${params.profile.ref.displayName} a échoué.`,
            'reflection'
        );
    }
    return parseCharacterIntent({ raw: result.content, profile: params.profile, attention });
}

export async function mapWithConcurrency<T, R>(
    values: T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(values.length);
    let cursor = 0;
    const worker = async () => {
        while (cursor < values.length) {
            const index = cursor++;
            try {
                results[index] = { status: 'fulfilled', value: await mapper(values[index], index) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker())
    );
    return results;
}

export interface CharacterReflectionFailure {
    participant: DirectedParticipant;
    reason: unknown;
}

export interface CharacterReflectionBatch {
    targets: DirectedParticipant[];
    intents: CharacterIntent[];
    failures: CharacterReflectionFailure[];
}

/** Pure selection boundary used by the UI for estimates and by the executor for work. */
export function selectReflectionTargets(
    participants: DirectedParticipant[],
    existingIntents: CharacterIntent[]
): DirectedParticipant[] {
    return participants.filter(
        (participant) =>
            participant.attention !== 'none' &&
            participant.mode !== 'silent' &&
            !existingIntents.some((intent) => intent.characterRefId === participant.characterRefId)
    );
}

/**
 * Injectable parallel reflection stage. It always waits for every requested worker and returns
 * successful intentions alongside failures, allowing retry to keep completed work atomically.
 */
export async function runCharacterReflections(params: {
    participants: DirectedParticipant[];
    profiles: ResolvedCharacterProfile[];
    existingIntents: CharacterIntent[];
    state: StoryState;
    latestUserMessage: Message;
    recentMessages?: Message[];
    relationships?: DirectedRelationship[];
    route: BackgroundRouteSnapshot;
    concurrency: number;
    signal?: AbortSignal;
    onSettled?: (completed: number, total: number) => void;
    reflect?: typeof reflectCharacter;
}): Promise<CharacterReflectionBatch> {
    const targets = selectReflectionTargets(params.participants, params.existingIntents);
    let completed = 0;
    const reflect = params.reflect ?? reflectCharacter;
    const results = await mapWithConcurrency(targets, params.concurrency, async (participant) => {
        try {
            const profile = params.profiles.find(
                (candidate) => candidate.ref.id === participant.characterRefId
            );
            if (!profile) {
                throw new DirectedSceneError(
                    `Profil introuvable pour ${participant.name}.`,
                    'reflection',
                    false
                );
            }
            return await reflect({
                profile,
                participant,
                state: params.state,
                latestUserMessage: params.latestUserMessage,
                recentMessages: params.recentMessages,
                relationships: params.relationships,
                route: params.route,
                signal: params.signal,
            });
        } finally {
            completed++;
            params.onSettled?.(completed, targets.length);
        }
    });
    const activeIds = new Set(params.participants.map((participant) => participant.characterRefId));
    return {
        targets,
        intents: [
            ...params.existingIntents.filter((intent) => activeIds.has(intent.characterRefId)),
            ...results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
        ],
        failures: results.flatMap((result, index) =>
            result.status === 'rejected'
                ? [{ participant: targets[index], reason: result.reason }]
                : []
        ),
    };
}

export function parseCompositionResult(
    raw: string,
    allowedParticipants: DirectedParticipant[]
): CompositionResult {
    const parsed = parseSceneJson(raw);
    const allowed = new Set(
        allowedParticipants.filter((p) => p.mode !== 'silent').map((p) => p.characterRefId)
    );
    const turns: CompositionResult['turns'] = [];
    const seen = new Set<string>();
    const participantById = new Map(
        allowedParticipants.map((participant) => [participant.characterRefId, participant])
    );
    const parseEffects = (value: unknown): SceneTransition[] => {
        if (value == null) return [];
        if (!Array.isArray(value)) {
            throw new DirectedSceneError(
                'Les effets de scène doivent être une liste.',
                'validation'
            );
        }
        return value.map((entry): SceneTransition => {
            if (!entry || typeof entry !== 'object') {
                throw new DirectedSceneError('Un effet de scène est invalide.', 'validation');
            }
            const item = entry as Record<string, unknown>;
            const type = asText(item.type);
            const characterRefId = asText(item.characterRefId);
            if (!type || !TRANSITION_TYPES.has(type)) {
                throw new DirectedSceneError('Un effet de scène a un type inconnu.', 'validation');
            }
            if (characterRefId && !participantById.has(characterRefId)) {
                throw new DirectedSceneError(
                    `Un effet référence un personnage non autorisé (${characterRefId}).`,
                    'validation'
                );
            }
            const presence = asText(item.presence);
            const agency = asText(item.agency);
            return {
                origin: 'planned',
                type: type as SceneTransition['type'],
                characterRefId,
                characterName: characterRefId
                    ? participantById.get(characterRefId)?.name
                    : undefined,
                presence:
                    presence && PRESENCE.has(presence)
                        ? (presence as SceneTransition['presence'])
                        : undefined,
                agency:
                    agency && AGENCY.has(agency)
                        ? (agency as SceneTransition['agency'])
                        : undefined,
                value: asText(item.value),
                evidence: asText(item.evidence),
            };
        });
    };
    if (parsed.turns != null && !Array.isArray(parsed.turns)) {
        throw new DirectedSceneError('Les tours composés doivent être une liste.', 'validation');
    }
    if (Array.isArray(parsed.turns)) {
        for (const entry of parsed.turns) {
            if (!entry || typeof entry !== 'object') {
                throw new DirectedSceneError('Une bulle composée est invalide.', 'validation');
            }
            const item = entry as Record<string, unknown>;
            const characterRefId = asText(item.characterRefId);
            const text = asText(item.text);
            if (!characterRefId || !text) {
                throw new DirectedSceneError(
                    'Une bulle composée doit avoir un personnage et un texte.',
                    'validation'
                );
            }
            if (!allowed.has(characterRefId)) {
                throw new DirectedSceneError(
                    `Le compositeur a fait intervenir un personnage non autorisé (${characterRefId}).`,
                    'validation'
                );
            }
            if (seen.has(characterRefId)) {
                throw new DirectedSceneError(
                    `Le compositeur a dupliqué le personnage ${characterRefId}.`,
                    'validation'
                );
            }
            seen.add(characterRefId);
            turns.push({ characterRefId, text, effects: parseEffects(item.effects) });
        }
    }
    const narration = asText(parsed.narration);
    if (!narration && turns.length === 0) {
        throw new DirectedSceneError(
            'La composition ne contient ni narration ni tour valide.',
            'validation'
        );
    }
    return { narration, turns, effects: parseEffects(parsed.effects) };
}

/** Director-planned effects only become state when the committed composition makes them visible. */
export function filterVisiblePlannedTransitions(
    transitions: SceneTransition[],
    composition: CompositionResult,
    profiles: ResolvedCharacterProfile[]
): SceneTransition[] {
    const narration = composition.narration?.toLocaleLowerCase() ?? '';
    const visible = [narration, ...composition.turns.map((turn) => turn.text.toLocaleLowerCase())]
        .join(' ')
        .replace(/\s+/g, ' ');
    return transitions.filter((transition) => {
        if (transition.characterRefId) {
            if (
                composition.turns.some((turn) => turn.characterRefId === transition.characterRefId)
            ) {
                return true;
            }
            const profile = profiles.find(
                (candidate) => candidate.ref.id === transition.characterRefId
            );
            return [profile?.ref.displayName, ...(profile?.ref.aliases ?? [])].some(
                (name) => !!name && visible.includes(name.toLocaleLowerCase())
            );
        }
        const value = transition.value?.trim().toLocaleLowerCase();
        return !!value && value.length >= 4 && visible.includes(value);
    });
}

/** Cheap pre-commit guard against the most damaging failure: narrating a private goal verbatim. */
export function assertNoPrivateIntentLeak(
    composition: CompositionResult,
    intents: CharacterIntent[],
    knowledge: StoryKnowledgeFact[] = []
): void {
    const visible = [composition.narration, ...composition.turns.map((turn) => turn.text)]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
    for (const intent of intents) {
        const privateGoal = intent.privateGoal?.trim().toLocaleLowerCase();
        if (privateGoal && privateGoal.length >= 24 && visible.includes(privateGoal)) {
            throw new DirectedSceneError(
                `Le compositeur a exposé textuellement l’objectif privé de ${intent.name}.`,
                'validation'
            );
        }
    }
    const mentions = (content: string, fact: StoryKnowledgeFact) =>
        [fact.text, ...(fact.aliases ?? [])].some((alias) => {
            const normalized = alias.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
            return normalized.length >= 8 && content.includes(normalized);
        });
    const narration = composition.narration?.toLocaleLowerCase().replace(/\s+/g, ' ') ?? '';
    for (const fact of knowledge.filter((candidate) => candidate.visibility === 'private')) {
        if (narration && mentions(narration, fact)) {
            throw new DirectedSceneError(
                `La narration expose le fait privé « ${fact.id} » sans autorisation.`,
                'validation'
            );
        }
        for (const turn of composition.turns) {
            if (
                !fact.knownBy.includes(turn.characterRefId) &&
                mentions(turn.text.toLocaleLowerCase().replace(/\s+/g, ' '), fact)
            ) {
                throw new DirectedSceneError(
                    `Le personnage ${turn.characterRefId} utilise un fait privé qu’il ne connaît pas (${fact.id}).`,
                    'validation'
                );
            }
        }
    }
}

export function compositionContract(params: {
    decision: DirectedSceneDecision;
    intents: CharacterIntent[];
    userName: string;
    knowledge?: StoryKnowledgeFact[];
}): string {
    return `[DIRECTED ENSEMBLE COMPOSITION]
Write one coherent roleplay beat, but return DATA rather than formatted chat. Preserve each character's canon voice and knowledge. Private goals explain behavior; never expose them as narration unless the intent explicitly permits a reveal. Never write actions, decisions or dialogue for ${params.userName}.

Director decision:
${JSON.stringify(params.decision)}

Private final intents:
${JSON.stringify(params.intents)}

Knowledge permissions (a private fact may only appear in a turn whose characterRefId is in knownBy; never state it in neutral narration):
${JSON.stringify(params.knowledge ?? [])}

Return exactly one JSON object and no commentary:
{"narration":"optional diegetic narration","turns":[{"characterRefId":"one allowed id","text":"that character's complete action/dialogue bubble","effects":[{"type":"exit|presence|agency","characterRefId":"id","presence":"onstage|remote|offstage","agency":"active|limited|none"}]}],"effects":[{"type":"location|event","value":"observable new value"}]}
Each characterRefId may occur at most once. Omit silent characters. Do not prefix text with the character's name.`;
}
