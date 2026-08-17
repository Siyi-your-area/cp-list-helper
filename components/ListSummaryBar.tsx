"use client";

import { useMemo, useState } from "react";
import { Gift, Package, Tag, Wallet } from "@phosphor-icons/react";
import type { WishItem } from "@/lib/types";
import { calculateListSummary } from "@/lib/list-summary";

type SummaryKind = "total" | "paid" | "free" | "cost";

interface ListSummaryBarProps {
  items: readonly WishItem[];
  className?: string;
}

function formatCurrency(value: number): string {
  return `¥${value.toLocaleString("zh-CN", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function ListSummaryBar({ items, className = "" }: ListSummaryBarProps) {
  const summary = useMemo(() => calculateListSummary(items), [items]);
  const [activeKind, setActiveKind] = useState<SummaryKind>("total");

  const tiles = [
    { kind: "total" as const, label: "总展品", value: summary.total, icon: Package },
    { kind: "paid" as const, label: "有料", value: summary.paid, icon: Tag },
    { kind: "free" as const, label: "无料", value: summary.free, icon: Gift },
    { kind: "cost" as const, label: "实际花费", value: formatCurrency(summary.actualCost), icon: Wallet },
  ];

  return (
    <section className={`overflow-hidden rounded-2xl border border-slate-200 bg-white ${className}`} aria-label="list 统计">
      <div className="grid grid-cols-4">
        {tiles.map(({ kind, label, value, icon: Icon }, index) => (
          <button
            key={kind}
            type="button"
            aria-pressed={activeKind === kind}
            aria-controls="list-summary-detail"
            onClick={() => setActiveKind(kind)}
            onMouseEnter={() => setActiveKind(kind)}
            onFocus={() => setActiveKind(kind)}
            className={`min-w-0 border-slate-200 px-2 py-3 text-left transition-colors sm:px-4 ${
              index < tiles.length - 1 ? "border-r" : ""
            } ${activeKind === kind ? "bg-slate-50" : "bg-white hover:bg-slate-50"}`}
          >
            <span className="flex items-center gap-1 text-[11px] text-slate-500 sm:text-xs">
              <Icon className="hidden h-3.5 w-3.5 shrink-0 sm:block" />
              <span className="truncate">{label}</span>
            </span>
            <strong className="mt-1 block truncate font-display text-lg font-bold text-slate-800 sm:text-2xl">
              {value}
            </strong>
          </button>
        ))}
      </div>
      <div id="list-summary-detail" className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 px-3 py-2 text-xs text-slate-500 sm:px-4">
        {activeKind === "total" && (
          <>
            <span>待购买 <strong className="text-slate-800">{summary.pending}</strong></span>
            <span>已购买 <strong className="text-slate-800">{summary.purchased}</strong></span>
            <span>已售罄 <strong className="text-slate-800">{summary.soldout}</strong></span>
            <span>待领取 <strong className="text-slate-800">{summary.pendingPickup}</strong></span>
            <span>已领取 <strong className="text-slate-800">{summary.received}</strong></span>
          </>
        )}
        {activeKind === "paid" && (
          <>
            <span>待购买 <strong className="text-slate-800">{summary.pending}</strong></span>
            <span>已购买 <strong className="text-slate-800">{summary.purchased}</strong></span>
            <span>已售罄 <strong className="text-slate-800">{summary.soldout}</strong></span>
          </>
        )}
        {activeKind === "free" && (
          <>
            <span>待领取 <strong className="text-slate-800">{summary.pendingPickup}</strong></span>
            <span>已领取 <strong className="text-slate-800">{summary.received}</strong></span>
          </>
        )}
        {activeKind === "cost" && (
          <>
            <span>预计花费 <strong className="text-slate-800">{formatCurrency(summary.estimatedCost)}</strong></span>
            <span>实际花费仅统计已购买制品</span>
          </>
        )}
      </div>
    </section>
  );
}
