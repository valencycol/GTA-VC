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