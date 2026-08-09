import type { MatchInput, NormalizedCPPItem } from "./types";

export function resolveImportedAuthor(
  input: MatchInput,
  cppItem?: NormalizedCPPItem
): string {
  return cppItem?.author?.trim() || input.author?.trim() || "";
}

export function detectWishItemType(
  cppItem?: NormalizedCPPItem
): "paid" | "free" {
  if (!cppItem) return "paid";

  const exchangeType = cppItem.exchangeType || "";
  if (exchangeType.includes("无料")) return "free";
  if (exchangeType.includes("有偿")) return "paid";

  const tags = cppItem.tags || [];
  if (tags.some((tag) => tag.includes("无料"))) return "free";
  if (cppItem.productName.includes("无料")) return "free";
  if (tags.some((tag) => tag.includes("有偿"))) return "paid";
  return "paid";
}
