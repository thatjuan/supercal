-- Spike schema for the feed side. Drop-and-create; spike_feed only.
drop table if exists settings, publication_source, publication, feed, resource, source_calendar cascade;
drop sequence if exists change_seq;

-- Global change sequence. Every resource write takes the next value, under a per-tenant
-- advisory lock (see src/store.ts recordChange) so seq order == commit order within a tenant.
create sequence change_seq;

create table source_calendar (
  id serial primary key,
  tenant_id int not null,
  name text not null,
  owner_email text            -- account address; used to prefer the organizer's copy in merges
);

-- One row per (source calendar, UID): master + overrides, kept as jCal so unknown props survive.
create table resource (
  source_calendar_id int not null references source_calendar(id),
  uid text not null,
  data jsonb not null,        -- EventResource (src/model.ts)
  sequence int not null default 0,
  last_modified timestamptz,  -- LAST-MODIFIED or DTSTAMP, merge tie-breaker
  organizer text,
  span tstzrange not null,    -- coarse [first start, last end) for time-range prefilter
  deleted boolean not null default false,   -- tombstone, needed by sync-collection
  seq bigint not null,
  changed_at timestamptz not null default now(),  -- feeds Last-Modified
  xid xid8 not null default pg_current_xact_id(), -- writer txn; only used by the xmin-watermark alternative (test/sync-race.ts)
  primary key (source_calendar_id, uid)
);
create index resource_seq on resource (source_calendar_id, seq);
create index resource_span on resource using gist (span);

create table feed (
  id serial primary key,
  tenant_id int not null,
  username text not null unique,
  password_hash text not null,   -- Bun.password (argon2id)
  ics_token_sha256 text not null unique,
  secret text not null           -- HMAC key for privacy-mode UID rewriting
);

create table publication (
  id serial primary key,
  feed_id int not null references feed(id),
  slug text not null,
  name text not null,
  color text not null,
  privacy text not null check (privacy in ('full', 'title-only', 'busy-only')),
  kind text not null check (kind in ('passthrough', 'virtual')),
  uid_mode text not null default 'auto' check (uid_mode in ('auto', 'source')), -- 'source' only for the spike's collision test
  keep_alarms boolean not null default false,
  epoch int not null default 1,  -- bumped on membership/projection change; invalidates sync tokens
  sort_order int not null default 0,
  unique (feed_id, slug)
);

create table publication_source (
  publication_id int not null references publication(id) on delete cascade,
  source_calendar_id int not null references source_calendar(id),
  priority int not null default 0,
  primary key (publication_id, source_calendar_id)
);

-- Tombstones older than this seq were purged; tokens below it are invalid.
create table settings (k text primary key, v bigint not null);
insert into settings values ('tombstone_floor', 0);
