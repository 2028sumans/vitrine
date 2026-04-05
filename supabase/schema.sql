-- Users table (mirrors NextAuth session data)
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  image text,
  pinterest_id text unique,
  created_at timestamptz default now()
);

-- Sessions table (managed by NextAuth adapter)
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  session_token text unique not null,
  expires timestamptz not null
);

-- Storefronts table
create table if not exists storefronts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  slug text unique not null,
  board_id text not null,
  board_name text,
  aesthetic_summary text,
  products jsonb default '[]',
  published boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS: enable on all tables
alter table users enable row level security;
alter table sessions enable row level security;
alter table storefronts enable row level security;

-- Users: users can only read/update their own row
create policy "users_select_own" on users
  for select using (auth.uid()::text = id::text);

create policy "users_update_own" on users
  for update using (auth.uid()::text = id::text);

-- Storefronts: owners can do anything; published storefronts are public
create policy "storefronts_owner_all" on storefronts
  for all using (auth.uid()::text = user_id::text);

create policy "storefronts_public_read" on storefronts
  for select using (published = true);

-- Sessions: service role only (NextAuth manages these)
create policy "sessions_service_role" on sessions
  for all using (auth.role() = 'service_role');
