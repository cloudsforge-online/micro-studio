/**
 * `asset` — storage reference, checksum, licence, dimensions, and the job that made it.
 *
 * 04-domain-model.md §5.1 states the invariant this file exists to hold:
 *
 *   > Every generated asset records the model, prompt, spec and cost that produced it, so a brand
 *   > kit is reproducible and a spend is attributable. Today `asset-forge` writes PNGs into
 *   > sibling working trees with no record of any of this.
 *
 * The record lives on `generation_jobs`; the asset points at it with `on delete restrict`, so the
 * evidence cannot be deleted out from under the artefact.
 *
 * ## Where the bytes go
 *
 * `AssetBlobStore` is a two-method port. The filesystem implementation below writes under
 * `STUDIO_ASSET_ROOT` and returns a URL. It is a directory rather than an object store because
 * the estate has no object-store service yet; when one exists, one implementation of this
 * interface replaces it and nothing else in the service changes.
 *
 * The path is derived from the **checksum**, not from the asset id or the kit name. Content
 * addressing means writing is idempotent — a retried job that regenerates identical bytes writes
 * the same path rather than a second file — and it means the stored path is itself a claim that
 * can be checked. `asset-forge` writes `${id}.png` into six sibling working trees, so the same
 * name means different bytes in different repositories and nothing detects it.
 */

import { createHash } from 'node:crypto'
import { mkdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Probe, ProbeResult } from '@cloudsforge/lifecycle'
import type { Db, Tx } from './outbox.ts'
import type { AssetFormat, AssetKind } from './specs.ts'
import type { Sizing } from './sizing.ts'

/**
 * The licence recorded on every generated asset.
 *
 * A constant rather than a free-text field: an asset whose licence is whatever the caller typed
 * is an asset nobody can clear for use. FLUX output on Azure Foundry is licensed to the customer
 * for commercial use, and it carries C2PA provenance and an invisible watermark, so the string
 * names the generator as well as the grant.
 */
export const GENERATED_LICENCE = 'cloudsforge-generated: commercial use permitted; AI-generated, C2PA provenance retained'

export interface Asset {
  readonly id: string
  readonly brandKitId: string
  readonly generationJobId: string
  readonly kind: AssetKind
  readonly format: AssetFormat
  readonly declaredWidth: number
  readonly declaredHeight: number
  readonly actualWidth: number | null
  readonly actualHeight: number | null
  readonly sizing: Sizing
  readonly storageUrl: string
  readonly checksum: string
  readonly byteSize: number
  readonly licence: string
  readonly c2pa: boolean
  readonly createdAt: string
}

/* ------------------------------------------------------------------------ blob store */

export interface StoredBlob {
  readonly storageUrl: string
  readonly checksum: string
  readonly byteSize: number
}

export interface AssetBlobStore {
  put(bytes: Buffer, format: AssetFormat): Promise<StoredBlob>
}

/** `sha256:<hex>`. Prefixed so the algorithm travels with the digest and can be changed later. */
export function checksumOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Write under a root directory, content-addressed.
 *
 * `ab/cdef…png` — the first byte of the digest as a directory, so a kit with ten thousand assets
 * does not put ten thousand entries in one directory, which several filesystems handle badly.
 */
export function filesystemBlobStore(root: string, baseUrl: string): AssetBlobStore {
  const absoluteRoot = resolve(root)
  return {
    async put(bytes, format) {
      const checksum = checksumOf(bytes)
      const hex = checksum.slice('sha256:'.length)
      const relative = join(hex.slice(0, 2), `${hex}.${format}`)
      const path = join(absoluteRoot, relative)
      await mkdir(dirname(path), { recursive: true })
      // Unconditional write. Content-addressed, so rewriting is writing the same bytes; checking
      // first would be a race with no benefit.
      await writeFile(path, bytes)
      return {
        // A configured base URL wins, so pointing a CDN at the same directory is configuration
        // rather than a migration of every stored row.
        storageUrl: baseUrl
          ? `${baseUrl}/${relative.split('\\').join('/')}`
          : pathToFileURL(path).href,
        checksum,
        byteSize: bytes.length,
      }
    },
  }
}

