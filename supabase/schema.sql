-- ============================================================================
-- EventPulse 活動／講座／工作坊報名系統 - Supabase PostgreSQL Schema & RLS
-- Project ID: jagzybbhxnkmlwmplvda (ap-northeast-1)
-- ============================================================================

-- 1. 建立內部安全 Schema (避免 SECURITY DEFINER 函式暴露於公開 RPC API)
create schema if not exists private;
grant usage on schema private to anon, authenticated;

-- 2. 會員與管理員資料表 (profiles)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  phone text not null default '',
  organization text not null default '',
  role text not null default 'admin' check (role in ('member', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 檢查目前登入者是否為管理員
create or replace function private.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

grant execute on function private.is_admin() to anon, authenticated;

-- 註冊時自動確認信箱並建立 Profile
create or replace function private.auto_confirm_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end;
$$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, phone, organization, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email, '會員'), '@', 1)),
    coalesce(new.raw_user_meta_data->>'phone', ''),
    coalesce(new.raw_user_meta_data->>'organization', ''),
    'admin'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 3. 活動主表 (events)
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  subtitle text not null default '',
  category text not null default '講座' check (category in ('講座', '工作坊', '課程', '論壇', '社群聚會')),
  description text not null default '',
  speaker_name text not null default '',
  speaker_title text not null default '',
  speaker_bio text not null default '',
  cover_image_url text not null default '',
  location text not null default '',
  location_address text not null default '',
  start_time timestamptz not null,
  end_time timestamptz not null,
  reg_start_time timestamptz not null default now(),
  reg_end_time timestamptz not null,
  bank_info jsonb not null default '{"bank_name": "玉山銀行 (808)", "branch": "營業部", "account_name": "EventPulse 活動報名平台", "account_number": "0123-940-056789"}'::jsonb,
  custom_fields jsonb not null default '[]'::jsonb,
  status text not null default 'published' check (status in ('draft', 'published', 'unlisted', 'closed')),
  is_featured boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists events_created_by_idx on public.events(created_by);
create index if not exists events_status_start_time_idx on public.events(status, start_time);

alter table public.events enable row level security;

-- 4. 票種設定表 (ticket_types)
create table if not exists public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  description text not null default '',
  price integer not null default 0 check (price >= 0),
  quota integer not null default 50 check (quota > 0),
  registered_count integer not null default 0 check (registered_count >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists ticket_types_event_id_idx on public.ticket_types(event_id);

alter table public.ticket_types enable row level security;

-- 5. 報名與票券紀錄表 (registrations)
create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  ticket_type_id uuid not null references public.ticket_types(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  attendee_name text not null,
  attendee_email text not null,
  attendee_phone text not null,
  attendee_org text not null default '',
  form_answers jsonb not null default '{}'::jsonb,
  amount integer not null default 0 check (amount >= 0),
  status text not null default 'pending_payment' check (status in ('pending_payment', 'pending_verification', 'confirmed', 'cancelled')),
  payment_method text not null default 'bank_transfer' check (payment_method in ('free', 'bank_transfer')),
  payment_last5 text not null default '',
  payment_amount integer,
  payment_date text not null default '',
  payment_note text not null default '',
  payment_reported_at timestamptz,
  payment_verified_at timestamptz,
  checkin_token text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  checked_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists registrations_event_id_idx on public.registrations(event_id);
create index if not exists registrations_ticket_type_id_idx on public.registrations(ticket_type_id);
create index if not exists registrations_user_id_idx on public.registrations(user_id);
create index if not exists registrations_checkin_token_idx on public.registrations(checkin_token);

alter table public.registrations enable row level security;

-- 6. Row Level Security (RLS) 存取控制政策
create policy "profiles_select_own_or_admin" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id or (select private.is_admin()));

create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

create policy "profiles_update_own_or_admin" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id or (select private.is_admin()))
  with check ((select auth.uid()) = id or (select private.is_admin()));

create policy "events_select_public_or_admin" on public.events
  for select to anon, authenticated
  using (status in ('published', 'unlisted', 'closed') or (select private.is_admin()));

create policy "events_insert_admin" on public.events
  for insert to authenticated
  with check ((select private.is_admin()));

create policy "events_update_admin" on public.events
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

create policy "events_delete_admin" on public.events
  for delete to authenticated
  using ((select private.is_admin()));

create policy "ticket_types_select_all" on public.ticket_types
  for select to anon, authenticated
  using (true);

create policy "ticket_types_insert_admin" on public.ticket_types
  for insert to authenticated
  with check ((select private.is_admin()));

create policy "ticket_types_update_admin" on public.ticket_types
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

create policy "ticket_types_delete_admin" on public.ticket_types
  for delete to authenticated
  using ((select private.is_admin()));

create policy "registrations_select_own_or_admin" on public.registrations
  for select to authenticated
  using ((select auth.uid()) = user_id or (select private.is_admin()));

create policy "registrations_insert_own" on public.registrations
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "registrations_update_own_or_admin" on public.registrations
  for update to authenticated
  using ((select auth.uid()) = user_id or (select private.is_admin()))
  with check ((select auth.uid()) = user_id or (select private.is_admin()));
