/**
 * A `setTimeout` that rejects with an AbortError as soon as `signal` fires, so a waiting
 * loop (retry backoff, batch polling) stops immediately when the caller gives up.
 * Safari < 17.4 has neither AbortSignal.timeout nor AbortSignal.any, hence the manual wiring.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
