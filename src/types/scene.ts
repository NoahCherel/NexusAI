/**
 * Persistent ensemble-scene types.
 *
 * Story state is immutable and branch-aware: messages point at a revision instead of
 * mutating one conversation-wide blob. Scene-beat records keep private orchestration data
 * out of the visible transcript while still making failures and retries inspectable.
 */

export type CharacterRefSource = 'root-card' | 'character-card' | 'canon-dossier' | 'ad-hoc';

export interface CharacterRef {
    id: string;
    source: CharacterRefSource;
    sourceId?: string;
    displayName: string;
    aliases?: string[];
    readiness: 'ready' | 'stub';
}

export type ScenePresence = 'onstage' | 'remote' | 'offstage';
export type SceneAgency = 'active' | 'limited' | 'none';

export interface StoryParticipant {
    character: CharacterRef;
    presence: ScenePresence;
    agency: SceneAgency;
}

export interface NarrativePlan {
    objective?: string;
    pressure?: string;
    openThreads: string[];
    nextMoves: string[];
    lastPlannedBeat?: number;
    updatedAt?: number;
}

export interface StoryKnowledgeFact {
    id: string;
    text: string;
    aliases?: string[];
    visibility: 'public' | 'private';
    /** Stable CharacterRef ids. Empty for a private fact known by nobody on stage. */
    knownBy: string[];
}

export interface StoryState {
    id: string;
    conversationId: string;
    parentRevisionId?: string;
    anchorMessageId?: string;
    revision: number;
    source: 'migration' | 'user' | 'observed' | 'generated' | 'auditor' | 'planner';
    scene: {
        location?: string;
        time?: string;
        summary?: string;
        participants: StoryParticipant[];
    };
    plot: NarrativePlan & {
        arcWork?: string;
        currentBeat?: string;
    };
    knowledge?: StoryKnowledgeFact[];
    /** JSON-pointer-like paths. A truthy entry prevents AI-authored changes. */
    locks: Record<string, true>;
    sourceBeatId?: string;
    createdAt: number;
}

export type TransitionOrigin = 'observed' | 'planned';
export type SceneTransitionType = 'enter' | 'exit' | 'presence' | 'agency' | 'location' | 'event';

export interface SceneTransition {
    origin: TransitionOrigin;
    type: SceneTransitionType;
    characterRefId?: string;
    characterName?: string;
    presence?: ScenePresence;
    agency?: SceneAgency;
    value?: string;
    evidence?: string;
}

export type SceneParticipationMode = 'speak' | 'act' | 'silent';
export type ReflectionAttention = 'none' | 'brief' | 'full';

export interface DirectedParticipant {
    characterRefId: string;
    name: string;
    mode: SceneParticipationMode;
    attention: ReflectionAttention;
    reason: string;
    direction?: string;
}

export interface DirectedSceneDecision {
    sceneGoal?: string;
    narrationHint?: string;
    pacing?: string;
    participants: DirectedParticipant[];
    observedTransitions: SceneTransition[];
    plannedTransitions: SceneTransition[];
}

/** Final, structured result only. Never a model's hidden chain-of-thought. */
export interface CharacterIntent {
    characterRefId: string;
    name: string;
    attention: Exclude<ReflectionAttention, 'none'>;
    perception?: string;
    emotion?: string;
    privateGoal?: string;
    observableAction?: string;
    speechIntent?: string;
    target?: string;
    departureIntent?: 'stay' | 'consider-leaving' | 'leave';
    usableFacts?: string[];
}

export interface CompositionTurn {
    characterRefId: string;
    text: string;
    effects?: SceneTransition[];
}

export interface CompositionResult {
    narration?: string;
    turns: CompositionTurn[];
    effects?: SceneTransition[];
}

export type SceneBeatStatus =
    | 'directing'
    | 'reflecting'
    | 'composing'
    | 'validating'
    | 'committed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'awaiting-profile'
    | 'dirty';

export interface SceneProfileAmbiguity {
    name: string;
    candidates: CharacterRef[];
}

export interface BackgroundRouteSnapshot {
    provider: 'nanogpt' | 'openrouter';
    model: string;
    billingScope: 'subscription' | 'free';
    routing: 'auto' | 'nanogpt' | 'openrouter-free';
    resolvedAt: number;
}

export interface SceneBeatError {
    stage: 'route' | 'director' | 'reflection' | 'composer' | 'validation' | 'commit';
    message: string;
    characterRefId?: string;
    retryable?: boolean;
    status?: number;
}

export interface SceneBeatRecord {
    id: string;
    conversationId: string;
    triggerMessageId: string;
    branchTipId: string;
    generationId: string;
    baseStoryStateRevisionId?: string;
    observedStoryStateRevisionId?: string;
    committedStoryStateRevisionId?: string;
    status: SceneBeatStatus;
    backgroundRoute?: BackgroundRouteSnapshot;
    composerRoute?: {
        provider: string;
        model: string;
        billingScope?: 'subscription' | 'default';
    };
    decision?: DirectedSceneDecision;
    intents: CharacterIntent[];
    composition?: CompositionResult;
    profileAmbiguity?: SceneProfileAmbiguity;
    outputMessageIds: string[];
    errors: SceneBeatError[];
    usage?: {
        /** Composer only, kept for the existing Coulisses line. */
        promptTokens?: number;
        completionTokens?: number;
        estimatedInputTokens?: number;
        /**
         * Per-agent breakdown. Every agent now sends the whole conversation, so the cost of a
         * beat is only legible agent by agent. `estimated` marks a provider that reports no
         * usage (NanoGPT emits no sentinel).
         */
        agents?: Array<{
            agent: 'director' | 'reflection' | 'composer' | 'auditor' | 'planner';
            name?: string;
            promptTokens?: number;
            completionTokens?: number;
            estimated?: boolean;
        }>;
    };
    /** Set when an agent's final block forced a history trim the rest of the beat did not have. */
    contextDivergence?: string[];
    timings: Partial<
        Record<'director' | 'reflections' | 'composer' | 'validation' | 'total', number>
    >;
    createdAt: number;
    updatedAt: number;
}

export interface SceneGenerationProgress {
    beatId: string;
    status: SceneBeatStatus;
    completedReflections: number;
    totalReflections: number;
    error?: string;
}
