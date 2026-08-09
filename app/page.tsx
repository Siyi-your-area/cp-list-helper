"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import NextLink from "next/link";
import {
  Calendar,
  ListHeart,
  Plus,
  X,
  ArrowRight,
  Trash,
  CaretDown,
  Spinner,
  Link as LinkIcon,
  Info,
  Warning,
  UploadSimple,
} from "@phosphor-icons/react";
import type { Exhibit, WishItem } from "@/lib/types";
import {
  getExhibitsAsync,
  createWishItemsAsync,
} from "@/lib/storage";
import { getClientId } from "@/lib/client-id";
import { authFetch, claimLegacyAccess, ensureAnonymousSession } from "@/lib/auth-client";
import { parseExcelFile } from "@/lib/excel-parser";
import { buildReviewNote } from "@/lib/match-review";
import { detectWishItemType, resolveImportedAuthor } from "@/lib/cpp-item-mapping";
import { matchCPPItemsInBatches } from "@/lib/cpp-match-client";
import { BearLogo } from "@/components/BearLogo";
import { CppUploadGuide } from "@/components/CppUploadGuide";

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
    days: [{ id: "7829", name: "8.22-8.23" }],
  },
];

export default function Home() {
  const router = useRouter();
  const [exhibits, setExhibits] = useState<Exhibit[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isImportMode, setIsImportMode] = useState(false);
  const [selectedExhibit, setSelectedExhibit] = useState("cpg08");
  const [listName, setListName] = useState("");
  const [createUploadFile, setCreateUploadFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [createStage, setCreateStage] = useState("");
  const [createElapsedSeconds, setCreateElapsedSeconds] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Exhibit | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [authError, setAuthError] = useState("");

  // ---- list识别码加入 ----
  const [inviteCode, setInviteCode] = useState("");
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError] = useState("");

  useEffect(() => {
    const legacyClientId = getClientId();
    void (async () => {
      try {
        await ensureAnonymousSession();
        await claimLegacyAccess(legacyClientId);
        await loadExhibits();
      } catch (error) {
        setAuthError(getErrorMessage(error, "身份初始化失败"));
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!creating) {
      setCreateElapsedSeconds(0);
      return;
    }

    setCreateElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setCreateElapsedSeconds((seconds) => seconds + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [creating]);

  async function loadExhibits() {
    try {
      setLoading(true);
      setAuthError("");
      const data = await getExhibitsAsync();
      setExhibits(data);
    } catch (error) {
      console.error("加载展会失败:", error);
      setAuthError(getErrorMessage(error, "读取list失败，请检查身份或数据库迁移"));
    } finally {
      setLoading(false);
    }
  }

  const openCreateModal = (importMode = false) => {
    setIsImportMode(importMode);
    setSelectedExhibit("cpg08");
    setCreateStage("");
    setCreateElapsedSeconds(0);
    setIsModalOpen(true);
  };

  const closeCreateModal = () => {
    setIsModalOpen(false);
    setIsImportMode(false);
    setSelectedExhibit("cpg08");
    setListName("");
    setCreateUploadFile(null);
    setCreateStage("");
  };

  const handleCreate = async () => {
    if (!selectedExhibit) {
      alert("请选择展会");
      return;
    }

    const preset = EXHIBIT_PRESETS.find((p) => p.id === selectedExhibit);
    if (!preset) return;

    const trimmedListName = listName.trim();
    if (!trimmedListName) {
      alert("请输入list名称");
      return;
    }
    if (trimmedListName.length > 50) {
      alert("list名称最多 50 个字");
      return;
    }

    try {
      setCreating(true);
      setCreateStage(createUploadFile ? "正在读取并检查上传文件" : "正在准备创建 list");
      const uploadInputs = createUploadFile ? await parseExcelFile(createUploadFile) : [];
      if (createUploadFile && uploadInputs.length === 0) {
        throw new Error("上传文件中没有找到 CPP 心愿单数据，请检查文件格式");
      }

      const listId = `${preset.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      setCreateStage("正在创建 list");
      const createResponse = await authFetch("/api/exhibits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: listId,
          name: trimmedListName,
          days: preset.days,
          cppEventId: preset.cppEventId,
        }),
      });
      const createResult = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createResult.error || "创建list失败");
      }

      let importError: Error | null = null;
      if (uploadInputs.length > 0) {
        try {
          setCreateStage(`正在匹配 CPP 制品：已匹配 0/${uploadInputs.length}`);
          const { results } = await matchCPPItemsInBatches({
            items: uploadInputs,
            eventId: listId,
            fetcher: authFetch,
            onProgress: (completed, total) => {
              setCreateStage(`正在匹配 CPP 制品：已匹配 ${completed}/${total}`);
            },
          });

        setCreateStage("正在整理匹配结果");
        const importedItems: Omit<WishItem, "id">[] = [];
        for (let index = 0; index < uploadInputs.length; index += 1) {
          const input = uploadInputs[index];
          const result = results[index];
          const cppItem = result?.cppItem;
          const itemType = detectWishItemType(cppItem);
          const item: Omit<WishItem, "id"> = {
            boothNumber: input.boothNumber,
            productName: input.productName,
            author: resolveImportedAuthor(input, cppItem),
            imageUrl: cppItem?.imageUrl || "",
            venue: input.boothNumber.charAt(0) || "",
            type: itemType,
            status: itemType === "free" ? "待领取" : "pending",
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
        setCreateStage("正在保存导入条目");
        await createWishItemsAsync(listId, importedItems);
        } catch (error) {
          importError = new Error(getErrorMessage(error, "导入 CPP 心愿单失败"));
          console.error("创建成功，但导入 CPP 心愿单失败:", error);
        }
      }

      if (importError) {
        closeCreateModal();
        await loadExhibits();
        alert(`list已创建，但 CPP 心愿单导入失败：${importError.message}`);
      } else {
        setCreateStage("正在打开 list 详情");
        router.push(`/exhibit/${listId}`);
        closeCreateModal();
      }
    } catch (error: any) {
      alert("创建失败: " + error.message);
    } finally {
      setCreating(false);
      setCreateStage("");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      const response = await authFetch(`/api/exhibits/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "删除或移除失败");
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
      setJoinError("请输入 4 位list识别码");
      return;
    }
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) {
      setJoinError("list识别码格式不正确");
      return;
    }

    setJoinLoading(true);
    setJoinError("");

    try {
      const response = await authFetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await response.json();

      if (!response.ok) {
        setJoinError(data.error || "list识别码无效");
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
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 pr-12 sm:pr-0">
              <BearLogo />
              <div>
                <h1 className="text-2xl font-bold text-slate-900 font-display">
                  CP list帮手
                </h1>
                <p className="text-sm text-slate-500">同人展会list管理工具</p>
              </div>
            </div>
            <NextLink
              href="/about"
              aria-label="关于与数据版权声明"
              className="absolute right-0 top-0 grid h-10 w-10 place-items-center rounded-xl bg-[#E3E4E0] text-[#4F5750] transition-colors hover:bg-[#D4C8BE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7F867B] focus-visible:ring-offset-2 sm:hidden"
            >
              <Info className="h-5 w-5" />
            </NextLink>
            <div className="flex w-full gap-2 sm:w-auto">
              <NextLink href="/about" className="ui-btn-secondary hidden sm:inline-flex">
                <Info className="h-4 w-4" />
                <span>关于</span>
              </NextLink>
              <button
                onClick={() => openCreateModal(false)}
                className="ui-btn-primary w-full active:scale-[0.98] sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                <span>创建展会list</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        {authError && (
          <div role="alert" className="mb-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            {authError}
          </div>
        )}
        {loading ? (
          <div className="text-center py-20">
            <Spinner className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-4" />
            <p className="text-slate-500">加载中...</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <InviteCodeCard
                code={inviteCode}
                setCode={setInviteCode}
                joinError={joinError}
                joinLoading={joinLoading}
                onJoin={handleJoinByCode}
              />
              <CppImportCard onImport={() => openCreateModal(true)} />
            </div>

            {exhibits.length === 0 ? (
              <div className="py-16 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100">
                  <ListHeart className="h-8 w-8 text-slate-400" />
                </div>
                <h2 className="mb-2 text-xl font-semibold text-slate-700 font-display">还没有list</h2>
                <p className="text-sm text-slate-500">创建、导入或使用识别码加入第一份list</p>
              </div>
            ) : (
              <>
                <div className="my-8 flex items-center gap-4">
                  <div className="h-px flex-1 bg-slate-200" />
                  <span className="text-sm text-slate-400">我的list</span>
                  <div className="h-px flex-1 bg-slate-200" />
                </div>

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
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
                    <div className="flex items-center gap-2 text-xs">
                      <span className="rounded-full bg-indigo-50 px-2 py-1 font-medium text-indigo-700">
                        {exhibit.accessRole === "owner" ? "创建人" : "协作者"}
                      </span>
                      <span className="text-slate-400">{exhibit.collaboratorCount || 0} 位协作者</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-slate-400" />
                      <span>{exhibit.date}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <ListHeart className="w-4 h-4 text-slate-400" />
                      <span>list <strong className="text-indigo-600">{exhibit.items.length}</strong> 件</span>
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
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 py-5 text-xs text-slate-500 sm:flex-row sm:px-6 lg:px-8">
          <span>开发者：IcebearHuang</span>
          <div className="flex items-center gap-3">
            <a
              href="https://xhslink.com/m/j0ghQF9UjL"
              target="_blank"
              rel="noreferrer"
              className="text-slate-700 underline decoration-amber-400 decoration-2 underline-offset-4"
            >
              小红书主页
            </a>
            <NextLink
              href="/about"
              className="text-slate-700 underline decoration-amber-400 decoration-2 underline-offset-4"
            >
              数据与版权声明
            </NextLink>
          </div>
        </div>
      </footer>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-900 font-display">
                {isImportMode ? "从 CPP 导入list" : "创建展会list"}
              </h2>
              <button
                onClick={closeCreateModal}
                disabled={creating}
                aria-label="关闭创建窗口"
                className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-600 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">list名称</label>
                <input
                  type="text"
                  disabled={creating}
                  value={listName}
                  onChange={(e) => setListName(e.target.value.slice(0, 50))}
                  maxLength={50}
                  placeholder="例如：熊的cpg list"
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                />
                <div className="mt-1 text-right text-xs text-slate-400">{listName.length}/50</div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">选择展会</label>
                <div className="relative">
                  <select
                    disabled={creating}
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
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <label className="text-sm font-medium text-slate-700">
                    上传CPP心愿单{" "}
                    <span className="font-normal text-slate-400">
                      {isImportMode ? "（必填）" : "（可选）"}
                    </span>
                  </label>
                  <CppUploadGuide />
                </div>
                <label className="w-full px-3.5 py-3 border border-dashed border-slate-300 rounded-lg hover:border-indigo-400 hover:bg-indigo-50/40 transition-colors cursor-pointer flex items-center gap-2 text-sm text-slate-600">
                  <UploadSimple className="w-5 h-5 text-indigo-500 shrink-0" />
                  <span className="truncate">{createUploadFile?.name || "选择 Excel 或 CSV 文件"}</span>
                  <input
                    type="file"
                    disabled={creating}
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(event) => setCreateUploadFile(event.target.files?.[0] || null)}
                  />
                </label>
                <p className="mt-1 text-xs text-slate-400">创建后会自动导入并匹配展品信息</p>
              </div>
            </div>

            {creating && (
              <div
                role="status"
                aria-live="polite"
                className="mt-5 rounded-lg border border-indigo-100 bg-indigo-50/70 p-3.5 text-sm text-slate-700"
              >
                <div className="flex items-center gap-2 font-medium text-slate-800">
                  <Spinner className="h-4 w-4 shrink-0 text-indigo-600 motion-safe:animate-spin" />
                  <span className="min-w-0 flex-1">{createStage || "正在处理"}</span>
                  <span
                    aria-hidden="true"
                    className="shrink-0 tabular-nums text-xs text-slate-500"
                  >
                    已等待 {createElapsedSeconds} 秒
                  </span>
                </div>
                <div
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-indigo-100"
                  aria-hidden="true"
                >
                  <div className="h-full w-full rounded-full bg-indigo-500/70 motion-safe:animate-pulse" />
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-600">
                  匹配通常需要1分钟以上，请耐心等待，请勿关闭页面
                </p>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleCreate}
                disabled={
                  creating ||
                  !selectedExhibit ||
                  !listName.trim() ||
                  (isImportMode && !createUploadFile)
                }
                className="ui-btn-primary flex-1 active:scale-[0.98]"
              >
                {creating && <Spinner className="w-4 h-4 animate-spin" />}
                {creating ? "处理中..." : isImportMode ? "导入并创建" : "创建list"}
              </button>
              <button
                onClick={closeCreateModal}
                disabled={creating}
                className="ui-btn-secondary flex-1"
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
                <Trash className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900 font-display">
                  {deleteTarget.accessRole === "owner"
                    ? `确认删除${deleteTarget.name}这份list?`
                    : `从我的列表移除${deleteTarget.name}?`}
                </h2>
                {deleteTarget.accessRole !== "owner" && (
                  <p className="text-sm text-slate-500 mt-1">
                    只会移除你的协作者成员关系，不会删除创建人的源 list。
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="ui-btn-danger flex-1"
              >
                {deleting && <Spinner className="w-4 h-4 animate-spin" />}
                {deleting ? "处理中..." : deleteTarget.accessRole === "owner" ? "删除整份list" : "退出协作"}
              </button>
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="ui-btn-secondary flex-1"
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
// list识别码输入卡片
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
  const normalizeCode = (value: string) =>
    value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 4);

  const handleCodeChange = (value: string) => {
    const normalized = normalizeCode(value);
    setCode(normalized);
    if (normalized.length === 4) {
      setTimeout(onJoin, 100);
    }
  };

  return (
    <section className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center gap-2 mb-3">
        <LinkIcon className="h-5 w-5 text-indigo-600" />
        <h3 className="text-sm font-semibold text-slate-900">使用list识别码打开list</h3>
      </div>
      <div className="my-auto grid grid-cols-[minmax(0,20rem)_auto] items-center justify-center gap-2 py-4">
        <div className="relative">
          <input
            type="text"
            value={code}
            onChange={(e) => handleCodeChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onJoin()}
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={4}
            aria-label="4位list识别码"
            className="peer absolute inset-0 z-10 h-full w-full cursor-text opacity-0"
          />
          <div className="grid grid-cols-4 gap-2 sm:gap-3" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => {
              const active = code.length === index || (code.length === 4 && index === 3);
              return (
                <div
                  key={index}
                  className={`grid aspect-square min-w-0 place-items-center rounded-xl border text-xl font-bold text-slate-900 transition-colors ${
                    active
                      ? "border-indigo-600 bg-indigo-50 ring-2 ring-indigo-500/20"
                      : "border-slate-200 bg-slate-100"
                  }`}
                >
                  {code[index] || ""}
                </div>
              );
            })}
          </div>
        </div>
        <button
          onClick={onJoin}
          disabled={joinLoading || code.length !== 4}
          className="ui-btn-primary whitespace-nowrap"
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
    </section>
  );
}

function CppImportCard({ onImport }: { onImport: () => void }) {
  return (
    <section className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-5">
      <div className="mb-1 flex items-center gap-2">
        <UploadSimple className="h-5 w-5 text-indigo-600" />
        <h3 className="text-sm font-semibold text-slate-900">从 CPP 导入</h3>
      </div>
      <p className="mb-4 text-xs leading-5 text-slate-500">
        支持 CP32 一期 / 二期、CPG08 的 CPP 心愿单 Excel，导入时请选择对应展会。
      </p>
      <button
        type="button"
        onClick={onImport}
        className="ui-btn-outline mt-auto w-full"
      >
        <UploadSimple className="h-5 w-5" />
        上传 CPP 心愿单 Excel
      </button>
      <div className="mt-1 flex justify-center">
        <CppUploadGuide />
      </div>
    </section>
  );
}
