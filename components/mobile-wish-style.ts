/** 手机清单与地图共用的状态颜色；放在 Tailwind 扫描的组件目录。 */
export function getStatusColor(status: string): string {
  switch (status) {
    case "pending":
    case "待领取":
      return "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300";
    case "已买待取":
      return "bg-violet-100 text-violet-900 ring-1 ring-inset ring-violet-300";
    case "purchased":
    case "已领取":
      return "bg-emerald-100 text-emerald-900 ring-1 ring-inset ring-emerald-300";
    case "soldout":
      return "bg-rose-100 text-rose-900 ring-1 ring-inset ring-rose-300";
    default:
      return "bg-slate-100 text-slate-600";
  }
}
