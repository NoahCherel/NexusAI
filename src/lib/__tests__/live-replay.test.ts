/**
 * Directed V2 replay harness.
 *
 * Always: a dry run over a synthetic export keeps the harness itself green.
 * On demand: replay a real export (REPLAY_FILE), dry by default, live against NanoGPT when
 * NANOGPT_API_KEY is set and the dev server answers on REPLAY_BASE_URL (localhost:3000).
 *
 *   $env:REPLAY_FILE='C:\...\Conversation.json'; $env:NANOGPT_API_KEY='...';
 *   npx vitest run src/lib/__tests__/live-replay.test.ts
 *
 * Optional: REPLAY_MODE=dry|live, REPLAY_MESSAGES (50), REPLAY_BEATS, REPLAY_MODEL,
 * REPLAY_COMPOSER_MODEL, REPLAY_USER (Noah), REPLAY_OUT (./.replay).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    extractCastCards,
    parseReplayExport,
    renderReplayReport,
    runReplay,
} from '@/lib/ai/evals/live-replay';

const FILE = process.env.REPLAY_FILE;
const KEY = process.env.NANOGPT_API_KEY;
const MODE = (process.env.REPLAY_MODE ?? (KEY ? 'live' : 'dry')) as 'dry' | 'live';
const BASE = process.env.REPLAY_BASE_URL ?? 'http://localhost:3000';
const OUT = process.env.REPLAY_OUT ?? resolve(process.cwd(), '.replay');

// The app calls its own Next routes with relative URLs; Node needs an origin.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(
        typeof input === 'string' && input.startsWith('/') ? `${BASE}${input}` : input,
        init
    )) as typeof fetch;

const syntheticExport = {
    character: {
        id: 'card',
        name: 'Académie',
        description:
            'Un lycée de pilotes.\n{{Char 1}}Alice Martin: Alice est une déléguée sévère qui protège la classe.\n{{Char 2}}Bruno Petit: Bruno est un farceur qui teste tout le monde.',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
    },
    messages: [
        {
            id: 'm1',
            parentId: null,
            role: 'assistant',
            content: 'Alice te fixe depuis le premier rang.',
            createdAt: '2026-01-01T00:00:00Z',
            messageOrder: 1,
        },
        {
            id: 'm2',
            parentId: 'm1',
            role: 'user',
            content: 'Je soutiens son regard.',
            createdAt: '2026-01-01T00:01:00Z',
            messageOrder: 2,
        },
        {
            id: 'm3',
            parentId: 'm2',
            role: 'assistant',
            content: 'Alice hausse un sourcil. Bruno ricane derrière toi. Tu décides de te taire.',
            createdAt: '2026-01-01T00:02:00Z',
            messageOrder: 3,
        },
        {
            id: 'm3b',
            parentId: 'm2',
            role: 'assistant',
            content: 'Version abandonnée.',
            createdAt: '2026-01-01T00:02:30Z',
            messageOrder: 3,
        },
        {
            id: 'm4',
            parentId: 'm3',
            role: 'user',
            content: 'Je demande à Bruno ce qui le fait rire.',
            createdAt: '2026-01-01T00:03:00Z',
            messageOrder: 4,
        },
        {
            id: 'm5',
            parentId: 'm4',
            role: 'assistant',
            content: 'Bruno hausse les épaules. Que fais-tu ?',
            createdAt: '2026-01-01T00:04:00Z',
            messageOrder: 5,
        },
    ],
};

describe('replay harness (dry, synthetic export)', () => {
    it('rebuilds the active branch from the parent chain and extracts the cast', () => {
        const fixture = parseReplayExport(syntheticExport);
        expect(fixture.messages.map((message) => message.id)).toEqual([
            'm1',
            'm2',
            'm3',
            'm4',
            'm5',
        ]);
        expect(fixture.messages[2].parentId).toBe('m2');
        expect(extractCastCards(fixture.character).map((card) => card.name)).toEqual([
            'Alice Martin',
            'Bruno Petit',
        ]);
    });

    it('replays every player message through the real orchestrator and renders a report', async () => {
        const fixture = parseReplayExport(syntheticExport);
        const trace = await runReplay({ fixture, userName: 'Noah', mode: 'dry' });
        expect(trace.roster).toEqual(['Alice Martin', 'Bruno Petit']);
        expect(trace.beats.map((beat) => beat.outcome)).toEqual(['committed', 'committed']);
        // The original reply decided for the player; the scripted V2 beat does not.
        expect(trace.beats[0].originalAuditCodes).toContain('player-control:hard');
        expect(trace.beats[1].originalAuditCodes).toContain('passive-ending:warning');
        expect(trace.beats[0].v2?.audit?.status).not.toBe('failed');
        expect(trace.beats[0].v2?.intents.length).toBeGreaterThan(0);
        // State carries from beat to beat: the second beat committed a later revision.
        expect(trace.beats[1].v2?.sceneSummary).toContain('beat 2');
        const report = renderReplayReport(trace);
        expect(report).toContain('## Comparaison globale');
        expect(report).toContain('### Beat · message 2');
    }, 60_000);
});

describe.skipIf(!FILE)('directed V2 replay of an exported conversation', () => {
    it(
        `replays ${FILE} (${MODE})`,
        async () => {
            const fixture = parseReplayExport(JSON.parse(readFileSync(FILE!, 'utf8')));
            mkdirSync(OUT, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const jsonPath = resolve(OUT, `replay-${MODE}-${stamp}.json`);
            const reportPath = resolve(OUT, `replay-${MODE}-${stamp}.md`);
            const trace = await runReplay({
                fixture,
                userName: process.env.REPLAY_USER ?? 'Noah',
                mode: MODE,
                apiKey: KEY,
                model: process.env.REPLAY_MODEL,
                composerModel: process.env.REPLAY_COMPOSER_MODEL,
                messageLimit: Number(process.env.REPLAY_MESSAGES ?? 50),
                beatLimit: process.env.REPLAY_BEATS ? Number(process.env.REPLAY_BEATS) : undefined,
                log: (line) => console.log(`${new Date().toISOString()} ${line}`),
                onBeat: (_entry, partial) => {
                    // Checkpoint after every beat so a long live run survives an interruption.
                    writeFileSync(jsonPath, JSON.stringify(partial, null, 2));
                    writeFileSync(reportPath, renderReplayReport(partial));
                },
            });
            writeFileSync(jsonPath, JSON.stringify(trace, null, 2));
            writeFileSync(reportPath, renderReplayReport(trace));
            console.log(`[replay] rapport : ${reportPath}`);
            expect(trace.beats.length).toBeGreaterThan(0);
            if (MODE === 'live') {
                expect(trace.beats.some((beat) => beat.outcome === 'committed')).toBe(true);
            }
        },
        4 * 60 * 60 * 1000
    );
});
