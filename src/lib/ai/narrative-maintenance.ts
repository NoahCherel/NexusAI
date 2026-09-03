'use client';

import type {
    CastingNeed,
    CharacterCard,
    Conversation,
    Message,
    NarrativeStep,
    SceneTransition,
    StoryState,
} from '@/types';
import type { APIPreset } from '@/types/preset';
import type { RPEngine } from '@/types/engine';
import {
    buildAgentPayload,
    type RetrievalStack,
    type SamplerParams,
} from '@/lib/ai/conversation-context';
import { backgroundAICall, resolveBackgroundRoute } from '@/lib/ai/background-ai';
import { parseSceneJson } from '@/lib/ai/directed-scene';
import {
    commitStoryStateRevision,
    getArcOutline,
    getSceneBeat,
    getSceneBeatsByConversation,
    getStoryState,
} from '@/lib/db';
import { applyStoryTransitions, createStoryStateRevision, storyRoster } from '@/lib/ai/story-state';
import { resolveWork } from '@/lib/ai/canon-context';
import { useChatStore } from '@/stores/chat-store';

/** Same override the beat agents use: the shared context ends by demanding prose. */
const MAINTENANCE_PREAMBLE = [
    '[STRUCTURED MAINTENANCE TURN — this is NOT a chat reply.',
    'Ignore every instruction above about prose, length, formatting and staying in character: they govern the visible reply, not this request.',
    'The story context above is your memory: use it. Return exactly one JSON object and nothing else.]',
].join('\n');

const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * A beat that starts generating invalidates every maintenance pass still in flight for its
 * conversation. Otherwise the planner could land a new active revision between the beat's
 * read and its guarded commit, and the visible beat would lose to background bookkeeping.
 */
const maintenanceEpochs = new Map<string, number>();

export function invalidateNarrativeMaintenance(conversationId: string): void {
    maintenanceEpochs.set(conversationId, (maintenanceEpochs.get(conversationId) ?? 0) + 1);
}

const maintenanceEpoch = (conversationId: string) => maintenanceEpochs.get(conversationId) ?? 0;

export function stillCurrent(
    conversationId: string,
    targetMessageId: string,
    revisionId: string,
    epoch?: number
): boolean {
    if (epoch != null && epoch !== maintenanceEpoch(conversationId)) return false;
    const store = useChatStore.getState();
    const path = store.getActiveBranchMessages(conversationId);
    if (!path.some((message) => message.id === targetMessageId)) return false;
    const latestRevision = [...path]
        .reverse()
        .find((message) => message.storyStateRevisionId)?.storyStateRevisionId;
    return latestRevision === revisionId;
}

async function commitMaintenanceState(
    previous: StoryState,
    next: StoryState,
    source: 'auditor' | 'planner',
    targetMessageId: string,
    sourceBeatId: string,
    epoch: number
): Promise<StoryState | null> {
    if (!stillCurrent(previous.conversationId, targetMessageId, previous.id, epoch)) return null;
    const revision = createStoryStateRevision({
        previous,
        next,
        source,
        anchorMessageId: targetMessageId,
        sourceBeatId,
    });
    await commitStoryStateRevision(revision, targetMessageId, previous.id);
    useChatStore.getState().applyStoryStateRevision({
        conversationId: previous.conversationId,
        messageId: targetMessageId,
        storyStateRevisionId: revision.id,
        roster: storyRoster(revision),
    });
    return revision;
}

/** Everything the maintenance agents need to share the writer's context. */
export interface DirectedMaintenanceContext {
    stack: RetrievalStack;
    conversation: Conversation;
    preset: APIPreset | null;
    engine: RPEngine | null;
    persona?: { name: string; bio: string; description?: string } | null;
    provider?: string;
    learnedBanList?: string[];
    sampler: SamplerParams;
}

