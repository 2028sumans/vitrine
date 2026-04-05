import { createClient } from "@supabase/supabase-js";

// Client-side Supabase client (uses anon key, respects RLS)
export function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// Server-side admin client (uses service role key, bypasses RLS)
// Only import this in server components or API routes — never expose to client
export function getServiceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
