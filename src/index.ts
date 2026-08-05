/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step below carries the reason it must precede the next; the ordering is the substance of
 * this file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process. See AD-17 and rule 7.
 *
 * It also deliberately does not call the image model at boot. A preflight that generated an image
 * would spend money on every rolling restart and repeatedly on a crash-looping replica; the
 * backend is reported as configured-but-unverified and the first real generation supplies the
 * evidence. See `preflight.ts`.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it
 * must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env, redactedEndpoint } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { postgresBrandKitStore } from './brandkits.ts'
import {
  assetRootProbe,
  checkAssetRoot,
  describeAssetRootFailure,
  filesystemBlobStore,
  findAsset,
  listAssetsForKit,
} from './assets.ts'
import { findJob, requestGeneration, GENERATE_KIND } from './generation.ts'
import { DEFAULT_UPLOAD_QUOTA, changeVisibility, storeUpload } from './uploads.ts'
import { fluxBackend, placeholderBackend, type BackendSet } from './backend.ts'
import { Preflight, imageBackendProbe } from './preflight.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable. Nothing below may run first, because
//    every step after this reads configuration and a half-built service that then exits is
//    harder to diagnose than one that never started.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  // The host and the model, never the key.
  imageEndpoint: redactedEndpoint(env.flux),
  imageModel: env.flux?.model ?? null,
})

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does **not** migrate — the migrator job does, and it has already run
//    by the time a container starts. Failing here rather than serving is the point: a replica of
//    the new code answering requests against the old schema corrupts data quietly, whereas a
//    container that refuses to start is a deploy that visibly stops.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. Assert the asset root is writable, in the same shape as the schema assertion above and for
//    the same reason: a precondition that every request depends on, checked once, before the
//    socket exists. This one is not hypothetical. `STUDIO_ASSET_ROOT` was unset in the deploy, the
//    fallback resolved to a root-owned `/app/out` under `USER node`, and every generation of every
//    kind failed EACCES while the container reported healthy and `/readyz` answered 200.
//
//    It writes rather than asking. See `checkAssetRoot` for why `fs.access` would not have caught
//    it, and note this check runs BEFORE `filesystemBlobStore` is constructed below, because
//    constructing that store proves nothing — it only calls `resolve()`.
try {
  await checkAssetRoot(env.assetRoot)
} catch (err) {
  logger.fatal('asset root is not writable', {
    err,
    assetRoot: env.assetRoot,
    detail: describeAssetRootFailure(env.assetRoot, err),
  })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 6. The image backends. Constructed whether or not a model is reachable: the placeholder always
//    exists, so `backends.placeholder` is never null and the service is never without a way to
//    answer a generation request that asked for one.
const preflight = new Preflight(env.flux, { deadlineMs: env.imageDeadlineMs })
const backends: BackendSet = {
  flux: env.flux
    ? fluxBackend(env.flux, {
        deadlineMs: env.imageDeadlineMs,
        priceUsdMicros: env.imagePriceUsdMicros,
      })
    : null,
  placeholder: placeholderBackend(),
}

// 7. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. The service is `starting` from here until `markReady()`, so a balancer
//    that probes during boot is told the truth rather than a static `{ok:true}`.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval or the balancer is still sending traffic when
  // the process stops accepting it.
  drainDelayMs: 5_000,
  // Longer than the template's, because an in-flight generation is a 20-to-40-second FLUX call
  // and a drain that cuts it loses an image that has already been paid for.
  drainTimeoutMs: 45_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignores
      // the signal would hang `/readyz` for ever. Racing the signal is what turns "the database is
      // not answering" into a fail rather than a hung readiness endpoint.
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(
    // Soft. If identity is down this service still serves everything that does not need a fresh
    // key — and marking it hard means one identity blip removes every service in the estate from
    // its balancer at once, which is a cascade, not a safety measure.
    httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }),
  )
  .addProbe(
    // Soft, and this is the difference between "broken" and "degraded". With no usable model the
    // service still creates brand kits, reads them and generates placeholders; only real art is
    // unavailable. A hard probe here would turn a missing model into an outage of the whole
    // service. It performs no I/O, so it can never spend money or hang the probe.
    imageBackendProbe(preflight),
  )
  .addProbe(
    // HARD, and the contrast with the probe directly above it is the whole reason this one exists.
    //
    // The image backend degrades honestly: with no model, brand kits, reads and placeholder
    // generation all still work, so `soft` — 200 with `state: "degraded"` — is the truth. An
    // unwritable asset root has no such remainder. Every generation of every kind fails, through
    // every backend including the placeholder, because they all end at `blobs.put()`. Reporting
    // that in the `/readyz` body while still answering 200 would leave the replica in the balancer
    // taking work it cannot finish — the same bug this probe exists to catch, wearing a fix's
    // clothes. So it is `hard`, and `/readyz` goes 503.
    //
    // Step 5 already refused to boot on an unwritable root. This is the root that goes read-only,
    // full or unmounted afterwards, which no boot check can see.
    assetRootProbe(env.assetRoot),
  )

