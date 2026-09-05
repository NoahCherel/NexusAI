/**
 * Replays an exported conversation through the REAL directed-narrative V2 orchestrator,
 * teacher-forced: every player message is kept, every original assistant reply is regenerated
 * as a V2 beat (Director → reflections → Composer → audit → planner) with the original
 * transcript as context, then the two are laid side by side.
 *
 * Two model modes share every other byte of the pipeline (payload builder, state, commits):
 * - `dry`: a scripted model, no network — validates the plumbing and the report.
 * - `live`: NanoGPT through the app's own /api/chat route (a dev server must be running).
 *
 * Runs under Vitest with fake-indexeddb: see `__tests__/live-replay.test.ts`.
 */

import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type {
    BackgroundRouteSnapshot,
    BeatAuditReport,
    CharacterIntent,
    DirectedSceneDecision,
    SceneBeatRecord,
} from '@/types/scene';
import {
    commitStoryStateRevision,
    getConversation,
    getStoryState,
    saveCharacter,
    saveConversation,
    saveMessage,
    saveSceneBeat,
    saveStoryState,
} from '@/lib/db';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { encryptApiKey } from '@/lib/crypto/api-keys';
import { backgroundAICall, resolveBackgroundRoute } from '@/lib/ai/background-ai';
import {
    buildAgentPayload,
    buildRetrievalStack,
    buildSamplerParams,
    type SamplerParams,
} from '@/lib/ai/conversation-context';
import { directSceneBeat, reflectCharacter } from '@/lib/ai/directed-scene';
import { executeDirectedBeat, type DirectedBeatDeps } from '@/lib/ai/directed-beat';
import {
    createInitialStoryState,
    getStoryStateForBranch,
    resolveSceneCharacters,
    resolveSceneEntryCandidates,
    storyRoster,
} from '@/lib/ai/story-state';
import { auditDirectedComposition } from '@/lib/ai/beat-auditor';
import { maintainNarrativeAfterBeat } from '@/lib/ai/narrative-maintenance';
import { nameMatchesText } from '@/lib/ai/canon-context';

export interface ReplayFixture {
    character: CharacterCard;
    /** The active branch, root first, one linear chain. */
    messages: Message[];
}

interface ExportedMessage {
    id: string;
    parentId?: string | null;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string | Date;
    isActiveBranch?: boolean;
    messageOrder?: number;
    regenerationIndex?: number;
}

/**
 * Rebuild the active branch of an export. Old exports flag nearly every message as active,
 * so the branch is the parent chain of the newest tip, not the `isActiveBranch` flag.
 */
export function parseReplayExport(raw: unknown): ReplayFixture {
    const data = raw as { character: CharacterCard; messages: ExportedMessage[] };
    if (!data?.character || !Array.isArray(data.messages)) {
        throw new Error('Export invalide : `character` et `messages` sont requis.');
    }
    const byId = new Map(data.messages.map((message) => [message.id, message]));
    const candidates = data.messages.filter((message) => message.isActiveBranch !== false);
    const tip = [...candidates].sort(
        (left, right) =>
            (right.messageOrder ?? 0) - (left.messageOrder ?? 0) ||
            new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    )[0];
    if (!tip) throw new Error('Export vide.');
    const chain: ExportedMessage[] = [];
    const seen = new Set<string>();
    for (let cursor: ExportedMessage | undefined = tip; cursor && !seen.has(cursor.id); ) {
        seen.add(cursor.id);
        chain.unshift(cursor);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    const messages = chain
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message, index, all) => ({
            id: message.id,
            conversationId: 'replay',
            parentId: index === 0 ? null : all[index - 1].id,
            role: message.role as 'user' | 'assistant',
            content: message.content ?? '',
            isActiveBranch: true,
            createdAt: new Date(message.createdAt),
            messageOrder: index + 1,
            regenerationIndex: 0,
        }));
    return { character: data.character, messages };
}

