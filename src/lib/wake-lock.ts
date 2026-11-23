/**
 * Keep the screen on during a long operation: when an iPhone locks itself, iOS pauses the
 * app and cuts its database access mid-way. Returns the release function; a no-op where the
 * browser has no wake lock or refuses it. Call it straight from a tap.
 */
export async function keepScreenOn(): Promise<() => void> {
    try {
        const lock = await navigator.wakeLock?.request('screen');
        return () => void lock?.release().catch(() => {});
    } catch {
        return () => {};
    }
}