/* --------------------------------------------------------------- is the root writable? */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ROOT IS PROVEN BY WRITING TO IT. IT IS NEVER ASKED.**
 *
 * This exists because of a live incident, not a hypothesis. `STUDIO_ASSET_ROOT` was unset in the
 * deploy, so `env.ts` fell back to `./out`, which resolved to a root-owned `/app/out` inside an
 * image whose last instruction is `USER node` (uid 1000). Every generation of every kind died with
 * `EACCES` in `put()` above — and the container reported `healthy`, `/readyz` answered **200**, and
 * the balancer kept feeding it, because nothing between the mount and the write had an opinion.
 *
 * **`fs.access(root, W_OK)` IS NOT THE CHECK, AND THIS IS MEASURED, NOT ASSERTED.** Substituting
 * `access` for the body below and running the suite fails three cases, for two distinct reasons:
 *
 *   * A root that is a regular FILE passes `access(W_OK)` — the file is writable — and the service
 *     boots and listens. The store then needs a DIRECTORY there and cannot have one.
 *   * A root that does not exist yet fails `access` with ENOENT, so a correct deploy with a fresh
 *     empty volume is refused. `mkdir --recursive` creates it, which is what `put()` does too.
 *
 * `access` also cannot see a full disk, and it reports a permission rather than the filesystem's
 * willingness to honour it — the class this estate has already been burned by, where an earlier
 * fix for this same defect passed on Docker Desktop and would have failed on Linux, because
 * virtiofs maps ownership and a fresh named volume's mount point is created `root:root`. The only
 * question whose answer cannot be stale is "did the write succeed".
 *
 * So: `mkdir`, `writeFile`, `unlink`, `rmdir` — the two calls `filesystemBlobStore.put()` makes on
 * the hot path, in that order, and then the two that undo them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * A dot-directory created and removed on EVERY check, mirroring the `ab/` shard `put()` creates.
 *
 * **It is torn down rather than kept, and that is not tidiness.** A first draft of this created the
 * directory once and wrote into it thereafter, and a test caught what that misses: removing write
 * permission from the ROOT does not stop a write into a subdirectory that already exists and is
 * still writable. The store does not have that luxury — a checksum starting `cd` needs a `cd/`
 * that has never existed, so `put()` creates a directory directly under the root on the hot path.
 * Creating and removing one here is what makes this check need the same permission the store does,
 * every time it runs, rather than only the first time.
 *
 * Named for the process, so two replicas sharing one root cannot remove each other's directory and
 * read the resulting ENOENT as a failure of the root. A process that dies mid-check leaves one
 * empty dot-directory, which its own next check reuses and removes.
 */
const WRITE_CHECK_DIR = `.studio-write-check-${process.pid}`

const WRITE_CHECK_FILE = 'writable'

/** Bytes, not an empty file: a zero-length write is not a write on every filesystem. */
const WRITE_CHECK_BYTES = Buffer.from('studio asset root write check\n')

/**
 * Write to the asset root and remove what was written. Throws whatever the filesystem threw.
 *
 * `mkdir` the shard and `writeFile` into it — `put()`'s two calls, in `put()`'s order — then undo
 * both. Nothing that could fail is skipped.
 *
 * Used twice, deliberately: once at boot, so an unwritable root is a container that refuses to
 * start rather than one that serves 500s, and once per readiness scrape, for a root that is fine
 * at boot and goes read-only, full or unmounted at 03:00.
 */
export async function checkAssetRoot(root: string): Promise<void> {
  const directory = join(resolve(root), WRITE_CHECK_DIR)
  const path = join(directory, WRITE_CHECK_FILE)
  // `recursive` creates the root itself when the deploy has not, which is the ordinary case for a
  // fresh volume — and fails here, loudly, when the root's own parent refuses it.
  await mkdir(directory, { recursive: true })
  await writeFile(path, WRITE_CHECK_BYTES)
  await unlink(path)
  await rmdir(directory)
}

/**
 * One sentence an operator can act on, from an errno most people read as "something went wrong".
 *
 * The EACCES wording names the cause that actually produced the incident, because the errno alone
 * sends people to `chmod` on a path that is correct and owned by somebody else.
 */
