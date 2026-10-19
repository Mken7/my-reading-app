import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { validStagingEndpoint } from "./authSafety";

// Explicitly isolated from lib/supabase.ts (the legacy live prototype).
// Never silently fall back to the existing production Supabase project.
const STAGING_URL = process.env.NEXT_PUBLIC_V2_SUPABASE_URL;
const STAGING_KEY = process.env.NEXT_PUBLIC_V2_SUPABASE_PUBLISHABLE_KEY;

export const v2StagingConfigured =
  process.env.NEXT_PUBLIC_ENABLE_V2_PREVIEW === "true" &&
  validStagingEndpoint(STAGING_URL) && Boolean(STAGING_KEY?.trim());

let cachedClient: SupabaseClient | null = null;

/** A staging-only browser client; never connects to the legacy production URL. */
export function getV2StagingClient(): SupabaseClient | null {
  if (!v2StagingConfigured || !STAGING_URL || !STAGING_KEY) return null;
  if (!cachedClient) {
    cachedClient = createClient(STAGING_URL, STAGING_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: "reading-app-v2-preview-staging",
      },
    });
  }
  return cachedClient;
}
