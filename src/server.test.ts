import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { Lifecycle, type Probe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import {
  READ_SCOPE,
  WRITE_SCOPE,
  createServer,
  registerServiceMetrics,
  type GenerationRequester,
  type ReadModel,
} from './server.ts'
import { assetRootProbe, checkAssetRoot } from './assets.ts'
import { BrandKitConflictError, type BrandKit, type BrandKitStore, type CreateBrandKit } from './brandkits.ts'
import { CreditCapError } from './credits.ts'
import { Preflight, imageBackendProbe } from './preflight.ts'
import { fluxConfigFor } from './testsupport.ts'
import type { GenerationJob, RequestGenerationInput } from './generation.ts'
import type { Asset } from './assets.ts'
import type { Attempt } from './backend.ts'

const ISSUER = 'https://identity.test'
const USER = '11111111-1111-4111-8111-111111111111'
const SUBJECT = `user:${USER}`

const keys = await generateKeyPair('RS256', { extractable: true })

const sign = (payload: Record<string, unknown>) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('15m')
    .sign(keys.privateKey)

/** A real `Verifier` over a local key set. Nothing here stubs the decision under test. */
const workingVerifier = () =>
  new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER, keySet: (async () => keys.publicKey) as never })

const unreachableVerifier = () =>
  new Verifier({
    jwksUrl: 'http://down',
    issuer: ISSUER,
    keySet: (async () => {
      throw new Error('getaddrinfo EAI_AGAIN identity')
    }) as never,
  })

const KIT: BrandKit = {
  id: 'kit-1',
  ownerSubject: SUBJECT,
  name: 'CloudsForge',
  accent: '#ff4d00',
  palette: ['#12100f'],
  typography: {},
  stylePrompt: 'an anvil under a cloud arc',
  status: 'draft',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
}

const JOB: GenerationJob = {
  id: 'job-1',
  brandKitId: KIT.id,
  ownerSubject: SUBJECT,
  spec: { kind: 'mark', width: 1024, height: 1024, format: 'png' },
  status: 'succeeded',
  prompt: 'a flat geometric mark in #ff4d00',
  backendChoice: 'auto',
  backend: 'flux',
  model: 'FLUX.2-pro',
  requestedSize: '1024x1024',
  attempts: [
    { backend: 'flux', model: 'FLUX.2-pro', outcome: 'ok', status: 200, detail: 'b64_json', durationMs: 20_000 },
  ],
  costEstimateUsdMicros: 60_000n,
  costActualUsdMicros: 60_000n,
  providerCostUnits: 3,
  creditState: 'settled',
  checksum: 'sha256:abc',
  errorCode: null,
  errorDetail: null,
  createdAt: '1970-01-01T00:00:00.000Z',
  startedAt: '1970-01-01T00:00:00.000Z',
  finishedAt: '1970-01-01T00:00:01.000Z',
}

const ASSET: Asset = {
  id: 'asset-1',
  brandKitId: KIT.id,
  generationJobId: JOB.id,
  kind: 'mark',
  format: 'png',
  declaredWidth: 1024,
  declaredHeight: 1024,
  actualWidth: 1024,
  actualHeight: 1024,
  sizing: 'exact',
  storageUrl: 'memory://sha256:abc.png',
  checksum: 'sha256:abc',
  byteSize: 629_074,
  licence: 'cloudsforge-generated: commercial use permitted; AI-generated, C2PA provenance retained',
  c2pa: true,
  createdAt: '1970-01-01T00:00:01.000Z',
}

function memoryKits(): BrandKitStore & { rows: BrandKit[] } {
  const rows: BrandKit[] = []
  return {
    rows,
    async create(input: CreateBrandKit) {
      if (rows.some((r) => r.ownerSubject === input.ownerSubject && r.name === input.name)) {
        throw new BrandKitConflictError(`a brand kit named "${input.name}" already exists`)
      }
      const kit: BrandKit = {
        ...KIT,
        id: `kit-${rows.length + 1}`,
        ownerSubject: input.ownerSubject,
        name: input.name,
        accent: input.accent,
        palette: input.palette,
        typography: input.typography,
        stylePrompt: input.stylePrompt,
      }
      rows.push(kit)
      return kit
    },
    async find(id) {
      return rows.find((r) => r.id === id) ?? (id === KIT.id ? KIT : null)
    },
    async listForOwner(ownerSubject) {
      return rows.filter((r) => r.ownerSubject === ownerSubject)
    },
  }
}

