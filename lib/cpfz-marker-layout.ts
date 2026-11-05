import type { CpfzMarker } from "./cpfz-map-model";

const LABEL_HEIGHT = 44;
const GAP = 12;
const PADDING = 4;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function resizeCpfzMapTransform(
  transform: { x: number; y: number; zoom: number },
  previous: { width: number; height: number; imageWidth: number; imageHeight: number },
  next: { width: number; height: number; imageWidth: number; imageHeight: number },
) {
  const centerX = (previous.width / 2 - transform.x) / (previous.imageWidth * transform.zoom);
  const centerY = (previous.height / 2 - transform.y) / (previous.imageHeight * transform.zoom);
  return {
    ...transform,
    x: next.width / 2 - centerX * next.imageWidth * transform.zoom,
    y: next.height / 2 - centerY * next.imageHeight * transform.zoom,
  };
}

export function layoutCpfzMarkers(
  markers: CpfzMarker[],
  transform: { x: number; y: number; zoom: number },
  image: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const nodes = markers.map((marker) => {
    const sx = transform.x + marker.x * image.width * transform.zoom;
    const sy = transform.y + marker.y * image.height * transform.zoom;
    const width = marker.groups.length > 1 ? 205 : Math.max(84, marker.label.length * 11 + 20);
    // 标签始终以摊位点为锚，不随摊位移动到屏幕另一半而换边。
    const vertical = sx < width + GAP + PADDING && sx + width + GAP > viewport.width - PADDING;
    const leftSide = sx >= width + GAP + PADDING || sx + width + GAP > viewport.width - PADDING;
    const left = clamp(vertical ? sx - width / 2 : leftSide ? sx - width - GAP : sx + GAP, PADDING, Math.max(PADDING, viewport.width - width - PADDING));
    const preferredTop = vertical ? sy >= LABEL_HEIGHT + GAP + PADDING ? sy - LABEL_HEIGHT - GAP : sy + GAP : sy - LABEL_HEIGHT / 2;
    return { marker, sx, sy, width, left, vertical, top: clamp(preferredTop, PADDING, Math.max(PADDING, viewport.height - LABEL_HEIGHT - PADDING)) };
  });

  // 只调整实际重叠的标签；不会因为拖动跨过屏幕中线而整列跳边。
  const placed: typeof nodes = [];
  for (const node of nodes.sort((a, b) => a.sy - b.sy || a.sx - b.sx)) {
    const preferred = node.top;
    for (let step = 0; step < nodes.length * 2; step++) {
      const offset = step === 0 ? 0 : Math.ceil(step / 2) * 46 * (step % 2 ? 1 : -1);
      const candidate = clamp(preferred + offset, PADDING, Math.max(PADDING, viewport.height - LABEL_HEIGHT - PADDING));
      const overlaps = placed.some((other) => node.left < other.left + other.width + 4 && node.left + node.width + 4 > other.left && candidate < other.top + LABEL_HEIGHT + 2 && candidate + LABEL_HEIGHT + 2 > other.top);
      if (!overlaps) { node.top = candidate; break; }
    }
    placed.push(node);
  }
  return placed.map((node) => {
    if (node.vertical) {
      const edgeY = node.top + LABEL_HEIGHT / 2 < node.sy ? node.top + LABEL_HEIGHT : node.top;
      return { ...node, path: `M ${node.sx} ${node.sy} V ${edgeY}` };
    }
    const edgeX = node.left + node.width / 2 < node.sx ? node.left + node.width : node.left;
    const edgeY = node.top + LABEL_HEIGHT / 2;
    const midX = (node.sx + edgeX) / 2;
    return { ...node, path: `M ${node.sx} ${node.sy} H ${midX} V ${edgeY} H ${edgeX}` };
  });
}
