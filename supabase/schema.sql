-- FrontierX — accounts, entitlement and saved portfolios.
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: every statement is guarded.

-- ─────────────────────────────────────────────────────────────
-- profiles: one row per user, created automatically on signup.
-- `plan` is the entitlement. The user can READ their own row but
-- has NO update policy on it, so the plan cannot be raised from the
-- browser even with a valid session — only the service role (your
-- server, or you in the dashboard) can change it. This is the whole
-- point of moving entitlement off localStorage.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text,
  plan            text not null default 'free' check (plan in ('free','advanced','pro')),
  plan_updated_at timestamptz,
  created_at      timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Deliberately NO insert/update/delete policy for authenticated users.
-- Row-level security denies by default, so the browser cannot write `plan`.

-- ─────────────────────────────────────────────────────────────
-- portfolios: the saved book, one row per user, owned end to end.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.portfolios (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  book       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.portfolios enable row level security;

drop policy if exists "own portfolio select" on public.portfolios;
create policy "own portfolio select"
  on public.portfolios for select using (auth.uid() = user_id);

drop policy if exists "own portfolio insert" on public.portfolios;
create policy "own portfolio insert"
  on public.portfolios for insert with check (auth.uid() = user_id);

drop policy if exists "own portfolio update" on public.portfolios;
create policy "own portfolio update"
  on public.portfolios for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────
-- Create the profile row automatically whenever a user signs up.
-- SECURITY DEFINER so the trigger can insert despite RLS.
-- ─────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, plan)
  values (new.id, new.email, 'free')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who signed up before this ran.
insert into public.profiles (id, email, plan)
select u.id, u.email, 'free' from auth.users u
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────
-- Granting Pro, until Stripe is wired up. Run in the SQL editor:
--
--   update public.profiles
--      set plan = 'pro', plan_updated_at = now()
--    where email = 'friend@example.com';
--
-- Revoke with plan = 'free'.
-- ─────────────────────────────────────────────────────────────
