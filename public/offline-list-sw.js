const CACHE_NAME = "cp-list-helper-offline-v1";
const MODE_KEY = "/__cp_list_manual_offline__";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function cacheUrl(cache, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const parsed = new URL(url, self.location.origin);
    const request = new Request(parsed.href, {
      credentials: parsed.origin === self.location.origin ? "include" : "omit",
      mode: parsed.origin === self.location.origin ? "same-origin" : "no-cors",
      cache: "reload",
      signal: controller.signal,
    });
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") await cache.put(parsed.href, response.clone());
  } catch {
    // 单张图片或静态资源失败不影响其余离线数据。
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("message", (event) => {
  const reply = (value) => event.ports[0] && event.ports[0].postMessage(value);
  if (event.data?.type === "PREPARE_OFFLINE_LIST") {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await Promise.all((event.data.urls || []).map((url) => cacheUrl(cache, url)));
        reply({ ok: true });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : "离线页面准备失败" });
      }
    })());
  }
  if (event.data?.type === "SET_MANUAL_OFFLINE") {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      if (event.data.active) {
        await cache.put(MODE_KEY, new Response(JSON.stringify({ route: event.data.route }), {
          headers: { "Content-Type": "application/json" },
        }));
      } else {
        await cache.delete(MODE_KEY);
      }
      reply({ ok: true });
    })());
  }
});

async function manualOfflineRoute(cache) {
  const response = await cache.match(MODE_KEY);
  if (!response) return null;
  try {
    return (await response.json()).route || null;
  } catch {
    return null;
  }
}

function offlineImage() {
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="100%" height="100%" fill="#f1f5f9"/><path d="M24 50l10-12 8 9 6-7 10 12H24z" fill="#cbd5e1"/></svg>',
    { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" } }
  );
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isListRoute = (path) => /^\/exhibit\/[^/]+\/?$/.test(path);
  const isListNavigation = event.request.mode === "navigate"
    && url.origin === self.location.origin && isListRoute(url.pathname);
  const referrer = event.request.referrer ? new URL(event.request.referrer) : null;
  const fromList = referrer?.origin === self.location.origin && isListRoute(referrer.pathname);
  const cacheable = isListNavigation || (fromList && (
    event.request.destination === "image"
    || (url.origin === self.location.origin && url.pathname.startsWith("/_next/"))
  ));
  if (!cacheable) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const offlineRoute = await manualOfflineRoute(cache);
    if (offlineRoute && (!isListNavigation || new URL(offlineRoute, self.location.origin).pathname === url.pathname)) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (isListNavigation) {
        const routeResponse = await cache.match(offlineRoute);
        if (routeResponse) return routeResponse;
      }
      if (event.request.destination === "image") return offlineImage();
      return new Response("离线资源尚未缓存", { status: 503 });
    }

    try {
      const response = await fetch(event.request);
      if (response.ok || response.type === "opaque") {
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (event.request.destination === "image") return offlineImage();
      return new Response("网络不可用", { status: 503 });
    }
  })());
});
