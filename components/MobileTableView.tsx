"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  MagnifyingGlass,
  X,
  ImageBroken,
  Pencil,
  Check,
  Trash,
  Camera,
  Flame,
} from "@phosphor-icons/react";
import type { Priority, WishItem } from "@/lib/types";
import { getVisibleWishNote } from "@/lib/match-review";
import { NOTE_MAX_LENGTH, OPEN_INFO_MAX_LENGTH, STATUS_TEXT, PRIORITY_COLOR, PRIORITY_ORDER } from "@/lib/types";
import {
  CPG_VENUE_ORDER,
  compareWishItemsByLocation,
  getWishItemVenue,
} from "@/lib/wish-item-sort";
import { ImageUploadProgress } from "@/components/ImageUploadProgress";
import { uploadWishItemImage, WISH_ITEM_IMAGE_MAX_BYTES } from "@/lib/wish-item-image-upload";

// ============================================================
// 类型
// ============================================================

interface MobileTableViewProps {
  eventId: string;
  items: WishItem[];
  onUpdateItem: (id: string, field: keyof WishItem, value: any) => void;
  onSaveItem: (item: WishItem) => Promise<WishItem>;
  onRemoveItem: (id: string) => void | Promise<void>;
}

type FilterMode = "all" | "unpurchased";
type SortMode = "default" | "priority" | "hot";

const PRIORITY_OPTIONS: Priority[] = ["首摊", "次摊", "P1", "P2", "P3", "随缘"];

// ============================================================
// 状态循环逻辑
// ============================================================

const PAID_STATUS_CYCLE = ["pending", "已买待取", "purchased", "soldout"] as const;
const FREE_STATUS_CYCLE = ["待领取", "已领取"] as const;

function getNextStatus(current: string, type: "paid" | "free"): string {
  const cycle: readonly string[] = type === "free" ? FREE_STATUS_CYCLE : PAID_STATUS_CYCLE;
  const idx = cycle.indexOf(current);
  if (idx === -1 || idx === cycle.length - 1) return cycle[0];
  return cycle[idx + 1];
}

// ============================================================
// 区域提取（摊位号第一个汉字）
// ============================================================

function getArea(boothNumber: string): string {
  return getWishItemVenue({ boothNumber }) || "其他";
}

/**
 * 状态颜色 — 直接返回 Tailwind class（JIT 可检测）
 */
