create table if not exists public.projects (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  title text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects enable row level security;

drop policy if exists "Users can read their own project" on public.projects;
create policy "Users can read their own project"
  on public.projects for select
  using (auth.uid() = owner_id);

drop policy if exists "Users can insert their own project" on public.projects;
create policy "Users can insert their own project"
  on public.projects for insert
  with check (auth.uid() = owner_id);

drop policy if exists "Users can update their own project" on public.projects;
create policy "Users can update their own project"
  on public.projects for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
