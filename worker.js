// gta-vc — replaces server.py / index.php on Cloudflare Workers.
//   everything is behind Basic Auth, including dist/ (needs run_worker_first = true)
//   /vcsky/*, /vcbr/*  → game assets from your R2 bucket
//   /token/get, /saves/*  → self-hosted saves, backed by Workers KV
//   everything else     → served from dist/ as a static asset
const REALM = "gta-vc";
const unauthorized = () =>
  new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"` },
  });

const equals = (a, b) => {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
};

function authorized(request, env) {
  if (!env.AUTH_EMAIL || !env.AUTH_PASSWORD) return false; // fail closed
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    const raw = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(raw);
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const okEmail = equals(decoded.slice(0, i), env.AUTH_EMAIL);
  const okPass = equals(decoded.slice(i + 1), env.AUTH_PASSWORD);
  return okEmail && okPass; // both compared; no early return
}

const R2_PREFIXES = { "/vcsky/": "vcsky/", "/vcbr/": "vcbr/" };
const MAX_SAVE_BYTES = 4 * 1024 * 1024;
const safe = (s) => typeof s === "string" && /^[\w.-]{1,64}$/.test(s);
const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) return unauthorized();

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
        .map(decode);
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
        const rel = decode(pathname.slice(prefix.length));
        if (rel === null || rel.includes("..")) {
          return new Response("bad request", { status: 400 });
        }
        const object = await env.GAME.get(keyBase + rel);
        if (!object) return new Response("not found", { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("cache-control", "public, max-age=31536000, immutable");
        if (rel.endsWith(".br")) headers.set("content-encoding", "br");
        return new Response(object.body, { headers, encodeBody: "manual" });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
