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
 free, unmetered    your R2 bucket       Workers KV
                    (game assets)        (save slots)
```

The repo's `server.py` and `index.php` only do three jobs: serve `dist/`, supply the game assets, and store save files. The Worker replaces all three. Nothing is compiled — `dist/` ships prebuilt in the repo — so there is no build step at all.

**A note on where the assets come from.** Upstream, the project proxies `cdn.dos.zone` for its assets. As of August 2026 those buckets return `AccessDenied` to everyone, including direct requests, because DOS Zone moved to a bring-your-own-files model. This guide therefore hosts the assets in your own R2 bucket from the start. There is no proxy configuration that works around a private bucket.

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
//   /vcsky/*, /vcbr/*  → game assets from your R2 bucket (game.js expects same-origin paths)
//   /token/get, /saves/*  → self-hosted saves, backed by Workers KV
//   everything else     → served from dist/ as a static asset (free, unmetered)

const R2_PREFIXES = { "/vcsky/": "vcsky/", "/vcbr/": "vcbr/" };

const MAX_SAVE_BYTES = 4 * 1024 * 1024;
const safe = (s) => typeof s === "string" && /^[\w.-]{1,64}$/.test(s);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

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

    for (const [prefix, keyBase] of Object.entries(R2_PREFIXES)) {
      if (pathname.startsWith(prefix)) {
        const key = keyBase + decodeURIComponent(pathname.slice(prefix.length));
        if (key.includes("..")) return new Response("bad request", { status: 400 });

        const object = await env.GAME.get(key);
        if (!object) return new Response("not found", { status: 404 });

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("cache-control", "public, max-age=31536000, immutable");
        if (key.endsWith(".br")) headers.set("content-encoding", "br");

        return new Response(object.body, { headers, encodeBody: "manual" });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
```

Three things worth knowing about this file:

- **`encodeBody: "manual"` is load-bearing.** The `vcbr/` objects are stored as raw Brotli. Setting `Content-Encoding: br` without this option makes the Workers runtime compress the body a *second* time, and the browser then fails with `CompileError: WebAssembly.instantiate(): expected magic word`. `manual` tells the runtime the bytes are already encoded and to pass them through untouched.
- The `.br` suffix decides the header. Files under `vcsky/` are stored decompressed and must not get a `Content-Encoding`, or you hit the same double-decode failure in reverse.
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

[[r2_buckets]]
binding = "GAME"
bucket_name = "gta-vc-assets"
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

### 3.4 Create the R2 bucket

R2 is the one piece that needs a payment method on file, even for the free tier. You are not charged inside 10 GB of storage, and R2 has no egress fees. There is no alternative for these files: the largest is around 130 MB, which exceeds both the 25 MiB per-file limit on Workers static assets and the 25 MB per-value limit on KV.

Enable R2 in the dashboard under **R2 Object Storage** (it prompts for a card once), then:

```bash
npx wrangler r2 bucket create gta-vc-assets
```

### 3.5 Load the game assets into R2

The project ships every asset in one packed archive, independent of any CDN. It is about 1.01 GiB and expands to roughly 1.6 GB across 31,000 files.

**Download the archive to disk first, then unpack it. Do not unpack straight from the URL.** `utils/packer_brotli.py` has two unpack paths, and only the local-file one is correct: it honours a per-file "stored as-is" flag so that already-Brotli files are written back untouched. The streaming path used for URLs ignores that flag and decompresses everything, leaving `vcbr/*.br` as plain data still named `.br`. Every layer downstream keys `Content-Encoding` off that extension, so the server then advertises Brotli on bytes that aren't, the browser's decoder fails, and the game hangs forever on "Downloading..." with a 200 in the server log.

From your repo root:

```bash
conda create -n revc python=3.11 -y
conda activate revc
pip install -r requirements.txt
curl -L -o revcdos.bin https://folder.morgen.qzz.io/revcdos.bin
python server.py --unpacked revcdos.bin
```

The output should show `stored as-is (.br)` for the four `vcbr` files and a roughly `1.0x` ratio on that line. A `2.3x` expansion there means you took the streaming path and the files are wrong.

**Verify by testing the bytes, not the filename.** The failure mode leaves valid-looking files with the right names, so check them directly:

```bash
du -sh unpacked/*/vcbr/     # ~122 MB, not ~285 MB

python -c "
import glob, brotli
for f in sorted(glob.glob('unpacked/*/vcbr/*.br')):
    head = open(f,'rb').read(4096)
    try:
        brotli.Decompressor().process(head); print('brotli OK   ', f)
    except Exception:
        print('NOT brotli  ', f)
"
```

Four `brotli OK` lines means you are good. Anything else, delete that unpacked directory and redo this step.

**Where the files land.** The directory name is the MD5 of the *source string* you passed, not of the archive contents. So `revcdos.bin` always unpacks to `unpacked/d387c6f45d823194bc47671214496367/`, while the URL form produces a different directory. Two consequences: a failed attempt from the URL leaves its own tree behind that you should delete to reclaim the space, and re-running the same command reuses the existing directory without re-unpacking.

That directory holds `vcsky/` and `vcbr/` subdirectories, and the server starts once unpacking finishes. **Play it at `http://localhost:8000` before going further** — that proves the assets are intact and separates any later problem from the assets themselves. Then `Ctrl-C`.

What you should end up with, and what the Worker depends on: files under `vcbr/` keep their `.br` extension and stay Brotli-compressed, while everything under `vcsky/` is written out decompressed.

Keep `revcdos.bin` when you're done. With the DOS Zone buckets closed, that archive is your only copy of the assets, and the mirror it came from is one person's file host with no guarantees. Store a copy somewhere off the laptop.

Uploading a few thousand files one at a time with `wrangler r2 object put` would take hours, so use rclone:

```bash
brew install rclone
```

rclone talks to R2 over its S3 API, which needs its own credentials — this is the one place in this guide where you create a token by hand. In the dashboard: **R2 → API → Manage API Tokens → Create API token**, permission **Object Read & Write**, scoped to `gta-vc-assets`. You get an Access Key ID, a Secret Access Key, and an endpoint URL.

```bash
rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id=YOUR_ACCESS_KEY_ID \
  secret_access_key=YOUR_SECRET_ACCESS_KEY \
  endpoint=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com \
  region=auto \
  no_check_bucket=true

cd unpacked/d387c6f45d823194bc47671214496367
rclone copy . r2:gta-vc-assets/ --progress --transfers 16 --checksum
```

The `vcsky/` and `vcbr/` directory names become the R2 key prefixes the Worker looks up, so copy the *contents* of that directory, not the directory itself. Note the trailing `.` — `rclone copy . r2:gta-vc-assets/` is what produces keys like `vcbr/vc-sky-en-v6.data.br`. Verify when it finishes:

```bash
npx wrangler r2 object get gta-vc-assets/vcbr/vc-sky-en-v6.wasm.br --file=/tmp/check.br
ls -lh /tmp/check.br    # tens of MB, not a few hundred bytes
```

Those rclone credentials are secrets. Keep them out of the repo — `rclone config create` stores them in `~/.config/rclone/rclone.conf`, not in your project.

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

That five-character key is the only thing protecting a save slot. Anyone who guesses it can read or overwrite that save. 
