import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOnlineBackupSchedule } from '@/hooks/useOnlineBackup';

const h = vi.hoisted(() => ({
    run: vi.fn(async () => ({ status: 'unchanged' as const })),
    state: {} as { lastUploadAt?: string },
}));

vi.mock('@/lib/online-backup', () => ({
    runOnlineBackup: h.run,
    readOnlineBackupState: () => h.state,
}));

const listeners = new Map<string, () => void>();
const doc = {
    visibilityState: 'visible',
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
    h.run.mockClear();
    h.state = {};
    listeners.clear();
    doc.visibilityState = 'visible';
    vi.stubGlobal('document', doc);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('online backup schedule', () => {
    it('checks 30 s after opening, then every 10 minutes', () => {
        const stop = startOnlineBackupSchedule();
        vi.advanceTimersByTime(29_999);
        expect(h.run).toHaveBeenCalledTimes(0);
        vi.advanceTimersByTime(1);
        expect(h.run).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(570_000); // t = 10 min
        expect(h.run).toHaveBeenCalledTimes(2);
        stop();
    });

    it('skips checks while the app is in the background', () => {
        doc.visibilityState = 'hidden';
        const stop = startOnlineBackupSchedule();
        vi.advanceTimersByTime(630_000);
        expect(h.run).not.toHaveBeenCalled();
        stop();
    });

    it('checks on return only when the last upload is older than 10 minutes', () => {
        const stop = startOnlineBackupSchedule();
        h.state = { lastUploadAt: new Date(Date.now() - 60_000).toISOString() };
        listeners.get('visibilitychange')!();
        expect(h.run).not.toHaveBeenCalled();
        h.state = { lastUploadAt: new Date(Date.now() - 11 * 60_000).toISOString() };
        listeners.get('visibilitychange')!();
        expect(h.run).toHaveBeenCalledTimes(1);
        stop();
    });

    it('stops everything when the page goes away', () => {
        const stop = startOnlineBackupSchedule();
        stop();
        vi.advanceTimersByTime(700_000);
        expect(h.run).not.toHaveBeenCalled();
        expect(listeners.size).toBe(0);
    });
});
