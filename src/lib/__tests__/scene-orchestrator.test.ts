import { describe, it, expect } from 'vitest';
import {
    parseDirectorResponse,
    applySceneChange,
    MAX_SPEAKERS_PER_BEAT,
} from '@/lib/ai/scene-orchestrator';

const roster = ['Naruto Uzumaki', 'Sakura Haruno', 'Kakashi Hatake', 'Gaara'];

describe('parseDirectorResponse', () => {
    it('parses a clean decision and resolves speaker casing against the roster', () => {
        const raw = JSON.stringify({
            narration: 'A cold wind sweeps the training ground.',
            speakers: ['naruto uzumaki', 'SAKURA HARUNO'],
            sceneChange: { event: 'storm coming' },
        });
        const d = parseDirectorResponse(raw, roster, 'Alex');
        expect(d.narration).toBe('A cold wind sweeps the training ground.');
        expect(d.speakers).toEqual(['Naruto Uzumaki', 'Sakura Haruno']);
        expect(d.sceneChange?.event).toBe('storm coming');
    });

    it('tolerates code fences and chatter around the JSON', () => {
        const raw = 'Sure! Here is the decision:\n```json\n{"speakers": ["Gaara"]}\n``` Done.';
        const d = parseDirectorResponse(raw, roster);
        expect(d.speakers).toEqual(['Gaara']);
    });

    it('caps speakers, dedupes, drops unknown names and the player', () => {
        const raw = JSON.stringify({
            speakers: [
                'Naruto Uzumaki',
                'Naruto Uzumaki',
                'Alex',
                'Random Stranger',
                'Sakura Haruno',
                'Kakashi Hatake',
                'Gaara',
            ],
        });
        const d = parseDirectorResponse(raw, [...roster, 'Alex'], 'Alex');
        expect(d.speakers.length).toBeLessThanOrEqual(MAX_SPEAKERS_PER_BEAT);
        expect(d.speakers).toEqual(['Naruto Uzumaki', 'Sakura Haruno', 'Kakashi Hatake']);
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
