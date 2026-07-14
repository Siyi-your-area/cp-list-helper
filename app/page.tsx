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
} from "@phosphor-icons/react";
import type { Exhibit } from "@/lib/types";
import {
  getExhibitsAsync,
  createExhibitAsync,
  deleteExhibitAsync,
} from "@/lib/storage";

/**
 * 预设展会信息
 */
const EXHIBIT_PRESETS: {
  id: string;
  label: string;
  days: { id: string; name: string }[];
}[] = [
  {
    id: "cp32-day1",
    label: "CP32一期",
    days: [{ id: "7040", name: "5.1-5.2" }],
  },
  {
    id: "cp32-day2",
    label: "CP32二期",
    days: [{ id: "7042", name: "5.4-5.5" }],
  },
  {
    id: "cpg08",
    label: "CPG08",
    days: [{ id: "7073", name: "8.22-8.23" }],
  },
];

export default function Home() {
  const router = useRouter();
  const [exhibits, setExhibits] = useState<Exhibit[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedExhibit, setSelectedExhibit] = useState("");
  const [creating, setCreating] = useState(false);

  // ---- 邀请码加入 ----
  const [inviteCode, setInviteCode] = useState("");
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError] = useState("");

  useEffect(() => {
    loadExhibits();
  }, []);

  async function loadExhibits() {
    try {
      setLoading(true);
      const data = await getExhibitsAsync();
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

    try {
      setCreating(true);
      await createExhibitAsync(preset.id, preset.label, preset.days);
      setIsModalOpen(false);
      setSelectedExhibit("");
      await loadExhibits();
    } catch (error: any) {
      alert("创建失败: " + error.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除这个展会吗？心愿单数据也会被删除，但 CPP 展品数据不受影响。")) return;
    try {
      await deleteExhibitAsync(id);
      await loadExhibits();
    } catch (error: any) {
      alert("删除失败: " + error.message);
    }
  };

  const handleJoinByCode = async () => {
    const code = inviteCode.trim().toUpperCase();
    if (code.length !== 4) {
      setJoinError("请输入 4 位邀请码");
      return;
    }
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) {
      setJoinError("邀请码格式不正确");
      return;
    }

    setJoinLoading(true);
    setJoinError("");

    try {
      const response = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await response.json();

      if (!response.ok) {
        setJoinError(data.error || "邀请码无效");
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
          <div className="flex justify-between items-center">
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
              className="bg-indigo-600 text-white px-5 py-2.5 rounded-lg hover:bg-indigo-700 transition-colors font-medium flex items-center gap-2 active:scale-[0.98]"
            >
              <Plus className="w-4 h-4" weight="bold" />
              <span>创建新展会</span>
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
            <h2 className="text-xl font-semibold text-slate-700 mb-2 font-display">还没有展会</h2>
            <p className="text-slate-500 text-sm mb-8">点击上方按钮创建第一个展会</p>

            {/* 邀请码加入（即使没有展会也显示） */}
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
            {/* 邀请码加入卡片 */}
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
              <span className="text-sm text-slate-400">我的展会</span>
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
                        handleDelete(exhibit.id);
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
              <h2 className="text-xl font-bold text-slate-900 font-display">创建新展会</h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
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
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex-1 bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700 transition-colors font-medium active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {creating && <Spinner className="w-4 h-4 animate-spin" />}
                {creating ? "创建中..." : "创建"}
              </button>
              <button
                onClick={() => setIsModalOpen(false)}
                className="flex-1 bg-slate-100 text-slate-700 py-2.5 rounded-lg hover:bg-slate-200 transition-colors font-medium"
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
// 邀请码输入卡片
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
        <h3 className="text-sm font-semibold text-indigo-900">输入邀请码加入展会</h3>
      </div>
      <div className="flex gap-2">
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
          placeholder="请输入4位邀请码"
          maxLength={4}
          className="flex-1 px-4 py-2.5 border border-indigo-200 rounded-lg bg-white text-center text-lg font-mono font-bold tracking-widest text-indigo-900 placeholder-slate-300 placeholder:text-sm placeholder:font-normal placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        <button
          onClick={onJoin}
          disabled={joinLoading || code.length !== 4}
          className="px-6 py-2.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 whitespace-nowrap"
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
