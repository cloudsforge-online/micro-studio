# `studio` — asset generation

[![ci](https://github.com/cloudsforge-online/micro-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-studio/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml)

<!-- absorbed-banner -->
> ## ⚠️ This code no longer deploys as a service. It runs inside `micro-agora`.
>
> Absorbed in wave **M5a**, release **2026.8.104** (2026-08-29) of the estate's service-merge sequence.
>
> **The canonical source is [`micro-agora`](https://github.com/cloudsforge-online/micro-agora)
> at [`src/studio/`](https://github.com/cloudsforge-online/micro-agora/tree/main/src/studio).
> Edit there.** What is in this repository is the copy the merge was made from: it is frozen, no
> image is published from it, `cfctl bump` skips it, and nothing in the estate runs it.
>
> **Why the repository still exists.** Its registry row survives as `absorbed(…)`, which is what
> keeps the Kubernetes `Service` of this name resolving — an `ExternalName` alias to `agora`, so
> every caller that addresses it by service name still reaches the code. `deployableRepos()` keeps
> the row and `releasableRepos()` drops it. The history here is also the history of the module.
>
> **What did not change**, and this is the point of the merge rather than an aside: the database is
> still its own, the routes are unchanged except where a collision forced a remount, the migrations
> still run under this module's name, and the trust boundary is unchanged. A merge moved a process
> boundary, not a responsibility.
>
> Everything below describes the domain, and remains accurate. Read the reasoning — including what
> was refused and why — in
> [`micro-deploy/docs/service-merge-plan.md`](https://github.com/cloudsforge-online/micro-deploy/blob/main/docs/service-merge-plan.md).

The engine behind Forge Create's brand track: brand kits, asset specs, leased generation jobs, and
assets whose provenance is complete. It productises the `asset-forge` CLI, and every design
decision below is traceable to something that CLI cannot do as a service.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

| `asset-forge` today | `studio` |
| --- | --- |
| Writes PNGs into sibling working trees with **no record** of the model, prompt, spec or cost | Every asset points at the `generation_jobs` row that made it, `on delete restrict` |
| Spend control is a `$2` default and a **TTY prompt**, per run, per process | A per-account cap enforced by a conditional UPDATE **before** the call, backed by a CHECK constraint |
| Resizes by shelling out to macOS **`sips`**, so the pipeline cannot run in CI | Pure-TypeScript measurement; exact sizes requested; a mismatch recorded as `unsized`, never relabelled |
| Accent `#ff4d00` hardcoded in `BRAND_STYLE` | Accent is a `brand_kits` column; the prompt is derived from the kit |
| A failure prints `asset-forge failed:` and a sentence | A typed `error_code` on the row, and a `reason` an operator can act on |

## Run it

```sh
pnpm install
pnpm migrate          # the one-shot migrator, a separate process — never the service
pnpm start
pnpm check            # typecheck + tests
```

**Set `STUDIO_ASSET_ROOT` in any container deploy.** The default `./out` is right on a laptop and
wrong in the image, where it resolves to a root-owned `/app/out` under `USER node`. The service now
refuses to start on a root it cannot write to, and `/readyz` answers 503 if the root becomes
unwritable later — both proved by writing a file and removing it, never by `fs.access`. See
`.env.example`.

DB tests skip without `STUDIO_TEST_DATABASE_URL` (the name must contain `test`; they truncate).
The suite runs `--test-concurrency=1` because those tests truncate and `node:test` runs files in
parallel by default.

## Routes

| | |
| --- | --- |
| `GET /livez` `GET /readyz` `GET /metrics` | Rule 4. Liveness is static; readiness runs the probes |
| | `postgres` and `asset-root` are **hard** (503); `identity-jwks` and `image-backend` are soft (200 + `degraded`) |
| `GET /v1/backend` | What it can generate with, and whether it can. Unauthenticated |
| `POST /v1/brand-kits` · `GET /v1/brand-kits/:id` | |
| `GET /v1/brand-kits` | The caller's own kits, newest first. `?limit=` is 1–200 and defaults to 50; a service token names the user it acts for with `?userId=` |
| | **A repeated bootstrap has no id to fetch by.** `deploy/scripts/seed/images.mjs` lists and matches on name to stay idempotent, because `estate-seed.mjs` re-runs several times an hour. Without this route the only way to be idempotent was to remember an id in a file outside the service — a second source of truth about what exists |
| `POST /v1/brand-kits/:id/generate` | **202 + a job.** Reaches no model |
| `GET /v1/brand-kits/:id/assets` | That kit's assets, newest first, each already carrying its `bytesUrl`. Same `?limit=`. Ownership is decided by the **kit**, through the same helper every other kit route uses, so naming somebody else's kit is the same 404 as naming one that does not exist |
| | The other half of the idempotent bootstrap, and the constraint is money: **a FLUX asset already in the tree is never regenerated.** A seeding run that could not see the existing one would buy a second image on every pass, and a different image for the same content each time |
| `GET /v1/jobs/:id` · `GET /v1/assets/:id` | The job, the asset, and the full provenance |
| `GET /v1/assets/:id/bytes` | The bytes, served at the media type on the **row** — which was written from the sniffed format, never from anything a caller sent. `nosniff`, a `default-src 'none'` CSP, `Content-Disposition: inline` with no filename, an `ETag` of the content address, and `Cross-Origin-Resource-Policy: cross-origin` because `market-web` and `foresight-web` embed these from other origins. Caching is `immutable`, and `public` only when the asset is — a `private` asset must not sit in a CDN handing one user's image to the next request for the same URL |
| | **A `public` asset is served with no token. Everything else still needs one.** That ordering — fetch the asset, then decide the auth — is the only thing that makes an `<img src>` work, since a browser sends no bearer token on one. It also means an unknown id and a private id are **both 401** without a token and **both 404** with one. **Never 403**, at any point: a 403 here would tell an anonymous stranger which asset ids exist |
| `POST /v1/assets/:id/visibility` | `{"visibility":"private"}` or `{"visibility":"public"}` — those two states and nothing else. An unrecognised value is a **400, never a silent default to private**, because downgrading a caller who meant to publish produces a broken image they cannot explain. `studio:write`, owner only, and it emits `studio.asset.visibility_changed` in the same transaction as the update |
| `POST /v1/uploads` | **The body IS the image: raw bytes, never `multipart/form-data`.** A `FormData` here arrives as a multipart envelope and is correctly refused as `unrecognised_format` — the least diagnosable failure this service can produce, because the user picked a real PNG and was told it is not an image. `Content-Type` is read and never consulted; `imagebytes.normalise` decides the format from magic bytes |
| | PNG, JPEG and WebP. **SVG is refused by name** (`upload_svg_refused`), because an SVG is a script document rather than a picture. At most **8 MiB, enforced while reading** rather than after buffering; edges 8–8192px; 40 MP overall, which is the bound a decompression bomb actually hits. EXIF and GPS are stripped *before* the checksum is taken, so no stored digest is the digest of somebody's coordinates |
| | `?visibility=` defaults to `private`; `?userId=` lets a service token store an upload against a named user. **201 for a new asset, 200 with `deduplicated: true` for bytes this owner already stored** — a client that retried after a timeout can tell which happened. The bound is **disk, not credits**: 200 uploads and 256 MB per owner per rolling day, then **429 with `Retry-After`**, because a free operation must not consume the cap that exists to bound the paid one |

---

# Making real generation work

**The image model is FLUX 2 Pro from Black Forest Labs, on Azure AI Foundry.** Not Azure OpenAI —
different route, different request body, different error vocabulary.

The resource this service is pointed at **already works**. If you are standing up a new one:

| | |
| --- | --- |
| **Resource type** | Azure AI Foundry (`*.services.ai.azure.com`), **not** Azure OpenAI (`*.openai.azure.com`) |
| **Region** | East US — the resource in use is `test01eastus01` |
| **Model** | `FLUX.2-pro`, from the Black Forest Labs partner catalogue in the Foundry model catalogue. Deploy it as a serverless / partner deployment |
| **Route** | `POST {endpoint}/providers/blackforestlabs/v1/flux-2-pro` |
| **Auth** | `api-key: <resource key>` (`Authorization: Bearer <key>` also works) |
| **Config** | `AZURE_FOUNDRY_ENDPOINT`, `AZURE_FOUNDRY_API_KEY`, `AZURE_FOUNDRY_IMAGE_PATH`, `STUDIO_IMAGE_MODEL` |

Everything below was **verified by a real request**, and each item contradicts something the API's
own shape implies. They are in `src/backend.ts` with the same warnings.

### 1. `model` is required in the request BODY

Even though the URL path already names the model. Omitting it:

```
400 {"error":{"code":"no_model_name","message":"Could not find a reference to a model …"}}
```

It reads like duplication, which is exactly why somebody will delete it. `bodyFor()` is the only
place a request body is built, and CI greps for the field.

### 2. The model name uses DOTS. The path segment uses HYPHENS

`FLUX.2-pro` is the model. `flux-2-pro` is the path. They are different strings:

```
{"model":"flux-2-pro"}  →  404 {"error":{"code":"DeploymentNotFound", …}}
```

A 404 here therefore looks identical to "nobody deployed the model", so `GET /v1/backend` names the
spelling **first** in its reason.

### 3. `aspect_ratio` and `size` are accepted and silently IGNORED. Use `width`/`height`

Probed: `aspect_ratio` of `1:1`, `8:3`, `21:9` and `40:21` all returned **1024x1024**, and
`size:"1024x384"` returned **1024x1024**. Only `width`/`height` are honoured. A parameter that is
accepted and ignored is worse than one that is rejected, because nothing fails.

### 4. Delivered dimensions floor to a multiple of 16

| Requested | Delivered |
| --- | --- |
| `1024x1024`, `1024x384`, `1280x640`, `256x256` | exact |
| `1200x630` | **`1200x624`** |
| `1200x632` | **`1200x624`** |

This matters for exactly one spec: an Open Graph card **must** be 1200x630 or scrapers reject it,
and 630 is not a multiple of 16. So `requestSizeFor()` rounds **up** — 1200x640 is asked for and
delivered — because an image larger than the spec can be cropped without inventing a pixel, and one
smaller can only be upscaled. The asset then records `sizing = 'unsized'` with **both** numbers.
Every other declared size is already on the grid; `sizing.test.ts` fails if that stops being true.

### 5. `output_format:"png"` is required

Without it the response is JPEG, which has no transparency and rings on flat vector edges.

### 6. Every image carries C2PA provenance and a Microsoft invisible watermark

About 100KB of it. That is a licensing and disclosure fact, so it is a column (`assets.c2pa`), read
from the delivered bytes rather than assumed, and the recorded licence names it.

### Fallback

`STUDIO_IMAGE_FALLBACK_MODEL` is **empty by default**, because only `FLUX.2-pro` is deployed on this
resource: `FLUX.1.5-pro`, `FLUX.1-pro`, `FLUX-1.1-pro`, `FLUX.1.1-pro`, `FLUX.1-Kontext-pro`,
`FLUX.2-flex` and `FLUX.2-dev` were all probed and all seven answer 404. It is configuration rather
than a hardcoded pair so that adopting a second model is an environment change, not a release.

**The chain falls back on 404, 429, 5xx and transport faults. Never on 400.** A prompt the safety
filter refused fails identically on the fallback model, so retrying spends the fallback's quota to
produce the same refusal — `asset-forge` deleted its own fallback chain over exactly this
(`model.ts`). 401 and 403 do not fall back either: authentication is a property of the
resource, not of the model.

### Costs

The response carries `request_meta.cost` in provider units. This paragraph used to call it **"a
flat `3` per image at every size probed, from 256² to 1200x630"**, and the qualifier turned out to
be doing all the work: **every one of those probes was under a megapixel.** Generating the wallet
asset set went above that and found the cost is **flat 3.0 only up to roughly 1 MP, and rises to
7.5 beyond it** — measured across 152 calls totalling 513.0 units.

So it is size-dependent, and a caller planning a large set should budget accordingly rather than
multiplying by three. The provider publishes no dollar exchange rate on this surface. The
credit reservation uses `STUDIO_IMAGE_PRICE_USD` (configuration, correctable) and the provider's own
figure is stored verbatim beside it in `generation_jobs.provider_cost_units`. A dollar rate
hardcoded in this repository would be a guess nobody could correct.

---

## Degraded is not broken

With no usable model the service still creates brand kits, reads them, serves its own health, and
generates through the placeholder backend. The image backend is a **soft** readiness probe, so
`/readyz` answers **200 with `state: "degraded"`** and the replica stays in the load balancer. A hard
probe would turn a missing model into an outage of everything else.

```
$ curl -s localhost:4015/readyz | jq '.ready, .state'
true
"degraded"

$ curl -s localhost:4015/v1/backend | jq -r .reason
no configured model is deployed on test01eastus01.services.ai.azure.com (FLUX.1.5-pro: not_found
404). Check the spelling first: the model name uses dots — FLUX.2-pro — and is NOT the hyphenated
path segment flux-2-pro, which returns DeploymentNotFound. Otherwise deploy the model in the
Foundry resource.
```

A generation in that state fails with a typed `no_backend_available`, and the credit hold is
**released** — a 404 costs nothing, so it must charge nothing.

## Selecting a backend

`POST /v1/brand-kits/:id/generate` takes `backend`: `auto` (default), `flux` or `placeholder`.

* `auto` — FLUX, then the placeholder. The fall-through is never silent: the asset records
  `backend = 'placeholder'` and every failed attempt on the way there is stored on the job.
* `flux` — a caller who must have real art gets a typed error, never an SVG.
* `placeholder` — deterministic labelled SVG, reserves nothing.

**The choice is a column, not a parameter.** The request and the generation are on opposite sides of
a job lease; holding the choice in a local variable meant a job requested as `placeholder` — and
therefore reserving nothing — ran on FLUX and spent real money outside the cap. That was a live bug,
found by running the service, and `generation_jobs_free_choice_costs_nothing` now makes it
unrepresentable.

## Live tests

Three tests probe the real endpoint and **skip** unless `STUDIO_LIVE_FLUX=1`. They cost money, so CI
never runs them.

```sh
set -a && . ./.env.local && set +a && STUDIO_LIVE_FLUX=1 pnpm test
```

They assert PNG magic bytes, exact dimensions, C2PA presence, and that the hyphenated spelling
really is a 404 — so if the vendor ever fixes that, the warning can be retired rather than repeated
for ever.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
