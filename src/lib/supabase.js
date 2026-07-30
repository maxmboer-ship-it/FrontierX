import { createClient } from "@supabase/supabase-js";

/* Auth is optional infrastructure. If the environment variables are not set the
   whole feature switches off and the app behaves exactly as it did before —
   local-only, no sign-in UI. That keeps the deployed site working while the
   Supabase project is still being provisioned, and means a misconfigured env
   degrades to "no accounts" rather than a blank page. */
const url = import.meta.env.VITE_SUPABASE_URL || "";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const authEnabled = Boolean(url && anonKey);

export const supabase = authEnabled
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

/* The plan lives in a `profiles` row the user does not have write access to —
   see supabase/schema.sql. Reading it here is what makes entitlement survive a
   cleared browser, and the API re-checks it server-side before returning any
   Pro data, so editing the value in devtools changes the UI but not the data. */
export async function fetchProfile(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, plan, plan_updated_at")
    .eq("id", userId)
    .single();
  if (error) return null;
  return data;
}

/* Portfolios follow the account rather than the browser. One row per user,
   upserted, so signing in on another machine restores the same book. */
export async function loadBook(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from("portfolios")
    .select("book, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data.book || null;
}

export async function saveBook(userId, book) {
  if (!supabase || !userId) return false;
  const { error } = await supabase
    .from("portfolios")
    .upsert({ user_id: userId, book, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  return !error;
}

export async function currentAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return (data && data.session && data.session.access_token) || null;
}
