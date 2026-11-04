-- GeneaTrace ledger schema. Idempotent: the API node applies it on every start.
-- Lives in its own schema so it never collides with other tables in the project.

create schema if not exists geneatrace;

create table if not exists geneatrace.actors (
  id            text primary key,
  name          text not null,
  role          text not null,
  org           text,
  email         text,
  license_no    text,
  public_key    text not null,
  api_key_hash  text not null unique,
  status        text not null default 'active',
  created_at    timestamptz not null default now()
);

-- Username + password sign-in (passwords stored as salted scrypt hashes).
alter table geneatrace.actors add column if not exists username text;
alter table geneatrace.actors add column if not exists password_hash text;
create unique index if not exists actors_username_idx on geneatrace.actors (username);

create table if not exists geneatrace.facilities (
  id          text primary key,
  name        text not null,
  actor_id    text not null references geneatrace.actors(id),
  type        text not null,
  address     text,
  city        text,
  lat         double precision,
  lng         double precision,
  license_no  text,
  licensed    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Blocks and events are the chain. Append-only (see triggers below).
create table if not exists geneatrace.blocks (
  id           integer primary key,
  hash         text not null unique,
  prev_hash    text not null,
  merkle_root  text not null,
  ts           text not null,
  nonce        integer not null,
  difficulty   integer not null,
  tx_count     integer not null,
  validator    text not null,
  signature    text not null,
  created_at   timestamptz not null default now()
);

create table if not exists geneatrace.events (
  id            text primary key,
  block_height  integer not null references geneatrace.blocks(id),
  seq           integer not null,
  type          text not null,
  product_id    text,
  batch_id      text,
  actor_id      text,
  facility_id   text,
  data          jsonb not null default '{}'::jsonb,
  prev_tx       text,
  salt          text not null,
  ts            text not null,
  signature     text not null,
  created_at    timestamptz not null default now()
);

create table if not exists geneatrace.batches (
  id               text primary key,
  sku              text not null,
  name             text not null,
  category         text not null,
  manufacturer_id  text not null references geneatrace.actors(id),
  quantity         integer not null,
  minted           integer not null default 0,
  mfg_date         text,
  expiry_date      text,
  attributes       jsonb not null default '{}'::jsonb,
  components       jsonb not null default '[]'::jsonb,
  status           text not null default 'active',
  created_at       timestamptz not null default now()
);

-- Materialised current state of each passport. Rebuildable from events; the API
-- replays the ledger on every passport view and flags any drift.
create table if not exists geneatrace.products (
  id               text primary key,
  batch_id         text not null references geneatrace.batches(id),
  sku              text not null,
  name             text not null,
  category         text not null,
  manufacturer_id  text not null references geneatrace.actors(id),
  status           text not null,
  custodian_id     text,
  facility_id      text,
  pending_to       text,
  signature        text not null,
  attributes       jsonb not null default '{}'::jsonb,
  last_tx          text,
  sold_at          text,
  scan_count       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists geneatrace.scans (
  id          text primary key,
  product_id  text,
  claimed_id  text not null,
  verdict     text not null,
  sig_valid   boolean,
  lat         double precision,
  lng         double precision,
  ip_hash     text,
  user_agent  text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists geneatrace.alerts (
  id           text primary key,
  severity     text not null,
  type         text not null,
  product_id   text,
  batch_id     text,
  facility_id  text,
  actor_id     text,
  message      text not null,
  details      jsonb not null default '{}'::jsonb,
  status       text not null default 'open',
  resolved_at  timestamptz,
  resolved_by  text,
  created_at   timestamptz not null default now()
);

create table if not exists geneatrace.programs (
  id               text primary key,
  name             text not null,
  manufacturer_id  text not null references geneatrace.actors(id),
  description      text,
  coverage         text,
  criteria         jsonb not null default '{}'::jsonb,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

-- Production machines. A process step must name a registered, qualified machine.
create table if not exists geneatrace.machines (
  id           text primary key,
  name         text not null,
  facility_id  text not null references geneatrace.facilities(id),
  actor_id     text not null references geneatrace.actors(id),
  processes    jsonb not null default '[]'::jsonb,
  status       text not null default 'active',
  created_at   timestamptz not null default now()
);

-- Customer details stay OFF-chain (privacy). The ledger only stores customer_ref, a salted hash.
create table if not exists geneatrace.sales (
  id              text primary key,
  product_id      text not null,
  retailer_id     text not null,
  customer_name   text,
  customer_phone  text,
  customer_email  text,
  invoice         text,
  price           double precision,
  customer_ref    text not null,
  replaces        text,
  created_at      timestamptz not null default now()
);

-- Service / return / recall cases. Every status change is also a ledger event.
create table if not exists geneatrace.tickets (
  id               text primary key,
  kind             text not null default 'issue',
  product_id       text not null,
  batch_id         text not null,
  retailer_id      text not null,
  manufacturer_id  text not null,
  sale_id          text,
  code             text,
  description      text,
  status           text not null,
  diagnosis        jsonb not null default '{}'::jsonb,
  replacement_id   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Ethereum anchor receipts: which transaction put each block hash on-chain.
create table if not exists geneatrace.anchors (
  id           text primary key,          -- <chain id>:<contract>:<height>
  height       integer not null,
  block_hash   text not null,
  chain_id     integer not null,
  contract     text not null,
  tx_hash      text not null,
  eth_block    bigint not null,
  anchored_at  text not null,
  created_at   timestamptz not null default now()
);
create index if not exists anchors_height_idx on geneatrace.anchors (contract, height);

create index if not exists events_product_idx  on geneatrace.events (product_id, block_height, seq);
create index if not exists events_batch_idx    on geneatrace.events (batch_id);
create index if not exists events_type_idx     on geneatrace.events (type);
create index if not exists events_block_idx    on geneatrace.events (block_height, seq);
create index if not exists products_batch_idx  on geneatrace.products (batch_id);
create index if not exists products_status_idx on geneatrace.products (status);
create index if not exists products_cust_idx   on geneatrace.products (custodian_id);
create index if not exists scans_product_idx   on geneatrace.scans (product_id, created_at);
create index if not exists alerts_status_idx   on geneatrace.alerts (status, created_at);
create index if not exists sales_product_idx   on geneatrace.sales (product_id);
create index if not exists tickets_retail_idx  on geneatrace.tickets (retailer_id, status);
create index if not exists tickets_maker_idx   on geneatrace.tickets (manufacturer_id, status);
create index if not exists tickets_product_idx on geneatrace.tickets (product_id);

-- Device-held company keys, two-factor sign-in and alert webhooks.
alter table geneatrace.actors add column if not exists signing_keys jsonb not null default '[]';
alter table geneatrace.actors add column if not exists totp_secret text;
alter table geneatrace.actors add column if not exists totp_enabled boolean not null default false;
alter table geneatrace.actors add column if not exists totp_last_step bigint not null default 0;
alter table geneatrace.actors add column if not exists webhook_url text;

-- Customer consent for safety notices, and erasure on request.
alter table geneatrace.sales add column if not exists consent_at timestamptz;
alter table geneatrace.sales add column if not exists erased_at timestamptz;

-- Shipping cartons: one scan moves every unit inside.
create table if not exists geneatrace.cartons (
  id          text primary key,
  actor_id    text not null,
  units       jsonb not null default '[]',
  created_at  timestamptz not null default now()
);

-- Delivery log for alerts sent outside the app.
create table if not exists geneatrace.notifications (
  id          text primary key,
  actor_id    text not null,
  alert_id    text,
  channel     text not null,
  status      text not null,
  error       text,
  created_at  timestamptz not null default now()
);

-- Append-only enforcement. Even with direct SQL access nobody can UPDATE/DELETE/TRUNCATE
-- the chain; anyone disabling these triggers is still caught by /api/chain/verify.
create or replace function geneatrace.reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'GeneaTrace ledger is append-only: % on %.% is not allowed', tg_op, tg_table_schema, tg_table_name
    using errcode = 'P0001';
end $$;

do $$
declare t text;
begin
  foreach t in array array['blocks', 'events', 'scans'] loop
    execute format('drop trigger if exists %I_append_only on geneatrace.%I', t, t);
    execute format('create trigger %I_append_only before update or delete on geneatrace.%I for each row execute function geneatrace.reject_mutation()', t, t);
    execute format('drop trigger if exists %I_no_truncate on geneatrace.%I', t, t);
    execute format('create trigger %I_no_truncate before truncate on geneatrace.%I for each statement execute function geneatrace.reject_mutation()', t, t);
  end loop;
end $$;

-- Keep the schema off the public Data API: only the API node (service connection) reads it.
alter table geneatrace.actors     enable row level security;
alter table geneatrace.facilities enable row level security;
alter table geneatrace.blocks     enable row level security;
alter table geneatrace.events     enable row level security;
alter table geneatrace.batches    enable row level security;
alter table geneatrace.products   enable row level security;
alter table geneatrace.scans      enable row level security;
alter table geneatrace.alerts     enable row level security;
alter table geneatrace.programs   enable row level security;
alter table geneatrace.machines   enable row level security;
alter table geneatrace.sales      enable row level security;
alter table geneatrace.tickets    enable row level security;
alter table geneatrace.anchors    enable row level security;
alter table geneatrace.cartons    enable row level security;
alter table geneatrace.notifications enable row level security;
