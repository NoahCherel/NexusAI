import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

it('is null when the Supabase env vars are missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    const { getSupabase } = await import('@/lib/supabase');
    expect(getSupabase()).toBeNull();
});

it('returns one shared client when configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const { getSupabase } = await import('@/lib/supabase');
    expect(getSupabase()).not.toBeNull();
    expect(getSupabase()).toBe(getSupabase());
});