// 8. The queue, before the routes: the generate route enqueues, so it closes over this.
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })

const kits = postgresBrandKitStore(sql, SERVICE)
const blobs = filesystemBlobStore(env.assetRoot, env.assetBaseUrl)

const runDeps = {
  sql,
  producer: SERVICE,
  backends,
  blobs,
  preflight,
  logger: logger.child({ job: GENERATE_KIND }),
}

const requestDeps = {
  sql,
  producer: SERVICE,
  defaultCreditCapUsdMicros: env.defaultCreditCapUsdMicros,
  priceUsdMicros: env.imagePriceUsdMicros,
  enqueue: async (job: { kind: string; key: string; payload: Record<string, unknown> }) => {
    // `keep` collapses a double-click into one run. The key is the owner's spend — see jobs.ts.
    await queue.enqueue({ ...job, onConflict: 'keep' })
  },
}

// 9. Routes. Constructed after the Lifecycle so the health handlers report real state, and after
//    the pool so the stores are real rather than a lazily-connected surprise on first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  kits,
  reads: {
    findJob: (id) => findJob(sql, id),
    findAsset: (id) => findAsset(sql, id),
    // The blob store, not the filesystem. The route hands it a checksum from a row it has already
    // authorised, and the store is the only thing that knows how a checksum becomes a path.
    readBlob: (checksum, format) => blobs.get(checksum, format as Parameters<typeof blobs.get>[1]),
    listAssetsForKit: (brandKitId, limit) => listAssetsForKit(sql, brandKitId, limit),
  },
  // The port, closing over the pipeline's dependencies. The route never sees the pool.
  generation: { request: (input) => requestGeneration(requestDeps, input) },
  uploads: {
    store: (input) =>
      storeUpload({ sql, producer: SERVICE, blobs, quota: DEFAULT_UPLOAD_QUOTA }, input),
    setVisibility: (input) => changeVisibility({ sql, producer: SERVICE }, input),
  },
  preflight,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in
  // this repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
  },
})

// 10. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//     replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//     the Lifecycle for exactly that.
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  // Deliberately modest. Each slot can hold a 40-second image call, and a wide runner would let
  // one replica hold more of the model's quota than the fallback rules can do anything about.
  concurrency: 2,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql,
  logger,
  signingSecret: env.outboxSigningSecret,
  generation: runDeps,
})
await seedRecurring(queue)
runner.start()

// 11. Listen. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 12. Ready. Only now: the state moves `starting → ready`, `/readyz` starts answering 200, and the
//     balancer is allowed to send traffic. Flipping this before `listen()` would advertise a
//     replica that has no socket.
lifecycle.markReady()

// 13. Signal handlers, last of all. Installing them earlier means a SIGTERM arriving mid-boot
//     drains a service that was never ready, and the drain races the construction above.
//     Hooks run in reverse registration order, so the server closes first, then the runner stops
//     claiming and drains, then the pool closes with nothing left to use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  // Generous, because a claimed generation is a paid image in flight; stopping short of it loses
  // the money and the artefact together.
  const clean = await runner.stop(40_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
