"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Target,
  Calendar,
  ListHeart,
  Plus,
  X,
  ArrowRight,
  Trash,
  CaretDown,
  Spinner,
  Link,
  Warning,
  UploadSimple,
} from "@phosphor-icons/react";
import type { Exhibit, MatchResult, WishItem } from "@/lib/types";
import {
  getExhibitsAsync,
  createWishItemsAsync,
  deleteExhibitAsync,
} from "@/lib/storage";
import { getClientId } from "@/lib/client-id";
import { parseExcelFile } from "@/lib/excel-parser";
import { buildReviewNote } from "@/lib/match-review";

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message || "");
    if (message) return message;
  }
  return fallback;
}

/**
 * 预设展会信息
 */
const EXHIBIT_PRESETS: {
  id: string;
  label: string;
  cppEventId: string;
  days: { id: string; name: string }[];
}[] = [
  {
    id: "cp32-day1",
    label: "CP32一期",
    cppEventId: "cp32",
    days: [{ id: "7040", name: "5.1-5.2" }],
  },
  {
    id: "cp32-day2",
    label: "CP32二期",
    cppEventId: "cp32",
    days: [{ id: "7042", name: "5.4-5.5" }],
  },
  {
    id: "cpg08",
    label: "CPG08",
    cppEventId: "cpg08",
    days: [{ id: "7073", name: "8.22-8.23" }],
  },
];

