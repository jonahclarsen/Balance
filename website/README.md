# balance.jonah.art

The Balance website and docs: static pages in `public/`, served by a small
Cloudflare Worker (`worker.js`). `jonah.art/balance` redirects here through the
jonah.art site's redirect settings.

- `/` landing page, `/docs/` user docs.
- `/download/mac`, `/download/android`, `/download/linux` redirect to the newest
  GitHub release that carries that platform's build. Release tags without
  `-all` publish only Android, so the Mac link can point at an older release.
- `/api/builds` lists those builds; the landing page shows the version from it.

## Screenshots

Every screenshot is rendered headlessly from a synthetic workspace
(`capture/seed.ts`) in the Iridescent theme. Never use real planner data.

```bash
pnpm site:capture   # builds the app, writes PNGs to artifacts/site-shots
pnpm site:images    # converts them to public/images/*.webp
```

Check every image after a capture (a montage is quickest), and update the docs
text when a captured page's labels change.

## Deploy

```bash
pnpm site:deploy
```

Deploys the `balance-site` Worker to Jonah's Cloudflare account with the
`balance.jonah.art` custom domain. Preview locally with
`pnpm dlx wrangler dev --config website/wrangler.jsonc`.
