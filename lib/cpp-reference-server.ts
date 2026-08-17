import {
  isAllowedCPPReferenceUrl,
  parseCPPProductLink,
  parseCPPProductReference,
} from "./cpp-link.ts";

type FetchLike = typeof fetch;

export async function resolveCPPProductReference(
  value: string,
  fetchImpl: FetchLike = fetch
): Promise<number | null> {
  const reference = parseCPPProductReference(value);
  if (!reference) return null;
  if (reference.kind !== "short") return reference.doujinshiId;

  let currentUrl = reference.url;
  for (let redirectCount = 0; redirectCount < 3; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml" },
    });

    const directId = parseCPPProductLink(response.url);
    if (directId) return directId;

    if (response.status < 300 || response.status >= 400) return null;
    const location = response.headers.get("location");
    if (!location) return null;

    const nextUrl = new URL(location, currentUrl).toString();
    if (!isAllowedCPPReferenceUrl(nextUrl)) return null;

    const redirectedId = parseCPPProductLink(nextUrl);
    if (redirectedId) return redirectedId;
    currentUrl = nextUrl;
  }

  return null;
}
