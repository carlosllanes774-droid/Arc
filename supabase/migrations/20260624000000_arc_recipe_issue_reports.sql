-- Optional: recipe issue reports from Recipe Experience (Report Issue flow).
-- When this table exists, submitRecipeIssueReport() prefers Supabase over localStorage.

create table if not exists public.arc_recipe_issue_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  recipe_id text not null,
  recipe_name text not null,
  report_text text not null check (char_length(report_text) <= 1000),
  spoonacular_id text,
  created_at timestamptz not null default now()
);

create index if not exists arc_recipe_issue_reports_created_at_idx
  on public.arc_recipe_issue_reports (created_at desc);

alter table public.arc_recipe_issue_reports enable row level security;

create policy "arc_recipe_issue_reports_insert_authenticated"
  on public.arc_recipe_issue_reports for insert
  with check (auth.uid() = user_id or user_id is null);

create policy "arc_recipe_issue_reports_select_own"
  on public.arc_recipe_issue_reports for select
  using (auth.uid() = user_id);
