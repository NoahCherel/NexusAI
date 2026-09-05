import { describe, expect, it } from 'vitest';
import { migrateSettings, useSettingsStore } from '@/stores/settings-store';

describe('settings persistence migrations', () => {
    it('restores the Flex toggle from the short-lived batch rename, on the root and on presets', () => {
        const migrated = migrateSettings(
            {
                useBatchMode: true,
                presets: [
                    { id: 'a', name: 'A', useBatchMode: true },
                    { id: 'b', name: 'B', useBatchMode: false },
                    { id: 'c', name: 'C' },
                ],
            },
            1
        ) as Record<string, unknown>;

        expect(migrated.useFlexTier).toBe(true);
        expect(migrated).not.toHaveProperty('useBatchMode');
        expect(migrated.presets).toEqual([
            { id: 'a', name: 'A', useFlexTier: true },
            { id: 'b', name: 'B', useFlexTier: false },
            { id: 'c', name: 'C' },
        ]);
    });

    it('leaves a v0 store (already on useFlexTier) and a v2 store alone', () => {
        const v0 = { useFlexTier: true, presets: [{ id: 'a', useFlexTier: true }] };
        expect(migrateSettings(structuredClone(v0), 0)).toEqual(v0);
        const v2 = { useFlexTier: false, presets: [] };
        expect(migrateSettings(structuredClone(v2), 2)).toEqual(v2);
    });

    it('defaults the flex tier to off', () => {
        expect(useSettingsStore.getInitialState().useFlexTier).toBe(false);
    });
});
