"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Pencil,
  Check,
  UploadSimple,
  FileArrowDown,
  Package,
  Clock,
  ShoppingBag,
  Flame,
  Gift,
  Wallet,
  MagnifyingGlass,
  X,
  ImageBroken,
  Trash,
  Plus,
  Camera,
  Copy,
  CheckCircle,
} from "@phosphor-icons/react";
import type { WishItem, MatchResult, MatchInput } from "@/lib/types";
import { STATUS_TEXT, PRIORITY_ORDER, PRIORITY_COLOR } from "@/lib/types";
import { parseExcelFile } from "@/lib/excel-parser";
import { useExhibitData } from "@/hooks/useExhibitData";
import { MobileTableView } from "@/components/MobileTableView";
import { getClientId } from "@/lib/client-id";

const PAGE_SIZE = 100;

/**
 * 状态颜色 — 直接返回 Tailwind class（JIT 可检测）
 * 待购买/待领取 → 淡蓝 | 已购买/已领取 → 淡绿 | 已售罄 → 淡红
 */
function getStatusColor(status: string): string {
  switch (status) {
    case "pending":
    case "待领取":
      return "bg-blue-100 text-blue-800";
    case "purchased":
    case "已领取":
      return "bg-green-100 text-green-800";
    case "soldout":
      return "bg-red-100 text-red-800";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

/**
 * 从 CPP 匹配结果推断有料/无料
 * 优先级：
 * 1. tags 包含 "无料" → free
 * 2. 商品名包含 "无料" → free
 * 3. tags 包含 "有偿" → paid
 * 4. 默认 paid
 */
function detectTypeFromCPP(result: MatchResult | undefined): "paid" | "free" {
  if (!result?.cppItem) return "paid";

  // 优先用交换状态判断（最准确）
  const exchangeType = result.cppItem.exchangeType || "";
  if (exchangeType.includes("无料")) return "free";
  if (exchangeType.includes("有偿")) return "paid";

  // 其次用标签判断
  const tags = result.cppItem.tags || [];
  if (tags.some((t) => t.includes("无料"))) return "free";
  // 商品名中也检查
  if (result.cppItem.productName.includes("无料")) return "free";
  if (tags.some((t) => t.includes("有偿"))) return "paid";
  return "paid";
}

async function imageUrlToExcelImage(
  imageUrl: string
): Promise<{ base64: string; extension: "png" | "jpeg" | "gif" } | null> {
  try {
    if (imageUrl.startsWith("data:image/")) {
      const match = imageUrl.match(/^data:image\/(png|jpeg|jpg|gif);base64,/i);
      const extension = match?.[1]?.toLowerCase() === "jpg" ? "jpeg" : match?.[1]?.toLowerCase();
      if (extension === "png" || extension === "jpeg" || extension === "gif") {
        return { base64: imageUrl, extension };
      }
      return null;
    }

    const response = await fetch(imageUrl);
    if (!response.ok) return null;

    const blob = await response.blob();
    const mime = blob.type || "image/png";
    const extension = mime.includes("jpeg") || mime.includes("jpg")
      ? "jpeg"
      : mime.includes("gif")
        ? "gif"
        : "png";

    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

    return { base64, extension };
  } catch {
    return null;
  }
}

export default function ExhibitDetail() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.id as string;

  const {
    items,
    eventInfo,
    loading,
    accessDenied,
    addItem,
    updateItem,
    updateItemLocally,
    saveItemDrafts,
    removeItem,
    removeItems,
    addItems,
    refresh,
  } = useExhibitData(eventId);

  const [searchKeyword, setSearchKeyword] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [isMatching, setIsMatching] = useState(false);
  const [matchStats, setMatchStats] = useState<any>(null);
  const [uploadingItems, setUploadingItems] = useState(false);
  const [desktopSortMode, setDesktopSortMode] = useState<"default" | "hot" | "priority">("default");
  const [uploadResult, setUploadResult] = useState<{ imported: number; matched: number; skipped: number } | null>(null);
  const [detailItem, setDetailItem] = useState<WishItem | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const dirtyItemIdsRef = useRef<Set<string>>(new Set());
  const [savingEdits, setSavingEdits] = useState(false);

  // ---- 分享码 ----
  const [shareCode, setShareCode] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // 页面加载时获取/生成分享码
    const clientId = getClientId();
    fetch(`/api/share?eventId=${encodeURIComponent(eventId)}&clientId=${encodeURIComponent(clientId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.code && data.code !== "NEED_MIGRATION") {
          setShareCode(data.code);
        }
      })
      .catch(() => {}); // 静默失败
  }, [eventId]);

  const handleCopyShareCode = async () => {
    if (!shareCode) return;
    try {
      await navigator.clipboard.writeText(shareCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const input = document.createElement("input");
      input.value = shareCode;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [searchKeyword]);

  useEffect(() => {
    if (!editMode) {
      setSelectedItemIds(new Set());
    }
  }, [editMode]);

  // ---- 操作函数 ----

  const handleDeleteItem = async (id: string) => {
    if (!confirm("确定删除这一行吗？")) return;
    await removeItem(id);
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleBatchDelete = async () => {
    const ids = Array.from(selectedItemIds);
    if (ids.length === 0) return;
    if (!confirm(`确定删除选中的 ${ids.length} 行吗？`)) return;

    await removeItems(ids);
    setSelectedItemIds(new Set());
  };

  const toggleSelectItem = (id: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectPage = () => {
    const pageIds = paginatedItems.map((item) => item.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedItemIds.has(id));
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      pageIds.forEach((id) => {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      });
      return next;
    });
  };

  const handleAddItem = async () => {
    await addItem({
      boothNumber: "",
      productName: "",
      author: "",
      venue: "",
      status: "pending",
      priority: "P1",
    });
    setTimeout(() => {
      setCurrentPage(Math.ceil((items.length + 1) / PAGE_SIZE));
    }, 100);
  };

  const handleUpdateItem = async (id: string, field: keyof WishItem, value: any) => {
    const updates: Partial<WishItem> = { [field]: value };
    if (field === "type" && value === "free") {
      updates.status = "待领取";
      updates.price = undefined;
    }
    if (field === "type" && value === "paid") {
      updates.status = "pending";
    }
    try {
      await updateItem(id, updates);
    } catch (error) {
      console.error(`更新失败 [${field}=${value}]:`, error);
      alert("更新失败: " + (error as Error).message);
    }
  };

  const handleDraftItem = (id: string, field: keyof WishItem, value: any) => {
    const updates: Partial<WishItem> = { [field]: value };
    if (field === "type" && value === "free") {
      updates.status = "待领取";
      updates.price = undefined;
    }
    if (field === "type" && value === "paid") {
      updates.status = "pending";
    }
    dirtyItemIdsRef.current.add(id);
    updateItemLocally(id, updates);
  };

  const handleToggleEditMode = async () => {
    if (!editMode) {
      dirtyItemIdsRef.current.clear();
      setEditMode(true);
      return;
    }

    try {
      setSavingEdits(true);
      await saveItemDrafts(Array.from(dirtyItemIdsRef.current));
      dirtyItemIdsRef.current.clear();
      setEditMode(false);
    } catch (error) {
      alert("保存失败: " + (error as Error).message);
    } finally {
      setSavingEdits(false);
    }
  };

  const handleSaveMobileItem = async (item: WishItem) => {
    updateItemLocally(item.id, item);
    await saveItemDrafts([item]);
  };

  // ---- 图片上传 ----

  /**
   * 将图片文件转为 base64 data URL 并存到对应条目
   */
  const handleImageFile = (itemId: string, file: File) => {
    if (!file.type.startsWith("image/")) {
      alert("请选择图片文件");
      return;
    }
    // 限制大小 2MB（localStorage 有容量限制）
    if (file.size > 2 * 1024 * 1024) {
      alert("图片大小不能超过 2MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      handleUpdateItem(itemId, "imageUrl", dataUrl);
    };
    reader.readAsDataURL(file);
  };

  /**
   * 全局粘贴事件处理 —— 在编辑模式下粘贴图片直接上传到对应行
   */
  useEffect(() => {
    if (!editMode) return;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      // 找到当前焦点所在的行
      const activeElement = document.activeElement;
      const row = activeElement?.closest("tr");
      const itemId = row?.getAttribute("data-item-id");
      if (!itemId) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) handleImageFile(itemId, file);
          break;
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [editMode, items]);

  // ---- Excel 上传 + 自动匹配 ----

  const handleUploadExcel = async (file: File) => {
    try {
      setUploadResult(null);
      // 1. 解析 Excel
      const inputs = await parseExcelFile(file);
      if (inputs.length === 0) {
        alert("Excel 中没有找到数据，请检查文件格式");
        return;
      }

      // 2. 去重
      const existingKeys = new Set(
        items.map((item) => `${item.boothNumber.trim()}|${item.productName.trim()}`)
      );

      const dedupedInputs: (MatchInput & { _skipped?: boolean })[] = inputs.map((input) => {
        const key = `${input.boothNumber.trim()}|${input.productName.trim()}`;
        if (existingKeys.has(key)) return { ...input, _skipped: true };
        return input;
      });

      const skippedCount = dedupedInputs.filter((d) => d._skipped).length;
      const newInputs = dedupedInputs.filter((d) => !d._skipped);

      if (newInputs.length === 0) {
        alert(`导入的 ${inputs.length} 条数据已全部存在，无需重复添加`);
        setIsUploadModalOpen(false);
        return;
      }

      // 3. 显示全局 Loading 并调用 API 匹配
      setUploadingItems(true);
      setIsMatching(true);
      setMatchStats(null);

      let results: MatchResult[] = [];
      try {
        const response = await fetch("/api/cpp/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: newInputs, eventId }),
        });
        const data = await response.json();
        results = data.results || [];
        setMatchStats(data.stats);
      } catch (err) {
        console.warn("API 匹配失败，使用无匹配模式:", err);
        results = newInputs.map(() => ({ matched: false, confidence: "none" as const, reason: "匹配服务不可用" }));
      }
      setIsMatching(false);

      // 4. 构建心愿单条目并批量保存
      const newItems: Omit<WishItem, "id">[] = newInputs.map((input, index) => {
        const result = results[index];
        const type = detectTypeFromCPP(result);
        return {
          boothNumber: input.boothNumber,
          productName: input.productName,
          author: input.author || result?.cppItem?.author || "",
          imageUrl: result?.cppItem?.imageUrl || "",
          venue: input.boothNumber.charAt(0) || "",
          type,
          status: type === "free" ? "待领取" : "pending",
          hotCount: result?.cppItem?.hotCount || 0,
          description: result?.cppItem?.description || "",
          matchedCPPItem: result?.cppItem,
          matchConfidence: result?.confidence,
        };
      });

      await addItems(newItems);

      // 5. Loading 完成，关闭弹窗
      setUploadingItems(false);

      const matchedCount = results.filter((r) => r.matched).length;
      setIsUploadModalOpen(false);
      setUploadResult({
        imported: newItems.length,
        matched: matchedCount,
        skipped: skippedCount,
      });
    } catch (error) {
      setIsMatching(false);
      setUploadingItems(false);
      alert("Excel 解析失败: " + (error as Error).message);
      console.error(error);
    }
  };

  // ---- 导出 Excel ----

  const handleExport = async () => {
    setExporting(true);
    try {
      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("心愿单");

      worksheet.columns = [
        { header: "场馆", key: "venue", width: 8 },
        { header: "摊位号", key: "boothNumber", width: 12 },
        { header: "制品名称", key: "productName", width: 28 },
        { header: "作者", key: "author", width: 18 },
        { header: "图片", key: "image", width: 14 },
        { header: "图片链接", key: "imageUrl", width: 32 },
        { header: "优先级", key: "priority", width: 10 },
        { header: "开摊信息", key: "openInfo", width: 18 },
        { header: "类型", key: "type", width: 10 },
        { header: "状态", key: "status", width: 12 },
        { header: "单价", key: "price", width: 10 },
        { header: "数量", key: "quantity", width: 8 },
        { header: "实付", key: "total", width: 10 },
        { header: "备注", key: "note", width: 18 },
        { header: "详情", key: "description", width: 40 },
      ];

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).height = 22;

      for (const item of items) {
        const row = worksheet.addRow({
          venue: item.venue,
          boothNumber: item.boothNumber,
          productName: item.productName,
          author: item.author,
          image: item.imageUrl ? "见图" : "",
          imageUrl: item.imageUrl || "",
          priority: item.priority,
          openInfo: item.openInfo,
          type: item.type === "paid" ? "有料" : item.type === "free" ? "无料" : "",
          status: STATUS_TEXT[item.status],
          price: item.price,
          quantity: item.quantity,
          total: item.price && item.quantity ? item.price * item.quantity : null,
          note: item.note,
          description: item.description,
        });
        row.height = 58;

        if (item.imageUrl) {
          const image = await imageUrlToExcelImage(item.imageUrl);
          if (image) {
            const imageId = workbook.addImage(image);
            worksheet.addImage(imageId, {
              tl: { col: 4.15, row: row.number - 0.85 },
              ext: { width: 48, height: 48 },
            });
          }
        }
      }

      worksheet.eachRow((row) => {
        row.alignment = { vertical: "middle", wrapText: true };
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${eventInfo?.name || eventId}_心愿单.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("导出失败:", error);
      alert("导出失败: " + (error as Error).message);
    } finally {
      setExporting(false);
    }
  };

  // ---- 搜索 + 排序 + 分页 ----

  const groupedItems = useMemo(() => {
    let filtered = items;

    if (searchKeyword) {
      const keyword = searchKeyword.toLowerCase();
      filtered = filtered.filter(
        (item) =>
          item.boothNumber.toLowerCase().includes(keyword) ||
          item.productName.toLowerCase().includes(keyword) ||
          item.author?.toLowerCase().includes(keyword)
      );
    }

    const sorted = [...filtered].sort((a, b) => {
      const boothCompare = a.boothNumber.localeCompare(b.boothNumber, "zh-Hans-CN", {
        numeric: true,
        sensitivity: "base",
      });

      if (desktopSortMode === "hot") {
        // 按热度排序（降序）
        const aHot = a.hotCount || 0;
        const bHot = b.hotCount || 0;
        if (aHot !== bHot) return bHot - aHot;
        return boothCompare;
      }

      if (desktopSortMode === "priority") {
        const aP = PRIORITY_ORDER[a.priority || "随缘"] || 6;
        const bP = PRIORITY_ORDER[b.priority || "随缘"] || 6;
        if (aP !== bP) return aP - bP;
        return boothCompare;
      }

      // 默认按摊位号排序
      return boothCompare;
    });

    const grouped: Record<string, WishItem[]> = {};
    sorted.forEach((item) => {
      const venue = item.venue || "未知";
      if (!grouped[venue]) grouped[venue] = [];
      grouped[venue].push(item);
    });

    return grouped;
  }, [items, searchKeyword, desktopSortMode]);

  const flattenedItems = useMemo(() => {
    const items: WishItem[] = [];
    Object.entries(groupedItems).forEach(([, venueItems]) => {
      venueItems.forEach((item) => items.push(item));
    });
    return items;
  }, [groupedItems]);

  const paginatedItems = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return flattenedItems.slice(start, start + PAGE_SIZE);
  }, [flattenedItems, currentPage]);

  const totalPages = Math.ceil(flattenedItems.length / PAGE_SIZE);

  const stats = useMemo(() => {
    return {
      total: items.length,
      purchased: items.filter((i) => i.status === "purchased").length,
      soldout: items.filter((i) => i.status === "soldout").length,
      pending: items.filter((i) => i.status === "pending" || i.status === "待领取").length,
      free: items.filter((i) => i.type === "free").length,
      totalSpent: items.reduce((sum, i) => {
        // 已购买/已领取的才计入花费
        if (i.status === "purchased" || i.status === "已领取") {
          const price = i.price ?? 0;
          const qty = i.quantity ?? 1;
          return sum + price * qty;
        }
        return sum;
      }, 0),
    };
  }, [items]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">加载中...</div>;
  }

  if (accessDenied) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm max-w-sm w-full p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
            <Package className="w-6 h-6 text-slate-400" />
          </div>
          <h1 className="text-lg font-bold text-slate-900 mb-2">无法查看这份心愿单</h1>
          <p className="text-sm text-slate-500 leading-6 mb-5">
            当前设备还没有加入这份 list。请回到首页输入四位清单识别码后再查看。
          </p>
          <button
            onClick={() => router.push("/")}
            className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors"
          >
            回到首页
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50 overflow-hidden">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 shrink-0">
        <div className="max-w-7xl mx-auto px-3 py-3 sm:px-6 sm:py-4 lg:px-8">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push("/")}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-600"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h1 className="text-lg sm:text-2xl font-bold text-slate-900 font-display">{eventInfo?.name || eventId}</h1>
                <p className="text-slate-500 text-xs sm:text-sm">{eventInfo?.date || ""}</p>
              </div>
              {/* 清单识别码 */}
              {shareCode && (
                <button
                  onClick={handleCopyShareCode}
                  className="ml-2 flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors group"
                  title="点击复制清单识别码"
                >
                  <span className="text-sm font-mono font-bold text-amber-700 tracking-wider">{shareCode}</span>
                  {copied ? (
                    <CheckCircle className="w-3.5 h-3.5 text-green-600" weight="bold" />
                  ) : (
                    <Copy className="w-3.5 h-3.5 text-amber-500 group-hover:text-amber-700" />
                  )}
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <button
                onClick={() => void handleToggleEditMode()}
                disabled={savingEdits}
                className={`px-2 sm:px-4 py-1.5 sm:py-2 rounded-lg font-medium transition-colors text-xs sm:text-sm flex items-center gap-1 ${
                  editMode ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {editMode ? <Check className="w-4 h-4" weight="bold" /> : <Pencil className="w-4 h-4" />}
                <span className="hidden sm:inline">{savingEdits ? "保存中..." : editMode ? "保存并退出" : "编辑模式"}</span>
              </button>
              <button
                onClick={() => setIsUploadModalOpen(true)}
                className="bg-indigo-600 text-white px-2 sm:px-4 py-1.5 sm:py-2 rounded-lg hover:bg-indigo-700 transition-colors text-xs sm:text-sm flex items-center gap-1"
              >
                <UploadSimple className="w-4 h-4" />
                <span className="hidden sm:inline">上传</span>
              </button>
              <button
                onClick={handleExport}
                disabled={exporting}
                className="bg-emerald-600 text-white px-2 sm:px-4 py-1.5 sm:py-2 rounded-lg hover:bg-emerald-700 transition-colors text-xs sm:text-sm flex items-center gap-1"
              >
                <FileArrowDown className="w-4 h-4" />
                <span className="hidden sm:inline">{exporting ? "导出中..." : "导出"}</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main content area - fills remaining height */}
      {/* 手机端视图 */}
      <div className="md:hidden flex-1 min-h-0">
        <MobileTableView
          items={items}
          onUpdateItem={handleUpdateItem}
          onSaveItem={handleSaveMobileItem}
          onRemoveItem={handleDeleteItem}
        />
      </div>

      {/* 桌面端视图 */}
      <div className="hidden md:flex flex-1 min-h-0 flex-col max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8">
        {/* Stats */}
        <div className="shrink-0 pt-6 pb-3">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard icon={Package} label="总展品" value={stats.total} color="slate" />
            <StatCard icon={Clock} label="待购买/领取" value={stats.pending} color="amber" />
            <StatCard icon={ShoppingBag} label="已购买" value={stats.purchased} color="emerald" />
            <StatCard icon={Flame} label="已售罄" value={stats.soldout} color="rose" />
            <StatCard icon={Gift} label="无料" value={stats.free} color="indigo" />
            <StatCard icon={Wallet} label="总花费" value={`¥${stats.totalSpent.toFixed(2)}`} color="violet" />
          </div>
        </div>

        {/* Search + Sort */}
        <div className="shrink-0 pb-3 flex gap-3">
          <div className="flex-1 relative">
            <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="搜索摊位号、制品名称、作者..."
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white text-sm"
            />
            {searchKeyword && (
              <button
                onClick={() => setSearchKeyword("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500 whitespace-nowrap">排序：</span>
            <button
              onClick={() => setDesktopSortMode((mode) => (mode === "priority" ? "default" : "priority"))}
              className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                desktopSortMode === "priority"
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              按优先级排序
            </button>
            <button
              onClick={() => setDesktopSortMode((mode) => (mode === "hot" ? "default" : "hot"))}
              className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors flex items-center gap-1 ${
                desktopSortMode === "hot"
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              <Flame className="w-3 h-3" />
              按热度排序
            </button>
            <span className="text-xs text-slate-400 whitespace-nowrap">
              {desktopSortMode === "default" ? "默认按摊位号" : "再点已选排序恢复摊位号"}
            </span>
          </div>
        </div>

        {/* Table - flex to fill remaining space */}
        <div className="flex-1 min-h-0 flex flex-col pb-6">
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden flex-1 min-h-0 flex flex-col">
          {editMode && (
            <div className="p-3 border-b border-slate-200 bg-slate-50 flex items-center gap-2">
              <button
                onClick={handleAddItem}
                className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors text-sm flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                添加新行
              </button>
              <button
                onClick={handleBatchDelete}
                disabled={selectedItemIds.size === 0}
                className="bg-rose-600 text-white px-4 py-2 rounded-lg hover:bg-rose-700 transition-colors text-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Trash className="w-4 h-4" />
                删除选中{selectedItemIds.size > 0 ? ` ${selectedItemIds.size}` : ""}
              </button>
            </div>
          )}

          <div ref={tableContainerRef} className="overflow-auto flex-1 min-h-0">
            <table className="w-full border-collapse">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  {editMode && (
                    <Th width="44px">
                      <input
                        type="checkbox"
                        checked={paginatedItems.length > 0 && paginatedItems.every((item) => selectedItemIds.has(item.id))}
                        onChange={toggleSelectPage}
                        aria-label="选择当前页"
                        className="w-4 h-4 rounded border-slate-300"
                      />
                    </Th>
                  )}
                  <Th width="50px">场馆</Th>
                  <Th width="70px">摊位号</Th>
                  <Th width="200px">制品名称</Th>
                  <Th width="120px">作者</Th>
                  <Th width="60px">图片</Th>
                  <Th width="70px">优先级</Th>
                  <Th width="60px">热度</Th>
                  <Th width="100px">开摊信息</Th>
                  <Th width="60px">类型</Th>
                  <Th width="70px">状态</Th>
                  <Th width="70px">单价</Th>
                  <Th width="50px">数量</Th>
                  <Th width="70px">实付</Th>
                  <Th width="100px">备注</Th>
                  <Th width="90px">详情</Th>
                  {editMode && <Th stickyRight="0" width="50px">操作</Th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedItems.map((item) => (
                  <tr key={item.id} data-item-id={item.id} className="hover:bg-slate-50/60 transition-colors">
                    {editMode && (
                      <Td>
                        <input
                          type="checkbox"
                          checked={selectedItemIds.has(item.id)}
                          onChange={() => toggleSelectItem(item.id)}
                          aria-label={`选择 ${item.productName}`}
                          className="w-4 h-4 rounded border-slate-300"
                        />
                      </Td>
                    )}
                    {/* 场馆 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.venue || ""} onChange={(e) => handleDraftItem(item.id, "venue", e.target.value)} className="w-16 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="font-medium text-slate-700">{item.venue || "-"}</span>
                      )}
                    </Td>
                    {/* 摊位号 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.boothNumber} onChange={(e) => handleDraftItem(item.id, "boothNumber", e.target.value)} className="w-20 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="font-medium text-indigo-600">{item.boothNumber}</span>
                      )}
                    </Td>
                    {/* 制品名称 */}
                    <Td maxWidth="200px" wrap>
                      {editMode ? (
                        <input type="text" value={item.productName} onChange={(e) => handleDraftItem(item.id, "productName", e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="break-words">{item.productName}</span>
                      )}
                    </Td>
                    {/* 作者 */}
                    <Td maxWidth="120px" wrap>
                      {editMode ? (
                        <input type="text" value={item.author || ""} onChange={(e) => handleDraftItem(item.id, "author", e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="text-slate-600 break-words">{item.author || "-"}</span>
                      )}
                    </Td>
                    {/* 图片 */}
                    <Td>
                      <ImageCell
                        item={item}
                        editMode={editMode}
                        onFileSelect={(file) => handleImageFile(item.id, file)}
                      />
                    </Td>
                    {/* 优先级 */}
                    <Td>
                      {editMode ? (
                        <select value={item.priority || "随缘"} onChange={(e) => handleDraftItem(item.id, "priority", e.target.value)} className="px-2 py-1 border border-slate-300 rounded-lg text-sm">
                          <option value="首摊">首摊</option>
                          <option value="次摊">次摊</option>
                          <option value="P1">P1</option>
                          <option value="P2">P2</option>
                          <option value="P3">P3</option>
                          <option value="随缘">随缘</option>
                        </select>
                      ) : (
                        <span className={`inline-block px-2 py-1 rounded text-xs border whitespace-nowrap ${PRIORITY_COLOR[item.priority || "随缘"]}`}>
                          {item.priority || "随缘"}
                        </span>
                      )}
                    </Td>
                    {/* 热度 */}
                    <Td>
                      <div className="flex items-center gap-1">
                        <Flame className="w-3.5 h-3.5 text-orange-500" />
                        <span className="text-sm font-medium text-slate-700">{item.hotCount || 0}</span>
                      </div>
                    </Td>
                    {/* 开摊信息 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.openInfo || ""} onChange={(e) => handleDraftItem(item.id, "openInfo", e.target.value)} placeholder="开摊时间、限购等" className="w-32 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="text-slate-600">{item.openInfo || "-"}</span>
                      )}
                    </Td>
                    {/* 类型 */}
                    <Td>
                      {editMode ? (
                        <select value={item.type || "paid"} onChange={(e) => handleDraftItem(item.id, "type", e.target.value)} className="px-2 py-1 border border-slate-300 rounded-lg text-sm">
                          <option value="paid">有料</option>
                          <option value="free">无料</option>
                        </select>
                      ) : (
                        <span className={`inline-block px-2 py-1 rounded text-xs ${item.type === "free" ? "bg-indigo-100 text-indigo-800" : "bg-slate-100 text-slate-600"} whitespace-nowrap`}>
                          {item.type === "free" ? "无料" : "有料"}
                        </span>
                      )}
                    </Td>
                    {/* 状态 */}
                    <Td>
                      {editMode ? (
                        <select value={item.status} onChange={(e) => handleDraftItem(item.id, "status", e.target.value)} className="px-2 py-1 border border-slate-300 rounded-lg text-sm">
                          {item.type === "free" ? (
                            <>
                              <option value="待领取">待领取</option>
                              <option value="已领取">已领取</option>
                            </>
                          ) : (
                            <>
                              <option value="pending">待购买</option>
                              <option value="purchased">已购买</option>
                              <option value="soldout">已售罄</option>
                            </>
                          )}
                        </select>
                      ) : (
                        <span className={`inline-block px-2 py-1 rounded text-xs whitespace-nowrap ${getStatusColor(item.status)}`}>
                          {STATUS_TEXT[item.status]}
                        </span>
                      )}
                    </Td>
                    {/* 单价 */}
                    <Td>
                      {item.type === "free" ? "-" : editMode ? (
                        <input type="number" value={item.price || ""} onChange={(e) => handleDraftItem(item.id, "price", parseFloat(e.target.value) || undefined)} className="w-16 px-2 py-1 border border-slate-300 rounded-lg text-sm" placeholder="¥" />
                      ) : (
                        <span>{item.price ? `¥${item.price}` : "-"}</span>
                      )}
                    </Td>
                    {/* 数量 */}
                    <Td>
                      {editMode ? (
                        <input type="number" value={item.quantity || ""} onChange={(e) => handleDraftItem(item.id, "quantity", parseInt(e.target.value) || undefined)} className="w-12 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span>{item.quantity || "-"}</span>
                      )}
                    </Td>
                    {/* 实付 (自动 = 单价 × 数量) */}
                    <Td>
                      {item.type === "free" ? "-" : (
                        <span>{item.price && item.quantity ? `¥${(item.price * item.quantity).toFixed(2)}` : "-"}</span>
                      )}
                    </Td>
                    {/* 备注 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.note || ""} onChange={(e) => handleDraftItem(item.id, "note", e.target.value)} className="w-32 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="text-slate-600">{item.note || "-"}</span>
                      )}
                    </Td>
                    {/* 详情 */}
                    <Td>
                      {item.description ? (
                        <button
                          onClick={() => setDetailItem(item)}
                          className="px-2.5 py-1.5 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors text-xs font-medium whitespace-nowrap"
                        >
                          查看详情
                        </button>
                      ) : (
                        <span className="text-slate-300 text-xs">-</span>
                      )}
                    </Td>
                    {/* 操作 */}
                    {editMode && (
                      <Td stickyRight="0">
                        <button onClick={() => handleDeleteItem(item.id)} className="text-slate-400 hover:text-rose-500 transition-colors p-1 rounded">
                          <Trash className="w-4 h-4" />
                        </button>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="p-4 border-t border-slate-100 flex items-center justify-between">
              <div className="text-sm text-slate-500">
                第 {currentPage} / {totalPages} 页，共 {flattenedItems.length} 条
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50">首页</button>
                <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50">上一页</button>
                <span className="text-sm text-slate-600 min-w-[60px] text-center">{currentPage}</span>
                <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50">下一页</button>
                <button onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50">末页</button>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      {/* 全局 Loading 覆盖层 — 上传/匹配/保存期间显示 */}
      {uploadingItems && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100]">
          <div className="bg-white rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="animate-spin w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full" />
            <div className="text-center">
              <p className="text-slate-800 font-semibold text-lg">正在导入心愿单</p>
              <p className="text-slate-500 text-sm mt-1">正在匹配展品信息（可能需要30s以上，请耐心等待）</p>
            </div>
          </div>
        </div>
      )}

      {/* 导入成功弹窗 */}
      {uploadResult && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-[110]">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-emerald-600" weight="fill" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900 font-display">导入成功</h2>
                <p className="text-sm text-slate-500">心愿单已保存并同步</p>
              </div>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-100 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">导入展品</span>
                <span className="font-semibold text-slate-900">{uploadResult.imported} 件</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">匹配成功</span>
                <span className="font-semibold text-emerald-600">{uploadResult.matched} 件</span>
              </div>
              {uploadResult.skipped > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-500">跳过重复</span>
                  <span className="font-semibold text-amber-600">{uploadResult.skipped} 件</span>
                </div>
              )}
            </div>

            <button
              onClick={() => setUploadResult(null)}
              className="mt-5 w-full bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700 transition-colors font-medium"
            >
              确定
            </button>
          </div>
        </div>
      )}

      {/* 详情弹窗 */}
      {detailItem && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-[110]">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] shadow-2xl flex flex-col">
            <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-100">
              <div>
                <h2 className="text-lg font-bold text-slate-900 font-display">{detailItem.productName}</h2>
                <p className="text-sm text-slate-500 mt-1">
                  {detailItem.boothNumber} · {detailItem.author || "未知作者"}
                </p>
              </div>
              <button
                onClick={() => setDetailItem(null)}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 overflow-auto">
              <p className="text-sm leading-7 text-slate-700 whitespace-pre-wrap break-words">
                {detailItem.description}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Upload Modal */}
      {isUploadModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 shadow-xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-900 font-display">上传心愿单</h2>
              <button onClick={() => setIsUploadModalOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {isMatching ? (
              <div className="text-center py-8">
                <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full mx-auto mb-4" />
                <p className="text-slate-600 font-medium">正在匹配展品信息</p>
                <p className="text-slate-400 text-sm mt-1">可能需要30s以上，请耐心等待</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    上传心愿单 Excel
                  </label>
                  <p className="text-xs text-slate-500 mb-2">
                    支持列名：社团摊位号、展品名称、作者（可选）
                  </p>
                  <input
                    type="file"
                    accept=".xls,.xlsx"
                    onChange={(e) => e.target.files?.[0] && handleUploadExcel(e.target.files[0])}
                    className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm"
                  />
                </div>

                {matchStats && (
                  <div className="bg-slate-50 rounded-lg p-4 text-sm space-y-1">
                    <p className="font-medium text-slate-700">上次匹配结果：</p>
                    <p>共 {matchStats.total} 条，匹配成功 <span className="text-emerald-600 font-medium">{matchStats.matched}</span> 条</p>
                    <p className="text-xs text-slate-500">
                      精确 {matchStats.exact} · 高置信 {matchStats.high} · 中置信 {matchStats.medium} · 低置信 {matchStats.low} · 未匹配 {matchStats.none}
                    </p>
                    {matchStats.fetchedFromAPI > 0 && (
                      <p className="text-xs text-indigo-600">
                        实时查询获取 {matchStats.fetchedFromAPI} 个新展品
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="mt-6">
              <button
                onClick={() => setIsUploadModalOpen(false)}
                className="w-full bg-slate-100 text-slate-700 py-2.5 rounded-lg hover:bg-slate-200 transition-colors font-medium text-sm"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 小组件 ----

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: any; color: string }) {
  const colorClass = `text-${color}-600`;
  return (
    <div className="bg-white rounded-xl p-4 border border-slate-200">
      <div className={`flex items-center gap-1.5 ${colorClass} text-xs mb-2`}>
        <Icon className="w-3.5 h-3.5" />
        <span>{label}</span>
      </div>
      <div className={`text-2xl font-bold ${colorClass} font-display`}>{value}</div>
    </div>
  );
}

function Th({ children, stickyRight, width }: { children: React.ReactNode; stickyRight?: string; width?: string }) {
  const style: any = {};
  if (stickyRight) {
    style.position = "sticky";
    style.right = stickyRight;
    style.zIndex = 20;
  }
  if (width) style.width = width;
  return (
    <th className="px-3 py-3 text-left text-xs font-medium text-slate-500 uppercase border-b whitespace-nowrap" style={style}>
      {children}
    </th>
  );
}

function Td({ children, minWidth, maxWidth, stickyRight, wrap }: { children: React.ReactNode; minWidth?: string; maxWidth?: string; stickyRight?: string; wrap?: boolean }) {
  const style: any = {};
  if (minWidth) style.minWidth = minWidth;
  if (maxWidth) style.maxWidth = maxWidth;
  if (stickyRight) {
    style.position = "sticky";
    style.right = stickyRight;
    style.zIndex = 10;
    style.backgroundColor = "white";
  }
  return (
    <td className={`px-3 py-3 text-sm ${wrap ? "" : "whitespace-nowrap"}`} style={style}>
      {children}
    </td>
  );
}

/**
 * 图片单元格 —— 支持点击上传 & 粘贴上传
 */
function ImageCell({
  item,
  editMode,
  onFileSelect,
}: {
  item: WishItem;
  editMode: boolean;
  onFileSelect: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (editMode) {
      inputRef.current?.click();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileSelect(file);
    // 清空 input，允许重复选择同一文件
    e.target.value = "";
  };

  return (
    <div
      onClick={handleClick}
      className={`relative w-12 h-12 rounded-lg overflow-hidden group ${
        editMode ? "cursor-pointer" : ""
      }`}
    >
      {item.imageUrl ? (
        <>
          <img
            src={item.imageUrl}
            alt=""
            className="w-12 h-12 object-cover border border-slate-200 rounded-lg"
          />
          {editMode && (
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <Camera className="w-5 h-5 text-white" />
            </div>
          )}
        </>
      ) : (
        <div
          className={`w-12 h-12 rounded-lg flex items-center justify-center border ${
            editMode
              ? "border-dashed border-slate-300 bg-slate-50 hover:border-indigo-400 hover:bg-indigo-50 transition-colors"
              : "border-slate-200 bg-slate-100"
          }`}
        >
          {editMode ? (
            <Camera className="w-5 h-5 text-slate-400 group-hover:text-indigo-500" />
          ) : (
            <ImageBroken className="w-5 h-5 text-slate-300" />
          )}
        </div>
      )}
      {editMode && (
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={handleChange}
          className="hidden"
        />
      )}
    </div>
  );
}
