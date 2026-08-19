import type { WishItem } from "./types";

export const CPG_VENUE_ORDER = ["壹", "贰", "叁", "肆", "伍"] as const;

const venueIndex = new Map<string, number>(
  CPG_VENUE_ORDER.map((venue, index) => [venue, index])
);

type WishItemLocation = Pick<WishItem, "boothNumber"> & Partial<Pick<WishItem, "venue">>;

export function isCreatorBoothNumber(boothNumber: string): boolean {
  return /^创\d+$/u.test(boothNumber.trim().normalize("NFKC"));
}

export function getWishItemVenue(item: WishItemLocation): string {
  // CPG08 的创作者摊位统一位于贰馆；摊位号本身仍保留“创xx”。
  if (isCreatorBoothNumber(item.boothNumber)) return "贰";

  const explicitVenue = item.venue?.trim() || "";
  if (venueIndex.has(explicitVenue)) return explicitVenue;

  const boothVenue = item.boothNumber.trim().charAt(0);
  return venueIndex.has(boothVenue) ? boothVenue : "";
}

function getBoothWithinVenue(item: WishItemLocation): string {
  const boothNumber = item.boothNumber.trim();
  const first = boothNumber.charAt(0);
  return venueIndex.has(first) ? boothNumber.slice(1).trim() : boothNumber;
}

function locationRank(item: WishItemLocation): number {
  const venue = getWishItemVenue(item);
  const booth = getBoothWithinVenue(item);
  if (venue && booth) return 0;
  if (venue || booth) return 1;
  return 2;
}

export function compareWishItemsByLocation(a: WishItem, b: WishItem): number {
  const rankDifference = locationRank(a) - locationRank(b);
  if (rankDifference !== 0) return rankDifference;

  const aVenue = getWishItemVenue(a);
  const bVenue = getWishItemVenue(b);
  const venueDifference = (venueIndex.get(aVenue) ?? CPG_VENUE_ORDER.length)
    - (venueIndex.get(bVenue) ?? CPG_VENUE_ORDER.length);
  if (venueDifference !== 0) return venueDifference;

  const boothDifference = getBoothWithinVenue(a).localeCompare(
    getBoothWithinVenue(b),
    "en",
    { numeric: true, sensitivity: "base" }
  );
  if (boothDifference !== 0) return boothDifference;

  return a.productName.localeCompare(b.productName, "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

export function normalizeWishItemLocation(item: WishItem): WishItem {
  const venue = getWishItemVenue(item);
  const booth = getBoothWithinVenue(item);
  const boothNumber = isCreatorBoothNumber(item.boothNumber)
    ? item.boothNumber.trim().normalize("NFKC")
    : venue && booth
      ? `${venue}${booth}`
      : item.boothNumber.trim();
  return { ...item, venue, boothNumber };
}
