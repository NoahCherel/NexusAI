import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/**
 * The browser's Supabase client, or null when the project isn't configured (fresh clone, CI).
 * The session lives in localStorage under `sb-…` keys, which global backups never copy.
 */
export function getSupabase(): SupabaseClient | null {
    if (client) return client;
    // Literal references: Next inlines NEXT_PUBLIC_* at build time.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) return null;
    client = createClient(url, key);
    return client;
}