export function describeAssetRootFailure(root: string, err: unknown): string {
  const absolute = resolve(root)
  const code = typeof (err as NodeJS.ErrnoException)?.code === 'string' ? (err as NodeJS.ErrnoException).code : ''
  const who = typeof process.getuid === 'function' ? `uid ${process.getuid()}` : 'this process'
  if (code === 'EACCES' || code === 'EPERM') {
    return (
      `${absolute} is not writable by ${who}, so EVERY generation of every kind would fail with ` +
      `${code} — set STUDIO_ASSET_ROOT to a directory the deploy has made writable, and chown the ` +
      `mount point: a fresh named volume is created root:root and this image runs as node (uid 1000)`
    )
  }
  if (code === 'ENOSPC') {
    return `${absolute} has no space left, so every generation would fail with ENOSPC`
  }
  if (code === 'EROFS') {
    return `${absolute} is on a read-only filesystem, so every generation would fail with EROFS`
  }
  if (code === 'ENOTDIR') {
    return `${absolute} is not a directory — STUDIO_ASSET_ROOT names a file or a path through one`
  }
  return `${absolute} could not be written: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * The readiness probe. **`hard`**, and the choice is the entire value of this file.
 *
 * `soft` would have been the shape of the fix rather than the fix: a soft failure appears in the
 * `/readyz` BODY, sets `state: "degraded"` — and still answers **200**, so the replica stays in the
 * balancer and keeps accepting generations it cannot complete. That is the same bug wearing a
 * fix's clothes, and it is why this probe does not match `imageBackendProbe`, which sits beside it
 * and is soft for a reason that does not apply here. A missing FLUX model degrades honestly: brand
 * kits, reads and placeholder generation all still work. An unwritable root fails every generation
 * of every kind, through every backend, including the placeholder — there is nothing left to
 * degrade to.
 *
 * A filesystem call that hangs — a wedged NFS mount — is not special-cased here. `Lifecycle`
 * already races every probe against `probeTimeoutMs` and reports the timeout as `fail`, and this
 * probe is hard, so a hang lands on 503 the same as a refusal does.
 */
export function assetRootProbe(root: string): Probe {
  return {
    name: 'asset-root',
    kind: 'hard',
    async check(): Promise<ProbeResult> {
      try {
        await checkAssetRoot(root)
        return { state: 'pass', detail: `${resolve(root)} is writable` }
      } catch (err) {
        return { state: 'fail', detail: describeAssetRootFailure(root, err) }
      }
    },
  }
}

/* ------------------------------------------------------------------------ store */

interface AssetRow {
  readonly id: string
  readonly brand_kit_id: string
  readonly generation_job_id: string
  readonly kind: string
  readonly format: string
  readonly declared_width: number
  readonly declared_height: number
  readonly actual_width: number | null
  readonly actual_height: number | null
  readonly sizing: string
  readonly storage_url: string
  readonly checksum: string
  readonly byte_size: string
  readonly licence: string
  readonly c2pa: boolean
  readonly created_at: Date
}

const toAsset = (row: AssetRow): Asset => ({
  id: row.id,
  brandKitId: row.brand_kit_id,
  generationJobId: row.generation_job_id,
  kind: row.kind as AssetKind,
  format: row.format as AssetFormat,
  declaredWidth: row.declared_width,
  declaredHeight: row.declared_height,
  actualWidth: row.actual_width,
  actualHeight: row.actual_height,
  sizing: row.sizing as Sizing,
  storageUrl: row.storage_url,
  checksum: row.checksum,
  byteSize: Number(row.byte_size),
  licence: row.licence,
  c2pa: row.c2pa,
  createdAt: row.created_at.toISOString(),
})

const COLUMNS = `id, brand_kit_id, generation_job_id, kind, format, declared_width, declared_height,
                 actual_width, actual_height, sizing, storage_url, checksum, byte_size, licence,
                 c2pa, created_at`

export interface InsertAsset {
  readonly brandKitId: string
  readonly generationJobId: string
  readonly kind: AssetKind
  readonly format: AssetFormat
  readonly declaredWidth: number
  readonly declaredHeight: number
  readonly actualWidth: number | null
  readonly actualHeight: number | null
  readonly sizing: Sizing
  readonly storageUrl: string
  readonly checksum: string
  readonly byteSize: number
  readonly c2pa: boolean
}

export async function insertAsset(sql: Db | Tx, input: InsertAsset): Promise<Asset> {
  const rows = await sql<AssetRow[]>`
    insert into assets (
      brand_kit_id, generation_job_id, kind, format, declared_width, declared_height,
      actual_width, actual_height, sizing, storage_url, checksum, byte_size, licence, c2pa
    ) values (
      ${input.brandKitId}, ${input.generationJobId}, ${input.kind}, ${input.format},
      ${input.declaredWidth}, ${input.declaredHeight},
      ${input.actualWidth}, ${input.actualHeight}, ${input.sizing},
      ${input.storageUrl}, ${input.checksum}, ${input.byteSize.toString()}::bigint,
      ${GENERATED_LICENCE}, ${input.c2pa}
    )
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('asset insert returned no row')
  return toAsset(row)
}

export async function findAsset(sql: Db, id: string): Promise<Asset | null> {
  const rows = await sql<AssetRow[]>`select ${sql.unsafe(COLUMNS)} from assets where id = ${id}`
  const row = rows[0]
  return row ? toAsset(row) : null
}

export async function listAssetsForKit(sql: Db, brandKitId: string, limit: number): Promise<Asset[]> {
  const rows = await sql<AssetRow[]>`
    select ${sql.unsafe(COLUMNS)}
      from assets
     where brand_kit_id = ${brandKitId}
     order by created_at desc
     limit ${limit}
  `
  return rows.map(toAsset)
}
