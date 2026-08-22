import type { WishItem } from "./types.ts";

export interface ListSummary {
  total: number;
  paid: number;
  free: number;
  pending: number;
  paidAwaitingPickup: number;
  purchased: number;
  soldout: number;
  pendingPickup: number;
  received: number;
  estimatedCost: number;
  actualCost: number;
}

function itemCost(item: WishItem): number {
  const price = item.price ?? 0;
  const quantity = item.quantity ?? 1;
  if (!Number.isFinite(price) || !Number.isFinite(quantity)) return 0;
  return Math.max(0, price) * Math.max(0, quantity);
}

export function calculateListSummary(items: readonly WishItem[]): ListSummary {
  const pending = items.filter((item) => item.status === "pending").length;
  const paidAwaitingPickup = items.filter((item) => item.status === "已买待取").length;
  const purchased = items.filter((item) => item.status === "purchased").length;
  const soldout = items.filter((item) => item.status === "soldout").length;
  const pendingPickup = items.filter((item) => item.status === "待领取").length;
  const received = items.filter((item) => item.status === "已领取").length;
  const paid = pending + paidAwaitingPickup + purchased + soldout;
  const free = pendingPickup + received;

  return {
    total: paid + free,
    paid,
    free,
    pending,
    paidAwaitingPickup,
    purchased,
    soldout,
    pendingPickup,
    received,
    estimatedCost: items.reduce((sum, item) => sum + itemCost(item), 0),
    actualCost: items.reduce(
      (sum, item) => sum + (
        item.status === "purchased" || item.status === "已买待取" ? itemCost(item) : 0
      ),
      0
    ),
  };
}
