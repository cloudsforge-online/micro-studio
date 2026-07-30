import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checksumOf } from '@cloudsforge/db'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'

const SQL = MIGRATIONS.map((m) => m.up).join('\n')

test('versions are unique and ascending', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length, 'a duplicate version makes the run refuse')
})

test('SCHEMA_VERSION is the highest migration, so a new one raises the boot assertion', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
})

test('a new service baselines nothing', () => {
  assert.equal(BASELINE_VERSION, 0, 'a non-zero baseline records migrations as applied without running them')
})

test('checksums are stable, which is what makes an edited migration refuse to run', () => {
  for (const m of MIGRATIONS) {
    assert.equal(checksumOf(m), checksumOf({ ...m, up: `\n  ${m.up}  \n` }), `${m.name} is whitespace-sensitive`)
  }
})

test('the jobs, outbox and inbox tables are all present', () => {
  for (const table of ['jobs', 'outbox', 'event_subscriptions', 'outbox_deliveries', 'inbox']) {
    assert.match(SQL, new RegExp(`create table if not exists ${table}\\b`), `${table} is missing`)
  }
  // The constraint the recurring-enqueue collapse depends on. Without it every tick duplicates.
  assert.match(SQL, /jobs_kind_key_uniq unique \(kind, key\)/)
  // The dedupe key consumers rely on — AD-10.
  assert.match(SQL, /primary key \(topic, event_id\)/)
})

test('the domain tables are all present', () => {
  for (const table of ['brand_kits', 'credit_accounts', 'generation_jobs', 'assets']) {
    assert.match(SQL, new RegExp(`create table if not exists ${table}\\b`), `${table} is missing`)
  }
})

test('THE SPEND CAP IS A DATABASE CONSTRAINT, not only a code path', () => {
  // A spend guard that exists only in application code is a spend guard that one forgotten code
  // path removes, and the thing on the other side of it is somebody's money.
  assert.match(SQL, /constraint credit_accounts_within_cap/)
  assert.match(SQL, /spent_usd_micros \+ reserved_usd_micros <= cap_usd_micros/)
})

test('PROVENANCE CANNOT BE DELETED out from under an asset', () => {
  // `on delete restrict`, never cascade. The record of what produced an asset is the reason this
  // service exists; cascade would have quietly reintroduced asset-forge's defect.
  assert.match(
    SQL,
    /generation_job_id uuid\s+not null references generation_jobs \(id\) on delete restrict/,
  )
})

test('one generation job produces at most one asset', () => {
  // A second row against the same job would be an asset whose cost is already attributed to
  // another one.
  assert.match(SQL, /constraint assets_one_per_job unique \(generation_job_id\)/)
})

test("`exact` may only be claimed when the pixels were measured and matched", () => {
  // Otherwise `exact` degrades into `nobody checked`, which is the state twelve estate assets are
  // in today.
  assert.match(SQL, /constraint assets_exact_means_measured/)
  assert.match(SQL, /actual_width = declared_width and actual_height = declared_height/)
})

test('a finished job has decided about the money, and a failed one says why', () => {
  assert.match(SQL, /constraint generation_jobs_terminal_is_settled/)
  assert.match(SQL, /constraint generation_jobs_failure_has_code/)
})

test('the asset kinds are exactly the ones the domain model names', () => {
  assert.match(SQL, /kind in \('mark', 'wordmark', 'favicon', 'og', 'social', 'banner', 'icon', 'tile'\)/)
})

test('the provenance columns a reproducible brand kit needs all exist', () => {
  // 04-domain-model §5.1: model, prompt, spec and cost, per asset.
  for (const column of [
    'backend',
    'model',
    'requested_size',
    'attempts',
    'prompt',
    'cost_estimate_usd_micros',
    'cost_actual_usd_micros',
    'provider_cost_units',
    'checksum',
  ]) {
    assert.match(SQL, new RegExp(`\\b${column}\\b`), `generation_jobs.${column} is missing`)
  }
  // Both the declared and the delivered dimensions, or `unsized` cannot be expressed.
  for (const column of ['declared_width', 'declared_height', 'actual_width', 'actual_height', 'c2pa']) {
    assert.match(SQL, new RegExp(`\\b${column}\\b`), `assets.${column} is missing`)
  }
})