const okAttempt: Attempt = {
  backend: 'flux',
  model: 'FLUX.2-pro',
  outcome: 'ok',
  status: 200,
  detail: 'b64_json',
  durationMs: 1,
}

interface Options {
  readonly probes?: Probe[]
  readonly ready?: boolean
  readonly verifier?: Verifier
  readonly preflight?: Preflight
  /** Injected into the generation port, to drive the refusal mappings. */
  readonly refuseWith?: Error
}

interface Harness {
  readonly url: string
  readonly lifecycle: Lifecycle
  readonly metrics: Metrics
  readonly kits: BrandKitStore & { rows: BrandKit[] }
  readonly accepted: RequestGenerationInput[]
}

async function withServer(options: Options, fn: (h: Harness) => Promise<void>): Promise<void> {
  const lifecycle = new Lifecycle({ cacheMs: 0 })
  for (const probe of options.probes ?? []) lifecycle.addProbe(probe)
  const metrics = registerServiceMetrics(registerHttpMetrics(new Metrics()))
  const kits = memoryKits()
  const accepted: RequestGenerationInput[] = []

  // Logs are discarded rather than silenced, so a serialisation failure in a log line still
  // surfaces as a thrown error rather than being hidden by a null logger.
  const logger = new Logger({ service: 'test', sink: () => {} })

  const reads: ReadModel = {
    async findJob(id) {
      return id === JOB.id ? JOB : null
    },
    async findAsset(id) {
      return id === ASSET.id ? ASSET : null
    },
  }

  // The generation port. These tests are about the HTTP surface; `generation.test.ts` drives the
  // real pipeline against a real database and a real endpoint.
  const generation: GenerationRequester = {
    async request(input) {
      if (options.refuseWith) throw options.refuseWith
      accepted.push(input)
      return {
        ...JOB,
        id: `job-${accepted.length}`,
        status: 'queued',
        spec: input.spec,
        backendChoice: input.choice,
        backend: null,
        model: null,
        checksum: null,
        creditState: 'reserved',
        costActualUsdMicros: 0n,
        finishedAt: null,
      }
    },
  }

  const server: Server = createServer({
    lifecycle,
    logger,
    metrics,
    verifier: options.verifier ?? workingVerifier(),
    kits,
    reads,
    generation,
    preflight: options.preflight ?? new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com')),
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  if (options.ready !== false) lifecycle.markReady()
  const { port } = server.address() as AddressInfo
  try {
    await fn({ url: `http://127.0.0.1:${port}`, lifecycle, metrics, kits, accepted })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const failingProbe = (name: string, kind: 'hard' | 'soft'): Probe => ({
  name,
  kind,
  check: async () => ({ state: 'fail', detail: 'connection refused' }),
})

/* --------------------------------------------------------------- health */

test('livez is static and stays 200 while the service is unready', async () => {
  await withServer({ ready: false, probes: [failingProbe('postgres', 'hard')] }, async (h) => {
    const res = await fetch(`${h.url}/livez`)
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { state: string }).state, 'starting')
    assert.equal((await fetch(`${h.url}/readyz`)).status, 503)
  })
})

test('readyz is 503 when a hard probe fails', async () => {
  await withServer({ probes: [failingProbe('postgres', 'hard')] }, async (h) => {
    const res = await fetch(`${h.url}/readyz`)
    assert.equal(res.status, 503)
    assert.equal(((await res.json()) as { ready: boolean }).ready, false)
  })
})

test('THE DIFFERENCE: no usable image model is 200 + degraded, not 503', async () => {
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([{ ...okAttempt, outcome: 'not_found', status: 404 }])

  await withServer({ preflight, probes: [imageBackendProbe(preflight)] }, async (h) => {
    const res = await fetch(`${h.url}/readyz`)
    assert.equal(res.status, 200, 'the replica stays in the balancer')
    const body = (await res.json()) as { ready: boolean; state: string; checks: { name: string; state: string }[] }
    assert.equal(body.ready, true)
    assert.equal(body.state, 'degraded')
    assert.equal(body.checks.find((c) => c.name === 'image-backend')?.state, 'warn')
  })
})

/* --------------------------------------------------------------- the asset root */

/**
 * The defect these four cases exist for: `STUDIO_ASSET_ROOT` unset, the fallback resolving to a
 * root-owned `/app/out` under `USER node`, every generation failing EACCES — and `/readyz`
 * answering **200** throughout.
 *
 * Each case asserts the STATUS CODE, not the body. A probe that reports an unwritable root in the
 * `/readyz` payload while still answering 200 leaves the replica in the balancer, which is the
 * original defect with a paragraph of explanation attached.
 */

/** A temporary directory, removed afterwards even if the case leaves it unreadable. */
async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'studio-asset-root-'))
  try {
    await fn(root)
  } finally {
    await chmod(root, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

const rootProbeCheck = (body: unknown) =>
  (body as { checks: { name: string; kind: string; state: string; detail?: string }[] }).checks.find(
    (c) => c.name === 'asset-root',
  )

test('a writable asset root passes, and the check leaves nothing behind', async () => {
  await withTempRoot(async (root) => {
    // Twice, because the second run is the one that matters: the check must need the same
    // permission on the second call as on the first, which is only true if it tears its own
    // scratch directory down. See WRITE_CHECK_DIR.
    await checkAssetRoot(root)
    await checkAssetRoot(root)

    assert.deepEqual(await readdir(root), [], 'the check removes both the file and the directory')

    await withServer({ probes: [assetRootProbe(root)] }, async (h) => {
      const res = await fetch(`${h.url}/readyz`)
      assert.equal(res.status, 200)
      assert.equal(rootProbeCheck(await res.json())?.state, 'pass')
    })
  })
})

test('THE POINT: an unwritable asset root is 503, not a 200 that mentions it', async () => {
  // Runs as any uid: `mkdir` under a path that goes through a regular FILE is ENOTDIR for root
  // too. The permission case below is the incident's own errno and needs a non-root uid.
  await withTempRoot(async (dir) => {
    const notADirectory = join(dir, 'this-is-a-file')
    await writeFile(notADirectory, 'x')

    await withServer({ probes: [assetRootProbe(notADirectory)] }, async (h) => {
      const res = await fetch(`${h.url}/readyz`)
      assert.equal(res.status, 503, 'the replica must leave the balancer, not merely complain')

      const body = (await res.json()) as { ready: boolean; state: string }
      assert.equal(body.ready, false)

      const check = rootProbeCheck(body)
      assert.equal(check?.state, 'fail')
      // HARD is the assertion. A soft probe reports exactly the same `fail` here and still answers
      // 200, so the kind — not the state — is what makes the status code correct.
      assert.equal(check?.kind, 'hard')
      assert.match(String(check?.detail), /not a directory/)
    })
  })
})

test('THE INCIDENT: a root the process cannot write to is EACCES and 503', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  // Announced rather than silent. Root ignores the mode bits, so this case cannot be run as root
  // and a green run that skipped it must say which one it was.
  if (uid === 0) {
    console.log('skipped as root: chmod cannot make a directory unwritable to uid 0')
    return
  }

  await withTempRoot(async (root) => {
    // r-x: exactly the state `/app/out` was in — the directory exists, is readable, is listable,
    // and cannot be written to by the uid the image runs as.
    await chmod(root, 0o500)

    await withServer({ probes: [assetRootProbe(root)] }, async (h) => {
      const res = await fetch(`${h.url}/readyz`)
      assert.equal(res.status, 503)

      const check = rootProbeCheck(await res.json())
      assert.equal(check?.state, 'fail')
      assert.equal(check?.kind, 'hard')
      // The sentence an operator gets: the errno's real cause, not `chmod` on a correct path.
      assert.match(String(check?.detail), /not writable by uid/)
      assert.match(String(check?.detail), /EVERY generation of every kind/)
    })
  })
})

test('a root that is fine at boot and unwritable later still goes 503', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (uid === 0) {
    console.log('skipped as root: chmod cannot make a directory unwritable to uid 0')
    return
  }

  // This is the case the boot assertion in index.ts cannot cover, and the reason the probe exists
  // as well as the boot check: a volume remounted read-only, or a disk that fills, at 03:00.
  await withTempRoot(async (root) => {
    await withServer({ probes: [assetRootProbe(root)] }, async (h) => {
      assert.equal((await fetch(`${h.url}/readyz`)).status, 200)
      await chmod(root, 0o500)
      // THE REGRESSION THIS PINS. A check that kept a scratch directory around would still be
      // writing into it here and would answer 200 — the root is unwritable and the probe cannot
      // tell, which is the original defect reintroduced by a check that looked correct.
      assert.equal((await fetch(`${h.url}/readyz`)).status, 503)
      await chmod(root, 0o700)
      assert.equal((await fetch(`${h.url}/readyz`)).status, 200, 'and it recovers without a restart')
    })
  })
})

