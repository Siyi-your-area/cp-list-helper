const WORKER_PATH = "/offline-list-sw.js";

async function getWorker(registerIfMissing = true): Promise<ServiceWorker | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration("/");
  const registration = existing || (registerIfMissing
    ? await navigator.serviceWorker.register(WORKER_PATH, { scope: "/" })
    : null);
  if (!registration) return null;
  const readyRegistration = await navigator.serviceWorker.ready;
  return navigator.serviceWorker.controller || readyRegistration.active || registration.active;
}

function postWorkerMessage(worker: ServiceWorker, message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => reject(new Error("离线页面准备超时")), 20000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      if (event.data?.ok) resolve();
      else reject(new Error(event.data?.error || "离线页面准备失败"));
    };
    worker.postMessage(message, [channel.port2]);
  });
}

export async function prepareOfflinePageCache(imageUrls: string[]): Promise<boolean> {
  const worker = await getWorker();
  if (!worker) return false;
  const urls = new Set<string>([window.location.href]);
  document.querySelectorAll<HTMLScriptElement>("script[src]").forEach((element) => {
    const url = new URL(element.src, window.location.href);
    if (url.origin === window.location.origin) urls.add(url.href);
  });
  document.querySelectorAll<HTMLLinkElement>("link[href]").forEach((element) => {
    const url = new URL(element.href, window.location.href);
    if (url.origin === window.location.origin) urls.add(url.href);
  });
  performance.getEntriesByType("resource").forEach((entry) => {
    const url = new URL(entry.name, window.location.href);
    if (url.origin === window.location.origin && url.pathname.startsWith("/_next/")) {
      urls.add(url.href);
    }
  });
  imageUrls.filter(Boolean).forEach((url) => urls.add(url));
  await postWorkerMessage(worker, {
    type: "PREPARE_OFFLINE_LIST",
    route: window.location.href,
    urls: Array.from(urls),
  });
  return true;
}

export async function setManualOfflineCache(active: boolean): Promise<void> {
  const worker = await getWorker(false);
  if (!worker) throw new Error("当前浏览器不支持离线页面");
  await postWorkerMessage(worker, {
    type: "SET_MANUAL_OFFLINE",
    active,
    route: window.location.href,
  });
}
