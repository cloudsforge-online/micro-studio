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

/**
 * The art direction for a world object, which is NOT the brand brief.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `brandStyle()` above says "Brand mark for a software company … flat geometric vector … legible
 * at 16 pixels". Run a stool through it and a stool is not what comes back: a LOGO of a stool
 * comes back, and it comes back looking deliberate, so nothing downstream can tell. There is no
 * assertion anywhere in this service that reads a prompt for meaning, so this would have been
 * wrong quietly and for ever — the same shape as the copybot guard that stayed green when its
 * index was dropped.
 *
 * So `world_object` takes its own paragraph, and every clause in it is doing work
 * (23-tessera.md §1.1, §2.1, §2.6):
 *
 *   * **painterly gouache, no outlines, no bevels, no gloss** — §1.1's measured argument. A
 *     hand-painted world is SUPPOSED to vary from tile to tile; a flat-vector world is not, and
 *     two vector chairs disagreeing by three pixels read as a bug rather than as a brushstroke.
 *   * **three-quarter isometric from above-left, 2:1 dimetric** — the projection is the world's,
 *     not the maker's. It is what makes one player's chair sit in the same room as another's.
 *   * **standing alone on a flat #12100f ground** — diffusion emits no alpha, so transparency is a
 *     derive step keyed against a KNOWN colour (`brand/normalise_ground.py:27`). A generation on
 *     any other ground cannot be cut out.
 *   * **one canonical facing** — the second is a horizontal mirror at render time, because this
 *     service has no `seed` column and a pipeline that cannot fix a seed cannot render the same
 *     chair four times (§2.1). Asking for four facings would produce four different chairs.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const WORLD_OBJECT_STYLE =
  'A single object in a persistent isometric world, painted rather than modelled. Painterly ' +
  'gouache with visible brush economy, warm ash-and-ember key light from the upper left against ' +
  'cool shadow. Three-quarter isometric view from above-left, 2:1 dimetric projection, one ' +
  'canonical facing. The object stands alone on a flat ' +
  `${BRAND_GROUND} ground with nothing else in frame: no background, no scene, no second object, ` +
  'no cast shadow leaving the frame. No outline, no bevel, no gloss, no 3D render, no ' +
  'photo-realism, no user-interface framing.'

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
  world_object:
    'One object, whole and unoccluded, occupying the middle of the square with clear ground all round it so the cutout step has an edge to key against. Its footprint sits on one ground tile; the space above it is headroom, so a tall object may use it and a low object may leave it empty.',
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
  // The style paragraph is chosen BY KIND, not by kit. Every kind but one is a brand artefact and
  // takes `brandStyle(accent)`; `world_object` is a thing in somebody's world and takes the
  // world's brief. The accent is not interpolated into it at all — a world object wears no
  // product colour, because it is not chrome. See WORLD_OBJECT_STYLE.
  const style =
    input.spec.kind === 'world_object' ? WORLD_OBJECT_STYLE : brandStyle(input.accent)
  // A world object's subject is the whole point of the request, so it is never allowed to fall
  // back to the kit's name the way a mark may: a firing with no description would otherwise
  // silently generate "a Tessera", which is not an object anybody asked for.
  //
  // `server.ts` refuses this with a **400** first — search it for `world_object`. That comes
  // second in the source and first in the call order, and this comment used to assert it while it
  // did not exist, which made the route 500 on any kit with an empty `stylePrompt`. This throw is
  // the second, structural refusal: it stands in front of every OTHER caller of `buildPrompt`,
  // and a caller that reaches it has already got past a guard, so 500 is the right answer there.
  if (input.spec.kind === 'world_object' && input.stylePrompt.trim().length === 0) {
    throw new Error('a world_object generation has no description to build a prompt from')
  }
  const parts = [
    style,
    COMPOSITION[input.spec.kind],
    input.stylePrompt.trim().length > 0
      ? input.spec.kind === 'world_object'
        ? `The object is: ${input.stylePrompt.trim()}`
        : `The one idea this mark is built around: ${input.stylePrompt.trim()}`
      : `Built around the name "${input.kitName}" and nothing else.`,
    LETTERED.has(input.spec.kind) ? lettering(input.kitName) : NO_TEXT,
  ]
  return parts.join('\n\n')
}
