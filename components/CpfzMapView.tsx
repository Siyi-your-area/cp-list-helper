"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImageBroken, Minus, Plus, X } from "@phosphor-icons/react";
import type { WishItem } from "@/lib/types";
import { PRIORITY_COLOR, STATUS_TEXT } from "@/lib/types";
import { CPFZ_MAP_ASPECT } from "@/lib/cpfz-map-data";
import { buildCpfzBoothGroups, clusterCpfzBooths } from "@/lib/cpfz-map-model";
import { layoutCpfzMarkers, resizeCpfzMapTransform } from "@/lib/cpfz-marker-layout";
import { getStatusColor } from "@/components/mobile-wish-style";

const HALLS = ["壹", "贰", "叁", "肆", "玖"] as const;
const HALL_NUMBERS: Record<string, number> = { 壹: 1, 贰: 2, 叁: 3, 肆: 4, 玖: 9 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type Transform = { x: number; y: number; zoom: number };
type Gesture = { start: Map<number, { x: number; y: number }>; transform: Transform };

interface CpfzMapViewProps {
  items: WishItem[];
  pendingOnly: boolean;
  onTogglePending: () => void;
  onStatusCycle: (item: WishItem) => void;
  onBoothComplete: (key: string, items: WishItem[]) => void;
  onOpenItem: (item: WishItem) => void;
  saving: boolean;
  completingBoothKey: string | null;
}

export function CpfzMapView({ items, pendingOnly, onTogglePending, onStatusCycle, onBoothComplete, onOpenItem, saving, completingBoothKey }: CpfzMapViewProps) {
  const [hall, setHall] = useState<string>("壹");
  const [size, setSize] = useState({ width: 375, height: 490 });
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, zoom: 1 });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mapError, setMapError] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousGeometry = useRef<{ hall: string; width: number; height: number; imageWidth: number; imageHeight: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const aspect = hall === "玖" ? 2972 / 5677 : hall === "贰" || hall === "叁" ? 5677 / 2972 : CPFZ_MAP_ASPECT;
  const imageWidth = Math.max(size.width * 2.35, size.height * aspect);
  const imageHeight = imageWidth / aspect;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = () => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previous = previousGeometry.current;
    previousGeometry.current = { hall, width: size.width, height: size.height, imageWidth, imageHeight };
    if (!previous || previous.hall !== hall) {
      setTransform({ x: size.width / 2 - imageWidth * (hall === "玖" ? .5 : .42), y: size.height / 2 - imageHeight * .5, zoom: 1 });
      setSelectedKey(null);
      setMapError(false);
      return;
    }
    if (previous.width !== size.width || previous.height !== size.height || previous.imageWidth !== imageWidth || previous.imageHeight !== imageHeight) {
      setTransform((current) => resizeCpfzMapTransform(current, previous, { width: size.width, height: size.height, imageWidth, imageHeight }));
    }
  }, [hall, size.width, size.height, imageWidth, imageHeight]);

  const groups = useMemo(() => buildCpfzBoothGroups(items, pendingOnly).filter((group) => group.hall === hall), [items, pendingOnly, hall]);
  const selected = groups.find((group) => group.key === selectedKey) || null;
  const markers = useMemo(() => clusterCpfzBooths(groups, {
    x: transform.x, y: transform.y, imageWidth, imageHeight,
    viewWidth: size.width, viewHeight: size.height,
  }, transform.zoom), [groups, transform, imageWidth, imageHeight, size]);

  useEffect(() => {
    if (selectedKey && !selected) setSelectedKey(null);
  }, [selectedKey, selected]);

  const zoomAt = (nextZoom: number, centerX: number, centerY: number) => {
    setTransform((current) => {
      const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      const factor = zoom / current.zoom;
      return { zoom, x: centerX - (centerX - current.x) * factor, y: centerY - (centerY - current.y) * factor };
    });
  };

  const handleMarker = (marker: (typeof markers)[number]) => {
    const zoom = Math.min(MAX_ZOOM, Math.max(transform.zoom * 1.85, marker.groups.length > 1 ? 2.6 : 2.1));
    setTransform({
      zoom,
      x: size.width / 2 - marker.x * imageWidth * zoom,
      y: size.height / 2 - marker.y * imageHeight * zoom,
    });
    setSelectedKey(marker.groups.length === 1 ? marker.groups[0].key : null);
  };

  const localPoint = (event: React.PointerEvent) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) };
  };
  const resetGesture = () => { gesture.current = { start: new Map(pointers.current), transform }; };
  const onPointerDown = (event: React.PointerEvent) => {
    viewportRef.current?.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, localPoint(event));
    resetGesture();
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, localPoint(event));
    const before = [...gesture.current.start.values()];
    const after = [...pointers.current.values()];
    const base = gesture.current.transform;
    if (before.length === 1 && after.length === 1) {
      setTransform({ ...base, x: base.x + after[0].x - before[0].x, y: base.y + after[0].y - before[0].y });
    } else if (before.length >= 2 && after.length >= 2) {
      const distance = (points: typeof before) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const oldCenter = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
      const newCenter = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 };
      const zoom = clamp(base.zoom * distance(after) / Math.max(1, distance(before)), MIN_ZOOM, MAX_ZOOM);
      setTransform({ zoom, x: newCenter.x - (oldCenter.x - base.x) * zoom / base.zoom, y: newCenter.y - (oldCenter.y - base.y) * zoom / base.zoom });
    }
  };
  const onPointerEnd = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    gesture.current = null;
  };
  const openItem = (item: WishItem) => {
    onOpenItem(item);
  };

  const positioned = useMemo(() => layoutCpfzMarkers(markers, transform, { width: imageWidth, height: imageHeight }, size), [markers, transform, imageWidth, imageHeight, size]);

  const itemCard = (item: WishItem) => (
    <div key={item.id} className="flex min-h-14 items-center gap-1.5 border-b border-slate-100 px-2 last:border-b-0">
      <button type="button" onClick={() => openItem(item)} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left">
        {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" /> : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-slate-100"><ImageBroken className="h-4 w-4 text-slate-400" /></span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-slate-800">{item.productName || "-"}</span>
          <span className="block truncate text-xs text-slate-400">{item.author || "-"}</span>
        </span>
      </button>
      <span className={`inline-flex min-w-8 shrink-0 items-center justify-center rounded border px-1 py-0.5 text-[11px] font-medium whitespace-nowrap ${PRIORITY_COLOR[item.priority || "随缘"]}`}>{item.priority || "随缘"}</span>
      <button type="button" disabled={saving} onClick={() => onStatusCycle(item)} className="flex min-h-11 shrink-0 items-center disabled:opacity-50"><span className={`rounded-full px-1.5 py-1 text-xs font-medium whitespace-nowrap ${getStatusColor(item.status)}`}>{STATUS_TEXT[item.status] || item.status}</span></button>
    </div>
  );

  return <div className="bg-white">
    <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-100 bg-white px-3 py-1">
      <button type="button" onClick={onTogglePending} className={`min-h-11 shrink-0 rounded-full px-2 text-xs font-medium whitespace-nowrap transition-colors ${pendingOnly ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>{pendingOnly ? "✓ 只看未买/取" : "只看未买/取"}</button>

      {HALLS.map((option) => <button type="button" key={option} onClick={() => setHall(option)} aria-label={`${option}馆`} className={`min-h-11 min-w-11 shrink-0 rounded px-2 text-xs font-medium whitespace-nowrap transition-colors ${hall === option ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600"}`}>{option}</button>)}
    </div>
    <div ref={viewportRef} role="application" aria-label={`${hall}馆地图，可拖动及双指缩放`} className="relative h-[min(62dvh,560px)] min-h-[350px] w-full overflow-hidden bg-[#f5f6f3]" style={{ touchAction: "none" }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onWheel={(event) => { event.preventDefault(); zoomAt(transform.zoom * (event.deltaY > 0 ? .85 : 1.18), event.nativeEvent.offsetX, event.nativeEvent.offsetY); }}>
      <img src={`/cpfz-map/hall-${HALL_NUMBERS[hall]}.png`} alt={`${hall}馆官方场地图`} draggable={false} onError={() => setMapError(true)} className="pointer-events-none absolute max-w-none select-none" style={{ width: imageWidth * transform.zoom, height: imageHeight * transform.zoom, left: transform.x, top: transform.y }} />
      {mapError && <div className="absolute inset-x-4 top-1/2 rounded-lg bg-white px-3 py-2 text-center text-sm text-slate-600">地图尚未准备，请联网后重新打开</div>}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        {positioned.map((node) => <g key={node.marker.key}><path d={node.path} fill="none" stroke="#5d695d" strokeWidth="1.4" /><circle cx={node.sx} cy={node.sy} r="2.5" fill="#5d695d" /></g>)}
      </svg>
      {positioned.map((node) => <button type="button" key={node.marker.key} onPointerDown={(event) => event.stopPropagation()} onClick={() => handleMarker(node.marker)} style={{ left: node.left, top: node.top, width: node.width }} className="absolute z-10 flex min-h-11 items-center justify-center text-xs font-medium"><span className={`w-full rounded-md border px-2 py-1 text-center shadow-sm ${selectedKey === node.marker.groups[0]?.key && node.marker.groups.length === 1 ? "border-[#5d695d] bg-[#5d695d] text-white" : "border-[#b7c0b7] bg-white text-[#343d37]"}`}>{node.marker.label}</span></button>)}
      <div className="absolute bottom-3 right-3 z-20 flex flex-col gap-1">
        <button type="button" aria-label="放大地图" onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomAt(transform.zoom * 1.5, size.width / 2, size.height / 2)} className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white shadow"><Plus className="h-5 w-5" /></button>
        <button type="button" aria-label="缩小地图" onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomAt(transform.zoom / 1.5, size.width / 2, size.height / 2)} className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white shadow"><Minus className="h-5 w-5" /></button>
      </div>
    </div>
    {hall === "玖" && <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">玖馆暂不支持摊位定位，仅展示场地图。</p>}
    {selected && <section className="border-t border-slate-200 bg-[#f5f6f3] px-3 py-3">
      <div className="mb-2 flex items-center gap-2"><h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#343d37]">{selected.label} · {selected.items.length} 件</h3><button type="button" onClick={() => onBoothComplete(selected.key, selected.items)} disabled={!selected.items.some((item) => ["pending", "已买待取", "待领取"].includes(item.status)) || completingBoothKey !== null || saving} className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium whitespace-nowrap ${getStatusColor(selected.items.some((item) => ["pending", "已买待取", "待领取"].includes(item.status)) ? "pending" : "purchased")} disabled:opacity-60`}>{completingBoothKey === selected.key ? "标记中…" : selected.items.some((item) => ["pending", "已买待取", "待领取"].includes(item.status)) ? "本摊完成" : "已完成"}</button><button type="button" onClick={() => setSelectedKey(null)} aria-label="收起摊位清单" className="flex h-11 w-11 items-center justify-center"><X className="h-4 w-4" /></button></div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">{selected.items.map(itemCard)}</div>
    </section>}
  </div>;
}
