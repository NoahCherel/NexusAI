import { expect, it, vi } from 'vitest';
import { notifyWriteError, useNotificationStore } from '@/components/ui/api-notification';

it('shows one notice however many saves fail, and logs each failure', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 50; i++) notifyWriteError(new Error('QuotaExceededError'));
    const notices = useNotificationStore.getState().notifications;
    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe('error');
    expect(log).toHaveBeenCalledTimes(50);
});
