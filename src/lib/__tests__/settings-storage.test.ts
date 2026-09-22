import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
    createSafeSettingsStorage,
    LEGACY_SETTINGS_KEY,
    SETTINGS_KEY,
    SETTINGS_HISTORY_KEY,
    readSettingsHistory,
    parseSettings,
    mergeMissingSettings,
} from '@/lib/settings-storage';

function memoryStorage(): Storage {
    const entries = new Map<string, string>();
    return {
        get length() {
            return entries.size;
        },
        key: (index) => [...entries.keys()][index] ?? null,
        clear: () => entries.clear(),
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value) => {
            entries.set(key, value);
        },
        removeItem: (key) => {
            entries.delete(key);
        },
    };
}

const authored = {
    personas: [{ id: 'persona', name: 'Saved persona', bio: '18 months of notes' }],
    presets: [{ id: 'preset', name: 'Saved preset', systemPrompt: 'My writing rules' }],
    customModels: [{ id: 'model', modelId: 'manual/model', provider: 'openrouter' }],
    customEngines: [{ id: 'engine' }],
};
const envelope = (state = authored, version = 2) => JSON.stringify({ state, version });
const initial = () => ({
    personas: [] as { id: string }[],
    presets: [] as { id: string }[],
    customModels: [] as { id: string }[],
    customEngines: [] as { id: string }[],
    temperature: 0.8,
});

describe('reproductions of the former persistence failure modes', () => {
    it('an old v0 bundle ignores a v2 save and overwrites all three collections', () => {
        const disk = memoryStorage();
        disk.setItem(LEGACY_SETTINGS_KEY, envelope());
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const oldApp = createStore(
                persist(initial, {
                    name: LEGACY_SETTINGS_KEY,
                    storage: createJSONStorage(() => disk),
                })
            );
            oldApp.setState({ temperature: 0.5 });
            expect(JSON.parse(disk.getItem(LEGACY_SETTINGS_KEY)!).state.personas).toEqual([]);
            expect(JSON.parse(disk.getItem(LEGACY_SETTINGS_KEY)!).state.presets).toEqual([]);
            expect(JSON.parse(disk.getItem(LEGACY_SETTINGS_KEY)!).state.customModels).toEqual([]);
        } finally {
            error.mockRestore();
        }
    });

    it('a stale tab drops additions made in another tab on an unrelated change', () => {
        const disk = memoryStorage();
        const make = () =>
            createStore(
                persist(initial, {
                    name: LEGACY_SETTINGS_KEY,
                    storage: createJSONStorage(() => disk),
                })
            );
        const first = make();
        const stale = make();
        first.setState(authored);
        stale.setState({ temperature: 0.5 });
        expect(JSON.parse(disk.getItem(LEGACY_SETTINGS_KEY)!).state.personas).toEqual([]);
    });
});

