import { describe, it, expect } from 'vitest';
// Tests the REAL production salvager. (The previous version of this file tested a local
// COPY of the algorithm — every test kept passing even if the production code was deleted.)
import { extractJsonObject } from '@/lib/ai/canon-retrieval';

describe('extractJsonObject (roster salvage)', () => {
    it('parses complete JSON normally', () => {
        const text = '```json\n{ "characters": [ { "name": "A" }, { "name": "B" } ] }\n```';
        expect(extractJsonObject(text)).toEqual({
            characters: [{ name: 'A' }, { name: 'B' }],
        });
    });

    it('strips <think> blocks before parsing', () => {
        const text = '<think>noise</think>{ "characters": [ { "name": "A" } ] }';
        expect(extractJsonObject(text)).toEqual({ characters: [{ name: 'A' }] });
    });

    it('salvages a partial array when the response is cut mid-entry', () => {
        const truncated = `{
            "characters": [
                { "name": "Naruto", "appearsInArcs": ["Kazekage Rescue"] },
                { "name": "Sasuke", "appearsInArcs": ["Itachi Pursuit"] },
                { "name": "Sakura", "appearsInArc`;
        const parsed = extractJsonObject(truncated) as { characters: { name: string }[] };
        expect(parsed.characters.map((c) => c.name)).toEqual(['Naruto', 'Sasuke']);
    });

    it('salvages even when truncation falls inside a nested array', () => {
        const truncated = `{ "characters": [
            { "name": "A", "appearsInArcs": ["x", "y"] },
            { "name": "B", "appearsInArcs": ["w"`;
        const parsed = extractJsonObject(truncated) as { characters: { name: string }[] };
        expect(parsed.characters.map((c) => c.name)).toEqual(['A']);
    });

    it('returns null when no complete entry can be recovered', () => {
        expect(extractJsonObject('{ "characters": [ { "name": "A')).toBeNull();
    });

    it('ignores braces inside string values when computing depth', () => {
        const text = '{ "characters": [ { "name": "Bob (the {real} one)" }, { "name": "C" } ] }';
        const parsed = extractJsonObject(text) as { characters: { name: string }[] };
        expect(parsed.characters).toHaveLength(2);
    });
});
