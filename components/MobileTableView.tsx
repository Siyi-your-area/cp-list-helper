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
import type { WishItem } from "@/lib/types";
import { getVisibleWishNote } from "@/lib/match-review";
import { STATUS_TEXT, PRIORITY_ORDER } from "@/lib/types";

// ============================================================
// 类型
// ============================================================

interface MobileTableViewProps {
  items: WishItem[];
  onUpdateItem: (id: string, field: keyof WishItem, value: any) => void;
  onSaveItem: (item: WishItem) => Promise<void>;
  onRemoveItem: (id: string) => void | Promise<void>;
}

type FilterMode = "all" | "unpurchased";
type SortMode = "default" | "priority" | "hot";

// ============================================================
// 状态循环逻辑
// ============================================================

const PAID_STATUS_CYCLE = ["pending", "purchased", "soldout"] as const;
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
  if (!boothNumber) return "其他";
  const first = boothNumber.charAt(0);
  // 中文字符
  if (/[一-龥]/.test(first)) return first;
  return "其他";
}

const AREA_ORDER = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];

/**
 * 状态颜色 — 直接返回 Tailwind class（JIT 可检测）
 */
function getStatusColor(status: string): string {
  switch (status) {
    case "pending":
    case "待领取":
      return "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300";
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

export function MobileTableView({ items, onUpdateItem, onSaveItem, onRemoveItem }: MobileTableViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [drawerItem, setDrawerItem] = useState<WishItem | null>(null);
  const [drawerEditing, setDrawerEditing] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [quantityInput, setQuantityInput] = useState("1");
  const [swipedItemId, setSwipedItemId] = useState<string | null>(null);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
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
      result = result.filter((item) => {
        if (item.type === "free") return item.status !== "已领取";
        return item.status !== "purchased" && item.status !== "soldout";
      });
    }

    // 区域筛选
    if (selectedArea) {
      result = result.filter((item) => getArea(item.boothNumber) === selectedArea);
    }

    // 排序：默认按摊位号，优先级/热度可切换/取消
    result.sort((a, b) => {
      const boothCompare = a.boothNumber.localeCompare(b.boothNumber, "zh-Hans-CN", {
        numeric: true,
        sensitivity: "base",
      });

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

      return boothCompare;
    });

    return result;
  }, [items, searchQuery, filterMode, selectedArea, sortMode]);

  // ---- 区域列表 ----

  const areas = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => {
      const area = getArea(item.boothNumber);
      if (area !== "其他") set.add(area);
    });
    // 按 AREA_ORDER 排序，没有的放最后
    return AREA_ORDER.filter((a) => set.has(a));
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
    setDrawerItem((prev) => (prev && prev.id === drawerItem.id ? { ...prev, [field]: value } : prev));
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
      setDrawerEditing(false);
    } catch (error) {
      alert("保存失败: " + (error as Error).message);
    }
  };

  const handleDrawerImageInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("请选择图片文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("图片大小不能超过 5MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      handleDrawerUpdate("imageUrl", dataUrl);
    };
    reader.readAsDataURL(file);
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
    <div className="flex flex-col h-full">
      {/* ---- 搜索栏 ---- */}
      <div className="px-3 pt-3 pb-2 bg-white border-b border-slate-200 sticky top-0 z-20">
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
      <div className="px-3 py-2 bg-white border-b border-slate-100 flex items-center gap-2 overflow-x-auto sticky top-[57px] z-19">
        <button
          onClick={() => setFilterMode(filterMode === "all" ? "unpurchased" : "all")}
          className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
            filterMode === "unpurchased"
              ? "bg-indigo-600 text-white"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          {filterMode === "unpurchased" ? "✓ 只看未买" : "只看未买"}
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
        <div className="px-3 py-2 bg-white border-b border-slate-100 flex gap-1.5 overflow-x-auto sticky top-[93px] z-18">
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
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {processedItems.length === 0 ? (
          <div className="text-center py-16 text-slate-400 text-sm">
            {items.length === 0 ? "暂无心愿单条目" : "没有匹配的结果"}
          </div>
        ) : (
          <div>
            {processedItems.map((item) => (
              <div
                key={item.id}
                data-mobile-wish-row
                data-item-id={item.id}
                className="relative overflow-hidden border-b border-slate-100"
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

                {/* 状态 */}
                <div className="w-14 flex-shrink-0 px-1.5 flex justify-end">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStatusCycle(item);
                    }}
                    className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${getStatusColor(item.status)}`}
                  >
                    {STATUS_TEXT[item.status] || item.status}
                  </button>
                </div>
                </div>
              </div>
            ))}
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
          已买 {items.filter((i) => i.status === "purchased" || i.status === "已领取").length} ·
          待买 {items.filter((i) => i.status === "pending" || i.status === "待领取").length}
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
          <div className="relative bg-white rounded-t-2xl max-h-[92dvh] flex flex-col animate-slide-up">
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
            <div className="overflow-y-auto flex-1 px-4 pb-28">
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
                  {drawerItem.priority && (
                    <span className="text-xs text-slate-400">{drawerItem.priority}</span>
                  )}
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
                /* 有料：单价 + 数量 + 实付 */
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
                    <label className="block text-xs text-slate-400 mb-1">实付</label>
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

              {/* 编辑模式 vs 查看模式 */}
              {drawerEditing ? (
                <div className="space-y-3 mb-4">
                  {drawerItem.type !== "free" && (
                    <EditField label="备注" value={getVisibleWishNote(drawerItem.note)} onChange={(v) => handleDrawerUpdate("note", v)} multiline />
                  )}
                  <EditField label="制品名称" value={drawerItem.productName} onChange={(v) => handleDrawerUpdate("productName", v)} />
                  <EditField label="作者" value={drawerItem.author || ""} onChange={(v) => handleDrawerUpdate("author", v)} />
                </div>
              ) : (
                <>
                  {/* 备注 */}
                  {drawerItem.note && (
                    <div className="mb-4 p-3 bg-slate-50 rounded-lg">
                      <div className="text-xs text-slate-400 mb-1">备注</div>
                      <div className="text-sm text-slate-700">{getVisibleWishNote(drawerItem.note)}</div>
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
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors ${
                  drawerEditing
                    ? "bg-green-600 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {drawerEditing ? <Check className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                {drawerEditing ? "保存" : "编辑"}
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      ) : (
        <input
          type={type || "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      )}
    </div>
  );
}