const slug = (value: string) =>
    value
        .toLocaleLowerCase()
        .normalize('NFD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

/** `{{Char N}}Name: description` sections of a whole-work card become one library card each. */
export function extractCastCards(card: CharacterCard): CharacterCard[] {
    const sections = card.description.split(/\{\{Char \d+\}\}/u).slice(1);
    return sections.flatMap((section) => {
        const colon = section.indexOf(':');
        if (colon <= 0) return [];
        const name = section.slice(0, colon).trim();
        if (!name || name.length > 60) return [];
        return [
            {
                id: `replay-cast-${slug(name)}`,
                name,
                description: section.trim(),
                personality: '',
                scenario: '',
                first_mes: '',
                mes_example: '',
            },
        ];
    });
}

/** Cast members whose name (or given name) is written in the replayed window. */
export function castPresentIn(cards: CharacterCard[], messages: Message[]): CharacterCard[] {
    const lower = messages
        .map((message) => message.content)
        .join('\n')
        .toLocaleLowerCase();
    return cards.filter(
        (card) =>
            nameMatchesText(card.name, lower) ||
            nameMatchesText(card.name.split(/\s+/)[0] ?? card.name, lower)
    );
}

export interface ReplayBeatEntry {
    /** Position of the player message in the replayed window (1-based). */
    index: number;
    userMessage: string;
    original: string;
    originalAuditCodes: string[];
    outcome: 'committed' | 'failed' | 'cancelled' | 'awaiting-profile';
    error?: string;
    durationMs: number;
    v2?: {
        text: string;
        decision?: DirectedSceneDecision;
        intents: CharacterIntent[];
        audit?: BeatAuditReport;
        timings: SceneBeatRecord['timings'];
        usage?: SceneBeatRecord['usage'];
        speakerNames: string[];
        sceneSummary?: string;
        location?: string;
        time?: string;
        planRevision?: number;
        activeStep?: string;
    };
}

export interface ReplayTrace {
    mode: 'dry' | 'live';
    model: string;
    composerModel: string;
    userName: string;
    roster: string[];
    messageLimit: number;
    beats: ReplayBeatEntry[];
    startedAt: string;
    finishedAt?: string;
}

export interface RunReplayOptions {
    fixture: ReplayFixture;
    userName: string;
    mode: 'dry' | 'live';
    /** How many messages of the branch are replayed (default 50). */
    messageLimit?: number;
    /** Stop after this many beats (default: every player message in the window). */
    beatLimit?: number;
    /** live: NanoGPT key (encrypted into the settings store, never logged). */
    apiKey?: string;
    /** live: background model id; default = the app's own subscription pick. */
    model?: string;
    /** live: composer model id; default = the background model. */
    composerModel?: string;
    /** Roster override; default = cast sections named in the window. */
    roster?: string[];
    maxSpeakers?: number;
    onBeat?: (entry: ReplayBeatEntry, trace: ReplayTrace) => void;
    log?: (line: string) => void;
}

const BEAT_KINDS = [
    'reaction',
    'initiative',
    'complication',
    'reveal',
    'payoff',
    'breather',
    'transition',
] as const;

/**
 * The scripted writer borrows the first sentence of the original reply that does not address
 * the player: the dry run must exercise the audit, not trip it on the classic narrator's habits.
 */
const dryNarration = (original: string) =>
    original
        .split(/(?<=[.!?])\s+|\n+/u)
        .map((sentence) => sentence.trim())
        .find((sentence) => sentence && !/\b(?:tu|toi|vous|you|your)\b/iu.test(sentence))
        ?.slice(0, 240) ?? 'La scène se poursuit.';

function renderBeatText(messages: Message[]): string {
    return messages
        .map((message) =>
            message.speaker?.kind === 'character'
                ? `**${message.speaker.name}** — ${message.content}`
                : message.content
        )
        .join('\n\n');
}

export async function runReplay(options: RunReplayOptions): Promise<ReplayTrace> {
    const log = options.log ?? (() => {});
    const messageLimit = options.messageLimit ?? 50;
    const messages = options.fixture.messages.slice(0, messageLimit).map((message) => ({
        ...message,
        conversationId: 'replay-conversation',
    }));
    const root: CharacterCard & { longTermMemory: string[] } = {
        ...options.fixture.character,
        id: 'replay-root',
        longTermMemory: [],
    };
    const castCards = extractCastCards(root);
    const present = castPresentIn(castCards, messages);
    const roster =
        options.roster ??
        (present.length ? present : castCards.slice(0, 3)).map((card) => card.name);
    await saveCharacter(root);
    for (const card of castCards) await saveCharacter({ ...card, longTermMemory: [] });

    const conversation: Conversation = {
        id: 'replay-conversation',
        characterId: root.id,
        title: `Replay — ${root.name}`,
        sceneMode: true,
        sceneStyle: 'composed-turns',
        directedNarrativeVersion: 2,
        sceneRoster: roster,
        createdAt: messages[0]?.createdAt ?? new Date(),
        updatedAt: new Date(),
    };
    await saveConversation(conversation);

    // Model routes. Live goes through the app's own settings store so the pipeline resolves
    // the route exactly as the chat page does; dry never touches the network.
    let route: BackgroundRouteSnapshot;
    if (options.mode === 'live') {
        if (!options.apiKey) throw new Error('Mode live : clé NanoGPT requise.');
        useSettingsStore.setState({
            apiKeys: [{ provider: 'nanogpt', encryptedKey: await encryptApiKey(options.apiKey) }],
            backgroundProvider: 'nanogpt',
            nanogptBackgroundModel: options.model ?? null,
            enableDirectedSceneMode: true,
            directedAuditMode: 'shadow',
        });
        const resolved = await resolveBackgroundRoute({ refreshSubscriptionModels: true });
        if (!resolved) throw new Error('Aucune route NanoGPT résolue (clé ou abonnement).');
        route = resolved;
    } else {
        useSettingsStore.setState({ enableDirectedSceneMode: true, directedAuditMode: 'shadow' });
        route = {
            provider: 'openrouter',
            model: 'scripted-dry-model',
            billingScope: 'free',
            routing: 'auto',
            resolvedAt: Date.now(),
        };
    }
    const composerRoute: BackgroundRouteSnapshot = {
        ...route,
        model: options.composerModel ?? route.model,
    };
    const sampler: SamplerParams = buildSamplerParams(null, {
        temperature: 0.8,
        enableReasoning: false,
        useBatchMode: false,
    });

    const trace: ReplayTrace = {
        mode: options.mode,
        model: route.model,
        composerModel: composerRoute.model,
        userName: options.userName,
        roster,
        messageLimit,
        beats: [],
        startedAt: new Date().toISOString(),
    };
    log(
        `[replay] ${options.mode} · ${route.provider}/${route.model} · roster ${roster.join(', ')}`
    );

    const persona = { name: options.userName, bio: '' };
    let beatsRun = 0;
    for (let index = 0; index < messages.length; index++) {
        if (messages[index].role !== 'user') continue;
        if (options.beatLimit != null && beatsRun >= options.beatLimit) break;
        const history = messages.slice(0, index + 1);
        const originalReplies: Message[] = [];
        for (
            let next = index + 1;
            next < messages.length && messages[next].role !== 'user';
            next++
        ) {
            originalReplies.push(messages[next]);
        }
        const original = originalReplies.map((message) => message.content).join('\n\n');
        // A player message the window cuts before its reply has nothing to compare against.
        if (!original.trim()) continue;
        beatsRun++;

        // The branch as the app would see it: exactly the history, nothing after the trigger.
        for (const message of history) await saveMessage(message);
        useChatStore.setState({ conversations: [conversation], messages: history });
        const stack = await buildRetrievalStack({
            character: root,
            conversation,
            history,
            activeBranchMessageIds: history.map((message) => message.id),
            personaName: options.userName,
            preset: null,
            lorebook: null,
            enableHierarchicalSummaries: false,
        });
        const storedConversation = (await getConversation(conversation.id)) ?? conversation;

        // Dry model: a scripted Director/reflection/writer shaped from the ORIGINAL reply, so
        // the plumbing (payloads, state, commits, audit, report) runs without a network.
        let dryDecision: DirectedSceneDecision | undefined;
        const dryDirect: DirectedBeatDeps['direct'] = async (params) => {
            const lower = original.toLocaleLowerCase();
            const onStage = new Set(
                params.state.scene.participants
                    .filter((participant) => participant.presence !== 'offstage')
                    .map((participant) => participant.character.id)
            );
            const participants = params.profiles
                .filter(
                    (profile) =>
                        onStage.has(profile.ref.id) &&
                        profile.ref.readiness === 'ready' &&
                        nameMatchesText(profile.ref.displayName.split(/\s+/)[0], lower)
                )
                .slice(0, params.maxSpeakers)
                .map((profile, position) => ({
                    characterRefId: profile.ref.id,
                    name: profile.ref.displayName,
                    mode: 'speak' as const,
                    attention: position === 0 ? ('full' as const) : ('brief' as const),
                    reason: 'Nommé dans la réponse originale.',
                    direction: 'Réagir en restant fidèle à la scène.',
                }));
            dryDecision = {
                sceneGoal: `Rejouer le beat ${beatsRun} (scripté).`,
                participants,
                observedTransitions: [],
                plannedTransitions: [],
                beatKind: BEAT_KINDS[(beatsRun - 1) % BEAT_KINDS.length],
                initiativeOwner: participants[0]?.characterRefId ?? 'world',
                concreteChange: original.split(/(?<=[.!?])\s/u)[0]?.slice(0, 160),
                playerFrame: {
                    perceptions: ['un regard insistant'],
                    externalPressures: [],
                    affordances: [],
                },
            };
            return dryDecision;
        };
        const dryReflect: DirectedBeatDeps['reflect'] = async (params) => ({
            characterRefId: params.profile.ref.id,
            name: params.profile.ref.displayName,
            attention: params.participant.attention as 'brief' | 'full',
            stance: `Position propre à ${params.profile.ref.displayName}`,
            initiative: 'Prendre la parole avant les autres.',
            directionResponse: 'accept',
            speechIntent: 'Répondre au joueur sans le flatter.',
            observableAction: 'Se redresse.',
        });
        const dryCompose: DirectedBeatDeps['compose'] = async () => ({
            content: JSON.stringify({
                narration: `[dry] ${dryNarration(original)}`,
                turns: (dryDecision?.participants ?? []).map((participant, position) => ({
                    characterRefId: participant.characterRefId,
                    text: `${['Elle hausse un sourcil.', 'Elle croise les bras.'][position % 2]} « ${position === 0 ? 'On verra bien' : 'Parle pour toi'}, ${options.userName}. »`,
                })),
                sceneSummary: `[dry] beat ${beatsRun} rejoué.`,
            }),
        });

        const deps: DirectedBeatDeps = {
            resolveRoute: async () => route,
            loadStoredState: getStoryStateForBranch,
            loadState: getStoryState,
            resolveCharacters: resolveSceneCharacters,
            resolveEntryCandidates: resolveSceneEntryCandidates,
            buildAgentPayload: async ({ contract, frozenWindow }) =>
                buildAgentPayload({
                    stack,
                    character: root,
                    conversation: storedConversation,
                    history,
                    preset: null,
                    engine: null,
                    persona,
                    provider: route.provider,
                    agentContract: contract,
                    frozenWindow,
                }),
            sampler,
            direct: options.mode === 'live' ? directSceneBeat : dryDirect,
            reflect: options.mode === 'live' ? reflectCharacter : dryReflect,
            compose:
                options.mode === 'live'
                    ? async ({ contract, signal, frozenWindow }) => {
                          const payload = await deps.buildAgentPayload({ contract, frozenWindow });
                          const result = await backgroundAICall({
                              systemPrompt: '',
                              userPrompt: '',
                              messages: payload.messages,
                              sampler,
                              cachePrefixLength: payload.stablePrefixLength,
                              maxRetries: 1,
                              route: composerRoute,
                              signal,
                              priority: 'scene',
                              timeoutMs: 300_000,
                          });
                          return result ? { content: result.content, usage: result.usage } : null;
                      }
                    : dryCompose,
            persistBeat: saveSceneBeat,
            commitObservedState: async (state, anchorMessageId) => {
                await commitStoryStateRevision(state, anchorMessageId);
                const anchor = messages.find((message) => message.id === anchorMessageId);
                if (anchor) anchor.storyStateRevisionId = state.id;
            },
            // Teacher-forced: the V2 bubbles are recorded, never spliced into the branch, so
            // the next beat still reads the ORIGINAL transcript. The state revision is what
            // carries over, anchored on the player message that triggered the beat.
            commitBeat: async ({ beat, storyState, messages: outputs }) => {
                await saveStoryState(storyState);
                await saveSceneBeat(beat);
                for (const output of outputs) await saveMessage(output);
                const current = (await getConversation(conversation.id)) ?? conversation;
                await saveConversation({
                    ...current,
                    activeStoryStateRevisionId: storyState.id,
                    sceneRoster: storyRoster(storyState),
                    updatedAt: new Date(),
                });
            },
        };

        // Snapshot BEFORE the beat: the original reply is judged against the state it was
        // written from, not against what the Director observed while regenerating it.
        const originalState =
            (await getStoryStateForBranch(storedConversation, history)) ??
            createInitialStoryState({ conversation: storedConversation, profiles: [] });
        const startedAt = Date.now();
        log(
            `[replay] beat ${beatsRun} · message ${index + 1}/${messages.length} · ${history.length} messages de contexte`
        );
        const outcome = await executeDirectedBeat(
            {
                conversation: storedConversation,
                character: root,
                beatHistory: history,
                userName: options.userName,
                maxSpeakers: options.maxSpeakers ?? 4,
                reflectionConcurrency: 2,
                rpJournal: stack.canonOptions.rpJournal,
                composer: { provider: composerRoute.provider, model: composerRoute.model },
                signal: new AbortController().signal,
                triggerKind: 'player-message',
                auditMode: 'shadow',
            },
            deps
        );

        const entry: ReplayBeatEntry = {
            index: index + 1,
            userMessage: messages[index].content,
            original,
            originalAuditCodes: auditDirectedComposition({
                composition: { narration: original, turns: [] },
                decision: { participants: [], observedTransitions: [], plannedTransitions: [] },
                intents: [],
                state: originalState,
                solo: true,
                userName: options.userName,
            })
                // The original has no Director decision: signals that read the decision
                // (a missing concreteChange) would be noise, not a measure of the prose.
                .issues.filter((issue) => issue.code !== 'missing-initiative')
                .map((issue) => `${issue.code}:${issue.severity}`),
            outcome: outcome.kind,
            durationMs: Date.now() - startedAt,
        };

        if (outcome.kind === 'committed') {
            const trigger = messages[index];
            trigger.storyStateRevisionId = outcome.state.id;
            await saveMessage(trigger);
            // The planner runs after the beat exactly as the chat page schedules it; its
            // revision (if any) must also carry over to the next beat.
            if (options.mode === 'live') {
                const current = (await getConversation(conversation.id)) ?? conversation;
                useChatStore.setState({
                    conversations: [current],
                    messages: [...history, ...outcome.messages],
                });
                const finalMessage = outcome.messages[outcome.messages.length - 1];
                try {
                    await maintainNarrativeAfterBeat({
                        character: root,
                        conversationId: conversation.id,
                        beatId: outcome.record.id,
                        targetMessageId: finalMessage.id,
                        beatContent: outcome.beatContent,
                        stalled: false,
                        history,
                        sceneContext: {
                            stack,
                            conversation: current,
                            preset: null,
                            engine: null,
                            persona,
                            provider: route.provider,
                            sampler,
                        },
                    });
                } catch (error) {
                    log(
                        `[replay] maintenance ignorée : ${error instanceof Error ? error.message : error}`
                    );
                }
                const after = await getConversation(conversation.id);
                if (after?.activeStoryStateRevisionId) {
                    trigger.storyStateRevisionId = after.activeStoryStateRevisionId;
                    await saveMessage(trigger);
                }
            }
            const latest =
                (trigger.storyStateRevisionId &&
                    (await getStoryState(trigger.storyStateRevisionId))) ||
                outcome.state;
            entry.v2 = {
                text: renderBeatText(outcome.messages),
                decision: outcome.record.decision,
                intents: outcome.record.intents,
                audit: outcome.record.audit,
                timings: outcome.record.timings,
                usage: outcome.record.usage,
                speakerNames: outcome.speakerNames,
                sceneSummary: latest.scene.summary,
                location: latest.scene.location,
                time: latest.scene.time,
                planRevision: latest.plot.planRevision,
                activeStep: latest.plot.steps?.find((step) => step.status === 'active')?.premise,
            };
        } else {
            entry.error =
                outcome.record.errors[outcome.record.errors.length - 1]?.message ??
                ('error' in outcome && outcome.error instanceof Error
                    ? outcome.error.message
                    : String(outcome.kind));
            entry.v2 = {
                text: '',
                decision: outcome.record.decision,
                intents: outcome.record.intents,
                audit: outcome.record.audit,
                timings: outcome.record.timings,
                usage: outcome.record.usage,
                speakerNames: [],
            };
        }
        trace.beats.push(entry);
        log(
            `[replay] beat ${beatsRun} → ${entry.outcome} en ${Math.round(entry.durationMs / 1000)} s` +
                (entry.error ? ` (${entry.error})` : '')
        );
        options.onBeat?.(entry, trace);
    }
    trace.finishedAt = new Date().toISOString();
    return trace;
}

const words = (text: string) => text.split(/\s+/u).filter(Boolean).length;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const count = (entries: string[], prefix: string) =>
    entries.filter((code) => code.startsWith(prefix)).length;

export function renderReplayReport(trace: ReplayTrace): string {
    const committed = trace.beats.filter((beat) => beat.outcome === 'committed');
    const failed = trace.beats.filter((beat) => beat.outcome !== 'committed');
    const originalCodes = trace.beats.flatMap((beat) => beat.originalAuditCodes);
    const v2Codes = committed.flatMap(
        (beat) => beat.v2?.audit?.issues.map((issue) => `${issue.code}:${issue.severity}`) ?? []
    );
    const distribution = (values: Array<string | undefined>) => {
        const tally = new Map<string, number>();
        for (const value of values) tally.set(value ?? '—', (tally.get(value ?? '—') ?? 0) + 1);
        return [...tally.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([key, total]) => `${key} ×${total}`)
            .join(', ');
    };
    const avg = (values: number[]) =>
        values.length
            ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
            : 0;
    const speakerName = (beat: ReplayBeatEntry, id?: string) =>
        id === 'world' || !id
            ? 'monde'
            : (beat.v2?.decision?.participants.find((p) => p.characterRefId === id)?.name ?? id);

    const lines: string[] = [];
    lines.push(`# Rejeu V2 — ${trace.mode} · ${trace.model}`);
    lines.push('');
    lines.push(`- Joueur : ${trace.userName} · roster : ${trace.roster.join(', ')}`);
    lines.push(
        `- Fenêtre : ${trace.messageLimit} messages · ${trace.beats.length} beats · ${committed.length} commités · ${failed.length} en échec`
    );
    lines.push(
        `- Compositeur : ${trace.composerModel} · début ${trace.startedAt} · fin ${trace.finishedAt ?? '—'}`
    );
    lines.push(
        `- Durée moyenne par beat : ${avg(committed.map((beat) => beat.durationMs)) / 1000} s`
    );
    lines.push('');
    lines.push('## Comparaison globale');
    lines.push('');
    lines.push('| Mesure | Original | V2 |');
    lines.push('|---|---|---|');
    lines.push(
        `| Contrôle du joueur (dur) | ${count(originalCodes, 'player-control:hard')} | ${count(v2Codes, 'player-control:hard')} |`
    );
    lines.push(
        `| Contrôle du joueur (à confirmer) | ${count(originalCodes, 'player-control:warning')} | ${count(v2Codes, 'player-control:warning')} |`
    );
    lines.push(
        `| Fin passive / « que fais-tu ? » | ${count(originalCodes, 'passive-ending')} | ${count(v2Codes, 'passive-ending')} |`
    );
    lines.push(
        `| Lieu absent du texte | ${count(originalCodes, 'unused-setting')} | ${count(v2Codes, 'unused-setting')} |`
    );
    lines.push(
        `| Mots par réponse (moy., beats commités) | ${avg(committed.map((beat) => words(beat.original)))} | ${avg(committed.map((beat) => words(beat.v2?.text ?? '')))} |`
    );
    lines.push(
        `| Beats à ≥ 2 voix distinctes | — | ${committed.filter((beat) => (beat.v2?.speakerNames.length ?? 0) >= 2).length} |`
    );
    lines.push(
        `| Réflexions privées (total) | — | ${committed.reduce((sum, beat) => sum + (beat.v2?.intents.length ?? 0), 0)} |`
    );
    lines.push(
        `| Beats avec changement concret déclaré | — | ${committed.filter((beat) => beat.v2?.decision?.concreteChange).length} |`
    );
    lines.push(
        `| Réécritures | — | ${committed.filter((beat) => beat.v2?.audit?.rewritten).length} |`
    );
    lines.push('');
    lines.push(
        `- Types de beat (V2) : ${distribution(committed.map((beat) => beat.v2?.decision?.beatKind))}`
    );
    lines.push(
        `- Porteurs d’initiative (V2) : ${distribution(committed.map((beat) => speakerName(beat, beat.v2?.decision?.initiativeOwner)))}`
    );
    lines.push(
        `- Statuts d’audit (V2) : ${distribution(committed.map((beat) => beat.v2?.audit?.status))}`
    );
    lines.push(`- Signaux d’audit (V2) : ${distribution(v2Codes) || 'aucun'}`);
    lines.push(`- Signaux sur l’original : ${distribution(originalCodes) || 'aucun'}`);
    if (failed.length) {
        lines.push('');
        lines.push('### Échecs');
        for (const beat of failed)
            lines.push(`- Beat ${beat.index} : ${beat.outcome} — ${beat.error ?? ''}`);
    }
    lines.push('');
    lines.push('## Beat par beat');
    for (const beat of trace.beats) {
        lines.push('');
        lines.push(`### Beat · message ${beat.index}`);
        lines.push('');
        lines.push(`**Joueur :** ${clip(beat.userMessage, 500)}`);
        lines.push('');
        lines.push(
            `**Original** (${words(beat.original)} mots · ${beat.originalAuditCodes.join(', ') || 'aucun signal'})`
        );
        lines.push('');
        lines.push(`> ${clip(beat.original, 1200).replace(/\n/g, '\n> ')}`);
        lines.push('');
        if (!beat.v2 || beat.outcome !== 'committed') {
            lines.push(`**V2 :** ${beat.outcome} — ${beat.error ?? ''}`);
            continue;
        }
        const v2 = beat.v2;
        const decision = v2.decision;
        lines.push(
            `**V2** (${words(v2.text)} mots · ${Math.round(beat.durationMs / 1000)} s · audit ${v2.audit?.status ?? '—'}${v2.audit?.rewritten ? ' · réécrit' : ''})`
        );
        lines.push('');
        lines.push(
            v2.text
                .split('\n')
                .map((line) => `> ${line}`)
                .join('\n')
        );
        lines.push('');
        if (decision) {
            lines.push('**Directeur**');
            lines.push(`- But : ${decision.sceneGoal ?? '—'}`);
            lines.push(
                `- Type : ${decision.beatKind ?? '—'} · initiative : ${speakerName(beat, decision.initiativeOwner)} · intensité ${decision.intensity ?? '—'} · humour ${decision.humor ?? '—'}`
            );
            lines.push(`- Changement visé : ${decision.concreteChange ?? '—'}`);
            if (decision.narrationHint) lines.push(`- Indication : ${decision.narrationHint}`);
            if (decision.playerFrame) {
                const frame = decision.playerFrame;
                lines.push(
                    `- Cadre joueur : perçoit ${frame.perceptions.join(' / ') || '—'} · pressions ${frame.externalPressures.join(' / ') || '—'} · possibilités ${frame.affordances.join(' / ') || '—'}`
                );
            }
            for (const participant of decision.participants) {
                lines.push(
                    `- ${participant.name} (${participant.mode}, ${participant.attention}) : ${participant.direction ?? participant.reason}`
                );
            }
            if (decision.castingRequest)
                lines.push(
                    `- Casting demandé : ${decision.castingRequest.role} — ${decision.castingRequest.reason}`
                );
            if (decision.observedTransitions.length || decision.plannedTransitions.length) {
                lines.push(
                    `- Transitions : ${[...decision.observedTransitions, ...decision.plannedTransitions].map((t) => `${t.origin} ${t.type}${t.characterName ? ` ${t.characterName}` : ''}${t.value ? ` → ${t.value}` : ''}`).join(' ; ')}`
                );
            }
            lines.push('');
        }
        if (v2.intents.length) {
            lines.push('**Réflexions privées**');
            for (const intent of v2.intents) {
                lines.push(
                    `- ${intent.name} — position : ${intent.stance ?? '—'} · initiative : ${intent.initiative ?? '—'} · direction : ${intent.directionResponse ?? '—'}${intent.directionResponseNote ? ` (${intent.directionResponseNote})` : ''}`
                );
                lines.push(
                    `  - veut : ${intent.privateGoal ?? '—'} · dit pour : ${intent.speechIntent ?? '—'} · fait : ${intent.observableAction ?? '—'}`
                );
                if (intent.stateDelta && Object.values(intent.stateDelta).some(Boolean)) {
                    lines.push(`  - delta : ${JSON.stringify(intent.stateDelta)}`);
                }
            }
            lines.push('');
        }
        if (v2.audit?.issues.length) {
            lines.push('**Audit**');
            for (const issue of v2.audit.issues)
                lines.push(`- ${issue.severity} · ${issue.code} : ${issue.message}`);
            lines.push('');
        }
        lines.push(
            `**État après le beat** — lieu : ${v2.location ?? '—'} · temps : ${v2.time ?? '—'} · résumé : ${v2.sceneSummary ?? '—'}${v2.activeStep ? ` · étape active : ${v2.activeStep}` : ''}${v2.planRevision ? ` · plan rév. ${v2.planRevision}` : ''}`
        );
        if (v2.timings) {
            lines.push(
                `_Temps : directeur ${v2.timings.director ?? '—'} ms · réflexions ${v2.timings.reflections ?? '—'} ms · compositeur ${v2.timings.composer ?? '—'} ms · total ${v2.timings.total ?? '—'} ms_`
            );
        }
    }
    return lines.join('\n');
}
