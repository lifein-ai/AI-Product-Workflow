-- V0 PostgreSQL target schema. The runnable starter uses the in-memory repository first.
create table if not exists projects (
  id uuid primary key,
  name text not null,
  initial_requirement text not null,
  product_spec jsonb not null,
  workflow_state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_project_created on messages(project_id, created_at);