/* --------------------------------------------------------------- /v1/backend */

test('GET /v1/backend reports endpoint, model, fallbackModel, usable and reason', async () => {
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/backend`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body['endpoint'], 'test01eastus01.services.ai.azure.com')
    assert.equal(body['model'], 'FLUX.2-pro')
    assert.equal(body['fallbackModel'], null)
    assert.equal(body['usable'], true)
    assert.equal(body['evidence'], 'unverified')
    assert.ok(typeof body['reason'] === 'string' && body['reason'].length > 0)
    assert.equal(body['placeholderAvailable'], true)
  })
})

test('GET /v1/backend is unauthenticated but never leaks the key', async () => {
  // A capability a caller cannot discover without a token is one they will discover by having a
  // job fail instead. It names no customer and carries no credential.
  const config = fluxConfigFor('https://test01eastus01.services.ai.azure.com')
  await withServer({ preflight: new Preflight(config) }, async (h) => {
    const text = await (await fetch(`${h.url}/v1/backend`)).text()
    assert.equal(text.includes(config.apiKey), false)
  })
})

test('GET /v1/backend honestly reports a resource with no deployed model', async () => {
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([{ ...okAttempt, outcome: 'not_found', status: 404 }])

  await withServer({ preflight }, async (h) => {
    const body = (await (await fetch(`${h.url}/v1/backend`)).json()) as Record<string, unknown>
    assert.equal(body['usable'], false)
    assert.equal(body['evidence'], 'observed')
    assert.match(String(body['reason']), /no configured model is deployed/)
    // And the service is still usable for everything else.
    assert.equal(body['placeholderAvailable'], true)
  })
})

test('?probe=1 requires a token, because it makes a real image call', async () => {
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/backend?probe=1`)
    assert.equal(res.status, 401)
  })
})

