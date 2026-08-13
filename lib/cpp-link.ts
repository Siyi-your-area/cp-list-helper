const CPP_HOSTS = new Set(["allcpp.cn", "www.allcpp.cn"]);

export function parseCPPProductLink(value: string): number | null {
  const input = value.trim();
  if (!input) return null;

  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!CPP_HOSTS.has(url.hostname.toLowerCase())) return null;

    const match = url.pathname.match(/^\/d\/(\d+)\.do\/?$/i);
    if (!match) return null;

    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}
