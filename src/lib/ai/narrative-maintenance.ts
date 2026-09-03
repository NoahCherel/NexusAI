'use client';

import type { CharacterCard, Conversation, Message, SceneTransition, StoryState } from '@/types';
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

export function stillCurrent(
    conversationId: string,
    targetMessageId: string,
    revisionId: string
): boolean {
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
    sourceBeatId: string
): Promise<StoryState | null> {
    if (!stillCurrent(previous.conversationId, targetMessageId, previous.id)) return null;
    const revision = createStoryStateRevision({
        previous,
        next,
        source,
        anchorMessageId: targetMessageId,
        sourceBeatId,
    });
    await commitStoryStateRevision(revision, targetMessageId);
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

    const auditorSchema = `Return exactly one JSON object: {"sceneSummary":"one sentence","pressure":"current dramatic pressure","openThreads":["still unresolved"],"transitions":[{"type":"exit|enter|presence|agency|location|event","characterRefId":"known id","presence":"onstage|remote|offstage","agency":"active|limited|none","value":"observable value","evidence":"short quote"}]}`;
    const auditorState = JSON.stringify({
        state,
        allowedCharacterIds: state.scene.participants.map((participant) => ({
            id: participant.character.id,
            name: participant.character.displayName,
        })),
        beat: params.beatContent.slice(0, 8_000),
    });

    // Auditor: extract only consequences that are demonstrably visible in the committed beat.
    const audit = await runMaintenanceAgent(
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
                          !['exit', 'enter', 'presence', 'agency', 'location', 'event'].includes(
                              type
                          ) ||
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
                    params.beatId
                )) ?? state;
        } catch (error) {
            console.warn('[Scene Auditor] Invalid response:', error);
        }
    }

    const allBeats = await getSceneBeatsByConversation(params.conversationId);
    const committed = allBeats.filter((candidate) => candidate.status === 'committed');
    const majorTransition = [
        ...(beat.decision?.observedTransitions ?? []),
        ...(beat.decision?.plannedTransitions ?? []),
    ].some((transition) => transition.type === 'location' || transition.type === 'event');
    const shouldPlan =
        committed.length === 1 || committed.length % 4 === 0 || majorTransition || params.stalled;
    if (!shouldPlan || !stillCurrent(params.conversationId, params.targetMessageId, state.id))
        return;

    const work = resolveWork(params.character);
    const outline = work ? (await getArcOutline(work))?.outline : undefined;
    const plannerSchema = `Return exactly one JSON object: {"objective":"current dramatic objective","pressure":"tension to build","openThreads":["unresolved thread"],"nextMoves":["possible next beat"]}`;
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
                lastPlannedBeat: committed.length,
                updatedAt: Date.now(),
            },
        };
        await commitMaintenanceState(
            state,
            planned,
            'planner',
            params.targetMessageId,
            params.beatId
        );
    } catch (error) {
        console.warn('[Story Director] Invalid response:', error);
    }
}