/* --------------------------------------------------------------- auth */

test('an unauthenticated request is 401 and the body carries the request id', async () => {
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1`)
    assert.equal(res.status, 401)
    const body = (await res.json()) as { error: { code: string; requestId: string } }
    assert.equal(body.error.code, 'unauthenticated')
    assert.equal(body.error.requestId, res.headers.get('x-request-id'))
  })
})

test('THE RULE: an unreachable JWKS is 503, never 401', async () => {
  // Answering 401 here signs every user in the estate out because identity is having a bad minute.
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({ verifier: unreachableVerifier() }, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 503)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'verifier_unavailable')
  })
})

test('a service token needs the scope', async () => {
  const unscoped = await sign({ sub: 'service:hub-api', scopes: ['something:else'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1`, {
      headers: { authorization: `Bearer ${unscoped}` },
    })
    assert.equal(res.status, 403)
    assert.match(((await res.json()) as { error: { message: string } }).error.message, new RegExp(READ_SCOPE))
  })
})

test("another user's brand kit is 404, not 403, so ids cannot be enumerated", async () => {
  const other = await sign({ sub: '22222222-2222-4222-8222-222222222222', handle: 'other', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1`, {
      headers: { authorization: `Bearer ${other}` },
    })
    assert.equal(res.status, 404)
  })
})

/* --------------------------------------------------------------- brand kits */

test('a brand kit is created and the accent is validated', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'CloudsForge', accent: '#ff4d00', palette: ['#12100f'] }),
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { brandKit: BrandKit }
    assert.equal(body.brandKit.accent, '#ff4d00')
    assert.equal(body.brandKit.ownerSubject, SUBJECT)
    assert.match(h.metrics.render(), /studio_brand_kits_created_total\{actor_kind="user"\} 1/)

    const bad = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', accent: 'orange' }),
    })
    assert.equal(bad.status, 400)
  })
})

test('a duplicate kit name for one owner is 409', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const body = JSON.stringify({ name: 'CloudsForge', accent: '#ff4d00' })
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    assert.equal((await fetch(`${h.url}/v1/brand-kits`, { method: 'POST', headers, body })).status, 201)
    const second = await fetch(`${h.url}/v1/brand-kits`, { method: 'POST', headers, body })
    assert.equal(second.status, 409)
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'brand_kit_exists')
  })
})

/* --------------------------------------------------------------- generate */

test('generate answers 202 with a status URL and reaches no model', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mark' }),
    })
    assert.equal(res.status, 202)
    const body = (await res.json()) as { accepted: boolean; statusUrl: string; job: { status: string } }
    assert.equal(body.accepted, true)
    assert.match(body.statusUrl, /^\/v1\/jobs\//)
    assert.equal(res.headers.get('location'), body.statusUrl)
    assert.equal(body.job.status, 'queued')
    assert.match(h.metrics.render(), /studio_generations_requested_total\{kind="mark",backend_choice="auto"\} 1/)
  })
})

test('an unknown kind or backend is 400 before anything is reserved', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const badKind = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'sticker' }),
    })
    assert.equal(badKind.status, 400)

    const badBackend = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'mark', backend: 'midjourney' }),
    })
    assert.equal(badBackend.status, 400)
  })
})

test('a credit cap refusal is 402 and says that no image call was made', async () => {
  // Not 403 (which sends a user to check their permissions) and not 500 (which sends an engineer
  // to read logs). The cap decided; this is an answer, and the client's remedy is a bigger cap.
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  const refuseWith = new CreditCapError(
    { ownerSubject: SUBJECT, capUsdMicros: 1_000_000n, spentUsdMicros: 990_000n, reservedUsdMicros: 0n },
    60_000n,
  )
  await withServer({ refuseWith }, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mark' }),
    })
    assert.equal(res.status, 402)
    const body = (await res.json()) as { error: Record<string, unknown> }
    assert.equal(body.error['code'], 'credit_cap_exceeded')
    assert.equal(body.error['capUsd'], '$1.000')
    assert.equal(body.error['remainingUsd'], '$0.010')
    assert.equal(body.error['requestedUsd'], '$0.060')
    // The fact a caller most needs and cannot otherwise know: being refused cost them nothing.
    assert.equal(body.error['imageCallMade'], false)
    assert.equal(h.accepted.length, 0)
    assert.match(h.metrics.render(), /studio_generations_refused_total\{reason="credit_cap"\} 1/)
  })
})

test('the spec the route builds is the one the pipeline is handed', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'og', backend: 'placeholder' }),
    })
    const input = h.accepted[0]
    assert.deepEqual(input?.spec, { kind: 'og', width: 1200, height: 630, format: 'png' })
    assert.equal(input?.choice, 'placeholder')
    assert.equal(input?.kit.id, 'kit-1')
  })
})

/* --------------------------------------------------------------- reads */

test('GET /v1/jobs/:id returns the job and its complete provenance', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/jobs/job-1`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { job: Record<string, unknown>; provenance: Record<string, unknown> }

    assert.equal(body.job['backend'], 'flux')
    assert.equal(body.job['model'], 'FLUX.2-pro')
    // Money crosses the wire as a decimal string, never a JSON number.
    assert.equal(body.job['costActualUsdMicros'], '60000')

    for (const field of ['backend', 'model', 'prompt', 'spec', 'attempts', 'checksum', 'requestedSize']) {
      assert.ok(body.provenance[field] !== undefined, `provenance.${field} is missing`)
    }
  })
})

