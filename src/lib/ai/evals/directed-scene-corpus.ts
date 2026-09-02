/**
 * Deterministic acceptance corpus for the directed-turn pipeline.
 *
 * Every fixture has two halves:
 * - `expected`: invariants that hold whatever model produced the beat. They are what a human
 *   or an evaluator scores when the corpus is replayed against Nexus normal, classic turns,
 *   unified turns, directed turns and imported SillyTavern presets with a real model.
 * - `script`: a scripted model (Director decision, compositions, injected fault) so the same
 *   invariants can be checked deterministically under Vitest against the real orchestrator
 *   (`executeDirectedBeat`) — see `__tests__/directed-scene-corpus.test.ts`.
 *
 * Names, never ids, appear here; the runner resolves them into stable `CharacterRef` ids.
 */
import type {
    ReflectionAttention,
    SceneAgency,
    SceneParticipationMode,
    ScenePresence,
    SceneTransitionType,
} from '@/types/scene';

export interface ScriptedTransition {
    type: SceneTransitionType;
    name?: string;
    presence?: ScenePresence;
    agency?: SceneAgency;
    value?: string;
    evidence?: string;
}

export interface ScriptedParticipant {
    name: string;
    mode: SceneParticipationMode;
    attention: ReflectionAttention;
    direction?: string;
}

export interface ScriptedComposition {
    narration?: string;
    turns?: Array<{ name: string; text: string; effects?: ScriptedTransition[] }>;
    effects?: ScriptedTransition[];
}

export type ScriptedFault =
    | 'reflection-failure'
    | 'quota'
    | 'cancel-during-composition'
    | 'branch-switch'
    | 'reload';

export interface DirectedSceneScript {
    /** Ready character cards outside the roster the Director may admit. */
    library?: string[];
    /** Roster names with neither card nor dossier: ad-hoc stubs. */
    stubs?: string[];
    /** Names matching two cards: the beat must pause for a choice. */
    ambiguous?: string[];
    /** Story state already attached to the branch before the beat. */
    state?: {
        location?: string;
        locks?: string[];
        participants?: Array<{ name: string; presence?: ScenePresence; agency?: SceneAgency }>;
        knowledge?: Array<{ text: string; knownBy: string[]; aliases?: string[] }>;
    };
    director: {
        participants: ScriptedParticipant[];
        observed?: ScriptedTransition[];
        planned?: ScriptedTransition[];
    };
    /** First attempt, then the single allowed correction. */
    compositions: ScriptedComposition[];
    fault?: ScriptedFault;
    /** Workers that fail (or die with the tab) on the first attempt. */
    failingReflections?: string[];
}

export interface DirectedSceneEvalCase {
    id: string;
    title: string;
    tags: string[];
    roster: string[];
    userMessage: string;
    expected: {
        active?: string[];
        inactive?: string[];
        mustSpeak?: string[];
        mustNotSpeak?: string[];
        maxSpeakers?: number;
        allowNoDialogue?: boolean;
        requireClarification?: boolean;
        preserveSecret?: string;
        location?: string;
        atomicOnFailure?: boolean;
        preserveBranch?: boolean;
    };
    script: DirectedSceneScript;
}

const speak = (name: string, attention: ReflectionAttention = 'brief'): ScriptedParticipant => ({
    name,
    mode: 'speak',
    attention,
});

