import { describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/stores/settings-store';

describe('directed scene rollout', () => {
    it('keeps the experimental pipeline opt-in by default', () => {
        expect(useSettingsStore.getInitialState().enableDirectedSceneMode).toBe(false);
    });
});
