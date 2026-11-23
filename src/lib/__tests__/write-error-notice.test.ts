import { beforeAll, expect, it, vi } from 'vitest';
import { notifyWriteError, useNotificationStore } from '@/components/ui/api-notification';

beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
});

it('shows one notice however many saves fail at once, and logs each failure', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 50; i++) notifyWriteError(new Error('QuotaExceededError'));
    const notices = useNotificationStore.getState().notifications;
    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe('error');
    expect(log).toHaveBeenCalledTimes(50);
});

it('shows the notice again when saves still fail a minute later, not sooner', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.advanceTimersByTime(30_000); // the first notice hides itself after 3 s
    notifyWriteError(new Error('still failing'));
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    vi.advanceTimersByTime(31_000);
    notifyWriteError(new Error('still failing'));
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
});
