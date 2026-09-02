export type BackgroundPriority = 'foreground' | 'scene' | 'background';
export type ScheduledProvider = 'nanogpt' | 'openrouter';

const PRIORITY: Record<BackgroundPriority, number> = {
    foreground: 0,
    scene: 1,
    background: 2,
};

interface QueueItem<T> {
    id: number;
    priority: BackgroundPriority;
    signal?: AbortSignal;
    task: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

interface SchedulerConfig {
    concurrency: number;
    startsPerWindow: number;
    windowMs: number;
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

export class ProviderScheduler {
    private active = 0;
    private nextId = 0;
    private queue: QueueItem<unknown>[] = [];
    private starts: number[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private sessionConcurrency: number;
    private recentRateLimits: number[] = [];
    private lastRateLimitAt = 0;

    constructor(private readonly config: SchedulerConfig) {
        this.sessionConcurrency = config.concurrency;
    }

    schedule<T>(
        priority: BackgroundPriority,
        signal: AbortSignal | undefined,
        task: () => Promise<T>
    ): Promise<T> {
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise<T>((resolve, reject) => {
            const item: QueueItem<T> = {
                id: this.nextId++,
                priority,
                signal,
                task,
                resolve,
                reject,
            };
            this.queue.push(item as QueueItem<unknown>);
            this.queue.sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.id - b.id);
            this.pump();
        });
    }

    /** A single transient 429 changes nothing; three within 30s lower the session ceiling. */
    noteRateLimit(): void {
        const now = Date.now();
        this.lastRateLimitAt = now;
        this.recentRateLimits = this.recentRateLimits.filter((at) => now - at < 30_000);
        this.recentRateLimits.push(now);
        if (this.recentRateLimits.length < 3) return;
        this.sessionConcurrency = Math.max(1, this.sessionConcurrency - 1);
        this.recentRateLimits = [];
    }

    /** Recover one slot after two quiet minutes and a successful provider call. */
    private noteSuccess(): void {
        const now = Date.now();
        if (
            this.sessionConcurrency < this.config.concurrency &&
            now - this.lastRateLimitAt >= 120_000
        ) {
            this.sessionConcurrency++;
            this.lastRateLimitAt = now;
        }
    }

    snapshot() {
        return {
            active: this.active,
            queued: this.queue.length,
            concurrency: this.sessionConcurrency,
        };
    }

    private pump(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const now = Date.now();
        this.starts = this.starts.filter((startedAt) => now - startedAt < this.config.windowMs);

        while (this.active < this.sessionConcurrency && this.queue.length > 0) {
            while (this.queue[0]?.signal?.aborted) {
                this.queue.shift()?.reject(abortError());
            }
            if (this.queue.length === 0) return;

            if (this.starts.length >= this.config.startsPerWindow) {
                const wait = Math.max(1, this.config.windowMs - (now - this.starts[0]));
                this.timer = setTimeout(() => this.pump(), wait);
                return;
            }

            const item = this.queue.shift()!;
            this.active++;
            this.starts.push(Date.now());
            item.task()
                .then((value) => {
                    this.noteSuccess();
                    item.resolve(value);
                }, item.reject)
                .finally(() => {
                    this.active--;
                    this.pump();
                });
        }
    }
}

const schedulers: Record<ScheduledProvider, ProviderScheduler> = {
    // Subscription limit is 10 concurrent / 10 starts per 10s. Keep two slots of headroom
    // for the visible composer and for other tabs using the same account.
    nanogpt: new ProviderScheduler({ concurrency: 8, startsPerWindow: 8, windowMs: 10_000 }),
    openrouter: new ProviderScheduler({
        concurrency: 2,
        // Preserve the historical two-second start spacing for strict free-model quotas,
        // while still allowing two long responses to overlap.
        startsPerWindow: 1,
        windowMs: 2_000,
    }),
};

export function scheduleBackgroundRequest<T>(params: {
    provider: ScheduledProvider;
    priority?: BackgroundPriority;
    signal?: AbortSignal;
    task: () => Promise<T>;
}): Promise<T> {
    return schedulers[params.provider].schedule(
        params.priority ?? 'background',
        params.signal,
        params.task
    );
}

export function noteProviderRateLimit(provider: ScheduledProvider): void {
    schedulers[provider].noteRateLimit();
}

export function getBackgroundSchedulerSnapshot(provider: ScheduledProvider) {
    return schedulers[provider].snapshot();
}
