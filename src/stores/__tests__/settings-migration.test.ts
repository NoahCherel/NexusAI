import { describe, expect, it } from 'vitest';
import { migrateSettings, useSettingsStore } from '@/stores/settings-store';

describe('settings persistence migrations', () => {
    it('carries the old Flex toggle over to the Batch toggle, on the root and on presets', () => {
        const migrated = migrateSettings(
            {
                useFlexTier: true,
                presets: [
                    { id: 'a', name: 'A', useFlexTier: true },
                    { id: 'b', name: 'B', useFlexTier: false },
                    { id: 'c', name: 'C' },
                ],
            },
            0
        ) as Record<string, unknown>;

        expect(migrated.useBatchMode).toBe(true);
        expect(migrated).not.toHaveProperty('useFlexTier');
        expect(migrated.presets).toEqual([
            { id: 'a', name: 'A', useBatchMode: true },
            { id: 'b', name: 'B', useBatchMode: false },
            { id: 'c', name: 'C' },
        ]);
    });

    it('leaves an already-migrated state alone', () => {
        const state = { useBatchMode: false, presets: [] };
        expect(migrateSettings(state, 1)).toEqual(state);
    });

    it('defaults batch mode to off', () => {
        expect(useSettingsStore.getInitialState().useBatchMode).toBe(false);
    });
});
