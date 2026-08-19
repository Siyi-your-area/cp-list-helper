const pulse = "animate-pulse rounded-lg bg-slate-200";

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 border-t border-slate-100 px-3 py-3 sm:px-5">
      <div className={`${pulse} h-12 w-12 shrink-0`} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className={`${pulse} h-4 w-2/3`} />
        <div className={`${pulse} h-3 w-1/3`} />
      </div>
      <div className={`${pulse} h-7 w-16 rounded-full`} />
    </div>
  );
}

export function HomePageSkeleton() {
  return (
    <div aria-label="页面加载中" role="status" className="space-y-8 py-2">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1].map((key) => (
          <div key={key} className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className={`${pulse} mb-6 h-5 w-40`} />
            <div className="flex gap-3">
              <div className={`${pulse} h-14 flex-1`} />
              <div className={`${pulse} h-14 w-24`} />
            </div>
            <div className={`${pulse} mt-5 h-3 w-2/3`} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <div className="h-px flex-1 bg-slate-200" />
        <div className={`${pulse} h-4 w-20`} />
        <div className="h-px flex-1 bg-slate-200" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <div key={key} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
            <div className={`${pulse} h-5 w-1/2`} />
            <div className={`${pulse} h-4 w-3/4`} />
            <div className={`${pulse} h-10 w-full`} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExhibitPageSkeleton() {
  return (
    <div aria-label="list 加载中" role="status" className="flex min-h-screen flex-col overflow-hidden bg-slate-50">
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <div className={`${pulse} h-9 w-9 shrink-0`} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className={`${pulse} h-6 w-36`} />
            <div className={`${pulse} h-3 w-52 max-w-full`} />
          </div>
          <div className={`${pulse} h-9 w-24`} />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 overflow-hidden px-3 py-4 sm:px-6">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 sm:gap-3">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <div key={key} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className={`${pulse} mb-3 h-3 w-2/3`} />
              <div className={`${pulse} h-7 w-1/2`} />
            </div>
          ))}
        </div>
        <div className={`${pulse} h-12 w-full shrink-0`} />
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      </main>
    </div>
  );
}
