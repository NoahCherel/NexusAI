import { describe, it, expect } from 'vitest';
import {
    parseDirectorResponse,
    applySceneChange,
    DEFAULT_MAX_SPEAKERS,
    MAX_SPEAKERS_CEILING,
} from '@/lib/ai/scene-orchestrator';

const roster = ['Naruto Uzumaki', 'Sakura Haruno', 'Kakashi Hatake', 'Gaara'];

describe('parseDirectorResponse', () => {
    it('parses the directed format ({name, direction}) and resolves casing against the roster', () => {
        const raw = JSON.stringify({
            narration: 'A cold wind sweeps the training ground.',
            sceneGoal: 'Force Naruto to admit the plan.',
            speakers: [
                { name: 'naruto uzumaki', direction: 'Deflect with a joke, but sweat.' },
                { name: 'SAKURA HARUNO', direction: 'Press the question, arms crossed.' },
            ],
            sceneChange: { event: 'storm coming' },
        });
        const d = parseDirectorResponse(raw, roster, 'Alex');
        expect(d.narration).toBe('A cold wind sweeps the training ground.');
        expect(d.sceneGoal).toBe('Force Naruto to admit the plan.');
        expect(d.speakers).toEqual([
            { name: 'Naruto Uzumaki', direction: 'Deflect with a joke, but sweat.' },
            { name: 'Sakura Haruno', direction: 'Press the question, arms crossed.' },
        ]);
        expect(d.sceneChange?.event).toBe('storm coming');
    });

    it('still accepts the legacy string[] speakers format (direction undefined)', () => {
        const raw = 'Sure! ```json\n{"speakers": ["Gaara"]}\n``` Done.';
        const d = parseDirectorResponse(raw, roster);
        expect(d.speakers).toEqual([{ name: 'Gaara', direction: undefined }]);
    });

    it('caps speakers at the given max, dedupes, drops unknown names and the player', () => {
        const raw = JSON.stringify({
            speakers: [
                'Naruto Uzumaki',
                { name: 'Naruto Uzumaki', direction: 'dup' },
                'Alex',
                'Random Stranger',
                'Sakura Haruno',
                'Kakashi Hatake',
                'Gaara',
            ],
        });
        const d2 = parseDirectorResponse(raw, [...roster, 'Alex'], 'Alex', 2);
        expect(d2.speakers.map((s) => s.name)).toEqual(['Naruto Uzumaki', 'Sakura Haruno']);

        const dDefault = parseDirectorResponse(raw, [...roster, 'Alex'], 'Alex');
        expect(dDefault.speakers.length).toBeLessThanOrEqual(DEFAULT_MAX_SPEAKERS);
        expect(dDefault.speakers.map((s) => s.name)).not.toContain('Alex');
        expect(dDefault.speakers.map((s) => s.name)).not.toContain('Random Stranger');
    });

    it('never exceeds the hard ceiling even with an absurd max', () => {
        const many = Array.from({ length: 20 }, (_, i) => `P${i}`);
        const raw = JSON.stringify({ speakers: many });
        const d = parseDirectorResponse(raw, many, undefined, 99);
        // Exact: 20 valid candidates → the parser must fill UP TO the ceiling (an empty
        // array would have satisfied the old <= assertion).
        expect(d.speakers.length).toBe(MAX_SPEAKERS_CEILING);
    });

    it('returns a silent decision on malformed or empty output', () => {
        expect(parseDirectorResponse('', roster).speakers).toEqual([]);
        expect(parseDirectorResponse('no json here', roster).speakers).toEqual([]);
        expect(parseDirectorResponse('{"speakers": "Naruto"}', roster).speakers).toEqual([]);
        expect(parseDirectorResponse('{broken json', roster).speakers).toEqual([]);
    });

    it('drops an empty sceneChange object', () => {
        const d = parseDirectorResponse(
            JSON.stringify({ speakers: [], sceneChange: {} }),
            roster
        );
        expect(d.sceneChange).toBeUndefined();
    });
});

describe('applySceneChange', () => {
    it('applies exits then enters, case-insensitively, without duplicates', () => {
        const next = applySceneChange(['Naruto Uzumaki', 'Gaara'], {
            exit: ['gaara'],
            enter: ['Kakashi Hatake', 'naruto uzumaki'],
        });
        expect(next).toEqual(['Naruto Uzumaki', 'Kakashi Hatake']);
    });

    it('returns the roster untouched without a change', () => {
        expect(applySceneChange(roster, undefined)).toEqual(roster);
    });
});