describe('protected settings persistence', () => {
    it.each([0, 1, 2])(
        'copies legacy v%s without changing it, with a pre-write checkpoint',
        (version) => {
            const disk = memoryStorage();
            const original = envelope(authored, version);
            disk.setItem(LEGACY_SETTINGS_KEY, original);
            const safe = createSafeSettingsStorage(() => disk);
            expect(safe.getItem(SETTINGS_KEY)).toBe(original);
            safe.setItem(SETTINGS_KEY, envelope());
            expect(disk.getItem(LEGACY_SETTINGS_KEY)).toBe(original);
            expect(disk.getItem(SETTINGS_KEY)).toBe(envelope());
            expect(readSettingsHistory(disk)[0].raw).toBe(original);
        }
    );

    it('ignores later destructive writes from a legacy bundle', () => {
        const disk = memoryStorage();
        disk.setItem(LEGACY_SETTINGS_KEY, envelope());
        const safe = createSafeSettingsStorage(() => disk);
        safe.getItem(SETTINGS_KEY);
        safe.setItem(SETTINGS_KEY, envelope());
        disk.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({ state: initial(), version: 0 }));
        expect(createSafeSettingsStorage(() => disk).getItem(SETTINGS_KEY)).toBe(envelope());
    });

    it('blocks a stale tab from replacing a more recent save', () => {
        const disk = memoryStorage();
        const warning = vi.fn();
        const a = createSafeSettingsStorage(() => disk);
        const b = createSafeSettingsStorage(() => disk, warning);
        a.getItem(SETTINGS_KEY);
        b.getItem(SETTINGS_KEY);
        a.setItem(SETTINGS_KEY, envelope());
        b.setItem(SETTINGS_KEY, JSON.stringify({ state: initial(), version: 2 }));
        expect(disk.getItem(SETTINGS_KEY)).toBe(envelope());
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('autre onglet'));
    });

    it.each([
        '{broken',
        'null',
        '{"state":[]}',
        '{"state":{"personas":null}}',
        envelope(authored, 3),
    ])('preserves unreadable or future data and blocks every subsequent write: %s', (raw) => {
        const disk = memoryStorage();
        disk.setItem(SETTINGS_KEY, raw);
        const warning = vi.fn();
        const safe = createSafeSettingsStorage(() => disk, warning);
        expect(() => safe.getItem(SETTINGS_KEY)).toThrow();
        safe.setItem(SETTINGS_KEY, envelope());
        expect(disk.getItem(SETTINGS_KEY)).toBe(raw);
        expect(warning).toHaveBeenCalled();
    });

    it('does not overwrite a save when the checkpoint exceeds quota', () => {
        const disk = memoryStorage();
        disk.setItem(SETTINGS_KEY, envelope());
        const warning = vi.fn();
        const safe = createSafeSettingsStorage(() => disk, warning);
        safe.getItem(SETTINGS_KEY);
        vi.spyOn(disk, 'setItem').mockImplementation(() => {
            throw new DOMException('Full', 'QuotaExceededError');
        });
        safe.setItem(SETTINGS_KEY, JSON.stringify({ state: initial(), version: 2 }));
        expect(disk.getItem(SETTINGS_KEY)).toBe(envelope());
        expect(warning).toHaveBeenCalled();
    });

    it('keeps the original checkpoint and bounds recent revisions; toggles do not rotate them', () => {
        const disk = memoryStorage();
        disk.setItem(SETTINGS_KEY, envelope());
        const safe = createSafeSettingsStorage(() => disk);
        safe.getItem(SETTINGS_KEY);
        for (let i = 0; i < 10; i++) {
            safe.setItem(
                SETTINGS_KEY,
                envelope({ ...authored, personas: [{ ...authored.personas[0], bio: String(i) }] })
            );
        }
        const history = readSettingsHistory(disk);
        expect(history).toHaveLength(5);
        expect(history[0].raw).toBe(envelope());
        const current = JSON.parse(disk.getItem(SETTINGS_KEY)!);
        for (let i = 0; i < 10; i++) {
            safe.setItem(
                SETTINGS_KEY,
                JSON.stringify({ ...current, state: { ...current.state, temperature: i } })
            );
        }
        expect(readSettingsHistory(disk)).toEqual(history);
    });

    it('refuses to initialize empty state over a surviving history', () => {
        const disk = memoryStorage();
        disk.setItem(
            SETTINGS_HISTORY_KEY,
            JSON.stringify([{ savedAt: '2026-09-22', raw: envelope() }])
        );
        const safe = createSafeSettingsStorage(() => disk, vi.fn());
        expect(() => safe.getItem(SETTINGS_KEY)).toThrow();
        safe.setItem(SETTINGS_KEY, envelope());
        expect(disk.getItem(SETTINGS_KEY)).toBeNull();
    });

    it('handles inaccessible storage without silently creating a replacement', () => {
        const warning = vi.fn();
        const safe = createSafeSettingsStorage(() => {
            throw new Error('Access denied');
        }, warning);
        expect(() => safe.getItem(SETTINGS_KEY)).toThrow();
        safe.setItem(SETTINGS_KEY, envelope());
        expect(warning).toHaveBeenCalledTimes(1);
    });

    it('allows an explicit recovery into absent settings without deleting surviving history', () => {
        const disk = memoryStorage();
        const history = JSON.stringify([{ savedAt: '2026-09-22', raw: envelope() }]);
        disk.setItem(SETTINGS_HISTORY_KEY, history);
        const safe = createSafeSettingsStorage(() => disk, vi.fn(), { explicitRestore: true });
        expect(safe.getItem(SETTINGS_KEY)).toBeNull();
        safe.setItem(SETTINGS_KEY, envelope());
        expect(disk.getItem(SETTINGS_KEY)).toBe(envelope());
        expect(disk.getItem(SETTINGS_HISTORY_KEY)).toBe(history);
    });

    it('loads authored data through the actual settings store and reconciles defaults safely', async () => {
        const disk = memoryStorage();
        disk.setItem(LEGACY_SETTINGS_KEY, envelope(authored, 0));
        vi.stubGlobal('window', { localStorage: disk });
        vi.resetModules();
        try {
            const { useSettingsStore } = await import('@/stores/settings-store');
            useSettingsStore.getState().initializeDefaultPresets();
            const saved = parseSettings(disk.getItem(SETTINGS_KEY)!);
            expect(saved.state.personas).toEqual(authored.personas);
            expect(saved.state.customModels).toEqual(authored.customModels);
            expect(saved.state.presets).toContainEqual(authored.presets[0]);
            expect(readSettingsHistory(disk)[0].raw).toBe(envelope(authored, 0));
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('restores missing records without replacing current edits or other preferences', () => {
        const current = parseSettings(envelope({ ...authored, personas: [] }));
        const backup = parseSettings(
            envelope({ ...authored, presets: [{ ...authored.presets[0], name: 'Old' }] })
        );
        const restored = mergeMissingSettings(current, backup);
        expect(restored.state).toEqual(authored);
        expect(current.state.personas).toEqual([]);
    });
});
