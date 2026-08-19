export function ImageUploadProgress({
  percent,
  compact = false,
}: {
  percent: number | null;
  compact?: boolean;
}) {
  if (percent === null) return null;

  if (compact) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="absolute inset-0 grid place-items-center rounded-lg bg-slate-900/80 text-xs font-bold text-white backdrop-blur-sm"
      >
        {percent}%
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-x-2 bottom-2 overflow-hidden rounded-lg bg-slate-900/80 px-2.5 py-2 text-white shadow-lg backdrop-blur-sm"
    >
      <div className="mb-1 flex items-center justify-between text-[11px] font-medium">
        <span>{percent === 100 ? "图片已读取，等待保存" : "图片处理中"}</span>
        <span>{percent}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/30">
        <div
          className="h-full rounded-full bg-white transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
