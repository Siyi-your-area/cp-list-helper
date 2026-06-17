"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Target,
  MapPin,
  Calendar,
  ListHeart,
  CheckCircle,
  Plus,
  X,
  ArrowRight,
  Trash,
} from "@phosphor-icons/react";
import type { Exhibit } from "@/lib/types";
import { getExhibits, saveExhibits, createExhibit, deleteExhibit } from "@/lib/storage";

export default function Home() {
  const router = useRouter();
  const [exhibits, setExhibits] = useState<Exhibit[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState({ name: "", venue: "", date: "" });

  useEffect(() => {
    setExhibits(getExhibits());
  }, []);

  const handleCreate = () => {
    if (!formData.name || !formData.venue || !formData.date) {
      if (!formData.name) {
        (document.querySelector('input[placeholder="例如：CP33"]') as HTMLInputElement)?.focus();
      } else if (!formData.venue) {
        (document.querySelector('input[placeholder="例如：上海国家会展中心"]') as HTMLInputElement)?.focus();
      } else {
        (document.querySelector('input[type="date"]') as HTMLInputElement)?.focus();
      }
      alert("请填写完整信息：展会名称、场馆、日期");
      return;
    }

    const newExhibit = createExhibit(formData.name, formData.venue, formData.date);
    setExhibits(getExhibits());
    setIsModalOpen(false);
    setFormData({ name: "", venue: "", date: "" });
  };

  const handleDelete = (id: string) => {
    if (!confirm("确定删除这个展会吗？")) return;
    deleteExhibit(id);
    setExhibits(getExhibits());
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
        {exhibits.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <ListHeart className="w-8 h-8 text-slate-400" />
            </div>
            <h2 className="text-xl font-semibold text-slate-700 mb-2 font-display">还没有展会</h2>
            <p className="text-slate-500 text-sm">点击上方按钮创建第一个展会</p>
          </div>
        ) : (
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
                      <MapPin className="w-4 h-4 text-slate-400" />
                      <span>{exhibit.venue}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-slate-400" />
                      <span>{exhibit.date}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <ListHeart className="w-4 h-4 text-slate-400" />
                      <span>心愿单 <strong className="text-indigo-600">{exhibit.items.length}</strong> 件</span>
                    </div>
                    {exhibit.cppData && (
                      <div className="flex items-center gap-2 text-emerald-600">
                        <CheckCircle className="w-4 h-4" weight="fill" />
                        <span>已导入CPP数据</span>
                      </div>
                    )}
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
                <label className="block text-sm font-medium text-slate-700 mb-1.5">展会名称</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="例如：CP33"
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">场馆</label>
                <input
                  type="text"
                  value={formData.venue}
                  onChange={(e) => setFormData({ ...formData, venue: e.target.value })}
                  placeholder="例如：上海国家会展中心"
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">展会日期</label>
                <input
                  type="date"
                  value={formData.date}
                  onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleCreate}
                className="flex-1 bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700 transition-colors font-medium active:scale-[0.98]"
              >
                创建
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