export async function maintainNarrativeAfterBeat(params: {
    character: CharacterCard;
    conversationId: string;
    beatId: string;
    targetMessageId: string;
    beatContent: string;
    stalled: boolean;
    /** Branch history up to (not including) the committed beat. */
    history?: Message[];
    sceneContext?: DirectedMaintenanceContext;
}): Promise<void> {
    const epoch = maintenanceEpoch(params.conversationId);
    const beat = await getSceneBeat(params.beatId);
    if (
        !beat?.committedStoryStateRevisionId ||
        (beat.status !== 'committed' && beat.status !== 'dirty')
    )
        return;
    const activePath = useChatStore.getState().getActiveBranchMessages(params.conversationId);
    const latestRevisionId = [...activePath]
        .reverse()
        .find((message) => message.storyStateRevisionId)?.storyStateRevisionId;
    let state = await getStoryState(latestRevisionId ?? beat.committedStoryStateRevisionId);
    if (!state) return;
    const route = beat.backgroundRoute ?? (await resolveBackgroundRoute());
    if (!route) return;

    /**
     * Run a maintenance agent with the SAME context the writer had when it is available: the
     * shared payload plus a final contract, on the beat's frozen route and the preset's
     * samplers. Without a scene context (a manual bubble edit) it degrades to the historical
     * state-only prompt rather than skipping the audit.
     */
    const runMaintenanceAgent = async (
        contract: string,
        legacy: { system: string; user: string; temperature: number; maxTokens: number }
    ) => {
        const context = params.sceneContext;
        if (!context || !params.history) {
            return backgroundAICall({
                route,
                priority: 'background',
                temperature: legacy.temperature,
                maxTokens: legacy.maxTokens,
                maxRetries: 1,
                systemPrompt: legacy.system,
                userPrompt: legacy.user,
            });
        }
        const payload = await buildAgentPayload({
            stack: context.stack,
            character: params.character,
            conversation: context.conversation,
            // Branch history up to the beat; the committed beat itself arrives verbatim
            // inside the contract, where the agent is told to judge it.
            history: params.history,
            learnedBanList: context.learnedBanList,
            preset: context.preset,
            engine: context.engine,
            persona: context.persona,
            provider: context.provider,
            agentContract: contract,
        });
        return backgroundAICall({
            systemPrompt: '',
            userPrompt: '',
            messages: payload.messages,
            sampler: context.sampler,
            cachePrefixLength: payload.stablePrefixLength,
            route,
            priority: 'background',
            maxRetries: 1,
        });
    };

    // The version comes from the conversation itself, not from whether the caller could hand
    // over a scene context: a V2 beat without one must never run the V1 continuity auditor.
    const storeConversation = useChatStore
        .getState()
        .conversations.find((candidate) => candidate.id === params.conversationId);
    const v2 =
        (storeConversation?.directedNarrativeVersion ??
            params.sceneContext?.conversation.directedNarrativeVersion) === 2;
    const arcRevisionAtStart = storeConversation?.arcRevision ?? 0;
    const auditorSchema = `Return exactly one JSON object: {"sceneSummary":"one sentence","pressure":"current dramatic pressure","openThreads":["still unresolved"],"transitions":[{"type":"exit|enter|presence|agency|location|time|event","characterRefId":"known id","presence":"onstage|remote|offstage","agency":"active|limited|none","value":"observable value","evidence":"short quote"}]}`;
    const auditorState = JSON.stringify({
        state,
        allowedCharacterIds: state.scene.participants.map((participant) => ({
            id: participant.character.id,
            name: participant.character.displayName,
        })),
        beat: params.beatContent.slice(0, 8_000),
    });

    // Auditor: extract only consequences that are demonstrably visible in the committed beat.
    const audit = v2
        ? null
        : await runMaintenanceAgent(
              `${MAINTENANCE_PREAMBLE}

[CONTINUITY AUDITOR]
Read the beat that just happened and update the scene state from what is VISIBLE in it. Never invent motives, off-screen events or future beats. A change only counts when the text shows it.

The beat that just happened:
${params.beatContent.slice(0, 8_000)}

Current state and the only ids you may use:
${auditorState}

${auditorSchema}`,
              {
                  system: `You are a continuity AUDITOR. Read the committed roleplay beat and update state only from visible facts. Never invent motives or future events. ${auditorSchema}`,
                  user: auditorState,
                  temperature: 0.2,
                  maxTokens: 650,
              }
          );
    if (audit) {
        try {
            const parsed = parseSceneJson(audit.content);
            const allowed = new Set(state.scene.participants.map((p) => p.character.id));
            const transitions: SceneTransition[] = Array.isArray(parsed.transitions)
                ? parsed.transitions.flatMap((entry): SceneTransition[] => {
                      if (!entry || typeof entry !== 'object') return [];
                      const item = entry as Record<string, unknown>;
                      const type = text(item.type);
                      const characterRefId = text(item.characterRefId);
                      if (
                          !type ||
                          ![
                              'exit',
                              'enter',
                              'presence',
                              'agency',
                              'location',
                              'time',
                              'event',
                          ].includes(type) ||
                          (characterRefId && !allowed.has(characterRefId))
                      )
                          return [];
                      const presence = text(item.presence);
                      const agency = text(item.agency);
                      return [
                          {
                              origin: 'planned',
                              type: type as SceneTransition['type'],
                              characterRefId,
                              presence: ['onstage', 'remote', 'offstage'].includes(presence || '')
                                  ? (presence as SceneTransition['presence'])
                                  : undefined,
                              agency: ['active', 'limited', 'none'].includes(agency || '')
                                  ? (agency as SceneTransition['agency'])
                                  : undefined,
                              value: text(item.value),
                              evidence: text(item.evidence),
                          },
                      ];
                  })
                : [];
            let audited = applyStoryTransitions(
                state,
                transitions,
                state.scene.participants.map((participant) => participant.character)
            );
            audited = {
                ...audited,
                scene: {
                    ...audited.scene,
                    summary: state.locks['/scene/summary']
                        ? audited.scene.summary
                        : (text(parsed.sceneSummary) ?? audited.scene.summary),
                },
                plot: {
                    ...audited.plot,
                    pressure: state.locks['/plot/pressure']
                        ? audited.plot.pressure
                        : (text(parsed.pressure) ?? audited.plot.pressure),
                    openThreads:
                        !state.locks['/plot/openThreads'] && Array.isArray(parsed.openThreads)
                            ? parsed.openThreads
                                  .map(text)
                                  .filter((item): item is string => !!item)
                                  .slice(0, 12)
                            : audited.plot.openThreads,
                },
            };
            state =
                (await commitMaintenanceState(
                    state,
                    audited,
                    'auditor',
                    params.targetMessageId,
                    params.beatId,
                    epoch
                )) ?? state;
        } catch (error) {
            console.warn('[Scene Auditor] Invalid response:', error);
        }
    }

    const allBeats = await getSceneBeatsByConversation(params.conversationId);
    const committed = allBeats.filter((candidate) => candidate.status === 'committed');
    const majorTransition =
        [
            ...(beat.decision?.observedTransitions ?? []),
            ...(beat.decision?.plannedTransitions ?? []),
        ].some(
            (transition) =>
                transition.type === 'location' ||
                transition.type === 'time' ||
                transition.type === 'event'
        ) ||
        beat.decision?.beatKind === 'payoff' ||
        beat.decision?.beatKind === 'transition';
    const branchBeatCount = v2 ? (state.plot.committedBeatCount ?? 0) : committed.length;
    const shouldPlan = planningDue({
        v2,
        committedBeatCount: state.plot.committedBeatCount,
        committedTotal: committed.length,
        majorTransition,
        stalled: params.stalled,
    });
    if (
        !shouldPlan ||
        !stillCurrent(params.conversationId, params.targetMessageId, state.id, epoch)
    )
        return;

    const work = resolveWork(params.character);
    const outline = work ? (await getArcOutline(work))?.outline : undefined;
    const plannerSchema = v2
        ? `Return exactly one JSON object: {"canonPosition":"where the playthrough now stands on the canon timeline, only if it moved","dramaticQuestion":"central unresolved question","objective":"current dramatic objective","pressure":"tension to build","openThreads":["unresolved thread"],"steps":[{"id":"stable short id","premise":"future dramatic step","prerequisites":["prior step id"],"seeds":["setup to plant"],"intendedPayoff":"observable payoff","canonAnchor":"optional","status":"planned|active"}],"castingNeeds":[{"id":"stable short id","role":"dramatic function","reason":"why needed","status":"open"}]}`
        : `Return exactly one JSON object: {"objective":"current dramatic objective","pressure":"tension to build","openThreads":["unresolved thread"],"nextMoves":["possible next beat"]}`;
    const plannerState = JSON.stringify({
        work,
        arcOutline: outline?.slice(0, 6_000),
        state,
        latestBeat: params.beatContent.slice(0, 6_000),
        stalled: params.stalled,
    });
    const planning = await runMaintenanceAgent(
        `${MAINTENANCE_PREAMBLE}

[STORY DIRECTOR]
Plan the next two to four beats of this story. You write no visible prose and you never decide what the player does. Preserve confirmed events, locked fields and canon; steer, do not railroad.

Where the story stands:
${plannerState}

${plannerSchema}`,
        {
            system: `You are the medium-term STORY DIRECTOR. Plan two to four future beats without writing visible prose or forcing player actions. Preserve confirmed events, locks and canon. ${plannerSchema}`,
            user: plannerState,
            temperature: 0.55,
            maxTokens: 800,
        }
    );
    if (!planning) return;
    try {
        const parsed = parseSceneJson(planning.content);
        let v2Steps = state.plot.steps;
        if (v2 && !state.locks['/plot/steps'] && Array.isArray(parsed.steps)) {
            const proposals = parsed.steps.slice(0, 8).flatMap((entry, index): NarrativeStep[] => {
                if (!entry || typeof entry !== 'object') return [];
                const item = entry as Record<string, unknown>;
                const premise = text(item.premise);
                const intendedPayoff = text(item.intendedPayoff);
                if (!premise || !intendedPayoff) return [];
                return [
                    {
                        id: text(item.id) ?? `step-${branchBeatCount}-${index + 1}`,
                        premise,
                        prerequisites: Array.isArray(item.prerequisites)
                            ? item.prerequisites
                                  .map(text)
                                  .filter((value): value is string => !!value)
                            : [],
                        seeds: Array.isArray(item.seeds)
                            ? item.seeds.map(text).filter((value): value is string => !!value)
                            : [],
                        intendedPayoff,
                        canonAnchor: text(item.canonAnchor),
                        status: item.status === 'active' ? 'active' : 'planned',
                        visibleEvidence: [],
                    },
                ];
            });
            const proposedById = new Map(proposals.map((step) => [step.id, step]));
            // A motivated detour: the planner replaces the active step with a different one
            // while the old step has no visible evidence. It is marked detoured (never
            // silently dropped), and planRevision below records the change of course.
            const proposesOtherActive = proposals.some(
                (step) => step.status === 'active' && step.id !== state.plot.activeStepId
            );
            const preserved = (state.plot.steps ?? []).map((step) => {
                const proposal = proposedById.get(step.id);
                proposedById.delete(step.id);
                if (['resolved', 'detoured', 'abandoned'].includes(step.status)) return step;
                if (!proposal) {
                    return step.status === 'active' &&
                        proposesOtherActive &&
                        step.visibleEvidence.length === 0
                        ? { ...step, status: 'detoured' as const }
                        : step;
                }
                return { ...proposal, visibleEvidence: step.visibleEvidence };
            });
            v2Steps = [...preserved, ...proposedById.values()].slice(0, 12);
            let claimedActive = false;
            v2Steps = v2Steps.map((step) => {
                if (step.status !== 'active') return step;
                if (claimedActive) return { ...step, status: 'planned' as const };
                claimedActive = true;
                return step;
            });
        }
        let v2CastingNeeds = state.plot.castingNeeds;
        if (v2 && !state.locks['/plot/castingNeeds'] && Array.isArray(parsed.castingNeeds)) {
            const proposals = parsed.castingNeeds
                .slice(0, 6)
                .flatMap((entry, index): CastingNeed[] => {
                    if (!entry || typeof entry !== 'object') return [];
                    const item = entry as Record<string, unknown>;
                    const role = text(item.role);
                    const reason = text(item.reason);
                    if (!role || !reason) return [];
                    return [
                        {
                            id: text(item.id) ?? `casting-${branchBeatCount}-${index + 1}`,
                            role,
                            reason,
                            status: 'open',
                        },
                    ];
                });
            const existing = new Map(
                (state.plot.castingNeeds ?? []).map((need) => [need.id, need])
            );
            for (const proposal of proposals) {
                if (!existing.has(proposal.id)) existing.set(proposal.id, proposal);
            }
            v2CastingNeeds = [...existing.values()].slice(0, 12);
        }
        const planned: StoryState = {
            ...state,
            plot: {
                ...state.plot,
                objective: state.locks['/plot/objective']
                    ? state.plot.objective
                    : (text(parsed.objective) ?? state.plot.objective),
                pressure: state.locks['/plot/pressure']
                    ? state.plot.pressure
                    : (text(parsed.pressure) ?? state.plot.pressure),
                openThreads:
                    !state.locks['/plot/openThreads'] && Array.isArray(parsed.openThreads)
                        ? parsed.openThreads
                              .map(text)
                              .filter((item): item is string => !!item)
                              .slice(0, 12)
                        : state.plot.openThreads,
                nextMoves: Array.isArray(parsed.nextMoves)
                    ? parsed.nextMoves
                          .map(text)
                          .filter((item): item is string => !!item)
                          .slice(0, 4)
                    : state.plot.nextMoves,
                // The canon compass moves here and nowhere else in V2; the beat commit only
                // mirrors it to the Arc Compass when no user edit happened meanwhile.
                canonPosition:
                    v2 && !state.locks['/plot/canonPosition']
                        ? (text(parsed.canonPosition) ?? state.plot.canonPosition)
                        : state.plot.canonPosition,
                dramaticQuestion:
                    v2 && !state.locks['/plot/dramaticQuestion']
                        ? (text(parsed.dramaticQuestion) ?? state.plot.dramaticQuestion)
                        : state.plot.dramaticQuestion,
                steps: v2Steps,
                activeStepId: v2
                    ? v2Steps?.find((step) => step.status === 'active')?.id
                    : state.plot.activeStepId,
                castingNeeds: v2CastingNeeds,
                planRevision: v2 ? (state.plot.planRevision ?? 0) + 1 : state.plot.planRevision,
                lastPlannedBeat: branchBeatCount,
                updatedAt: Date.now(),
            },
        };
        const landed = await commitMaintenanceState(
            state,
            planned,
            'planner',
            params.targetMessageId,
            params.beatId,
            epoch
        );
        // The planner is the only agent that moves the canon compass. It reaches the Arc
        // Compass here, and only if the user did not edit the arc while the planner ran.
        const movedTo = landed?.plot.canonPosition;
        if (v2 && landed && movedTo && movedTo !== state.plot.canonPosition) {
            const store = useChatStore.getState();
            const current = store.conversations.find(
                (candidate) => candidate.id === params.conversationId
            );
            if (
                current &&
                (current.arcRevision ?? 0) === arcRevisionAtStart &&
                current.arc?.currentPosition !== movedTo
            ) {
                store.updateArc(params.conversationId, {
                    ...current.arc,
                    currentPosition: movedTo,
                });
            }
        }
    } catch (error) {
        console.warn('[Story Director] Invalid response:', error);
    }
}

/**
 * When the Story Director plans: after the first committed beat of a branch, every fourth
 * beat, after a major transition, or when the writer stalled. V2 counts beats on the branch
 * (`committedBeatCount`); V1 keeps its historical count of committed beat records.
 */
export function planningDue(params: {
    v2: boolean;
    committedBeatCount?: number;
    committedTotal: number;
    majorTransition: boolean;
    stalled: boolean;
}): boolean {
    const count = params.v2 ? (params.committedBeatCount ?? 0) : params.committedTotal;
    return (
        count === 1 || (count > 0 && count % 4 === 0) || params.majorTransition || params.stalled
    );
}
