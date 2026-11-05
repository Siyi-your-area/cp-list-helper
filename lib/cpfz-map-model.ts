import type { WishItem } from "./types";
import { getCpfzMapPoint } from "./cpfz-map-data";

export type CpfzBoothGroup = {
  key: string;
  hall: string;
  label: string;
  x: number;
  y: number;
  items: WishItem[];
};

const BOOTH_PATTERN = /([壹贰叁肆玖][A-Z]\d{1,2})/g;

export function buildCpfzBoothGroups(items: WishItem[], pendingOnly: boolean): CpfzBoothGroup[] {
  const groups = new Map<string, CpfzBoothGroup>();
  for (const item of items) {
    if (pendingOnly && !["pending", "已买待取", "待领取"].includes(item.status)) continue;
    const booth = item.boothNumber.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
    const codes = [...booth.matchAll(BOOTH_PATTERN)].map((match) => match[1]);
    if (!codes.length || codes.join("") !== booth || new Set(codes.map((code) => code[0])).size !== 1) continue;
    const point = getCpfzMapPoint(codes[0]);
    if (!point || codes.some((code) => !getCpfzMapPoint(code))) continue;
    const key = `${point.hall}:${booth}`;
    const group = groups.get(key) || { key, hall: point.hall, label: booth, x: point.x, y: point.y, items: [] };
    if (!group.items.some((existing) => existing.id === item.id)) group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export type CpfzMarker = {
  key: string;
  groups: CpfzBoothGroup[];
  x: number;
  y: number;
  label: string;
};

export function clusterCpfzBooths(groups: CpfzBoothGroup[], viewport: { x: number; y: number; imageWidth: number; imageHeight: number; viewWidth: number; viewHeight: number }, zoom: number): CpfzMarker[] {
  const visible = groups.filter((group) => {
    const sx = viewport.x + group.x * viewport.imageWidth * zoom;
    const sy = viewport.y + group.y * viewport.imageHeight * zoom;
    return sx >= 0 && sx <= viewport.viewWidth && sy >= 0 && sy <= viewport.viewHeight;
  });
  const clusters: CpfzBoothGroup[][] = [];
  for (const group of visible) {
    const nearby = zoom < 2.5 ? clusters.find((cluster) => cluster.length < 6 && cluster.some((other) =>
      Math.hypot((other.x - group.x) * viewport.imageWidth * zoom, (other.y - group.y) * viewport.imageHeight * zoom) < 66
    )) : undefined;
    if (nearby) nearby.push(group);
    else clusters.push([group]);
  }
  return clusters.map((members) => {
    const first = members[0];
    const count = members.reduce((total, group) => total + group.items.length, 0);
    return {
      key: members.map((group) => group.key).join("|"),
      groups: members,
      x: members.reduce((sum, group) => sum + group.x, 0) / members.length,
      y: members.reduce((sum, group) => sum + group.y, 0) / members.length,
      label: members.length === 1
        ? `${first.label}(${count})`
        : `${first.hall}${members[0].label.slice(1)}–${members[members.length - 1].label.slice(1)} · ${members.length}摊 · ${count}件 · 点此放大`,
    };
  });
}
