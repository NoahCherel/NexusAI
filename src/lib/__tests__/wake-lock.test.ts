import { afterEach, expect, it, vi } from 'vitest';
import { keepScreenOn } from '@/lib/wake-lock';

afterEach(() => vi.unstubAllGlobals());

it('keeps the screen on until released', async () => {
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release }));
    vi.stubGlobal('navigator', { wakeLock: { request } });
    const done = await keepScreenOn();
    expect(request).toHaveBeenCalledWith('screen');
    done();
    expect(release).toHaveBeenCalledTimes(1);
});

it('does nothing on a browser without wake lock', async () => {
    vi.stubGlobal('navigator', {});
    const done = await keepScreenOn();
    expect(() => done()).not.toThrow();
});

it('does nothing when the browser refuses the wake lock', async () => {
    vi.stubGlobal('navigator', {
        wakeLock: {
            request: async () => {
                throw new DOMException('refused', 'NotAllowedError');
            },
        },
    });
    const done = await keepScreenOn();
    expect(() => done()).not.toThrow();
});
