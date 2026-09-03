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
import { backgroundAICall, BackgroundContextLengthError } from '@/lib/ai/background-ai';
import type { AgentPayload, SamplerParams } from '@/lib/ai/conversation-context';
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

/**
 * The one block that differs between agents. Everything before it — card, canon dossiers,
 * arc, lorebook, Chronicle, RP journal, relationships, engine contract, preset post-history,
 * history window — is the composer's, verbatim.
 *
 * The preamble is not optional: the shared context ends with instructions to write prose of a
 * given length, and this call must return JSON instead.
 */
const AGENT_PREAMBLE = [
    '[STRUCTURED PLANNING TURN — this is NOT a chat reply.',
    'Ignore every instruction above about prose, length, formatting and staying in character as a narrator: they govern the visible reply, not this request.',
    'The story context above is your memory: use it. Return exactly one JSON object and nothing else — no prose, no code fence commentary.]',
].join('\n');

export function directorContract(params: {
    state: StoryState;
    profiles: ResolvedCharacterProfile[];
    userName: string;
    relationships?: DirectedRelationship[];
    maxSpeakers: number;
}): string {
    // Ids, not names, are authoritative past this point: the parser resolves everything by id.
    const cast = params.profiles.map((profile) => {
        const participant = params.state.scene.participants.find(
            (candidate) => candidate.character.id === profile.ref.id
        );
        const onStage = !!participant && participant.presence !== 'offstage';
        // The shared context above already describes the root card and the injected canon
        // dossiers of the on-stage cast. A separate library card, an ad-hoc name or an
        // off-stage candidate is NOT in it, so they get a short reminder here.
        const described =
            profile.ref.source === 'root-card' ||
            (profile.ref.source === 'canon-dossier' && onStage);
        return {
            id: profile.ref.id,
            name: profile.ref.displayName,
            aliases: profile.ref.aliases,
            readiness: profile.ref.readiness,
            presence: participant?.presence ?? 'offstage',
            agency: participant?.agency ?? 'limited',
            identity: described
                ? undefined
                : [profile.personality, profile.description]
                      .filter(Boolean)
                      .join(' ')
                      .slice(0, 600) || undefined,
        };
    });
    const relationships = (params.relationships ?? [])
        .filter((relationship) =>
            params.profiles.some(
                (profile) =>
                    profile.ref.displayName === relationship.from ||
                    profile.ref.displayName === relationship.to
            )
        )
        .slice(0, 20)
        .map((relationship) => ({
            from: relationship.from,
            to: relationship.to === USER_REL_KEY ? params.userName : relationship.to,
            ...relationship.axes,
        }));

    return `${AGENT_PREAMBLE}

[BEAT DIRECTOR]
You direct an ensemble roleplay. Read the story above, then decide what the player's latest message has ALREADY made true and which characters must act now. You never write dialogue or prose.

Scene state:
${JSON.stringify({
    player: params.userName,
    location: params.state.scene.location,
    time: params.state.scene.time,
    summary: params.state.scene.summary,
    work: params.state.plot.arcWork,
    currentBeat: params.state.plot.currentBeat,
    objective: params.state.plot.objective,
    pressure: params.state.plot.pressure,
    openThreads: params.state.plot.openThreads,
    // The medium-term plan. Advisory: steer toward it, never force it.
    plannedNextMoves: params.state.plot.nextMoves,
    lockedFields: Object.keys(params.state.locks),
})}

Cast (use these exact ids):
${JSON.stringify(cast)}

Directed bonds (-100..100):
${JSON.stringify(relationships)}

Return exactly one JSON object:
{
  "sceneGoal": "dramatic purpose of this beat",
  "narrationHint": "optional event or atmosphere for the writer",
  "pacing": "slow|steady|urgent",
  "observedTransitions": [{"type":"exit|enter|presence|agency|location|event","characterRefId":"id","presence":"onstage|remote|offstage","agency":"active|limited|none","value":"...","evidence":"short quote from the player's message"}],
  "plannedTransitions": [{"type":"exit|enter|presence|agency|location|event","characterRefId":"id","presence":"onstage|remote|offstage","agency":"active|limited|none","value":"..."}],
  "participants": [{"characterRefId":"id","mode":"speak|act|silent","attention":"none|brief|full","reason":"why this character matters now","direction":"goal/emotion/action for their turn"}]
}

Rules:
- At most ${params.maxSpeakers} participants with mode speak or act. A directly addressed character takes priority.
- "observedTransitions" holds ONLY completed, unambiguous facts stated in the player's latest message. Wanting, preparing or turning toward the door is not an exit.
- An offstage character may participate only after an observed or planned entrance, or with remote presence.
- attention full for a real dilemma, initiative, revelation or conflict; brief for a reaction; none when their presence is incidental. A stub profile can only receive none.
- Never select the player. Never reveal a secret. Use the supplied ids exactly.`;
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

export interface AgentCallContext {
    /** Builds the full shared payload with this agent's contract as the final block. */
    buildPayload: (contract: string) => Promise<AgentPayload>;
    sampler: SamplerParams;
    route: BackgroundRouteSnapshot;
    signal?: AbortSignal;
}

/** Token usage of one agent call, estimated when the provider reports none (NanoGPT). */
export interface AgentCallUsage {
    promptTokens?: number;
    completionTokens?: number;
    estimated?: boolean;
}

/**
 * One structured agent turn: build the shared payload, call the frozen route, parse. A single
 * malformed answer gets exactly one correction on the same model — the contract the composer
 * already lives under.
 */
export async function callStructuredAgent<T>(params: {
    context: AgentCallContext;
    contract: string;
    parse: (raw: string) => T;
    stage: DirectedSceneError['stage'];
    failureMessage: string;
    onUsage?: (usage: AgentCallUsage) => void;
}): Promise<T> {
    const { context } = params;
    const run = async (contract: string) => {
        const payload = await context.buildPayload(contract);
        let result: Awaited<ReturnType<typeof backgroundAICall>>;
        try {
            result = await backgroundAICall({
                systemPrompt: '',
                userPrompt: '',
                messages: payload.messages,
                sampler: context.sampler,
                cachePrefixLength: payload.stablePrefixLength,
                maxRetries: 2,
                route: context.route,
                signal: context.signal,
                priority: 'scene',
            });
        } catch (error) {
            if (error instanceof BackgroundContextLengthError) {
                // The preset sized the window; the background model is narrower. Retrying
                // the same route cannot help — the user has to pick a wider background model
                // or a smaller preset context.
                throw new DirectedSceneError(
                    `Le modèle background « ${error.model} » ne peut pas recevoir le contexte du preset (${payload.tokenBreakdown.total.toLocaleString('fr-FR')} tokens). Choisissez un modèle background à fenêtre plus large ou réduisez le contexte du preset.`,
                    'route',
                    false
                );
            }
            throw error;
        }
        if (!result) throw new DirectedSceneError(params.failureMessage, params.stage);
        params.onUsage?.({
            promptTokens: result.usage?.promptTokens ?? payload.tokenBreakdown.total,
            completionTokens:
                result.usage?.completionTokens ?? Math.ceil(result.content.length / 4),
            estimated: !result.usage,
        });
        return result.content;
    };

    const first = await run(params.contract);
    try {
        return params.parse(first);
    } catch (error) {
        if (!(error instanceof DirectedSceneError) || error.stage !== 'validation') throw error;
        const corrected = await run(
            `${params.contract}\n\n[CORRECTION] Your previous output was invalid: ${error.message} Return the corrected JSON object only. Previous output:\n${first.slice(0, 3_000)}`
        );
        return params.parse(corrected);
    }
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
    context: AgentCallContext;
    onUsage?: (usage: AgentCallUsage) => void;
}): Promise<DirectedSceneDecision> {
    return callStructuredAgent({
        context: params.context,
        contract: directorContract({
            state: params.state,
            profiles: params.profiles,
            userName: params.userName,
            relationships: params.relationships,
            maxSpeakers: params.maxSpeakers,
        }),
        parse: (raw) => parseDirectedDecision(raw, params.profiles, params.maxSpeakers),
        stage: 'director',
        failureMessage: 'Le directeur de beat n’a pas répondu.',
        onUsage: params.onUsage,
    });
}

