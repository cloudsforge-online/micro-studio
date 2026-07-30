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
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
