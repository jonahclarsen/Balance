# balance.jonah.art

The Balance website and docs: static pages in `public/`, served by a small
Cloudflare Worker (`worker.js`). `jonah.art/balance` redirects here through the
jonah.art site's redirect settings.

- `/` landing page, `/docs/` user docs.
- `/download/mac`, `/download/android`, `/download/linux` redirect to the newest
  GitHub release that carries that platform's build. Nightly releases carry
  the notarized Mac app and the Android APK; only `-all` tags add Linux, so the
  Linux link can point at an older release.
- `/api/builds` lists those builds; the landing page shows the version from it.
- `/admin` picks the font for each role (headings, hero, wordmark, body, nav and
  buttons, code) with a live preview. Settings live in the `SETTINGS` KV
  namespace; the Worker injects them into every page and serves the chosen
  Google Fonts first-party under `/fonts/`. Roles and the catalog are in
  `public/admin/fonts.js`, and the matching CSS variables are in `site.css`.

## Admin login

`/admin` is behind the "Jonah Art Admin" Cloudflare Access application, the same
one that protects `jonah.art/admin`, so one sign-in covers both. The Worker
re-verifies the Access token against `ACCESS_ISSUER`, `ACCESS_AUD` and the
`ADMIN_EMAIL` secret (`pnpm dlx wrangler@4 secret put ADMIN_EMAIL --config
website/wrangler.jsonc`).

## Screenshots

Every screenshot is rendered headlessly from a synthetic workspace
(`capture/seed.ts`) in the Iridescent theme, once light and once dark. The pages
swap in the `-dark.webp` copies through `<picture>` when the browser prefers dark
mode. Never use real planner data.

```bash
pnpm site:capture   # builds the app, writes PNGs to artifacts/site-shots
pnpm site:images    # converts them to public/images/*.webp
```

Check every image after a capture (a montage is quickest), and update the docs
text when a captured page's labels change.

## Deploy

Pushing changes under `website/` to `main` deploys the `balance-site` Worker
through Cloudflare Workers Builds (trigger "Deploy main", root `/website`,
`npx wrangler@4 deploy`). Build logs are under the Worker's Deployments tab.
To deploy by hand:

```bash
pnpm site:deploy
```

Preview locally with
`pnpm dlx wrangler dev --config website/wrangler.jsonc`. Locally `/admin`
returns 401 without an Access token; to try it, run a scratch Worker that
exports `createWorker(async () => true)` from `worker.js`.
