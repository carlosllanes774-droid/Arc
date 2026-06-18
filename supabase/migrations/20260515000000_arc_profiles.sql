-- Arc user profile + app state (Supabase Auth is source of truth for identity).
-- Run in Supabase SQL editor or via CLI migrations.

create table if not exists public.arc_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  app_state jsonb not null default '{}'::jsonb,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists arc_profiles_updated_at_idx on public.arc_profiles (updated_at desc);

alter table public.arc_profiles enable row level security;

create policy "arc_profiles_select_own"
  on public.arc_profiles for select
  using (auth.uid() = id);

create policy "arc_profiles_insert_own"
  on public.arc_profiles for insert
  with check (auth.uid() = id);

create policy "arc_profiles_update_own"
  on public.arc_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
