/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **Expand/contract is not advice.** A rolling deploy always runs two versions of this service
 * against one schema, so every change is four releases: add a column, deploy code that writes
 * both, backfill, deploy code that reads the new one, then drop the old one. A migration that
 * renames or drops in one step takes the previous replica down with it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 4" means. The fix for a wrong migration is always a new migration.
 *
 * ## The two invariants that live in this file rather than in application code
 *
 * 1. **`credit_accounts_within_cap`.** `spent + reserved <= cap` is a CHECK constraint. The
 *    conditional UPDATE in `credits.ts` is what produces a good error message; this is what makes
 *    the cap true. A spend guard that exists only in application code is a spend guard that one
 *    forgotten code path removes, and the thing on the other side of it is somebody's money.
 *
 * 2. **`assets.generation_job_id` is `on delete restrict`.** Provenance is the reason this service
 *    exists: `asset-forge` writes PNGs into sibling working trees with no record of the model,
 *    prompt, spec or cost that produced them, so a brand kit is not reproducible and a spend is
 *    not attributable. `restrict` means the record of what produced an asset cannot be deleted
 *    while the asset is still there. `cascade` would have quietly reintroduced the defect.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs
    // table missing the (kind, key) unique constraint, which silently turns every recurring
    // enqueue into a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of
      -- the backlog rather than the size of history.
      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the
      -- event to be redelivered to all of them on each retry.
      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'brand_kits',
    up: `
      create table if not exists brand_kits (
        id            uuid        primary key default gen_random_uuid(),
        owner_subject text        not null,
        name          text        not null,
        -- One accent, and it must be a hex colour. The design system says "a single accent from
        -- the registry"; a free-text accent is how #ff4d00 ended up hardcoded in asset-forge's
        -- BRAND_STYLE and applied to every surface regardless of which product it was for.
        accent        text        not null,
        palette       jsonb       not null default '[]'::jsonb,
        typography    jsonb       not null default '{}'::jsonb,
        style_prompt  text        not null default '',
        status        text        not null default 'draft',
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now(),
        constraint brand_kits_accent_hex   check (accent ~ '^#[0-9a-fA-F]{6}$'),
        constraint brand_kits_status_known check (status in ('draft', 'active', 'archived')),
        constraint brand_kits_name_len     check (char_length(name) between 1 and 200),
        -- A kit is reusable across launches, so it is named per owner rather than globally.
        constraint brand_kits_owner_name_uniq unique (owner_subject, name)
      );

      create index if not exists brand_kits_owner_idx on brand_kits (owner_subject, created_at desc);
    `,
  },
  {
    version: 5,
    name: 'credit_accounts',
    up: `
      create table if not exists credit_accounts (
        owner_subject       text        primary key,
        cap_usd_micros      bigint      not null,
        spent_usd_micros    bigint      not null default 0,
        reserved_usd_micros bigint      not null default 0,
        created_at          timestamptz not null default now(),
        updated_at          timestamptz not null default now(),
        constraint credit_accounts_cap_positive  check (cap_usd_micros >= 0),
        constraint credit_accounts_spent_positive check (spent_usd_micros >= 0),
        constraint credit_accounts_held_positive  check (reserved_usd_micros >= 0),
        -- The spend cap, as a database constraint rather than as a code path. See the file header.
        constraint credit_accounts_within_cap
          check (spent_usd_micros + reserved_usd_micros <= cap_usd_micros)
      );
    `,
  },
  {
    version: 6,
    name: 'generation_jobs',
    up: `
      create table if not exists generation_jobs (
        id            uuid        primary key default gen_random_uuid(),
        brand_kit_id  uuid        not null references brand_kits (id) on delete cascade,
        owner_subject text        not null,

        -- The asset_spec, denormalised onto the job. A spec is a VALUE, not an entity: it has no
        -- lifecycle, nothing references it by id, and a table of them would only add a join and
        -- the chance that editing a spec row silently rewrites what a delivered asset claims to
        -- be. src/specs.ts holds the catalogue of default sizes per kind.
        kind          text        not null,
        width         integer     not null,
        height        integer     not null,
        format        text        not null,

        status        text        not null default 'queued',
        prompt        text        not null,

        -- WHICH BACKEND THE CALLER ASKED FOR. Persisted, not passed.
        --
        -- The request and the generation are separated by a leased job, so anything held only in
        -- the request's local variables is lost across that boundary. Leaving it out meant a job
        -- requested as "placeholder" — and therefore reserving nothing — ran on FLUX and spent
        -- real money outside the cap. The choice is part of the job, so it lives on the job.
        backend_choice text       not null default 'auto',

        -- Provenance. Every column below answers "what produced this, and what did it cost".
        backend       text,
        -- The model as the API spells it, e.g. FLUX.2-pro. Stored rather than derived, because
        -- the model name and the URL path segment for the same model are different strings.
        model         text,
        -- What was ASKED for, which is not always the declared spec: FLUX floors each dimension
        -- to a multiple of 16, so the request is rounded up. Both numbers are needed to explain a
        -- delivered size that matches neither.
        requested_size text,
        -- One row per backend attempt, in order: {backend, model, outcome, status, ms}.
        -- This is what makes a fallback visible after the fact — 'the primary 404'd and the
        -- fallback served it' is a fact about a specific asset, not a line in yesterday's log.
        attempts      jsonb       not null default '[]'::jsonb,

        cost_estimate_usd_micros bigint not null default 0,
        cost_actual_usd_micros   bigint not null default 0,
        -- The provider's OWN accounting, verbatim: request_meta.cost, in provider units. Kept
        -- beside our dollar estimate rather than converted, because no exchange rate is published
        -- on this surface and a rate invented here would be indistinguishable from a measured one.
        provider_cost_units      integer,
        -- 'reserved' until the job finishes, then 'settled' (spent) or 'released' (refunded).
        credit_state  text        not null default 'reserved',

        checksum      text,
        error_code    text,
        error_detail  text,

        created_at    timestamptz not null default now(),
        started_at    timestamptz,
        finished_at   timestamptz,

        constraint generation_jobs_kind_known check (
          kind in ('mark', 'wordmark', 'favicon', 'og', 'social', 'banner', 'icon', 'tile')
        ),
        constraint generation_jobs_status_known check (
          status in ('queued', 'running', 'succeeded', 'failed')
        ),
        constraint generation_jobs_format_known check (format in ('png', 'svg')),
        constraint generation_jobs_backend_choice_known check (
          backend_choice in ('auto', 'flux', 'placeholder')
        ),
        -- A job that reserved nothing may only run on a backend that costs nothing. This is the
        -- constraint that makes the defect above unrepresentable rather than merely fixed.
        constraint generation_jobs_free_choice_costs_nothing check (
          backend_choice <> 'placeholder' or cost_estimate_usd_micros = 0
        ),
        constraint generation_jobs_credit_state_known check (
          credit_state in ('reserved', 'settled', 'released')
        ),
        constraint generation_jobs_size_sane check (
          width between 1 and 8192 and height between 1 and 8192
        ),
        constraint generation_jobs_cost_positive check (
          cost_estimate_usd_micros >= 0 and cost_actual_usd_micros >= 0
        ),
        -- A finished job has decided about the money. A row that is 'succeeded' and still
        -- 'reserved' is a hold nothing will ever release, which is a customer who cannot spend
        -- credit they were never charged.
        constraint generation_jobs_terminal_is_settled check (
          status in ('queued', 'running') or credit_state in ('settled', 'released')
        ),
        -- A failure must say why, in a code a client can branch on. 'it failed' is what
        -- asset-forge prints today and it is not actionable.
        constraint generation_jobs_failure_has_code check (
          status <> 'failed' or error_code is not null
        )
      );

      create index if not exists generation_jobs_kit_idx
        on generation_jobs (brand_kit_id, created_at desc);
      create index if not exists generation_jobs_owner_idx
        on generation_jobs (owner_subject, created_at desc);
    `,
  },
  {
    version: 7,
    name: 'assets',
    up: `
      create table if not exists assets (
        id                uuid        primary key default gen_random_uuid(),
        brand_kit_id      uuid        not null references brand_kits (id) on delete cascade,
        -- RESTRICT, not CASCADE. See the file header: the record of what produced an asset may
        -- not be deleted while the asset exists.
        generation_job_id uuid        not null references generation_jobs (id) on delete restrict,

        kind              text        not null,
        format            text        not null,
        -- What the spec asked for, and what the bytes actually are. Both, always. asset-forge
        -- ships twelve game masters at 1024 square against a declared 512 and 256 because only
        -- one of these numbers was ever recorded.
        declared_width    integer     not null,
        declared_height   integer     not null,
        actual_width      integer,
        actual_height     integer,
        sizing            text        not null,

        storage_url       text        not null,
        checksum          text        not null,
        byte_size         bigint      not null,
        licence           text        not null,
        -- Every FLUX image carries C2PA provenance and a Microsoft invisible watermark, about
        -- 100KB of it. That is a disclosure and licensing fact about the bytes, so it is a column:
        -- an estate that already discloses AI-generated artwork needs to be able to SELECT which
        -- assets are, rather than re-examine the files.
        c2pa              boolean     not null default false,
        created_at        timestamptz not null default now(),

        constraint assets_sizing_known check (sizing in ('exact', 'unsized', 'unknown')),
        constraint assets_byte_size_positive check (byte_size > 0),
        -- 'exact' is a claim about pixels, so it may only be made when the pixels were read and
        -- they matched. Without this, 'exact' degrades into 'nobody checked'.
        constraint assets_exact_means_measured check (
          sizing <> 'exact'
          or (actual_width = declared_width and actual_height = declared_height)
        ),
        -- One job produces one asset. A second row against the same job would be an asset whose
        -- cost has already been attributed to another one.
        constraint assets_one_per_job unique (generation_job_id)
      );

      create index if not exists assets_kit_idx on assets (brand_kit_id, created_at desc);
    `,
  },
  {
    version: 8,
    name: 'world_object_kind',
    /**
     * `world_object` — the ninth asset kind, and the first that is not a brand artefact.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **WHY THIS IS A MIGRATION AND NOT AN EDIT TO VERSION 6.** Migration text is IMMUTABLE once
     * released — `@cloudsforge/db` checksums it and refuses a changed migration, and the fix is
     * always a new one (`service-template/src/migrations.ts:1-15`). Widening the literal in
     * version 6 would have left every database that has already run it carrying the OLD
     * eight-value constraint while `specs.ts` accepted nine, so `specFor('world_object')` would
     * have returned a valid spec and the insert would have failed at the database with a
     * constraint violation nobody could have predicted from the TypeScript.
     *
     * **AND WHY THE CONSTRAINT IS RE-ADDED RATHER THAN DROPPED.** The enumeration is the reason
     * `specFor` can say "kind must be one of …" and mean it. A `kind` column with no CHECK would
     * accept a typo — `world-object`, `worldobject` — as a row, and the row would then be a job
     * whose prompt was built from a kind `prompt.ts` has no COMPOSITION for. The list is short
     * and closed on purpose; this widens it by exactly one.
     *
     * 23-tessera.md §9.1 calls this "the only change to `micro-studio` the design depends on".
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    up: `
      alter table generation_jobs
        drop constraint if exists generation_jobs_kind_known;
      alter table generation_jobs
        add constraint generation_jobs_kind_known check (
          kind in ('mark', 'wordmark', 'favicon', 'og', 'social', 'banner', 'icon', 'tile',
                   'world_object')
        );
    `,
  },
]

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the
 * old schema when a deploy runs ahead of its migrator.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted.
 *
 * A new service leaves this at 0. A service migrated from the old estate sets it to the version
 * whose DDL matches the live schema, ships one release, and then sets it back to 0. There is no
 * `studio` in the frozen estate — asset-forge is a CLI with no database at all — so this is 0 and
 * stays 0.
 */
export const BASELINE_VERSION = 0
