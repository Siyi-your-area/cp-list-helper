const CPP_HOSTS = new Set(["allcpp.cn", "www.allcpp.cn"]);
const CPP_SHORT_HOSTS = new Set(["icp.red", "www.icp.red"]);

export type CPPProductReference =
  | { kind: "did"; doujinshiId: number }
  | { kind: "web"; doujinshiId: number }
  | { kind: "short"; url: string };

function parsePositiveId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parseCPPProductLink(value: string): number | null {
  const input = value.trim();
  if (!input) return null;

  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!CPP_HOSTS.has(url.hostname.toLowerCase())) return null;

    const match = url.pathname.match(/^\/d\/(\d+)\.do\/?$/i);
    if (!match) return null;

    return parsePositiveId(match[1]);
  } catch {
    return null;
  }
}

export function parseCPPProductReference(value: string): CPPProductReference | null {
  const input = value.trim();
  if (!input) return null;

  const directId = parsePositiveId(input);
  if (directId) return { kind: "did", doujinshiId: directId };

  const productId = parseCPPProductLink(input);
  if (productId) return { kind: "web", doujinshiId: productId };

  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!CPP_SHORT_HOSTS.has(url.hostname.toLowerCase())) return null;
    if (!/^\/[A-Za-z0-9_-]{4,64}\/?$/.test(url.pathname)) return null;
    return { kind: "short", url: url.toString() };
  } catch {
    return null;
  }
}

export function isAllowedCPPReferenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    return CPP_HOSTS.has(hostname) || CPP_SHORT_HOSTS.has(hostname);
  } catch {
    return false;
  }
}