function getStatusColor(status: string): string {
  switch (status) {
    case "pending":
    case "待领取":
      return "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300";
    case "已买待取":
      return "bg-violet-100 text-violet-900 ring-1 ring-inset ring-violet-300";
    case "purchased":
    case "已领取":
      return "bg-emerald-100 text-emerald-900 ring-1 ring-inset ring-emerald-300";
    case "soldout":
      return "bg-rose-100 text-rose-900 ring-1 ring-inset ring-rose-300";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

// ============================================================
// 组件
// ============================================================

export function MobileTableView({ eventId, items, onUpdateItem, onSaveItem, onRemoveItem }: MobileTableViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [drawerItem, setDrawerItem] = useState<WishItem | null>(null);
  const [imageUploadProgress, setImageUploadProgress] = useState<number | null>(null);
  const [drawerEditing, setDrawerEditing] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [quantityInput, setQuantityInput] = useState("1");
  const [swipedItemId, setSwipedItemId] = useState<string | null>(null);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const [completingBoothKey, setCompletingBoothKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const swipeStartRef = useRef<{ id: string; x: number; y: number } | null>(null);

  // ---- 过滤 + 排序 ----

  const processedItems = useMemo(() => {
    let result = [...items];

    // 搜索
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (item) =>
          item.boothNumber.toLowerCase().includes(q) ||
          item.productName.toLowerCase().includes(q) ||
          (item.author && item.author.toLowerCase().includes(q))
      );
    }

    // 筛选
    if (filterMode === "unpurchased") {
      result = result.filter(
        (item) => item.status === "pending" || item.status === "已买待取" || item.status === "待领取"
      );
    }

    // 区域筛选
    if (selectedArea) {
      result = result.filter((item) => getArea(item.boothNumber) === selectedArea);
    }

    // 排序：默认按摊位号，优先级/热度可切换/取消
    result.sort((a, b) => {
      const locationCompare = compareWishItemsByLocation(a, b);

      if (sortMode === "hot") {
        const aHot = a.hotCount || 0;
        const bHot = b.hotCount || 0;
        if (aHot !== bHot) return bHot - aHot;
      }

      if (sortMode === "priority") {
        const aP = PRIORITY_ORDER[a.priority || "随缘"] || 6;
        const bP = PRIORITY_ORDER[b.priority || "随缘"] || 6;
        if (aP !== bP) return aP - bP;
      }

      return locationCompare;
    });

    return result;
  }, [items, searchQuery, filterMode, selectedArea, sortMode]);

  const boothGroups = useMemo(() => {
    const groups: Array<{
      key: string;
      venue: string;
      boothNumber: string;
      items: WishItem[];
    }> = [];
    const groupsByKey = new Map<string, (typeof groups)[number]>();

    processedItems.forEach((item) => {
      const boothNumber = item.boothNumber.trim();
      const venue = getArea(boothNumber);
      const key = boothNumber ? `${venue}:${boothNumber}` : `unassigned:${item.id}`;
      let group = groupsByKey.get(key);
      if (!group) {
        group = { key, venue, boothNumber, items: [] };
        groupsByKey.set(key, group);
        groups.push(group);
      }
      group.items.push(item);
    });

    return groups;
  }, [processedItems]);

  // ---- 区域列表 ----

  const areas = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => {
      const area = getArea(item.boothNumber);
      if (area !== "其他") set.add(area);
    });
    // 按 AREA_ORDER 排序，没有的放最后
    return CPG_VENUE_ORDER.filter((area) => set.has(area));
  }, [items]);

  // ---- 状态切换 ----

  const handleStatusCycle = (item: WishItem) => {
    const next = getNextStatus(item.status, item.type || "paid");
    onUpdateItem(item.id, "status", next);
    // 更新 drawer 中的 item
    setDrawerItem((prev) => (prev && prev.id === item.id ? { ...prev, status: next } : prev));
  };

  // ---- Drawer 内编辑 ----

  const handleDrawerUpdate = (field: keyof WishItem, value: any) => {
    if (!drawerItem) return;
    const limitedValue = field === "openInfo" && typeof value === "string"
      ? value.slice(0, OPEN_INFO_MAX_LENGTH)
      : field === "note" && typeof value === "string"
        ? value.slice(0, NOTE_MAX_LENGTH)
        : value;
    setDrawerItem((prev) => (prev && prev.id === drawerItem.id ? { ...prev, [field]: limitedValue } : prev));
  };

  const handleCompleteBooth = async (groupKey: string, groupItems: WishItem[]) => {
    const pendingItems = groupItems.filter(
      (item) => item.status === "pending" || item.status === "已买待取" || item.status === "待领取"
    );
    if (pendingItems.length === 0 || completingBoothKey) return;

    setCompletingBoothKey(groupKey);
    try {
      for (const item of pendingItems) {
        await onSaveItem({
          ...item,
          status: item.type === "free" ? "已领取" : "purchased",
        });
      }
    } catch (error) {
      alert("本摊标记失败: " + (error as Error).message);
    } finally {
      setCompletingBoothKey(null);
    }
  };

  const handleDrawerTypeChange = (type: "paid" | "free") => {
    if (!drawerItem || drawerItem.type === type) return;
    setDrawerItem((prev) => {
      if (!prev) return prev;
      return type === "free"
        ? { ...prev, type, status: "待领取", price: undefined }
        : { ...prev, type, status: "pending" };
    });
  };

  const handleDrawerSave = async () => {
    if (!drawerItem) return;
    try {
      await onSaveItem(drawerItem);
      setDrawerItem(null);
      setDrawerEditing(false);
      setDetailsExpanded(false);
    } catch (error) {
      alert("保存失败: " + (error as Error).message);
    }
  };

  const handleDrawerImageInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("请选择图片文件");
      return;
    }
    if (file.size > WISH_ITEM_IMAGE_MAX_BYTES) {
      alert("图片大小不能超过 5MB");
      return;
    }
    try {
      const uploadedUrl = await uploadWishItemImage(eventId, file, setImageUploadProgress);
      handleDrawerUpdate("imageUrl", uploadedUrl);
      window.setTimeout(() => setImageUploadProgress(null), 800);
    } catch (error) {
      setImageUploadProgress(null);
      alert(error instanceof Error ? error.message : "图片读取失败");
    }
  };

  const handleDrawerDelete = async () => {
    if (!drawerItem) return;
    if (confirm("确定删除这一行吗？")) {
      try {
        setDeletingItemId(drawerItem.id);
        await onRemoveItem(drawerItem.id);
        setDrawerItem(null);
      } catch (error) {
        alert("删除失败: " + (error as Error).message);
      } finally {
        setDeletingItemId(null);
      }
    }
  };

  const handleSwipeStart = (event: React.PointerEvent, itemId: string) => {
    swipeStartRef.current = { id: itemId, x: event.clientX, y: event.clientY };
  };

  const handleSwipeEnd = (event: React.PointerEvent, itemId: string) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start || start.id !== itemId) return;

    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) <= Math.abs(deltaY) || Math.abs(deltaX) < 36) return;
    if (deltaX < 0) setSwipedItemId(itemId);
    else if (swipedItemId === itemId) setSwipedItemId(null);
  };

  const handleSwipeDelete = async (itemId: string) => {
    if (!confirm("确定删除这一行吗？")) {
      setSwipedItemId(null);
      return;
    }
    try {
      setDeletingItemId(itemId);
      await onRemoveItem(itemId);
      setSwipedItemId(null);
    } catch (error) {
      alert("删除失败: " + (error as Error).message);
    } finally {
      setDeletingItemId(null);
    }
  };

  // ---- 点击列表外部关闭 drawer ----

  useEffect(() => {
    if (!drawerItem) return;
    const handler = (e: MouseEvent) => {
      // 点击drawer外部关闭
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [drawerItem]);

  // ---- 渲染 ----

  return (
    <div>
      {/* ---- 搜索栏 ---- */}
      <div className="border-b border-slate-200 bg-white px-3 pt-3 pb-2">
        <div className="relative">
          <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="搜索摊位号 / 商品名 / 作者"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-8 py-2 bg-slate-100 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* ---- 筛选 + 排序 ---- */}
      <div className="sticky top-0 z-20 flex items-center gap-2 overflow-x-auto border-b border-slate-100 bg-white px-3 py-2">
        <button
          onClick={() => setFilterMode(filterMode === "all" ? "unpurchased" : "all")}
          className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
            filterMode === "unpurchased"
              ? "bg-indigo-600 text-white"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          {filterMode === "unpurchased" ? "✓ 只看未买/取" : "只看未买/取"}
        </button>
        <div className="relative">
          <button
            onClick={() => setSortMode(sortMode === "priority" ? "default" : "priority")}
            className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap flex items-center gap-1 ${
              sortMode === "priority" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"
            }`}
          >
            优先级
          </button>
        </div>
        <div className="relative">
          <button
            onClick={() => setSortMode(sortMode === "hot" ? "default" : "hot")}
            className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap flex items-center gap-1 ${
              sortMode === "hot" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"
            }`}
          >
            热度
            <Flame className={`w-3 h-3 ${sortMode === "hot" ? "text-white" : "text-slate-400"}`} />
          </button>
        </div>
      </div>

      {/* ---- 区域快跳 ---- */}
      {areas.length > 0 && (
        <div className="sticky top-[41px] z-[19] flex gap-1.5 overflow-x-auto border-b border-slate-100 bg-white px-3 py-2">
          <button
            onClick={() => setSelectedArea(null)}
            className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors ${
              !selectedArea ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600"
            }`}
          >
            全部
          </button>
          {areas.map((area) => (
            <button
              key={area}
              onClick={() => setSelectedArea(selectedArea === area ? null : area)}
              className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors ${
                selectedArea === area ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              {area}
            </button>
          ))}
        </div>
      )}

      {/* ---- 表格 ---- */}
      <div ref={listRef}>
        {processedItems.length === 0 ? (
          <div className="text-center py-16 text-slate-400 text-sm">
            {items.length === 0 ? "暂无list条目" : "没有匹配的结果"}
          </div>
        ) : (
          <div className="space-y-2 bg-slate-100 py-2">
            {boothGroups.map((group) => {
              const pendingCount = group.items.filter(
                (item) => item.status === "pending" || item.status === "已买待取" || item.status === "待领取"
              ).length;
              return (
              <section
                key={group.key}
                className="mx-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              >
                {group.items.length > 1 && (
                  <div className="flex h-9 items-center justify-between gap-2 border-b border-slate-100 bg-white px-3">
                    <div className="min-w-0 truncate">
                      <span className="text-xs font-semibold text-slate-700">
                        {group.boothNumber
                          ? group.venue === "其他"
                            ? group.boothNumber
                            : `${group.venue}馆 · ${group.boothNumber}`
                          : "未匹配摊位"}
                      </span>
                      <span className="ml-1.5 text-[11px] text-slate-400">{group.items.length} 件</span>
                    </div>
                    {group.boothNumber && (
                      <button
                        type="button"
                        onClick={() => void handleCompleteBooth(group.key, group.items)}
                        disabled={pendingCount === 0 || completingBoothKey !== null}
                        className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium whitespace-nowrap ${
                          getStatusColor(pendingCount === 0 ? "purchased" : "pending")
                        } disabled:opacity-60`}
                      >
                        {completingBoothKey === group.key
                          ? "标记中…"
                          : pendingCount === 0
                            ? "已完成"
                            : "本摊完成"}
                      </button>
                    )}
                  </div>
                )}
                {group.items.map((item) => (
              <div
                key={item.id}
                data-mobile-wish-row
                data-item-id={item.id}
                className="relative overflow-hidden border-b border-slate-100 last:border-b-0"
              >
                {swipedItemId === item.id && (
                  <button
                    type="button"
                    onClick={() => void handleSwipeDelete(item.id)}
                    disabled={deletingItemId === item.id}
                    aria-label={`删除${item.productName || "这一项"}`}
                    className="absolute inset-y-0 right-0 flex w-20 items-center justify-center gap-1 bg-rose-600 text-sm font-medium text-white disabled:opacity-60"
                  >
                    <Trash className="h-4 w-4" />
                    {deletingItemId === item.id ? "删除中" : "删除"}
                  </button>
                )}
                <div
                  onPointerDown={(event) => handleSwipeStart(event, item.id)}
                  onPointerUp={(event) => handleSwipeEnd(event, item.id)}
                  onPointerCancel={() => {
                    swipeStartRef.current = null;
                  }}
                  onClick={() => {
                    if (swipedItemId) {
                      setSwipedItemId(null);
                      return;
                    }
                    setDrawerItem(item);
                    setQuantityInput(String(item.quantity ?? 1));
                    setDrawerEditing(true);
                    setDetailsExpanded(false);
                  }}
                  className={`relative z-10 flex items-center bg-white active:bg-slate-50 transition-transform duration-200 ${
                    swipedItemId === item.id ? "-translate-x-20" : "translate-x-0"
                  }`}
                  style={{ minHeight: 56, touchAction: "pan-y" }}
                >
                {/* 图片 */}
                <div className="w-12 h-12 flex-shrink-0 p-1.5">
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt=""
                      className="w-full h-full object-cover rounded"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full bg-slate-100 rounded flex items-center justify-center">
                      <ImageBroken className="w-4 h-4 text-slate-300" />
                    </div>
                  )}
                </div>

                {/* 摊位号 */}
                <div className="w-14 flex-shrink-0 px-1">
                  <span className="text-sm font-bold text-slate-900">{item.boothNumber || "-"}</span>
                </div>

                {/* 商品名 */}
                <div className="flex-1 min-w-0 px-1">
                  <div className="text-sm text-slate-800 truncate">{item.productName || "-"}</div>
                  {item.author && (
                    <div className="text-xs text-slate-400 truncate">{item.author}</div>
                  )}
                </div>

                {/* 优先级；数量大于 1 时紧邻展示数量 */}
                <div className="flex flex-shrink-0 items-center justify-center gap-1 px-0.5">
                  <span
                    className={`inline-flex min-w-8 items-center justify-center rounded border px-1 py-0.5 text-[11px] font-medium whitespace-nowrap ${
                      PRIORITY_COLOR[item.priority || "随缘"]
                    }`}
                  >
                    {item.priority || "随缘"}
                  </span>
                  {(item.quantity ?? 1) > 1 && (
                    <span className="inline-flex min-w-7 items-center justify-center rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 whitespace-nowrap">
                      ×{item.quantity}
                    </span>
                  )}
                </div>

                {/* 状态 */}
                <div className="flex w-[4.25rem] flex-shrink-0 justify-end px-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStatusCycle(item);
                    }}
                    className={`rounded-full px-1.5 py-1 text-xs font-medium whitespace-nowrap ${getStatusColor(item.status)}`}
                  >
                    {STATUS_TEXT[item.status] || item.status}
                  </button>
                </div>
                </div>
              </div>
                ))}
              </section>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- 计数 ---- */}
      <div className="px-3 py-2 bg-white border-t border-slate-200 text-xs text-slate-500 flex justify-between">
        <span>
          共 {processedItems.length} 件
          {filterMode === "unpurchased" || selectedArea ? ` / 总计 ${items.length} 件` : ""}
        </span>
        <span>
          已买/取 {items.filter((i) => i.status === "purchased" || i.status === "已领取").length} ·
          待买/取 {items.filter((i) => i.status === "pending" || i.status === "已买待取" || i.status === "待领取").length}
        </span>
      </div>

      {/* ============================================================ */}
      {/* ---- 底部抽屉 ---- */}
      {/* ============================================================ */}

      {drawerItem && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          {/* 遮罩 */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => { setDrawerItem(null); setDrawerEditing(false); setDetailsExpanded(false); }}
          />

          {/* 抽屉内容 */}
          <div className="relative flex max-h-[92vh] max-h-[92dvh] min-h-0 flex-col overflow-hidden rounded-t-2xl bg-white animate-slide-up">
            {/* 拖拽条 */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-slate-300" />
            </div>

            {/* 关闭按钮 */}
            <button
              onClick={() => { setDrawerItem(null); setDrawerEditing(false); setDetailsExpanded(false); }}
              className="absolute top-3 right-4 z-20 w-10 h-10 rounded-full bg-white/95 shadow-sm border border-slate-100 text-slate-500 hover:text-slate-700 flex items-center justify-center"
            >
              <X className="w-6 h-6" />
            </button>

            {/* 可滚动内容 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
              {/* 大图 + 上传按钮 */}
              <div className="relative w-full h-56 bg-slate-100 rounded-xl overflow-hidden mb-4 flex items-center justify-center">
                {drawerItem.imageUrl ? (
                  <img
                    src={drawerItem.imageUrl}
                    alt={drawerItem.productName}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <ImageBroken className="w-12 h-12 text-slate-300" />
                )}
                {/* 上传按钮 */}
                <div className="absolute bottom-2 right-2 flex gap-2">
                  <label className="bg-white/95 backdrop-blur-sm px-3 py-2 rounded-full shadow-lg cursor-pointer active:scale-95 transition-transform flex items-center gap-1.5 text-xs font-medium text-slate-700">
                    <Camera className="w-4 h-4" />
                    拍照
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={(e) => handleDrawerImageInput(e)}
                    />
                  </label>
                  <label className="bg-white/95 backdrop-blur-sm px-3 py-2 rounded-full shadow-lg cursor-pointer active:scale-95 transition-transform flex items-center gap-1.5 text-xs font-medium text-slate-700">
                    相册
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => handleDrawerImageInput(e)}
                    />
                  </label>
                </div>
                <ImageUploadProgress percent={imageUploadProgress} />
              </div>

              {/* 基本信息 */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base font-bold text-slate-900">{drawerItem.boothNumber}</span>
                  {drawerEditing ? (
                    <div className="flex rounded-lg bg-slate-100 p-0.5" aria-label="制品类型">
                      {([
                        { value: "paid", label: "有料" },
                        { value: "free", label: "无料" },
                      ] as const).map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => handleDrawerTypeChange(option.value)}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                            drawerItem.type === option.value
                              ? "bg-[#7F867B] text-white shadow-sm"
                              : "text-slate-600"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${
                        drawerItem.type === "free"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {drawerItem.type === "free" ? "无料" : "有料"}
                    </span>
                  )}
                  <span
                    className={`rounded border px-2 py-0.5 text-xs font-medium ${
                      PRIORITY_COLOR[drawerItem.priority || "随缘"]
                    }`}
                  >
                    {drawerItem.priority || "随缘"}
                  </span>
                  {/* 热度 */}
                  {(drawerItem.hotCount !== undefined && drawerItem.hotCount > 0) && (
                    <span className="flex items-center gap-0.5 text-xs text-orange-600 font-medium">
                      <Flame className="w-3 h-3" />
                      {drawerItem.hotCount}
                    </span>
                  )}
                </div>
                <div className="text-base text-slate-800 font-medium mb-1">
                  {drawerItem.productName}
                </div>
                {drawerItem.author && (
                  <div className="text-sm text-slate-500">{drawerItem.author}</div>
                )}
              </div>

              {/* ---- 单价 / 数量 / 状态（紧跟商品信息，无需滚动） ---- */}
              {drawerItem.type === "free" ? (
                /* 无料：只显示数量和状态 */
                <div className="flex items-end gap-3 mb-4">
                  <div className="w-20 flex-shrink-0">
                    <label className="block text-xs text-slate-400 mb-1">数量</label>
                    {drawerEditing ? (
                      <input
                        type="number"
                        min={0}
                        value={quantityInput}
                        onChange={(e) => {
                          setQuantityInput(e.target.value);
                          handleDrawerUpdate("quantity", e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)));
                        }}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    ) : (
                      <div className="px-3 py-2 text-sm font-medium text-slate-800 text-center">
                        {drawerItem.quantity ?? 1}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* 有料：单价 + 数量 + 总价 */
                <div className="flex items-end gap-3 mb-4">
                  <div className="flex-1 min-w-0">
                    <label className="block text-xs text-slate-400 mb-1">单价</label>
                    {drawerEditing ? (
                      <input
                        type="number"
                        value={drawerItem.price?.toString() || ""}
                        onChange={(e) => handleDrawerUpdate("price", e.target.value ? Number(e.target.value) : undefined)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="¥"
                      />
                    ) : (
                      <div className="px-3 py-2 text-sm font-medium text-slate-800">
                        {drawerItem.price != null ? `¥${drawerItem.price}` : "-"}
                      </div>
                    )}
                  </div>
                  <div className="w-20 flex-shrink-0">
                    <label className="block text-xs text-slate-400 mb-1">数量</label>
                    {drawerEditing ? (
                      <input
                        type="number"
                        min={0}
                        value={quantityInput}
                        onChange={(e) => {
                          setQuantityInput(e.target.value);
                          handleDrawerUpdate("quantity", e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)));
                        }}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    ) : (
                      <div className="px-3 py-2 text-sm font-medium text-slate-800 text-center">
                        {drawerItem.quantity ?? 1}
                      </div>
                    )}
                  </div>
                  <div className="w-24 flex-shrink-0">
                    <label className="block text-xs text-slate-400 mb-1">总价</label>
                    <div className="px-3 py-2 text-sm font-bold text-indigo-600">
                      {drawerItem.price != null && drawerItem.quantity != null
                        ? `¥${(drawerItem.price * drawerItem.quantity).toFixed(2)}`
                        : "-"}
                    </div>
                  </div>
                </div>
              )}

              {/* ---- 状态切换按钮 ---- */}
              <div className="mb-4">
                <div className="text-xs text-slate-400 mb-2">状态</div>
                <div className="grid grid-cols-2 gap-2">
                  {(drawerItem.type === "free"
                    ? [
                        { value: "待领取", label: "待领取" },
                        { value: "已领取", label: "已领取" },
                      ]
                    : [
                        { value: "pending", label: "待购买" },
                        { value: "已买待取", label: "已买待取" },
                        { value: "purchased", label: "已购买" },
                        { value: "soldout", label: "已售罄" },
                      ]
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleDrawerUpdate("status", opt.value)}
                      className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                        drawerItem.status === opt.value
                          ? getStatusColor(opt.value)
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {opt.label}
                      {drawerItem.status === opt.value && " ✓"}
                    </button>
                  ))}
                </div>
              </div>

              {/* ---- 优先级 ---- */}
              <div className="mb-4">
                <div className="text-xs text-slate-400 mb-2">优先级</div>
                {drawerEditing ? (
                  <div className="grid grid-cols-3 gap-2">
                    {PRIORITY_OPTIONS.map((priority) => {
                      const selected = (drawerItem.priority || "随缘") === priority;
                      return (
                        <button
                          key={priority}
                          type="button"
                          onClick={() => handleDrawerUpdate("priority", priority)}
                          className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                            selected
                              ? `${PRIORITY_COLOR[priority]} ring-2 ring-offset-1 ring-slate-300`
                              : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                          }`}
                        >
                          {priority}{selected && " ✓"}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <span
                    className={`inline-flex rounded border px-2.5 py-1 text-sm font-medium ${
                      PRIORITY_COLOR[drawerItem.priority || "随缘"]
                    }`}
                  >
                    {drawerItem.priority || "随缘"}
                  </span>
                )}
              </div>

              {/* ---- 开摊信息：位于状态之后、备注之前 ---- */}
              <div className="mb-4">
                {drawerEditing ? (
                  <EditField
                    label="开摊信息"
                    value={drawerItem.openInfo || ""}
                    onChange={(value) => handleDrawerUpdate("openInfo", value)}
                    multiline
                    maxLength={OPEN_INFO_MAX_LENGTH}
                  />
                ) : (
                  <div className="rounded-lg bg-slate-50 p-3">
                    <div className="mb-1 text-xs text-slate-400">开摊信息</div>
                    <div className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                      {drawerItem.openInfo || "-"}
                    </div>
                  </div>
                )}
              </div>

              {/* 编辑模式 vs 查看模式 */}
              {drawerEditing ? (
                <div className="space-y-3 mb-4">
                  <EditField label="备注" value={getVisibleWishNote(drawerItem.note)} onChange={(v) => handleDrawerUpdate("note", v)} multiline maxLength={NOTE_MAX_LENGTH} />
                  <EditField label="制品名称" value={drawerItem.productName} onChange={(v) => handleDrawerUpdate("productName", v)} />
                  <EditField label="作者" value={drawerItem.author || ""} onChange={(v) => handleDrawerUpdate("author", v)} />
                </div>
              ) : (
                <>
                  {/* 备注 */}
                  {drawerItem.note && (
                    <div className="mb-4 p-3 bg-slate-50 rounded-lg">
                      <div className="text-xs text-slate-400 mb-1">备注</div>
                      <div className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{getVisibleWishNote(drawerItem.note)}</div>
                    </div>
                  )}
                </>
              )}

              {/* 详情 */}
              {drawerItem.description && (
                <div className="mb-4 rounded-lg border border-amber-100 bg-amber-50 overflow-hidden">
                  <button
                    onClick={() => setDetailsExpanded((value) => !value)}
                    className="w-full px-3 py-2.5 flex items-center justify-between text-left"
                  >
                    <span className="text-sm text-amber-800 font-medium">展品详情</span>
                    <span className="text-xs text-amber-700">{detailsExpanded ? "收起" : "展开"}</span>
                  </button>
                  {detailsExpanded && (
                    <div className="px-3 pb-3 text-sm text-amber-900 leading-relaxed whitespace-pre-wrap">
                      {drawerItem.description}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ---- 底部操作栏 ---- */}
            <div className="border-t border-slate-200 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] flex gap-2">
              <button
                onClick={() => {
                  if (drawerEditing) {
                    void handleDrawerSave();
                  } else {
                    setDrawerEditing(true);
                  }
                }}
                disabled={imageUploadProgress !== null}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors disabled:cursor-wait disabled:opacity-60 ${
                  drawerEditing
                    ? "bg-green-600 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {drawerEditing ? <Check className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                {imageUploadProgress !== null ? "图片处理中" : drawerEditing ? "保存" : "编辑"}
              </button>
              <button
                onClick={handleDrawerDelete}
                disabled={deletingItemId === drawerItem.id}
                className="px-4 py-2.5 rounded-lg text-sm font-medium bg-rose-50 text-rose-600 hover:bg-rose-100 transition-colors flex items-center gap-1.5"
              >
                <Trash className="w-4 h-4" />
                {deletingItemId === drawerItem.id ? "删除中" : "删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 编辑字段组件
// ============================================================

function EditField({
  label,
  value,
  onChange,
  multiline,
  type,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  type?: string;
  maxLength?: number;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-400">
        <label>{label}</label>
        {maxLength && <span>{value.length}/{maxLength}</span>}
      </div>
      {multiline ? (
        <textarea
          value={value}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      ) : (
        <input
          type={type || "text"}
          value={value}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      )}
    </div>
  );
}