export const DIRECTED_SCENE_EVAL_CORPUS: DirectedSceneEvalCase[] = [
    {
        id: 'two-explicit-address',
        title: 'Interlocuteur explicitement sollicité',
        tags: ['2-characters', 'explicit-address'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Alice, dis-moi ce que tu as vu.',
        expected: { mustSpeak: ['Alice'] },
        script: {
            director: {
                participants: [
                    speak('Alice', 'full'),
                    { name: 'Bob', mode: 'act', attention: 'brief' },
                ],
            },
            compositions: [
                {
                    narration: 'Le silence retombe sur le quai.',
                    turns: [
                        { name: 'Alice', text: 'J’ai vu la porte s’ouvrir toute seule.' },
                        { name: 'Bob', text: 'Il croise les bras sans un mot.' },
                    ],
                },
            ],
        },
    },
    {
        id: 'eight-character-cap',
        title: 'Scène bondée avec plafond d’intervenants',
        tags: ['8-characters', 'speaker-cap'],
        roster: ['Ada', 'Bruno', 'Camille', 'Denis', 'Elena', 'Farid', 'Gaëlle', 'Hugo'],
        userMessage: 'La cloche d’alarme retentit dans toute la salle.',
        expected: { maxSpeakers: 5 },
        script: {
            director: {
                participants: [
                    'Ada',
                    'Bruno',
                    'Camille',
                    'Denis',
                    'Elena',
                    'Farid',
                    'Gaëlle',
                    'Hugo',
                ].map((name) => speak(name)),
            },
            compositions: [
                {
                    narration: 'La cloche hurle.',
                    turns: [
                        'Ada',
                        'Bruno',
                        'Camille',
                        'Denis',
                        'Elena',
                        'Farid',
                        'Gaëlle',
                        'Hugo',
                    ].map((name) => ({ name, text: `${name} sursaute.` })),
                },
                {
                    narration: 'La cloche hurle.',
                    turns: ['Ada', 'Bruno', 'Camille', 'Denis', 'Elena'].map((name) => ({
                        name,
                        text: `${name} sursaute.`,
                    })),
                },
            ],
        },
    },
    {
        id: 'observed-exit',
        title: 'Départ déjà accompli par le message utilisateur',
        tags: ['exit', 'observed-transition'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Alice est partie. Je me tourne vers Bob.',
        expected: { inactive: ['Alice'], mustNotSpeak: ['Alice'], mustSpeak: ['Bob'] },
        script: {
            director: {
                observed: [{ type: 'exit', name: 'Alice', evidence: 'Alice est partie.' }],
                participants: [speak('Bob'), speak('Alice')],
            },
            compositions: [{ turns: [{ name: 'Bob', text: 'Elle reviendra, tu verras.' }] }],
        },
    },
    {
        id: 'false-exit',
        title: 'Faux départ sans sortie de scène',
        tags: ['false-exit'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Alice se tourne vers la porte, mais hésite encore.',
        expected: { active: ['Alice'] },
        script: {
            director: { participants: [speak('Alice', 'full')] },
            compositions: [{ turns: [{ name: 'Alice', text: 'Elle reste sur le seuil.' }] }],
        },
    },
    {
        id: 'observed-entry',
        title: 'Entrée visible confirmée',
        tags: ['entry', 'observed-transition'],
        roster: ['Alice'],
        userMessage: 'Bob entre dans la pièce et referme la porte.',
        expected: { active: ['Bob'] },
        script: {
            library: ['Bob'],
            director: {
                observed: [{ type: 'enter', name: 'Bob', evidence: 'Bob entre dans la pièce' }],
                participants: [speak('Bob'), { name: 'Alice', mode: 'act', attention: 'brief' }],
            },
            compositions: [
                {
                    turns: [
                        { name: 'Bob', text: 'Désolé du retard.' },
                        { name: 'Alice', text: 'Elle range la lettre.' },
                    ],
                },
            ],
        },
    },
    {
        id: 'planned-entry',
        title: 'Entrée proposée devant être visible',
        tags: ['entry', 'planned-transition'],
        roster: ['Alice'],
        userMessage: 'Un bruit de pas se rapproche dans le couloir. Serait-ce Bob ?',
        expected: { active: ['Bob'] },
        script: {
            library: ['Bob'],
            director: {
                planned: [{ type: 'enter', name: 'Bob' }],
                participants: [speak('Alice'), { name: 'Bob', mode: 'act', attention: 'brief' }],
            },
            compositions: [
                {
                    narration: 'Bob apparaît dans l’embrasure, essoufflé.',
                    turns: [{ name: 'Alice', text: 'Tu tombes bien.' }],
                },
            ],
        },
    },
    {
        id: 'return-after-exit',
        title: 'Retour d’un personnage hors scène',
        tags: ['return'],
        roster: ['Alice'],
        userMessage: 'Bob revient finalement dans la cuisine.',
        expected: { active: ['Bob'] },
        script: {
            state: {
                participants: [{ name: 'Alice' }, { name: 'Bob', presence: 'offstage' }],
            },
            director: {
                observed: [{ type: 'enter', name: 'Bob' }],
                participants: [speak('Bob')],
            },
            compositions: [{ turns: [{ name: 'Bob', text: 'Ça sent le café.' }] }],
        },
    },
    {
        id: 'silent-witness',
        title: 'Témoin silencieux mais présent',
        tags: ['silent'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Bob observe Alice sans dire un mot.',
        expected: { active: ['Bob'], mustNotSpeak: ['Bob'] },
        script: {
            director: {
                participants: [speak('Alice'), { name: 'Bob', mode: 'silent', attention: 'none' }],
            },
            compositions: [{ turns: [{ name: 'Alice', text: 'Elle soutient son regard.' }] }],
        },
    },
    {
        id: 'remote-phone',
        title: 'Participant distant joignable',
        tags: ['remote'],
        roster: ['Alice', 'Bob'],
        userMessage: 'J’appelle Bob et mets le téléphone sur haut-parleur.',
        expected: { mustSpeak: ['Bob'] },
        script: {
            director: {
                observed: [{ type: 'presence', name: 'Bob', presence: 'remote' }],
                participants: [speak('Bob')],
            },
            compositions: [{ turns: [{ name: 'Bob', text: 'Allô ? Je vous entends mal.' }] }],
        },
    },
    {
        id: 'unconscious',
        title: 'Personnage inconscient sans capacité d’action',
        tags: ['agency-none'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Bob reste inconscient sur le canapé.',
        expected: { active: ['Bob'], mustNotSpeak: ['Bob'] },
        script: {
            director: {
                observed: [{ type: 'agency', name: 'Bob', agency: 'none' }],
                participants: [speak('Bob'), speak('Alice')],
            },
            compositions: [{ turns: [{ name: 'Alice', text: 'Elle prend son pouls.' }] }],
        },
    },
    {
        id: 'unknown-profile',
        title: 'Participant sans profil complet',
        tags: ['unknown', 'stub-profile'],
        roster: ['Alice', 'Inconnu'],
        userMessage: 'L’inconnu nous dévisage.',
        expected: { mustNotSpeak: ['Inconnu'] },
        script: {
            stubs: ['Inconnu'],
            director: {
                participants: [
                    speak('Alice'),
                    { name: 'Inconnu', mode: 'silent', attention: 'full' },
                ],
            },
            compositions: [{ turns: [{ name: 'Alice', text: 'Qui êtes-vous ?' }] }],
        },
    },
    {
        id: 'ambiguous-name',
        title: 'Deux cartes portent le même nom',
        tags: ['ambiguous-alias'],
        roster: ['Alex'],
        userMessage: 'Alex, réponds-moi.',
        expected: { requireClarification: true, mustSpeak: ['Alex'] },
        script: {
            ambiguous: ['Alex'],
            director: { participants: [speak('Alex')] },
            compositions: [{ turns: [{ name: 'Alex', text: 'Je t’écoute.' }] }],
        },
    },
    {
        id: 'single-character',
        title: 'Beat à un seul personnage',
        tags: ['1-character'],
        roster: ['Alice'],
        userMessage: 'Je pose la lettre sur la table.',
        expected: { mustSpeak: ['Alice'] },
        script: {
            director: { participants: [{ name: 'Alice', mode: 'speak', attention: 'none' }] },
            compositions: [
                { turns: [{ name: 'Alice', text: 'Elle lit l’adresse sans y toucher.' }] },
            ],
        },
    },
    {
        id: 'narration-only',
        title: 'Beat atmosphérique sans dialogue',
        tags: ['no-dialogue'],
        roster: ['Alice'],
        userMessage: 'Je regarde la tempête gagner la vallée.',
        expected: { allowNoDialogue: true },
        script: {
            director: { participants: [{ name: 'Alice', mode: 'silent', attention: 'none' }] },
            compositions: [{ narration: 'La pluie efface la crête, puis la route.' }],
        },
    },
    {
        id: 'private-secret',
        title: 'Secret connu d’un seul personnage',
        tags: ['secret'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Je leur demande pourquoi la clé a disparu.',
        expected: { preserveSecret: 'Bob a caché la clé' },
        script: {
            state: { knowledge: [{ text: 'Bob a caché la clé', knownBy: ['Bob'] }] },
            director: { participants: [speak('Alice'), speak('Bob', 'full')] },
            compositions: [
                {
                    turns: [
                        { name: 'Alice', text: 'Tout le monde sait que Bob a caché la clé.' },
                        { name: 'Bob', text: 'Il hausse les épaules.' },
                    ],
                },
                {
                    turns: [
                        { name: 'Alice', text: 'Aucune idée. Elle était là hier.' },
                        { name: 'Bob', text: 'Il évite son regard et hausse les épaules.' },
                    ],
                },
            ],
        },
    },
    {
        id: 'canon-user-conflict',
        title: 'Le message visible prime sur le canon',
        tags: ['canon-conflict'],
        roster: ['Alice'],
        userMessage: 'Alice retire sa bague, contrairement à son habitude établie.',
        expected: { active: ['Alice'] },
        script: {
            director: { participants: [speak('Alice', 'full')] },
            compositions: [
                { turns: [{ name: 'Alice', text: 'Elle pose la bague sur la table.' }] },
            ],
        },
    },
    {
        id: 'plan-user-conflict',
        title: 'Le message visible prime sur le plan',
        tags: ['plan-conflict'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Je refuse le duel et quitte l’arène avec Alice.',
        expected: { inactive: ['Alice'] },
        script: {
            director: {
                observed: [{ type: 'exit', name: 'Alice' }],
                participants: [speak('Bob')],
            },
            compositions: [{ turns: [{ name: 'Bob', text: 'Lâches ! crie-t-il dans leur dos.' }] }],
        },
    },
    {
        id: 'locked-location',
        title: 'Un effet planifié ne remplace pas un lieu verrouillé',
        tags: ['lock'],
        roster: ['Alice'],
        userMessage: 'Nous poursuivons la conversation.',
        expected: { location: 'Quai' },
        script: {
            state: { location: 'Quai', locks: ['/scene/location'] },
            director: { participants: [speak('Alice')] },
            compositions: [
                {
                    turns: [{ name: 'Alice', text: 'Elle marche vers la gare.' }],
                    effects: [{ type: 'location', value: 'Gare' }],
                },
            ],
        },
    },
    {
        id: 'user-overrides-lock',
        title: 'Un événement utilisateur remplace une valeur verrouillée',
        tags: ['lock', 'observed-transition'],
        roster: ['Alice'],
        userMessage: 'Nous sommes maintenant sur le quai de la gare.',
        expected: { location: 'Quai de la gare' },
        script: {
            state: { location: 'Quai', locks: ['/scene/location'] },
            director: {
                observed: [{ type: 'location', value: 'Quai de la gare' }],
                participants: [speak('Alice')],
            },
            compositions: [{ turns: [{ name: 'Alice', text: 'Le train est en retard.' }] }],
        },
    },
    {
        id: 'reflection-failure',
        title: 'Échec d’un worker de réflexion',
        tags: ['failure', 'retry'],
        roster: ['Alice', 'Bob', 'Chloé'],
        userMessage: 'Que proposez-vous pour sortir ?',
        expected: { atomicOnFailure: true, mustSpeak: ['Alice', 'Bob', 'Chloé'] },
        script: {
            fault: 'reflection-failure',
            failingReflections: ['Bob'],
            director: { participants: [speak('Alice'), speak('Bob'), speak('Chloé')] },
            compositions: [
                {
                    turns: [
                        { name: 'Alice', text: 'Par le toit.' },
                        { name: 'Bob', text: 'Par les égouts.' },
                        { name: 'Chloé', text: 'Par la porte, tout simplement.' },
                    ],
                },
            ],
        },
    },
    {
        id: 'quota-exhaustion',
        title: 'Quota insuffisant avant un gros beat',
        tags: ['quota', 'failure'],
        roster: ['Ada', 'Bruno', 'Camille', 'Denis', 'Elena', 'Farid'],
        userMessage: 'Chacun expose son plan en détail.',
        expected: { atomicOnFailure: true },
        script: {
            fault: 'quota',
            director: {
                participants: ['Ada', 'Bruno', 'Camille', 'Denis', 'Elena'].map((name) =>
                    speak(name, 'full')
                ),
            },
            compositions: [],
        },
    },
    {
        id: 'cancellation',
        title: 'Annulation pendant la composition',
        tags: ['cancellation', 'failure'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Décidons maintenant.',
        expected: { atomicOnFailure: true },
        script: {
            fault: 'cancel-during-composition',
            director: { participants: [speak('Alice'), speak('Bob')] },
            compositions: [],
        },
    },
    {
        id: 'branch-switch',
        title: 'Changement de branche pendant le beat',
        tags: ['branch', 'stale-result'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Je choisis la porte de gauche.',
        expected: { atomicOnFailure: true, preserveBranch: true },
        script: {
            fault: 'branch-switch',
            director: { participants: [speak('Alice'), speak('Bob')] },
            compositions: [],
        },
    },
    {
        id: 'reload-interrupted',
        title: 'Rechargement pendant les réflexions',
        tags: ['reload', 'interrupted', 'retry'],
        roster: ['Alice', 'Bob'],
        userMessage: 'Réagissez tous les deux.',
        expected: { atomicOnFailure: true, preserveBranch: true, mustSpeak: ['Alice', 'Bob'] },
        script: {
            fault: 'reload',
            failingReflections: ['Bob'],
            director: { participants: [speak('Alice'), speak('Bob')] },
            compositions: [
                {
                    turns: [
                        { name: 'Alice', text: 'Je reste.' },
                        { name: 'Bob', text: 'Moi aussi.' },
                    ],
                },
            ],
        },
    },
];
