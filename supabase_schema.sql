-- Novel Architect schema for Supabase. Safe to re-run: every statement is idempotent.
-- Run it in the Supabase SQL editor on first setup and again after upgrading the app.

create table if not exists public.projects (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  title text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update set
    email = excluded.email,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.handle_new_auth_user();

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

-- Revision tracking (added in 1.1). The API saves with
--   PATCH /projects?owner_id=eq.<id>&revision=eq.<revision the browser edited>
-- so a stale browser tab cannot silently overwrite newer work. Existing rows
-- start at revision 1; every update increments the revision.
alter table public.projects add column if not exists revision bigint not null default 1;

create or replace function public.bump_project_revision()
returns trigger
language plpgsql
as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists projects_bump_revision on public.projects;
create trigger projects_bump_revision
  before update on public.projects
  for each row execute function public.bump_project_revision();

-- Data API access. Since May 2026 Supabase no longer exposes new tables to the
-- Data API automatically, so grant exactly what the app uses. Signed-in users
-- still reach only their own rows through the Row Level Security policies
-- above; visitors who are not signed in get no table access at all; the
-- server's service role is used by the Database admin page.
grant usage on schema public to anon, authenticated, service_role;
revoke all on public.projects, public.profiles from anon;
grant select, insert, update on public.projects to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.projects to service_role;
grant select on public.profiles to service_role;