test('GET /v1/assets/:id returns the asset and the provenance of the job that made it', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/assets/asset-1`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { asset: Asset; provenance: Record<string, unknown> }
    assert.equal(body.asset.checksum, 'sha256:abc')
    assert.equal(body.asset.sizing, 'exact')
    assert.equal(body.asset.c2pa, true, 'a disclosure fact, carried on the asset')
    assert.equal(body.provenance['generationJobId'], JOB.id)
  })
})

test('an unknown job or asset is 404', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const headers = { authorization: `Bearer ${token}` }
    assert.equal((await fetch(`${h.url}/v1/jobs/nope`, { headers })).status, 404)
    assert.equal((await fetch(`${h.url}/v1/assets/nope`, { headers })).status, 404)
  })
})

/* --------------------------------------------------------------- plumbing */

test('a malformed body is 400 rather than 500', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(res.status, 400)
  })
})

test('a request id is propagated when safe and replaced when it is not', async () => {
  await withServer({}, async (h) => {
    const propagated = await fetch(`${h.url}/livez`, { headers: { 'x-request-id': 'abc-123_XYZ' } })
    assert.equal(propagated.headers.get('x-request-id'), 'abc-123_XYZ')

    // An unvalidated inbound id is a header-injection and a log-forgery primitive at once.
    const hostile = await fetch(`${h.url}/livez`, { headers: { 'x-request-id': 'a b"c' } })
    assert.notEqual(hostile.headers.get('x-request-id'), 'a b"c')
  })
})

test('a path parameter cannot swallow the rest of the path', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    // `/v1/jobs/a/b` must not match `/v1/jobs/:id` with id="a/b".
    const res = await fetch(`${h.url}/v1/jobs/a/b`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 404)
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /no route for/)
  })
})

test('an unknown path is 404 and does not mint a metric series of its own', async () => {
  await withServer({}, async (h) => {
    await fetch(`${h.url}/v1/nothing-here`)
    const rendered = h.metrics.render()
    // Any caller could otherwise mint unbounded time series and take the scrape target down.
    assert.match(rendered, /route="unmatched"/)
    assert.equal(/nothing-here/.test(rendered), false)
  })
})

test('metrics render as valid Prometheus exposition', async () => {
  await withServer({}, async (h) => {
    await fetch(`${h.url}/livez`)
    const res = await fetch(`${h.url}/metrics`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/)

    const comment = /^# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .+$/
    const sample =
      /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="[^"]*"(,[a-zA-Z_][a-zA-Z0-9_]*="[^"]*")*\})? -?(\d+(\.\d+)?([eE][-+]?\d+)?|\+Inf|NaN)$/
    for (const line of (await res.text()).split('\n').filter((l) => l.length > 0)) {
      assert.ok(comment.test(line) || sample.test(line), `not valid exposition: ${line}`)
    }
  })
})

test('health answers are never cached', async () => {
  await withServer({}, async (h) => {
    assert.equal((await fetch(`${h.url}/readyz`)).headers.get('cache-control'), 'no-store')
    assert.equal((await fetch(`${h.url}/v1/backend`)).headers.get('cache-control'), 'no-store')
  })
})

test('a drain reports unready and refuses to claim jobs before the socket closes', async () => {
  await withServer({}, async (h) => {
    assert.equal(h.lifecycle.claimingJobs, true)
    const drained = h.lifecycle.shutdown('SIGTERM')

    assert.equal((await fetch(`${h.url}/readyz`)).status, 503)
    assert.equal(h.lifecycle.claimingJobs, false)
    assert.equal((await fetch(`${h.url}/livez`)).status, 200, 'a draining process is still alive')

    await drained
  })
})

test('the write scope is required to generate', async () => {
  const reader = await sign({ sub: 'service:hub-api', scopes: [READ_SCOPE] })
  const writer = await sign({ sub: 'service:hub-api', scopes: [WRITE_SCOPE] })
  await withServer({}, async (h) => {
    const body = JSON.stringify({ kind: 'mark' })
    const refused = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reader}`, 'content-type': 'application/json' },
      body,
    })
    assert.equal(refused.status, 403)

    const allowed = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writer}`, 'content-type': 'application/json' },
      body,
    })
    assert.equal(allowed.status, 202)
  })
})
