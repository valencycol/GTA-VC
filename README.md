# Hosting GTA: Vice City at gta-vc.colaco.se

A complete guide: macOS toolchain → repo changes → Cloudflare setup → DNS → save games → automatic deploys.

Everything here was tested against `valencycol/GTA-VC` with Wrangler 4.127.0 and a simulated KV namespace.

---

## What you're building

```
                 gta-vc.colaco.se
                        │
              ┌─────────┴──────────┐
              │  Cloudflare Worker │
              └─────────┬──────────┘
                        │
     ┌──────────────────┼───────────────────┐
     │                  │                   │
  dist/*            /vcsky/*            /saves/*
 (static assets)    /vcbr/*             /token/get
 free, unmetered    proxied to           Workers KV
                    cdn.dos.zone         (save slots)
```

The repo's `server.py` and `index.php` only do three jobs: serve `dist/`, proxy two CDN paths, and store save files. The Worker replaces all three. Nothing is compiled — `dist/` ships prebuilt in the repo — so there is no build step at all.

---

## 0. Prerequisites

- A MacBook with admin rights
- The GitHub repo `valencycol/GTA-VC` (already yours)
- A Cloudflare account with `colaco.se` already on it (it is — that's where feeds and notes live)
- No credit card. This guide uses Workers KV specifically to avoid R2's payment-method requirement.

---

## 1. macOS toolchain

Wrangler 4 requires **Node 22 or newer**. Check what you have:

```bash
node -v
```

If it's missing or below 22:

```bash
# Homebrew (install Homebrew first from brew.sh if needed)
brew install node
```

Or with nvm if you juggle Node versions:

```bash
nvm install 22 && nvm use 22
```

Verify:

```bash
node -v   # v22.x or higher
npm -v
```

---

## 2. Clone and set up the repo

```bash
git clone https://github.com/valencycol/GTA-VC.git
cd GTA-VC
```

### 2.1 `package.json`

Create it at the repo root:

```json
{
  "name": "gta-vc",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.127.0"
  }
}
```

Then:

```bash
npm install
```

This creates `package-lock.json`. **Commit it** — Cloudflare's CI uses it to reproduce your Wrangler version.

### 2.2 `.gitignore`

Append to the existing file:

```
node_modules/
.wrangler/
```

### 2.3 `worker.js`

Create at the repo root. This is the whole server:

```js
// gta-vc — replaces server.py / index.php on Cloudflare Workers.
//   /vcsky/*, /vcbr/*  → proxied to the DOS Zone CDN (game.js expects same-origin paths)
//   /token/get, /saves/*  → self-hosted saves, backed by Workers KV
//   everything else     → served from dist/ as a static asset (free, unmetered)

const UPSTREAM = {
  "/vcsky/": "https://cdn.dos.zone/vcsky/",
  "/vcbr/": "https://br.cdn.dos.zone/vcsky/",
};

const MAX_SAVE_BYTES = 4 * 1024 * 1024;
const safe = (s) => typeof s === "string" && /^[\w.-]{1,64}$/.test(s);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, search } = url;

    // --- saves ---------------------------------------------------------

    if (pathname === "/token/get") {
      const id = url.searchParams.get("id");
      if (!safe(id)) return new Response("bad request", { status: 400 });
      return Response.json({ token: id, premium: true, email: "local@user" });
    }

    if (pathname === "/saves/upload") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const form = await request.formData();
      const token = form.get("token");
      const fileName = form.get("fileName");
      const file = form.get("file");
      if (!safe(token) || !safe(fileName) || typeof file === "string") {
        return new Response("bad request", { status: 400 });
      }
      const body = await file.arrayBuffer();
      if (body.byteLength === 0) return new Response("empty save", { status: 400 });
      if (body.byteLength > MAX_SAVE_BYTES) {
        return new Response("save too large", { status: 413 });
      }
      await env.SAVES.put(`${token}/${fileName}`, body);
      return Response.json({ success: true });
    }

    if (pathname.startsWith("/saves/download/")) {
      const [token, fileName] = pathname
        .slice("/saves/download/".length)
        .split("/")
        .map(decodeURIComponent);
      if (!safe(token) || !safe(fileName)) {
        return new Response("bad request", { status: 400 });
      }
      const body = await env.SAVES.get(`${token}/${fileName}`, "arrayBuffer");
      if (!body) return new Response("not found", { status: 404 });
      return new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    }

    // --- game assets ---------------------------------------------------

    for (const [prefix, base] of Object.entries(UPSTREAM)) {
      if (pathname.startsWith(prefix)) {
        const target = base + pathname.slice(prefix.length) + search;
        return fetch(new Request(target, request), {
          cf: { cacheEverything: true },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
```

Two things worth knowing about this file:

- The proxy never reads the response body. That's deliberate — it lets the pre-compressed `.br` game data pass through with `Content-Encoding: br` intact. Touching the body causes `ERR_CONTENT_DECODING_FAILED` in the browser.
- The `safe()` guard is not in the original Python. KV keys are flat strings, so without it a token containing a slash could write into another player's namespace.

### 2.4 `wrangler.toml`

Create at the repo root. Leave the KV `id` as a placeholder for now; step 3 fills it in.

```toml
name = "gta-vc"
main = "worker.js"
compatibility_date = "2026-08-28"

routes = [
  { pattern = "gta-vc.colaco.se", custom_domain = true }
]

[assets]
directory = "./dist"
binding = "ASSETS"

[[kv_namespaces]]
binding = "SAVES"
id = "PASTE_KV_ID_HERE"
```

TOML is order-sensitive: `routes` must sit **above** `[assets]` and `[[kv_namespaces]]`, or it gets parsed as part of the table above it.

### 2.5 Make self-hosted saves the default

`dist/index.html` picks its save backend from a URL parameter. `server.py` used to patch this at request time; serving statically, you patch it once in your fork:

```bash
sed -i '' 's/get("custom_saves") === "1"/get("custom_saves") !== "0"/' dist/index.html
```

Confirm it landed:

```bash
grep -n 'custom_saves' dist/index.html
```

You should see `!== "0"`. Now your KV-backed saves are on by default, and `?custom_saves=0` still falls back to the DOS Zone cloud if you ever want to compare.

---

## 3. Cloudflare setup and authentication

### 3.1 How Wrangler authenticates

You do not create any API tokens for this setup, and nothing secret ever enters the repo. There are three ways Wrangler can authenticate, and this guide uses the first two, both of which are automatic:

| Where | Method | What you do |
|---|---|---|
| Your MacBook | OAuth via `wrangler login` | Click Allow in the browser once |
| Workers Builds (section 6) | Token Cloudflare generates for itself | Nothing |
| External CI, e.g. GitHub Actions | Manual API token | Only if you choose this route — see Appendix B |

**On the Mac,** `wrangler login` runs an interactive OAuth flow and requests exactly the scopes this project needs: `workers_scripts:write`, `workers_kv:write`, `workers_routes:write`, plus `account:read`, `zone:read` and `user:read`. The resulting credentials are stored in Wrangler's own user config directory outside your project, so there is nothing to add to `.gitignore` and nothing to paste anywhere.

**In Workers Builds,** Cloudflare provisions an API token for your account when you connect the repository. Per Cloudflare's documentation it carries Account Settings (read), Workers Scripts (edit), Workers KV Storage (edit), Workers R2 Storage (edit), Workers Routes (edit) across your zones, and user details (read). No GitHub secrets are involved. Avoiding that secret-handling step is the main reason this guide uses Workers Builds rather than GitHub Actions.

Two useful commands:

```bash
npx wrangler whoami    # which account am I authenticated against?
npx wrangler logout    # revoke the local OAuth credentials
```

**What is not a secret:** the KV namespace `id` in `wrangler.toml`, your Worker name, and your Cloudflare account ID are opaque resource identifiers. They are safe to commit, and useless to anyone without an authenticated token. Only an API token is sensitive.

### 3.2 Log in

```bash
npx wrangler login
```

Opens a browser for OAuth. Confirm with:

```bash
npx wrangler whoami
```

### 3.3 Create the KV namespace

```bash
npx wrangler kv namespace create SAVES
```

It prints a namespace `id`. Paste that into `wrangler.toml` in place of `PASTE_KV_ID_HERE`.

No dashboard clicking and no payment method needed. KV's free tier gives you 1 GB of storage, 100,000 reads and 1,000 writes per day, and a 25 MB ceiling per value. A Vice City save is around 200 KB.

---

## 4. First deploy

```bash
npm run deploy
```

Wrangler uploads `dist/` as static assets (26 files, well under the 20,000 limit) plus the ~2.5 KB Worker, then wires up the custom domain. Watch for:

```
✨ Read 26 files from the assets directory
Your Worker has access to the following bindings:
  env.SAVES    KV Namespace
  env.ASSETS   Assets
```

---

## 5. DNS

Because `routes` in `wrangler.toml` declares a custom domain, **Cloudflare creates the DNS record for you** on deploy. `colaco.se` is already in your account, so it adds a proxied record for `gta-vc` pointing at the Worker and issues the certificate. Nothing to do by hand.

Two things that can go wrong:

- **A conflicting record already exists.** If `gta-vc.colaco.se` has an A, AAAA, or CNAME record from something else, delete it in the Cloudflare DNS dashboard and redeploy.
- **Certificate pending.** The domain shows as "Initializing" for a minute or two on first setup. Give it five minutes before assuming something's broken.

Prefer to do it by hand instead? Drop the `routes` block and use the dashboard: **Workers & Pages → gta-vc → Settings → Domains & Routes → Add → Custom domain → `gta-vc.colaco.se`**.

---

## 6. Automatic deploys from GitHub

Push your changes first:

```bash
git add package.json package-lock.json worker.js wrangler.toml .gitignore dist/index.html
git commit -m "Deploy to Cloudflare Workers with KV-backed saves"
git push
```

Then connect the repo:

1. Cloudflare dashboard → **Workers & Pages** → select **gta-vc**
2. **Settings → Builds → Connect**
3. Authorize the GitHub integration, pick `valencycol/GTA-VC`, branch `main`
4. **Build command:** `npm ci`
5. **Deploy command:** `npm run deploy`
6. Save

Every push to `main` now redeploys. You can still run `npm run deploy` from the Mac whenever you want; the two don't conflict.

No GitHub secrets are needed — Cloudflare handles its own credentials, as described in 3.1. If you'd rather run the deploy from GitHub Actions instead, that's the one path that requires a hand-made API token; see Appendix B.

---

## 7. Using the save feature

There are two layers, and the first works whether or not you do anything.

**Browser-local (automatic).** The wasm mounts `/vc-assets/local/userfiles` as an IndexedDB filesystem and syncs on every in-game save. Close the tab, come back, your save is there. It's per-browser, per-device, and vanishes if you clear site data.

**Server-side (the KV part).** On the start page there's a box reading *"Enter js-dos key (5 len)"*. Type any five characters — `valen`, `alvi1`, whatever:

1. The page calls `/token/get?id=valen`
2. Your Worker answers `premium: true`, and the status next to "Cloud saves" turns **green / enabled**
3. From then on, every in-game save also pushes `vcsky.saves` to KV under `valen/vcsky.saves`
4. Entering the same five characters on your phone, or on any other browser, pulls that save back

Red status saying *disabled* means the Worker isn't answering `/token/get` — see troubleshooting.

That five-character key is the only thing protecting a save slot. Anyone who guesses it can read or overwrite that save. Fine among friends; see section 9 if you want it locked down.

---

## 8. Local development on the MacBook

```bash
npm run dev
```

Serves at `http://localhost:8787` with a local KV simulation in `.wrangler/state`. The CDN proxy makes real requests to dos.zone, so the game is fully playable locally. `Ctrl-C` to stop.

Useful URL parameters while testing:

| Parameter | Effect |
|---|---|
| `?cheats=1` | Cheat menu on **F3**, including a memory scanner |
| `?lang=ru` | Russian build |
| `?max_fps=60` | Cap the frame rate |
| `?fullscreen=0` | Don't auto-fullscreen |
| `?configurable=1` | Settings UI before the play button |
| `?custom_saves=0` | Bypass your KV saves, use DOS Zone cloud instead |

---

## 9. Verification checklist

After deploying, from the Mac:

```bash
# 1. Game page loads
curl -sI https://gta-vc.colaco.se/ | head -3

# 2. Brotli game data passes through uncompressed-untouched
curl -sI https://gta-vc.colaco.se/vcbr/vc-sky-en-v6.wasm.br | grep -i 'http\|content-'
#    expect: 200 + content-encoding: br

# 3. Token endpoint answers
curl -s 'https://gta-vc.colaco.se/token/get?id=valen'
#    expect: {"token":"valen","premium":true,"email":"local@user"}

# 4. Save round-trip
head -c 1024 /dev/urandom > /tmp/test.bin
curl -s -F "token=test1" -F "fileName=vcsky.saves" -F "file=@/tmp/test.bin" \
  https://gta-vc.colaco.se/saves/upload
curl -s -o /tmp/back.bin https://gta-vc.colaco.se/saves/download/test1/vcsky.saves
cmp /tmp/test.bin /tmp/back.bin && echo "saves working"

# 5. Guards hold
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://gta-vc.colaco.se/saves/download/test1/..%2F..%2Fx'   # expect 400
```

Then in a browser: load the site, enter a 5-character key, check the status goes green, start the game, save at a hideout, hard-refresh, and confirm the save loads.

---

## 10. Limits, costs, and two things to watch

**What counts against your free tier.** Everything in `dist/` is served as a static asset, which Cloudflare bills at zero and doesn't cap. Only `/vcsky/*`, `/vcbr/*`, `/saves/*` and `/token/get` invoke the Worker, against 100,000 requests/day. The game caches streamed assets in IndexedDB and the 130 MB payload in the Cache API, so a returning player costs almost nothing. KV's 1,000 writes/day is the other ceiling — that's 1,000 in-game saves across all players per day.

**The bandwidth terms.** Cloudflare's Service-Specific Terms restrict using the CDN to serve large files hosted *outside* Cloudflare without a paid Developer Platform service. Proxying a 130 MB payload from dos.zone is exactly that shape. It won't matter for you and a few friends. If this ever gets real traffic, move the assets into R2 (see appendix) — Cloudflare explicitly permits large files served from their own storage, with no egress fees.

**Access control.** The game data is Rockstar's, and a public `gta-vc.colaco.se` distributes it. If you'd rather keep it private, put Cloudflare Access in front of the Worker (**Zero Trust → Access → Applications**, free for small teams). That also fixes the guessable-save-key problem in one move.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cloud saves: disabled` in red | `/token/get` not reachable | Check the `sed` edit in 2.5 actually landed; check the Worker deployed |
| `ERR_CONTENT_DECODING_FAILED` on the big download | Something read the proxied response body | Return the `fetch()` result untouched; don't clone or rewrite headers |
| Custom domain stuck initializing | Conflicting DNS record for `gta-vc` | Delete it in the DNS dashboard, redeploy |
| `Unexpected fields found in kv_namespaces[0]` | `routes` placed after a table header in TOML | Move `routes` above `[assets]` |
| Wrangler refuses to start | Node below 22 | `brew upgrade node` or `nvm use 22` |
| Game loads but assets 404 | Upstream CDN unreachable | `curl -I https://cdn.dos.zone/vcsky/sha256sums.txt` |
| Saves don't sync across devices | No key entered, or different key | Same 5 characters on both, status green |
| `Authentication error [code: 10000]` locally | OAuth credentials expired or revoked | `npx wrangler logout` then `npx wrangler login` |
| Deployed to the wrong Cloudflare account | Logged in as a different account | `npx wrangler whoami`, then re-login |
| GitHub Actions fails to authenticate | Missing or misscoped token | Check both repo secrets exist and the token covers the account and zone (Appendix B) |

---

## Appendix A: moving the assets to R2

Only needed if the site gets real traffic. R2 requires a payment method on file even for the free tier (10 GB storage, no egress fees), which is why it isn't the default here.

1. Pull the assets locally: `python server.py --unpacked https://folder.morgen.qzz.io/revcdos.bin` produces `unpacked/{hash}/vcsky/` and `vcbr/`
2. `npx wrangler r2 bucket create gta-vc-assets`, then upload both trees
3. Add the binding to `wrangler.toml`:
   ```toml
   [[r2_buckets]]
   binding = "GAME"
   bucket_name = "gta-vc-assets"
   ```
4. Replace the `UPSTREAM` loop with an R2 lookup keyed on the same paths, and set `content-encoding: br` yourself for `.br` keys — R2 stores raw bytes and won't infer it

That drops the dependency on dos.zone entirely and puts you inside the terms with room to spare.

---

## Appendix B: GitHub Actions instead of Workers Builds

Only needed if you want the deploy to run inside GitHub — for example to add tests, linting, or steps Workers Builds can't do. This is the single path in this guide that requires a hand-made API token, because CI runners are non-interactive and can't complete the OAuth flow.

If you set this up, **turn Workers Builds off** (Worker → Settings → Builds → Disconnect), or every push deploys twice.

### B.1 Create the token

1. Cloudflare dashboard → **Account API tokens** → **Create Token**
2. Under **Permission policies**, open the **Custom** dropdown and choose the **Edit Cloudflare Workers** template
3. Name it something identifiable, e.g. `github-actions-gta-vc`
4. Scope it down: under **Account Resources** pick only your account, and under **Zone Resources** pick only `colaco.se`
5. Create the token and copy the value — it is shown exactly once

That template grants Workers Scripts, Workers KV Storage and Workers Routes, which is everything this Worker touches. Static asset uploads ride on the Workers Scripts permission, so nothing extra is needed. If you later move assets to R2 (Appendix A), add **R2 Storage: Edit**.

### B.2 Add the repo secrets

You also need your account ID, which you'll find on the Workers & Pages overview page in the dashboard.

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**, twice:

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from B.1 |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

Never commit the token itself. It grants deploy access to every Worker on the account it's scoped to.

### B.3 The workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Worker

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v6
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          preCommands: npm ci
```

The `preCommands: npm ci` step installs the Wrangler version pinned in your `package-lock.json`, so CI deploys with the same version you tested locally. Action versions here match Cloudflare's current documented example; check for newer majors if you set this up much later.

### B.4 Rotating or revoking

Tokens are independent, so this is cheap to redo. Cloudflare dashboard → **Account API tokens** → **Roll** to issue a new value, or **Delete** to kill it outright, then update the GitHub secret. If a token ever leaks, delete it first and create a fresh one rather than trying to narrow its scope.
