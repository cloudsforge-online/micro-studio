/**
 * The prompt, derived from the brand kit rather than hand-written per asset.
 *
 * assets/design-system.md §7 states the brand style that generated art must match:
 *
 *   > flat geometric vector, warm ash ground `#12100f`, single accent from the registry, no
 *   > gradients, no photographic texture, no text in the mark.
 *
 * and names the defect this file exists to prevent: `asset-forge` bakes `#ff4d00` into
 * `BRAND_STYLE`, so every surface's mark is drawn in the site's accent rather than its own, and
 * Hearth's mark is generated in the *game* art style, which is why it does not visually match its
 * siblings. The fix stated there is "make the track derive from the registry rather than from a
 * hand-written spec" — here, the registry is the `brand_kit` row, and the accent is a column.
 *
 * ## The prompt is stored, not recomputed
 *
 * `buildPrompt` runs once, when the job is created, and the exact string is written to
 * `generation_jobs.prompt`. Recomputing it at read time would mean that editing this file changes
 * what a delivered asset claims to have been generated from — which is precisely the
 * irreproducibility 04-domain-model §5.1 calls out.
 */

import type { AssetKind, AssetSpec } from './specs.ts'

/** The one ground colour the whole system sits on. design-system.md §7, verbatim. */
export const BRAND_GROUND = '#12100f'

/** Lettering is allowed on exactly two kinds. Everywhere else it is a defect. */
const LETTERED: ReadonlySet<AssetKind> = new Set<AssetKind>(['wordmark', 'og', 'social', 'banner'])

const NO_TEXT = 'No text, no lettering, no numerals, no currency symbols, no watermark.'

function lettering(name: string): string {
  return (
    `Any lettering must read exactly "${name}" — that spelling, that capitalisation, nothing ` +
    'else. One clean geometric sans, medium weight, wide tracking. No tagline, no second line, ' +
    'no misspellings, no invented words.'
  )
}

/**
 * The shared art direction. The accent is the **only** thing that varies between kits; everything
 * else in this paragraph is what makes a set of marks read as one family rather than as six logos.
 */
export function brandStyle(accent: string): string {
  return (
    'Brand mark for a software company, drawn as one member of an existing family of marks. ' +
    'Flat geometric vector: every shape constructed from circles, squares and 45-degree chamfers ' +
    'on a single grid, one uniform stroke weight throughout, sharp corners left sharp, generous ' +
    `negative space, optically centred. High contrast against a warm ash ground (${BRAND_GROUND}) ` +
    `with exactly one accent colour — ${accent} — and no second hue anywhere. Flat fills only: ` +
    'no gradients, no photographic texture, no bevels, no drop shadows, no glow, no 3D, no ' +
    'photo-realism, no weathering, no illustration. Confident and minimal, and legible at 16 ' +
    'pixels. No stock-logo cliches, no swooshes.'
  )
}

/** What each kind is, in one sentence, so the composition differs even though the style does not. */
const COMPOSITION: Readonly<Record<AssetKind, string>> = Object.freeze({
  mark: 'The brand mark. One idea, executed cleanly, centred and symmetrical in a square field with even margins on all four sides.',
  wordmark:
    'A horizontal wordmark lockup: the brand mark on the left, then a clear gap of one mark-width, then the name set as text, its baseline optically aligned to the centre of the mark. Wide empty field, the lockup occupying the middle third.',
  favicon:
    'A favicon source. Drawn heavier and simpler than the full mark — thicker strokes, fewer parts, larger counters — so it survives being resampled to 32 and 16 pixels. Fills the square edge to edge with only a hairline margin.',
  og: 'An Open Graph card. Wide composition: the brand mark in the left third at roughly a third of the card height, the right two thirds left deliberately empty apart from the name. Nothing near the outer edges; social platforms crop them.',
  social:
    'A repository social preview banner. The brand mark on the left, the name beside it, generous empty space to the right. A banner, not a poster: no scene, no illustration, no background pattern. The platform rounds the corners and darkens the edges, so keep everything well inboard.',
  banner:
    'A wide page banner. The mark held small in one third of the frame and the rest deliberately empty, so overlaid text has somewhere to sit.',
  icon: 'A single interface icon on a flat field, centred, drawn at one weight with no detail that dies below 32 pixels.',
  tile: 'A seamless square tile: the motif repeated on a regular grid so opposite edges meet without a seam.',
})

export interface PromptInput {
  readonly kitName: string
  readonly accent: string
  /** Free text from the kit — the one idea the mark is built around. May be empty. */
  readonly stylePrompt: string
  readonly spec: AssetSpec
}

/**
 * Build the full prompt for one asset.
 *
 * Order matters: style first, composition second, the kit's own idea third, prohibitions last.
 * A prohibition placed before the subject is routinely ignored by image models, which is how
 * "no text" produces a mark with a word in it.
 */
export function buildPrompt(input: PromptInput): string {
  const parts = [
    brandStyle(input.accent),
    COMPOSITION[input.spec.kind],
    input.stylePrompt.trim().length > 0
      ? `The one idea this mark is built around: ${input.stylePrompt.trim()}`
      : `Built around the name "${input.kitName}" and nothing else.`,
    LETTERED.has(input.spec.kind) ? lettering(input.kitName) : NO_TEXT,
  ]
  return parts.join('\n\n')
}
