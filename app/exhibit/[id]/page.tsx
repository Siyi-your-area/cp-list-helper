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
} from "@phosphor-icons/react";
import * as XLSX from "xlsx";
import type { WishItem, MatchResult } from "@/lib/types";
import { STATUS_TEXT, STATUS_COLOR, PRIORITY_ORDER, PRIORITY_COLOR } from "@/lib/types";
import { getExhibit, updateExhibit } from "@/lib/storage";
import { parseExcelFile } from "@/lib/excel-parser";

const PAGE_SIZE = 100;

export default function ExhibitDetail() {
  const params = useParams();
  const router = useRouter();
  const [exhibit, setExhibit] = useState<any>(null);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [isMatching, setIsMatching] = useState(false);
  const [matchStats, setMatchStats] = useState<any>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const found = getExhibit(params.id as string);
    if (found) {
      setExhibit(found);
    } else {
      alert("展会不存在");
      router.push("/");
    }
  }, [params.id, router]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchKeyword]);

  // ---- 操作函数 ----

  const refreshExhibit = () => {
    const updated = getExhibit(params.id as string);
    if (updated) setExhibit(updated);
  };

  const handleDeleteItem = (id: string) => {
    if (!exhibit) return;
    if (!confirm("确定删除这一行吗？")) return;

    const updated = updateExhibit(exhibit.id, {
      items: exhibit.items.filter((item: WishItem) => item.id !== id),
    });
    if (updated) setExhibit(updated);
  };

  const handleAddItem = () => {
    if (!exhibit) return;

    const newItem: WishItem = {
      id: `${Date.now()}`,
      boothNumber: "",
      productName: "",
      author: "",
      venue: "",
      status: "pending",
      priority: "P1",
    };

    const updated = updateExhibit(exhibit.id, {
      items: [...exhibit.items, newItem],
    });
    if (updated) {
      setExhibit(updated);
      setTimeout(() => {
        setCurrentPage(Math.ceil((exhibit.items.length + 1) / PAGE_SIZE));
      }, 100);
    }
  };

  const handleUpdateItem = (id: string, field: keyof WishItem, value: any) => {
    if (!exhibit) return;

    const updatedItems = exhibit.items.map((item: WishItem) => {
      if (item.id !== id) return item;
      const updatedItem = { ...item, [field]: value };
      if (field === "type" && value === "free") {
        updatedItem.status = "待领取";
        updatedItem.price = undefined;
        updatedItem.actualPrice = undefined;
        updatedItem.actualQuantity = undefined;
      }
      if (field === "type" && value === "paid") {
        updatedItem.status = "pending";
      }
      return updatedItem;
    });

    const updated = updateExhibit(exhibit.id, { items: updatedItems });
    if (updated) setExhibit(updated);
  };

  // ---- Excel 上传 + 自动匹配 ----

  const handleUploadExcel = async (file: File) => {
    if (!exhibit) return;

    try {
      // 1. 解析 Excel
      const inputs = await parseExcelFile(file);
      if (inputs.length === 0) {
        alert("Excel 中没有找到数据，请检查文件格式");
        return;
      }

      // 2. 调用 API 匹配
      setIsMatching(true);
      setMatchStats(null);

      let results: MatchResult[] = [];
      try {
        const response = await fetch("/api/cpp/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: inputs }),
        });
        const data = await response.json();
        results = data.results || [];
        setMatchStats(data.stats);
      } catch (err) {
        console.warn("API 匹配失败，使用无匹配模式:", err);
        results = inputs.map(() => ({
          matched: false,
          confidence: "none" as const,
          reason: "匹配服务不可用",
        }));
      }
      setIsMatching(false);

      // 3. 构建心愿单条目
      const items: WishItem[] = inputs.map((input, index) => {
        const result = results[index];
        const venue = input.boothNumber.charAt(0) || "";

        const item: WishItem = {
          id: `${Date.now()}-${index}`,
          boothNumber: input.boothNumber,
          productName: input.productName,
          author: input.author || "",
          imageUrl: "",
          venue,
          status: "pending",
          matchConfidence: result?.confidence || "none",
        };

        // 如果匹配成功，填充 CPP 数据
        if (result?.matched && result.cppItem) {
          item.author = input.author || result.cppItem.author || "";
          item.imageUrl = result.cppItem.imageUrl || "";
          item.matchedCPPItem = result.cppItem;
        }

        return item;
      });

      // 4. 保存到 localStorage
      const updated = updateExhibit(exhibit.id, {
        items: [...exhibit.items, ...items],
      });
      if (updated) setExhibit(updated);

      const matchedCount = results.filter((r) => r.matched).length;
      alert(
        `导入 ${items.length} 件展品\n` +
        `匹配成功 ${matchedCount} 件（精确 ${results.filter(r => r.confidence === "exact").length}，` +
        `模糊 ${results.filter(r => r.confidence !== "exact" && r.confidence !== "none").length}，` +
        `未匹配 ${results.filter(r => !r.matched).length}）`
      );
      setIsUploadModalOpen(false);
    } catch (error) {
      setIsMatching(false);
      alert("Excel 解析失败: " + (error as Error).message);
      console.error(error);
    }
  };

  // ---- 导出 Excel ----

  const handleExport = () => {
    if (!exhibit) return;

    const data = exhibit.items.map((item: WishItem) => ({
      场馆: item.venue,
      摊位号: item.boothNumber,
      制品名称: item.productName,
      作者: item.author,
      图片: item.imageUrl,
      优先级: item.priority,
      开摊信息: item.openInfo,
      类型: item.type === "paid" ? "有料" : item.type === "free" ? "无料" : "",
      状态: STATUS_TEXT[item.status],
      价格: item.price,
      计划数量: item.quantity,
      限购量: item.purchaseLimit,
      实付金额: item.actualPrice,
      实购数量: item.actualQuantity,
      备注: item.note,
      购买备注: item.purchaseNote,
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "心愿单");
    XLSX.writeFile(wb, `${exhibit.name}_心愿单.xlsx`);
  };

  // ---- 搜索 + 排序 + 分页 ----

  const groupedItems = useMemo(() => {
    if (!exhibit) return {};

    let filtered = exhibit.items as WishItem[];

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
      const aP = PRIORITY_ORDER[a.priority || "随缘"] || 6;
      const bP = PRIORITY_ORDER[b.priority || "随缘"] || 6;
      return aP - bP;
    });

    const grouped: Record<string, WishItem[]> = {};
    sorted.forEach((item) => {
      const venue = item.venue || "未知";
      if (!grouped[venue]) grouped[venue] = [];
      grouped[venue].push(item);
    });

    return grouped;
  }, [exhibit, searchKeyword]);

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
    if (!exhibit) return { total: 0, purchased: 0, soldout: 0, pending: 0, free: 0, totalSpent: 0 };
    const items = exhibit.items as WishItem[];
    return {
      total: items.length,
      purchased: items.filter((i) => i.status === "purchased").length,
      soldout: items.filter((i) => i.status === "soldout").length,
      pending: items.filter((i) => i.status === "pending" || i.status === "待领取").length,
      free: items.filter((i) => i.type === "free").length,
      totalSpent: items.reduce((sum, i) => sum + (i.actualPrice || 0) * (i.actualQuantity || 0), 0),
    };
  }, [exhibit]);

  if (!exhibit) {
    return <div className="min-h-screen flex items-center justify-center">加载中...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <button
                onClick={() => router.push("/")}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-600 flex items-center gap-1 text-sm"
              >
                <ArrowLeft className="w-4 h-4" />
                返回
              </button>
              <div>
                <h1 className="text-2xl font-bold text-slate-900 font-display">{exhibit.name}</h1>
                <p className="text-slate-500 text-sm">
                  {exhibit.venue} · {exhibit.date}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setEditMode(!editMode)}
                className={`px-4 py-2 rounded-lg font-medium transition-colors text-sm flex items-center gap-1.5 ${
                  editMode ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {editMode ? <Check className="w-4 h-4" weight="bold" /> : <Pencil className="w-4 h-4" />}
                {editMode ? "编辑中" : "编辑模式"}
              </button>
              <button
                onClick={() => setIsUploadModalOpen(true)}
                className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors text-sm flex items-center gap-1.5"
              >
                <UploadSimple className="w-4 h-4" />
                上传心愿单
              </button>
              <button
                onClick={handleExport}
                className="bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-700 transition-colors text-sm flex items-center gap-1.5"
              >
                <FileArrowDown className="w-4 h-4" />
                导出Excel
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Stats */}
      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard icon={Package} label="总展品" value={stats.total} color="slate" />
          <StatCard icon={Clock} label="待购买/领取" value={stats.pending} color="amber" />
          <StatCard icon={ShoppingBag} label="已购买" value={stats.purchased} color="emerald" />
          <StatCard icon={Flame} label="已售罄" value={stats.soldout} color="rose" />
          <StatCard icon={Gift} label="无料" value={stats.free} color="indigo" />
          <StatCard icon={Wallet} label="总花费" value={`¥${stats.totalSpent.toFixed(2)}`} color="violet" />
        </div>
      </div>

      {/* Search */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative">
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
      </div>

      {/* Table */}
      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {editMode && (
            <div className="p-3 border-b border-slate-200 bg-slate-50">
              <button
                onClick={handleAddItem}
                className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors text-sm flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                添加新行
              </button>
            </div>
          )}

          <div ref={tableContainerRef} className="overflow-auto" style={{ maxHeight: "calc(100vh - 450px)" }}>
            <table className="w-full border-collapse">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  <Th>场馆</Th>
                  <Th>摊位号</Th>
                  <Th>制品名称</Th>
                  <Th>作者</Th>
                  <Th>图片</Th>
                  <Th>优先级</Th>
                  <Th>开摊信息</Th>
                  <Th>类型</Th>
                  <Th>状态</Th>
                  <Th>价格</Th>
                  <Th>数量</Th>
                  <Th>限购</Th>
                  <Th>实付</Th>
                  <Th>实购</Th>
                  <Th>备注</Th>
                  <Th>购买备注</Th>
                  {editMode && <Th stickyRight="0">操作</Th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedItems.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/60 transition-colors">
                    {/* 场馆 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.venue || ""} onChange={(e) => handleUpdateItem(item.id, "venue", e.target.value)} className="w-16 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="font-medium text-slate-700">{item.venue || "-"}</span>
                      )}
                    </Td>
                    {/* 摊位号 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.boothNumber} onChange={(e) => handleUpdateItem(item.id, "boothNumber", e.target.value)} className="w-20 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="font-medium text-indigo-600">{item.boothNumber}</span>
                      )}
                    </Td>
                    {/* 制品名称 */}
                    <Td minWidth="200px">
                      {editMode ? (
                        <input type="text" value={item.productName} onChange={(e) => handleUpdateItem(item.id, "productName", e.target.value)} className="w-64 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span>{item.productName}</span>
                      )}
                    </Td>
                    {/* 作者 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.author || ""} onChange={(e) => handleUpdateItem(item.id, "author", e.target.value)} className="w-24 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="text-slate-600">{item.author || "-"}</span>
                      )}
                    </Td>
                    {/* 图片 */}
                    <Td>
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt="" className="w-12 h-12 object-cover rounded-lg border border-slate-200" />
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center">
                          <ImageBroken className="w-5 h-5 text-slate-300" />
                        </div>
                      )}
                    </Td>
                    {/* 优先级 */}
                    <Td>
                      {editMode ? (
                        <select value={item.priority || "随缘"} onChange={(e) => handleUpdateItem(item.id, "priority", e.target.value)} className="px-2 py-1 border border-slate-300 rounded-lg text-sm">
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
                    {/* 开摊信息 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.openInfo || ""} onChange={(e) => handleUpdateItem(item.id, "openInfo", e.target.value)} placeholder="开摊时间、限购等" className="w-32 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="text-slate-600">{item.openInfo || "-"}</span>
                      )}
                    </Td>
                    {/* 类型 */}
                    <Td>
                      {editMode ? (
                        <select value={item.type || "paid"} onChange={(e) => handleUpdateItem(item.id, "type", e.target.value)} className="px-2 py-1 border border-slate-300 rounded-lg text-sm">
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
                        <select value={item.status} onChange={(e) => handleUpdateItem(item.id, "status", e.target.value)} className="px-2 py-1 border border-slate-300 rounded-lg text-sm">
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
                        <span className={`inline-block px-2 py-1 rounded text-xs whitespace-nowrap ${STATUS_COLOR[item.status]}`}>
                          {STATUS_TEXT[item.status]}
                        </span>
                      )}
                    </Td>
                    {/* 价格 */}
                    <Td>
                      {item.type === "free" ? "-" : editMode ? (
                        <input type="number" value={item.price || ""} onChange={(e) => handleUpdateItem(item.id, "price", parseFloat(e.target.value) || undefined)} className="w-16 px-2 py-1 border border-slate-300 rounded-lg text-sm" placeholder="¥" />
                      ) : (
                        <span>{item.price ? `¥${item.price}` : "-"}</span>
                      )}
                    </Td>
                    {/* 数量 */}
                    <Td>
                      {editMode ? (
                        <input type="number" value={item.quantity || ""} onChange={(e) => handleUpdateItem(item.id, "quantity", parseInt(e.target.value) || undefined)} className="w-12 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span>{item.quantity || "-"}</span>
                      )}
                    </Td>
                    {/* 限购 */}
                    <Td>
                      {editMode ? (
                        <input type="number" value={item.purchaseLimit || ""} onChange={(e) => handleUpdateItem(item.id, "purchaseLimit", parseInt(e.target.value) || undefined)} className="w-12 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span>{item.purchaseLimit || "-"}</span>
                      )}
                    </Td>
                    {/* 实付 */}
                    <Td>
                      {editMode ? (
                        <input type="number" value={item.actualPrice || ""} onChange={(e) => handleUpdateItem(item.id, "actualPrice", parseFloat(e.target.value) || undefined)} className="w-16 px-2 py-1 border border-slate-300 rounded-lg text-sm" placeholder="¥" />
                      ) : (
                        <span>{item.actualPrice ? `¥${item.actualPrice}` : "-"}</span>
                      )}
                    </Td>
                    {/* 实购 */}
                    <Td>
                      {editMode ? (
                        <input type="number" value={item.actualQuantity || ""} onChange={(e) => handleUpdateItem(item.id, "actualQuantity", parseInt(e.target.value) || undefined)} className="w-12 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span>{item.actualQuantity || "-"}</span>
                      )}
                    </Td>
                    {/* 备注 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.note || ""} onChange={(e) => handleUpdateItem(item.id, "note", e.target.value)} className="w-32 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="text-slate-600">{item.note || "-"}</span>
                      )}
                    </Td>
                    {/* 购买备注 */}
                    <Td>
                      {editMode ? (
                        <input type="text" value={item.purchaseNote || ""} onChange={(e) => handleUpdateItem(item.id, "purchaseNote", e.target.value)} className="w-32 px-2 py-1 border border-slate-300 rounded-lg text-sm" />
                      ) : (
                        <span className="text-slate-600">{item.purchaseNote || "-"}</span>
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
                <p className="text-slate-600 font-medium">正在匹配 CPP 数据...</p>
                <p className="text-slate-400 text-sm mt-1">自动填充图片和作者信息</p>
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

function Th({ children, stickyRight }: { children: React.ReactNode; stickyRight?: string }) {
  const style: any = {};
  if (stickyRight) {
    style.position = "sticky";
    style.right = stickyRight;
    style.zIndex = 20;
  }
  return (
    <th className="px-3 py-3 text-left text-xs font-medium text-slate-500 uppercase border-b whitespace-nowrap" style={style}>
      {children}
    </th>
  );
}

function Td({ children, minWidth, stickyRight }: { children: React.ReactNode; minWidth?: string; stickyRight?: string }) {
  const style: any = {};
  if (minWidth) style.minWidth = minWidth;
  if (stickyRight) {
    style.position = "sticky";
    style.right = stickyRight;
    style.zIndex = 10;
    style.backgroundColor = "white";
  }
  return (
    <td className="px-3 py-3 text-sm whitespace-nowrap" style={style}>
      {children}
    </td>
  );
}
