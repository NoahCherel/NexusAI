import type {
    BeatAuditIssue,
    BeatAuditReport,
    CharacterIntent,
    CompositionResult,
    DirectedSceneDecision,
    StoryState,
} from '@/types';
import {
    callStructuredAgent,
    parseSceneJson,
    type AgentCallContext,
    type AgentCallUsage,
} from '@/lib/ai/directed-scene';

const visibleText = (composition: CompositionResult) =>
    [composition.narration, ...composition.turns.map((turn) => turn.text)]
        .filter(Boolean)
        .join('\n')
        .trim();

const normalizeWords = (value: string) =>
    new Set(
        value
            .toLocaleLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter((word) => word.length >= 4)
    );

function similarity(left: string, right: string): number {
    const a = normalizeWords(left);
    const b = normalizeWords(right);
    if (!a.size || !b.size) return 0;
    const intersection = [...a].filter((word) => b.has(word)).length;
    return intersection / (a.size + b.size - intersection);
}

/**
 * Decisions, speech and thoughts imposed on the player: a hard violation. `fais`/`do` are out
 * because "tu fais face à" is ordinary second-person narration, and feelings live in the
 * warning list below because "tu ressens un courant d'air" is a perception, not an emotion.
 */
const PLAYER_CONTROL_HARD = [
    /\btu (?:décides|acceptes|refuses|dis|réponds|choisis)\b/iu,
    /\bvous (?:décidez|acceptez|refusez|dites|répondez|choisissez)\b/iu,
    /\byou (?:decide|accept|refuse|say|answer|choose)\b/iu,
];

/**
 * Ambiguous between perception and imposed feeling or thought ("you think you hear
 * footsteps" is an idiom): the judge decides, never the regex.
 */
const PLAYER_CONTROL_SOFT = [
    /\btu (?:ressens|éprouves|veux|as envie|as peur|penses)\b/iu,
    /\bvous (?:ressentez|éprouvez|voulez|avez envie|avez peur|pensez)\b/iu,
    /\byou (?:feel|want|fear|need|think)\b/iu,
];

/**
 * A character addressing the player in the second person ("Tu décides, Noah") is dialogue,
 * not narration deciding for the player. Strip quoted speech and dash-led dialogue lines
 * before the control regexes run, so only narration and stage directions are judged.
 */
export function stripDialogue(text: string): string {
    return (
        text
            // Newline-bounded: one unclosed « must not swallow every narration line after it.
            .replace(/«[^»\n]*»/gu, ' ')
            .replace(/“[^”\n]*”/gu, ' ')
            .replace(/"[^"\n]*"/gu, ' ')
            .replace(/^\s*[—–-]\s.*$/gmu, ' ')
    );
}

const PASSIVE_ENDING = [
    /que (?:fais|faites)-?(?:tu|vous)\s*[?？]?\s*$/iu,
    /what do you do\s*[?？]?\s*$/iu,
    /à toi de (?:voir|choisir|décider)[.!?…]*\s*$/iu,
];

