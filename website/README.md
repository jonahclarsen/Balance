# balance.jonah.art

The Balance website and docs: static pages in `public/`, served by a small
Cloudflare Worker (`worker.js`). `jonah.art/balance` redirects here through the
jonah.art site's redirect settings.

- `/` landing page, `/docs/` user docs.
- `/download/mac`, `/download/android`, `/download/linux` redirect to the newest
  GitHub release that carries that platform's build. Release tags without
  `-all` publish only Android, so the Mac link can point at an older release.
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
(`capture/seed.ts`) in the Iridescent theme. Never use real planner data.

```bash
pnpm site:capture   # builds the app, writes PNGs to artifacts/site-shots
pnpm site:images    # converts them to public/images/*.webp and versions their URLs
```

Check every image after a capture (a montage is quickest), and update the docs
text when a captured page's labels change.

## Deploy

```bash
pnpm site:deploy
```

Deploys the `balance-site` Worker to Jonah's Cloudflare account with the
`balance.jonah.art` custom domain. Preview locally with
`pnpm dlx wrangler dev --config website/wrangler.jsonc`. Locally `/admin`
returns 401 without an Access token; to try it, run a scratch Worker that
exports `createWorker(async () => true)` from `worker.js`.
