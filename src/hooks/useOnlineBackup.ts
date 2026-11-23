'use client';

import { useEffect } from 'react';
import { readOnlineBackupState, runOnlineBackup } from '@/lib/online-backup';
import { getLiveSettingsEnvelope } from '@/stores/settings-store';

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 600_000;

/** Back up 30 s after opening, then every 10 min while visible. Returns the stop function. */
export function startOnlineBackupSchedule(): () => void {
    const tick = () => {
        if (document.visibilityState !== 'visible') return;
        void runOnlineBackup({ getLiveSettings: getLiveSettingsEnvelope });
    };
    // iOS freezes timers in the background: catch up when the app comes back.
    const onVisible = () => {
        const last = readOnlineBackupState().lastUploadAt;
        if (!last || Date.now() - new Date(last).getTime() > CHECK_EVERY_MS) tick();
    };
    const first = setTimeout(tick, FIRST_CHECK_MS);
    const every = setInterval(tick, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
        clearTimeout(first);
        clearInterval(every);
        document.removeEventListener('visibilitychange', onVisible);
    };
}

export function useOnlineBackup(): void {
    useEffect(() => startOnlineBackupSchedule(), []);
}