/** Fast, deterministic pre-commit checks. Semantic checks are warnings for the optional judge. */
export function auditDirectedComposition(params: {
    composition: CompositionResult;
    decision: DirectedSceneDecision;
    intents: CharacterIntent[];
    state: StoryState;
    solo: boolean;
    userName?: string;
    rewritten?: boolean;
}): BeatAuditReport {
    const text = visibleText(params.composition);
    const issues: BeatAuditIssue[] = [];
    const add = (issue: BeatAuditIssue) => {
        if (!issues.some((candidate) => candidate.code === issue.code)) issues.push(issue);
    };

    const narrationOnly = stripDialogue(text);
    if (PLAYER_CONTROL_HARD.some((pattern) => pattern.test(narrationOnly))) {
        add({
            code: 'player-control',
            severity: 'hard',
            message: 'La narration attribue une décision, une pensée ou une parole au joueur.',
        });
    }
    if (params.userName && params.userName !== 'the player') {
        const escaped = params.userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const namedControl = new RegExp(
            `\\b${escaped}\\s+(?:décide|accepte|refuse|ressent|pense|dit|répond|choisit|se lève|avance|recule|decides|accepts|refuses|feels|thinks|says|answers|chooses|stands|moves)\\b`,
            'iu'
        );
        if (namedControl.test(narrationOnly)) {
            add({
                code: 'player-control',
                severity: 'hard',
                message: 'La narration agit ou pense à la place du personnage joueur nommé.',
            });
        }
    }
    if (PLAYER_CONTROL_SOFT.some((pattern) => pattern.test(narrationOnly))) {
        add({
            code: 'player-control',
            severity: 'warning',
            message:
                'La narration prête peut-être une émotion ou un désir au joueur ; à confirmer par le juge.',
        });
    }
    const recentKinds = params.state.plot.recentBeatKinds ?? [];
    const recentOwners = params.state.plot.recentInitiativeOwners ?? [];
    const sameKindStreak =
        !!params.decision.beatKind &&
        recentKinds.length >= 3 &&
        recentKinds.slice(-3).every((kind) => kind === params.decision.beatKind);
    const sameOwnerStreak =
        !!params.decision.initiativeOwner &&
        params.decision.initiativeOwner !== 'world' &&
        recentOwners.length >= 3 &&
        recentOwners.slice(-3).every((owner) => owner === params.decision.initiativeOwner);
    if (sameKindStreak || sameOwnerStreak) {
        add({
            code: 'repetitive-structure',
            severity: 'warning',
            message: sameKindStreak
                ? `Quatrième beat « ${params.decision.beatKind} » d’affilée : la structure se répète.`
                : 'Le même personnage porte l’initiative depuis quatre beats.',
        });
    }
    if (PASSIVE_ENDING.some((pattern) => pattern.test(text))) {
        add({
            code: 'passive-ending',
            severity: 'warning',
            message: 'Le beat se termine par une relance passive ou une question obligatoire.',
        });
    }
    if (
        params.decision.beatKind !== 'breather' &&
        !params.decision.concreteChange &&
        !(
            params.composition.effects?.length ||
            params.composition.turns.some((turn) => turn.effects?.length)
        )
    ) {
        add({
            code: 'missing-initiative',
            severity: 'warning',
            message: 'Aucun changement concret n’est identifié pour ce beat.',
        });
    }
    // Solo initiative is normalised upstream (parser + executor force `world`): a hard issue
    // on a Director field could never be fixed by rewriting the prose, so none is raised here.
    if (params.decision.servedStepId) {
        const signalled = params.composition.stepSignals?.some(
            (signal) => signal.stepId === params.decision.servedStepId
        );
        if (!signalled) {
            add({
                code: 'fake-progress',
                severity: 'warning',
                message: 'L’étape annoncée ne possède aucune preuve dans le texte visible.',
            });
        }
    }
    const tone = params.state.scene.tone;
    if (
        tone &&
        ((params.decision.humor != null &&
            (params.decision.humor < tone.humor[0] || params.decision.humor > tone.humor[1])) ||
            (params.decision.intensity != null &&
                (params.decision.intensity < tone.intensity[0] ||
                    params.decision.intensity > tone.intensity[1])) ||
            (params.decision.darkness != null &&
                (params.decision.darkness < tone.darkness[0] ||
                    params.decision.darkness > tone.darkness[1])) ||
            (params.decision.intimacy != null &&
                (params.decision.intimacy < tone.intimacy[0] ||
                    params.decision.intimacy > tone.intimacy[1])))
    ) {
        add({
            code: 'tone-bounds',
            severity: 'warning',
            message: 'Le beat sort des bornes de tonalité configurées.',
        });
    }
    for (let left = 0; left < params.composition.turns.length; left++) {
        for (let right = left + 1; right < params.composition.turns.length; right++) {
            if (
                similarity(
                    params.composition.turns[left].text,
                    params.composition.turns[right].text
                ) > 0.72
            ) {
                add({
                    code: 'voice-similarity',
                    severity: 'warning',
                    message: 'Deux personnages ont des formulations excessivement similaires.',
                });
            }
        }
    }
    const forbiddenHit = (tone?.forbidden ?? [])
        .map((term) => term.trim())
        .filter((term) => term.length >= 3)
        .find((term) => text.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
    if (forbiddenHit) {
        add({
            code: 'tone-bounds',
            severity: 'warning',
            message: `Le texte contient un terme interdit : « ${forbiddenHit} ».`,
        });
    }
    // Free-text stances are compared by word overlap, not by equality; the structured
    // directionResponse catches the other uniformity, every character simply complying.
    const stances = params.intents
        .map((intent) => intent.stance)
        .filter((stance): stance is string => !!stance);
    const responses = params.intents
        .map((intent) => intent.directionResponse)
        .filter((response): response is NonNullable<typeof response> => !!response);
    const stancesAlike =
        stances.length >= 2 &&
        stances.every((stance, index) =>
            stances.every((other, otherIndex) =>
                index === otherIndex ? true : similarity(stance, other) >= 0.6
            )
        );
    const allComply = responses.length >= 2 && responses.every((response) => response === 'accept');
    // Complying with a benign direction is normal; it only reads as uniformity when the
    // characters gave no distinct stance the judge could weigh instead.
    if (!params.solo && (stancesAlike || (allComply && stances.length < 2))) {
        add({
            code: 'uniform-stances',
            severity: 'warning',
            message: stancesAlike
                ? 'Tous les personnages adoptent la même position.'
                : 'Tous les personnages se plient à la direction sans nuance ni refus.',
        });
    }
    if (!params.solo && params.composition.turns.length >= 2) {
        const automaticApproval =
            /\b(?:tu as raison|vous avez raison|bien sûr|excellente idée|parfait|you(?:'re| are) right|of course|great idea|perfect)\b/iu;
        if (params.composition.turns.every((turn) => automaticApproval.test(turn.text))) {
            add({
                code: 'positivity-bias',
                severity: 'warning',
                message:
                    'Tous les personnages approuvent ou valorisent le joueur sans friction visible.',
            });
        }
        const lengths = params.composition.turns
            .map((turn) => turn.text.length)
            .sort((a, b) => a - b);
        if (lengths.at(-1)! > Math.max(180, lengths[0] * 3)) {
            add({
                code: 'spotlight-imbalance',
                severity: 'warning',
                message:
                    'Un personnage monopolise nettement le beat sans justification structurelle.',
            });
        }
    }
    if (params.userName && params.composition.turns.length >= 2) {
        const lowerName = params.userName.toLocaleLowerCase();
        if (
            params.composition.turns.every((turn) =>
                turn.text.toLocaleLowerCase().includes(lowerName)
            )
        ) {
            add({
                code: 'player-overfocus',
                severity: 'warning',
                message: 'Chaque intervention se recentre explicitement sur le personnage joueur.',
            });
        }
    }
    const locationWords = (params.state.scene.location ?? '')
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter((word) => word.length >= 5);
    if (
        locationWords.length &&
        !locationWords.some((word) => text.toLocaleLowerCase().includes(word))
    ) {
        add({
            code: 'unused-setting',
            severity: 'warning',
            message: 'Le lieu établi ne laisse aucune trace concrète dans le beat.',
        });
    }

    return {
        status: issues.some((issue) => issue.severity === 'hard')
            ? 'failed'
            : issues.length
              ? 'warning'
              : 'passed',
        source: 'local',
        issues,
        rewritten: params.rewritten ?? false,
        createdAt: Date.now(),
    };
}

/**
 * Local signals worth a judge call. The others (`unused-setting`, a missing concreteChange)
 * are cheap heuristics that fire on most beats; they are recorded for calibration but must
 * not by themselves cost an API call or force a rewrite.
 */
const JUDGE_TRIGGER_CODES = new Set<BeatAuditIssue['code']>([
    'player-control',
    'positivity-bias',
    'uniform-stances',
    'voice-similarity',
    'spotlight-imbalance',
    'player-overfocus',
    'fake-progress',
    'tone-bounds',
    'passive-ending',
    'repetitive-structure',
]);

export const needsJudge = (report: BeatAuditReport) =>
    report.issues.some((issue) => JUDGE_TRIGGER_CODES.has(issue.code));

const ISSUE_CODES = new Set<BeatAuditIssue['code']>([
    'invalid-participant',
    'private-leak',
    'player-control',
    'missing-initiative',
    'player-overfocus',
    'positivity-bias',
    'uniform-stances',
    'voice-similarity',
    'fake-progress',
    'unused-setting',
    'repetitive-structure',
    'spotlight-imbalance',
    'tone-bounds',
    'passive-ending',
]);

export async function auditCompositionWithModel(params: {
    context: AgentCallContext;
    local: BeatAuditReport;
    composition: CompositionResult;
    decision: DirectedSceneDecision;
    state: StoryState;
    solo: boolean;
    userName: string;
    onUsage?: (usage: AgentCallUsage) => void;
}): Promise<BeatAuditReport> {
    const contract = `[PRE-COMMIT BEAT AUDITOR]
Judge the candidate roleplay beat. Return compact JSON, not prose. Do not demand dialogue in solo mode. World initiative is valid. A breather need not advance the plot. Mark hard only for player control, private knowledge leakage, or an invalid participant; quality weaknesses are warnings.

Player: ${params.userName}
Mode: ${params.solo ? 'solo' : 'ensemble'}
State: ${JSON.stringify(params.state)}
Director: ${JSON.stringify(params.decision)}
Candidate: ${JSON.stringify(params.composition)}
Local signals: ${JSON.stringify(params.local.issues)}

Known codes: ${[...ISSUE_CODES].join(' | ')}

Return exactly: {"issues":[{"code":"one known code","severity":"warning|hard","message":"short actionable reason"}]}`;
    const parsed = await callStructuredAgent({
        context: params.context,
        contract,
        parse: (raw) => parseSceneJson(raw),
        stage: 'validation',
        failureMessage: 'L’auditeur narratif n’a pas répondu.',
        onUsage: params.onUsage,
    });
    const modelIssues: BeatAuditIssue[] = Array.isArray(parsed.issues)
        ? parsed.issues.flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return [];
              const item = entry as Record<string, unknown>;
              const code =
                  typeof item.code === 'string' ? (item.code as BeatAuditIssue['code']) : undefined;
              const severity = item.severity === 'hard' ? 'hard' : 'warning';
              const message = typeof item.message === 'string' ? item.message.trim() : '';
              return code && ISSUE_CODES.has(code) && message
                  ? [{ code, severity, message, confirmedBy: 'judge' as const }]
                  : [];
          })
        : [];
    // Local signals stay in the report for calibration; only what the judge raised or
    // confirmed carries `confirmedBy`, and only that may cost a rewrite in enforce mode.
    const issues = [...params.local.issues];
    for (const issue of modelIssues) {
        const existing = issues.find((candidate) => candidate.code === issue.code);
        if (!existing) issues.push(issue);
        else {
            existing.confirmedBy = 'judge';
            if (issue.severity === 'hard') existing.severity = 'hard';
        }
    }
    return {
        status: issues.some((issue) => issue.severity === 'hard')
            ? 'failed'
            : issues.length
              ? 'warning'
              : 'passed',
        source: 'local+llm',
        issues,
        rewritten: params.local.rewritten,
        createdAt: Date.now(),
    };
}
