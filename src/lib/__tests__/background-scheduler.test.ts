import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderScheduler } from '@/lib/ai/background-scheduler';

afterEach(() => {
    vi.useRealTimers();
});

describe('ProviderScheduler adaptive limits', () => {
    it('waits for several 429s before lowering concurrency, then recovers slowly', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const scheduler = new ProviderScheduler({
            concurrency: 4,
            startsPerWindow: 20,
            windowMs: 1_000,
        });

        scheduler.noteRateLimit();
        scheduler.noteRateLimit();
        expect(scheduler.snapshot().concurrency).toBe(4);
        scheduler.noteRateLimit();
        expect(scheduler.snapshot().concurrency).toBe(3);

        vi.setSystemTime(121_001);
        await scheduler.schedule('scene', undefined, async () => 'ok');
        expect(scheduler.snapshot().concurrency).toBe(4);
    });

    it('preserves a start interval while allowing long requests to overlap', async () => {
        vi.useFakeTimers();
        const scheduler = new ProviderScheduler({
            concurrency: 2,
            startsPerWindow: 1,
            windowMs: 2_000,
        });
        let starts = 0;
        const releases: Array<() => void> = [];
        const task = () =>
            new Promise<void>((resolve) => {
                starts++;
                releases.push(resolve);
            });

        const first = scheduler.schedule('background', undefined, task);
        const second = scheduler.schedule('background', undefined, task);
        expect(starts).toBe(1);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(starts).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(starts).toBe(2);
        releases.forEach((release) => release());
        await Promise.all([first, second]);
    });
});
