export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!key || key === "Viewer.html") return respond(env, "Viewer.html", "text/html; charset=utf-8");
    if (key === "cave.json" || key === "report.json") return respond(env, key, "application/json");
    return respond(env, key, "");
  },
};

async function respond(env, key, type) {
  const obj = await env.CAVE.get(key);
  if (!obj) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const headers = new Headers({
    "content-type": type || obj.httpMetadata?.contentType || guess(key),
    "cache-control": key.endsWith(".json") || key === "Viewer.html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  if (obj.range) headers.set("content-range", obj.range);
  return new Response(obj.body, { status: obj.range ? 206 : 200, headers });
}

function guess(key) {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" }[ext] || "application/octet-stream";
}