export function reflectionContract(params: {
    profile: ResolvedCharacterProfile;
    participant: DirectedParticipant;
    state: StoryState;
    relationships?: DirectedRelationship[];
    rpJournal?: string[];
}): string {
    const attention = params.participant.attention as 'brief' | 'full';
    const name = params.profile.ref.displayName;
    // The root card and the on-stage canon dossiers are already in the shared context; a
    // separate library card or an ad-hoc name is not, so carry it here.
    const ownProfile =
        params.profile.ref.source === 'root-card' || params.profile.ref.source === 'canon-dossier'
            ? undefined
            : [params.profile.personality, params.profile.description]
                  .filter(Boolean)
                  .join('\n')
                  .slice(0, 4_000) || undefined;
    const known = (params.state.knowledge ?? []).filter(
        (fact) => fact.visibility === 'public' || fact.knownBy.includes(params.profile.ref.id)
    );
    const bonds = (params.relationships ?? [])
        .filter((relationship) => relationship.from === name || relationship.to === name)
        .slice(0, 12)
        .map((relationship) => ({
            from: relationship.from,
            to: relationship.to,
            ...relationship.axes,
        }));
    const sections = [
        ownProfile ? `Who ${name} is:\n${ownProfile}` : '',
        params.profile.canon?.timelineCap
            ? `Canon knowledge stops at: ${params.profile.canon.timelineCap}`
            : '',
        params.rpJournal?.length
            ? `What has happened to ${name} in THIS playthrough:\n- ${params.rpJournal.slice(-12).join('\n- ')}`
            : '',
        bonds.length
            ? `How ${name} feels about the others (-100..100):\n${JSON.stringify(bonds)}`
            : '',
        known.length
            ? `Facts ${name} knows (a private one is theirs alone — reveal it only deliberately):\n${JSON.stringify(
                  known.map((fact) => ({
                      text: fact.text,
                      private: fact.visibility === 'private',
                  }))
              )}`
            : '',
    ].filter(Boolean);

    return `${AGENT_PREAMBLE}

[PRIVATE DECISION — ${name}]
You decide privately what ${name} does next in the scene above. You are not writing the reply: you return a compact FINAL INTENT that a writer will turn into prose. Use only what ${name} can plausibly know from the story above and the facts below. Never decide, narrate or speak for the player or for another character.

${sections.join('\n\n')}

Scene right now: ${JSON.stringify({
        location: params.state.scene.location,
        objective: params.state.plot.objective,
        pressure: params.state.plot.pressure,
        openThreads: params.state.plot.openThreads,
        others: params.state.scene.participants
            .filter((participant) => participant.character.id !== params.profile.ref.id)
            .map((participant) => ({
                name: participant.character.displayName,
                presence: participant.presence,
                agency: participant.agency,
            })),
    })}
The director asks ${name} to: ${params.participant.direction ?? 'react in character'} (mode: ${params.participant.mode})

Return exactly one JSON object:
{"perception":"what they notice","emotion":"current emotion","privateGoal":"what they want","observableAction":"physical action they may take","speechIntent":"what their line should accomplish, not the final line","target":"optional target","departureIntent":"stay|consider-leaving|leave","usableFacts":["facts they may reveal"]}

Depth: ${attention}. ${attention === 'brief' ? 'Be terse and reactive: one clear beat.' : 'Resolve the meaningful dilemma or initiative while staying in character.'}`;
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
    rpJournal?: string[];
    route: BackgroundRouteSnapshot;
    signal?: AbortSignal;
    context?: AgentCallContext;
    onUsage?: (usage: AgentCallUsage) => void;
}): Promise<CharacterIntent> {
    if (params.participant.attention === 'none') {
        throw new DirectedSceneError(
            'Une réflexion a été demandée avec attention none.',
            'reflection',
            false
        );
    }
    if (!params.context) {
        throw new DirectedSceneError(
            `Contexte de scène manquant pour la réflexion de ${params.profile.ref.displayName}.`,
            'reflection',
            false
        );
    }
    const attention = params.participant.attention;
    return callStructuredAgent({
        context: params.context,
        contract: reflectionContract({
            profile: params.profile,
            participant: params.participant,
            state: params.state,
            relationships: params.relationships,
            rpJournal: params.rpJournal,
        }),
        parse: (raw) => parseCharacterIntent({ raw, profile: params.profile, attention }),
        stage: 'reflection',
        failureMessage: `La réflexion de ${params.profile.ref.displayName} a échoué.`,
        onUsage: params.onUsage,
    });
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

/**
 * Like `mapWithConcurrency`, but the first item runs alone. Used when every call shares a
 * cacheable prompt prefix: the lone first call writes the cache, the fan-out then hits it.
 */
export async function mapWithConcurrencyWarmup<T, R>(
    values: T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
    if (values.length <= 1 || concurrency <= 1) {
        return mapWithConcurrency(values, concurrency, mapper);
    }
    const [first] = await mapWithConcurrency(values.slice(0, 1), 1, mapper);
    const rest = await mapWithConcurrency(values.slice(1), concurrency, (value, index) =>
        mapper(value, index + 1)
    );
    return [first, ...rest];
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
    /** Per-character playthrough notes, keyed by display name. */
    rpJournal?: Record<string, string[]>;
    route: BackgroundRouteSnapshot;
    concurrency: number;
    signal?: AbortSignal;
    onSettled?: (completed: number, total: number) => void;
    reflect?: typeof reflectCharacter;
    /** Shared-context seam; absent only in unit tests that inject their own `reflect`. */
    context?: AgentCallContext;
    onUsage?: (name: string, usage: AgentCallUsage) => void;
}): Promise<CharacterReflectionBatch> {
    const targets = selectReflectionTargets(params.participants, params.existingIntents);
    let completed = 0;
    const reflect = params.reflect ?? reflectCharacter;
    // Every agent of the beat shares one stable prefix, so the first call is what populates
    // the provider's prompt cache. Fanning out immediately makes all N calls miss it; running
    // one alone first means the rest are cache hits on the identical system + history.
    const results = await mapWithConcurrencyWarmup(
        targets,
        params.concurrency,
        async (participant) => {
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
                    rpJournal: params.rpJournal?.[profile.ref.displayName],
                    route: params.route,
                    signal: params.signal,
                    context: params.context,
                    onUsage: (usage) => params.onUsage?.(profile.ref.displayName, usage),
                });
            } finally {
                completed++;
                params.onSettled?.(completed, targets.length);
            }
        }
    );
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