export default function Home() {
  const router = useRouter();
  const [exhibits, setExhibits] = useState<Exhibit[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedExhibit, setSelectedExhibit] = useState("");
  const [listName, setListName] = useState("");
  const [createUploadFile, setCreateUploadFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Exhibit | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [clientId, setClientId] = useState("");

  // ---- 清单识别码加入 ----
  const [inviteCode, setInviteCode] = useState("");
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError] = useState("");

  useEffect(() => {
    setClientId(getClientId());
  }, []);

  useEffect(() => {
    if (!clientId) return;
    loadExhibits();
  }, [clientId]);

  async function loadExhibits() {
    try {
      setLoading(true);
      const data = await getExhibitsAsync(clientId);
      setExhibits(data);
    } catch (error) {
      console.error("加载展会失败:", error);
    } finally {
      setLoading(false);
    }
  }

  const handleCreate = async () => {
    if (!selectedExhibit) {
      alert("请选择展会");
      return;
    }

    const preset = EXHIBIT_PRESETS.find((p) => p.id === selectedExhibit);
    if (!preset) return;

    const trimmedListName = listName.trim();
    if (!trimmedListName) {
      alert("请输入心愿单名称");
      return;
    }
    if (trimmedListName.length > 50) {
      alert("心愿单名称最多 50 个字");
      return;
    }

    try {
      setCreating(true);
      const uploadInputs = createUploadFile ? await parseExcelFile(createUploadFile) : [];
      if (createUploadFile && uploadInputs.length === 0) {
        throw new Error("上传文件中没有找到心愿单数据，请检查文件格式");
      }

      const listId = `${preset.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const createResponse = await fetch("/api/exhibits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: listId,
          name: trimmedListName,
          days: preset.days,
          cppEventId: preset.cppEventId,
          clientId,
        }),
      });
      const createResult = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createResult.error || "创建心愿单失败");
      }

      let importError: Error | null = null;
      if (uploadInputs.length > 0) {
        try {
        let results: MatchResult[] = [];
        try {
          const response = await fetch("/api/cpp/match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: uploadInputs, eventId: listId }),
          });
          if (response.ok) {
            const data = await response.json();
            results = data.results || [];
          }
        } catch (error) {
          console.warn("创建时自动匹配失败，将保留原始上传内容:", error);
        }

        const importedItems: Omit<WishItem, "id">[] = [];
        for (let index = 0; index < uploadInputs.length; index += 1) {
          const input = uploadInputs[index];
          const result = results[index];
          const cppItem = result?.cppItem;
          const isFree =
            cppItem?.exchangeType?.includes("无料") ||
            cppItem?.tags?.some((tag) => tag.includes("无料")) ||
            cppItem?.productName?.includes("无料");
          const item: Omit<WishItem, "id"> = {
            boothNumber: input.boothNumber,
            productName: input.productName,
            author: input.author || cppItem?.author || "",
            imageUrl: cppItem?.imageUrl || "",
            venue: input.boothNumber.charAt(0) || "",
            type: isFree ? "free" : "paid",
            status: isFree ? "待领取" : "pending",
            hotCount: cppItem?.hotCount || 0,
            description: cppItem?.description || "",
            matchedCPPItem: cppItem,
            matchConfidence: result?.confidence,
            note: result?.requiresReview && result.candidate
              ? buildReviewNote(result.candidate)
              : result?.decision === "unmatched"
                ? "待补充：未找到可靠的 CPP 匹配"
                : undefined,
          };
          importedItems.push(item);
        }
        await createWishItemsAsync(listId, importedItems);
        } catch (error) {
          importError = new Error(getErrorMessage(error, "导入心愿单失败"));
          console.error("创建成功，但导入心愿单失败:", error);
        }
      }

      setIsModalOpen(false);
      setSelectedExhibit("");
      setListName("");
      setCreateUploadFile(null);
      await loadExhibits();
      if (importError) {
        alert(`心愿单已创建，但上传内容导入失败：${importError.message}`);
      }
    } catch (error: any) {
      alert("创建失败: " + error.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      await deleteExhibitAsync(deleteTarget.id, clientId);
      setDeleteTarget(null);
      await loadExhibits();
    } catch (error: any) {
      alert("删除失败: " + error.message);
    } finally {
      setDeleting(false);
    }
  };

  const handleJoinByCode = async () => {
    const code = inviteCode.trim().toUpperCase();
    if (code.length !== 4) {
      setJoinError("请输入 4 位清单识别码");
      return;
    }
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) {
      setJoinError("清单识别码格式不正确");
      return;
    }

    setJoinLoading(true);
    setJoinError("");

    try {
      const response = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, clientId }),
      });
      const data = await response.json();

      if (!response.ok) {
        setJoinError(data.error || "清单识别码无效");
        return;
      }

      router.push(`/exhibit/${data.eventId}`);
    } catch (error) {
      setJoinError("网络错误，请重试");
    } finally {
      setJoinLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center">
                <Target className="w-5 h-5 text-white" weight="bold" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900 font-display">
                  CP展会List帮手
                </h1>
                <p className="text-sm text-slate-500">同人展会心愿单管理工具</p>
              </div>
            </div>
            <button
              onClick={() => setIsModalOpen(true)}
              className="w-full sm:w-auto bg-indigo-600 text-white px-5 py-2.5 rounded-lg hover:bg-indigo-700 transition-colors font-medium flex items-center justify-center gap-2 active:scale-[0.98]"
            >
              <Plus className="w-4 h-4" weight="bold" />
              <span>创建心愿单</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        {loading ? (
          <div className="text-center py-20">
            <Spinner className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-4" />
            <p className="text-slate-500">加载中...</p>
          </div>
        ) : exhibits.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <ListHeart className="w-8 h-8 text-slate-400" />
            </div>
            <h2 className="text-xl font-semibold text-slate-700 mb-2 font-display">还没有心愿单</h2>
            <p className="text-slate-500 text-sm mb-8">点击上方按钮创建第一个心愿单</p>

            {/* 清单识别码加入（即使没有展会也显示） */}
            <InviteCodeCard
              code={inviteCode}
              setCode={setInviteCode}
              joinError={joinError}
              joinLoading={joinLoading}
              onJoin={handleJoinByCode}
            />
          </div>
        ) : (
          <>
            {/* 清单识别码加入卡片 */}
            <InviteCodeCard
              code={inviteCode}
              setCode={setInviteCode}
              joinError={joinError}
              joinLoading={joinLoading}
              onJoin={handleJoinByCode}
            />

            {/* 分隔线 */}
            <div className="flex items-center gap-4 my-8">
              <div className="flex-1 h-px bg-slate-200" />
              <span className="text-sm text-slate-400">我的心愿单</span>
              <div className="flex-1 h-px bg-slate-200" />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {exhibits.map((exhibit) => (
              <div
                key={exhibit.id}
                onClick={() => router.push(`/exhibit/${exhibit.id}`)}
                className="bg-white rounded-xl border border-slate-200 hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer overflow-hidden group"
              >
                <div className="p-5">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-lg font-bold text-slate-900 group-hover:text-indigo-600 transition-colors font-display">
                      {exhibit.name}
                    </h3>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(exhibit);
                      }}
                      className="text-slate-300 hover:text-rose-500 transition-colors p-1 rounded"
                    >
                      <Trash className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="space-y-2.5 text-slate-600 text-sm">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-slate-400" />
                      <span>{exhibit.date}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <ListHeart className="w-4 h-4 text-slate-400" />
                      <span>心愿单 <strong className="text-indigo-600">{exhibit.items.length}</strong> 件</span>
                    </div>
                  </div>
                  <div className="mt-5 pt-4 border-t border-slate-100">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-slate-400">点击查看详情</span>
                      <ArrowRight className="w-4 h-4 text-indigo-500 group-hover:translate-x-1 transition-transform" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          </>
        )}
      </main>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-900 font-display">创建展会心愿单</h2>
              <button
                onClick={() => {
                  setIsModalOpen(false);
                  setSelectedExhibit("");
                  setListName("");
                  setCreateUploadFile(null);
                }}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">心愿单名称</label>
                <input
                  type="text"
                  value={listName}
                  onChange={(e) => setListName(e.target.value.slice(0, 50))}
                  maxLength={50}
                  placeholder="例如：熊的CP32大买一场"
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                />
                <div className="mt-1 text-right text-xs text-slate-400">{listName.length}/50</div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">选择展会</label>
                <div className="relative">
                  <select
                    value={selectedExhibit}
                    onChange={(e) => setSelectedExhibit(e.target.value)}
                    className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm appearance-none bg-white cursor-pointer"
                  >
                    <option value="">请选择展会</option>
                    {EXHIBIT_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <CaretDown className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>
              {selectedExhibit && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">展会日期</label>
                  <div className="px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700">
                    {EXHIBIT_PRESETS.find((p) => p.id === selectedExhibit)?.days.map((d) => d.name).join(" / ")}
                  </div>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  上传心愿单 <span className="font-normal text-slate-400">（可选）</span>
                </label>
                <label className="w-full px-3.5 py-3 border border-dashed border-slate-300 rounded-lg hover:border-indigo-400 hover:bg-indigo-50/40 transition-colors cursor-pointer flex items-center gap-2 text-sm text-slate-600">
                  <UploadSimple className="w-5 h-5 text-indigo-500 shrink-0" />
                  <span className="truncate">{createUploadFile?.name || "选择 Excel 或 CSV 文件"}</span>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(event) => setCreateUploadFile(event.target.files?.[0] || null)}
                  />
                </label>
                <p className="mt-1 text-xs text-slate-400">创建后会自动导入并匹配展品信息</p>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleCreate}
                disabled={creating || !selectedExhibit || !listName.trim()}
                className="flex-1 bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700 transition-colors font-medium active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {creating && <Spinner className="w-4 h-4 animate-spin" />}
                {creating ? "创建中..." : "创建"}
              </button>
              <button
                onClick={() => {
                  setIsModalOpen(false);
                  setSelectedExhibit("");
                  setListName("");
                  setCreateUploadFile(null);
                }}
                className="flex-1 bg-slate-100 text-slate-700 py-2.5 rounded-lg hover:bg-slate-200 transition-colors font-medium"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl max-w-sm w-full p-6 shadow-xl">
            <div className="flex items-start gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center shrink-0">
                <Trash className="w-5 h-5 text-rose-600" weight="bold" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900 font-display">
                  {deleteTarget.accessRole === "owner"
                    ? `确认删除${deleteTarget.name}这份list?`
                    : `从我的列表移除${deleteTarget.name}?`}
                </h2>
                {deleteTarget.accessRole !== "owner" && (
                  <p className="text-sm text-slate-500 mt-1">
                    只会从当前设备移除，不会删除分享者的源 list。
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 bg-rose-600 text-white py-2.5 rounded-lg hover:bg-rose-700 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deleting && <Spinner className="w-4 h-4 animate-spin" />}
                {deleting ? "删除中..." : "删除"}
              </button>
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 bg-slate-100 text-slate-700 py-2.5 rounded-lg hover:bg-slate-200 transition-colors font-medium disabled:opacity-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 清单识别码输入卡片
// ============================================================

function InviteCodeCard({
  code,
  setCode,
  joinError,
  joinLoading,
  onJoin,
}: {
  code: string;
  setCode: (v: string) => void;
  joinError: string;
  joinLoading: boolean;
  onJoin: () => void;
}) {
  return (
    <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-100 rounded-xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Link className="w-5 h-5 text-indigo-600" weight="bold" />
        <h3 className="text-sm font-semibold text-indigo-900">使用清单识别码打开心愿单</h3>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 4));
            // 输入4位自动提交
            if (e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").length >= 4) {
              setTimeout(onJoin, 100);
            }
          }}
          onKeyDown={(e) => e.key === "Enter" && onJoin()}
          placeholder="4位清单识别码"
          maxLength={4}
          className="w-full min-w-0 px-4 py-2.5 border border-indigo-200 rounded-lg bg-white text-center text-lg font-mono font-bold tracking-widest text-indigo-900 placeholder-slate-300 placeholder:text-sm placeholder:font-normal placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        <button
          onClick={onJoin}
          disabled={joinLoading || code.length !== 4}
          className="w-full sm:w-auto px-4 py-2.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 whitespace-nowrap"
        >
          {joinLoading ? <Spinner className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
          加入
        </button>
      </div>
      {joinError && (
        <div className="flex items-center gap-1.5 mt-2 text-sm text-rose-600">
          <Warning className="w-4 h-4" />
          <span>{joinError}</span>
        </div>
      )}
    </div>
  );
}
