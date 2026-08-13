"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  CheckCircle,
  LinkSimple,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { authFetch } from "@/lib/auth-client";
import { parseCPPProductLink } from "@/lib/cpp-link";
import { detectWishItemType } from "@/lib/cpp-item-mapping";
import { NOTE_MAX_LENGTH, type NormalizedCPPItem, type Priority, type WishItem } from "@/lib/types";
import { getWishItemVenue } from "@/lib/wish-item-sort";

type NewWishItem = Omit<WishItem, "id">;
type LookupState = "idle" | "loading" | "success" | "not-found" | "error";

interface AddWishItemDialogProps {
  eventId: string;
  existingItems: WishItem[];
  onClose: () => void;
  onSubmit: (item: NewWishItem) => Promise<void>;
}

const fieldClass =
  "min-h-11 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200";

export function AddWishItemDialog({
  eventId,
  existingItems,
  onClose,
  onSubmit,
}: AddWishItemDialogProps) {
  const [cppUrl, setCppUrl] = useState("");
  const [lookupState, setLookupState] = useState<LookupState>("idle");
  const [lookupMessage, setLookupMessage] = useState("");
  const [linkedCPPItem, setLinkedCPPItem] = useState<NormalizedCPPItem | null>(null);
  const [productName, setProductName] = useState("");
  const [author, setAuthor] = useState("");
  const [boothNumber, setBoothNumber] = useState("");
  const [type, setType] = useState<"paid" | "free">("paid");
  const [priority, setPriority] = useState<Priority>("随缘");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [purchaseLimit, setPurchaseLimit] = useState("");
  const [note, setNote] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lookupSequenceRef = useRef(0);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, submitting]);

  const applyCPPItem = (item: NormalizedCPPItem) => {
    setLinkedCPPItem(item);
    setProductName(item.productName || "");
    setAuthor(item.author || "");
    setBoothNumber(item.boothNumber || "");
    setType(detectWishItemType(item));
    setImageUrl(item.imageUrl || "");
  };

  const lookupCPPItem = async (value = cppUrl) => {
    const normalizedUrl = value.trim();
    if (!parseCPPProductLink(normalizedUrl)) {
      setLinkedCPPItem(null);
      setLookupState("error");
      setLookupMessage("不是有效的 CPP 制品链接，请检查后重试。");
      return;
    }

    const sequence = ++lookupSequenceRef.current;
    setLookupState("loading");
    setLookupMessage("");
    try {
      const response = await authFetch("/api/cpp/item-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, cppUrl: normalizedUrl }),
      });
      const data = await response.json().catch(() => ({}));
      if (sequence !== lookupSequenceRef.current) return;
      if (!response.ok) throw new Error(data.error || "读取失败");
      if (!data.found || !data.item) {
        setLinkedCPPItem(null);
        setLookupState("not-found");
        setLookupMessage("当前展会数据库暂未收录该制品，你仍然可以手动填写。");
        return;
      }
      applyCPPItem(data.item as NormalizedCPPItem);
      setLookupState("success");
      setLookupMessage("资料已自动填入，你可以继续修改后添加。");
    } catch (error) {
      if (sequence !== lookupSequenceRef.current) return;
      setLinkedCPPItem(null);
      setLookupState("error");
      setLookupMessage(error instanceof Error ? error.message : "读取失败，请稍后重试。");
    }
  };

  const handlePasteLink = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text").trim();
    if (!pasted) return;
    event.preventDefault();
    setCppUrl(pasted);
    window.setTimeout(() => void lookupCPPItem(pasted), 0);
  };

  const handleImageFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      setLookupState("error");
      setLookupMessage("请选择图片文件。");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setLookupState("error");
      setLookupMessage("图片大小不能超过 2MB。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setImageUrl(String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  const duplicate = Boolean(
    productName.trim() && existingItems.some((item) =>
      item.productName.trim() === productName.trim()
      && item.boothNumber.trim() === boothNumber.trim()
    )
  );

  const handleSubmit = async () => {
    if (!productName.trim()) {
      setLookupState("error");
      setLookupMessage("请填写制品名称。");
      return;
    }

    const parsedPrice = price.trim() === "" ? undefined : Number(price);
    const parsedQuantity = Math.max(1, Number(quantity) || 1);
    const parsedLimit = purchaseLimit.trim() === "" ? undefined : Math.max(1, Number(purchaseLimit) || 1);
    if (parsedPrice !== undefined && (!Number.isFinite(parsedPrice) || parsedPrice < 0)) {
      setLookupState("error");
      setLookupMessage("单价需要填写为不小于 0 的数字。");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        boothNumber: boothNumber.trim(),
        venue: getWishItemVenue({ boothNumber: boothNumber.trim() }),
        productName: productName.trim(),
        author: author.trim(),
        imageUrl,
        type,
        status: type === "free" ? "待领取" : "pending",
        priority,
        price: parsedPrice,
        quantity: parsedQuantity,
        purchaseLimit: parsedLimit,
        note: note.trim() || undefined,
        hotCount: linkedCPPItem?.hotCount ?? 0,
        description: linkedCPPItem?.description || "",
        matchedCPPItem: linkedCPPItem || undefined,
        matchConfidence: linkedCPPItem ? "exact" : undefined,
      });
      onClose();
    } catch (error) {
      setLookupState("error");
      setLookupMessage(error instanceof Error ? error.message : "添加失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/40 sm:items-center sm:p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-item-title"
        className="flex max-h-[94dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:max-h-[90vh] sm:rounded-3xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-5 py-5 sm:px-7">
          <div>
            <h2 id="add-item-title" className="text-xl font-bold text-slate-900 sm:text-2xl">添加制品</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500 sm:text-sm">粘贴 CPP 链接自动补全，或者直接手动填写。</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200" aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-7">
          <div>
            <label htmlFor="cpp-item-url" className="mb-2 block text-sm font-semibold text-slate-800">
              CPP 制品链接 <span className="font-normal text-slate-400">（可选）</span>
            </label>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <div className="relative">
                <LinkSimple className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                <input
                  id="cpp-item-url"
                  value={cppUrl}
                  onChange={(event) => {
                    setCppUrl(event.target.value);
                    if (!event.target.value.trim()) {
                      setLookupState("idle");
                      setLinkedCPPItem(null);
                    }
                  }}
                  onPaste={handlePasteLink}
                  placeholder="粘贴 https://www.allcpp.cn/d/…"
                  className={`${fieldClass} pl-9`}
                />
              </div>
              <button type="button" onClick={() => void lookupCPPItem()} disabled={lookupState === "loading"} className="ui-btn-primary min-w-[84px] px-4 disabled:opacity-60">
                {lookupState === "loading" ? <SpinnerGap className="h-4 w-4 animate-spin" /> : "读取"}
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">只读取当前展会已经同步到本工具数据库的制品。</p>
          </div>

          {lookupState !== "idle" && lookupState !== "loading" && (
            <div className={`rounded-2xl border p-4 ${lookupState === "success" ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`} role="status">
              <div className={`flex items-center gap-2 text-sm font-semibold ${lookupState === "success" ? "text-emerald-800" : "text-rose-800"}`}>
                {lookupState === "success" ? <CheckCircle className="h-5 w-5" /> : <WarningCircle className="h-5 w-5" />}
                {lookupState === "success" ? "已从 CPP 数据库读取" : lookupState === "not-found" ? "没有找到对应制品" : "读取未完成"}
              </div>
              <p className="mt-1 pl-7 text-xs leading-5 text-slate-600">{lookupMessage}</p>
              {lookupState === "success" && linkedCPPItem && (
                <div className="mt-3 space-y-3 border-t border-emerald-200/70 pt-3">
                  <div className="flex items-center gap-3">
                    {imageUrl ? <img src={imageUrl} alt="" className="h-16 w-16 rounded-xl border border-white object-cover" /> : <div className="grid h-16 w-16 place-items-center rounded-xl bg-white text-slate-400"><Camera className="h-5 w-5" /></div>}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">{linkedCPPItem.productName}</p>
                      <p className="mt-1 truncate text-xs text-slate-500">{linkedCPPItem.author || "作者未填写"} · {linkedCPPItem.boothNumber || "摊位号待公布"} · 热度 {linkedCPPItem.hotCount ?? 0}</p>
                    </div>
                  </div>
                  {linkedCPPItem.description && (
                    <div className="rounded-xl bg-white/80 p-3">
                      <p className="text-xs font-semibold text-slate-700">展品详情</p>
                      <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-600">
                        {linkedCPPItem.description}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 text-xs text-slate-400 before:h-px before:flex-1 before:bg-slate-200 after:h-px after:flex-1 after:bg-slate-200">
            确认或补充制品信息
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="mb-2 block text-sm font-semibold text-slate-800">制品名称 *</span>
              <input value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="请输入制品名称" className={fieldClass} />
            </label>
            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-800">作者</span>
              <input value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="作者名称" className={fieldClass} />
            </label>
            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-800">摊位号</span>
              <input value={boothNumber} onChange={(event) => setBoothNumber(event.target.value)} placeholder="例如：壹A01 / 创064" className={fieldClass} />
            </label>
            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-800">类型</span>
              <select value={type} onChange={(event) => setType(event.target.value as "paid" | "free")} className={fieldClass}>
                <option value="paid">有料</option>
                <option value="free">无料</option>
              </select>
            </label>
            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-800">优先级</span>
              <select value={priority} onChange={(event) => setPriority(event.target.value as Priority)} className={fieldClass}>
                <option value="首摊">首摊</option><option value="次摊">次摊</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option><option value="随缘">随缘</option>
              </select>
            </label>
            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-800">单价</span>
              <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" placeholder="¥ 选填" className={fieldClass} />
            </label>
            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-800">数量</span>
              <input value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" min="1" className={fieldClass} />
            </label>
            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-800">限购数量</span>
              <input value={purchaseLimit} onChange={(event) => setPurchaseLimit(event.target.value)} type="number" min="1" placeholder="选填" className={fieldClass} />
            </label>
            <label className="sm:col-span-2">
              <span className="mb-2 block text-sm font-semibold text-slate-800">备注</span>
              <textarea value={note} maxLength={NOTE_MAX_LENGTH} onChange={(event) => setNote(event.target.value)} placeholder="想提醒自己或协作者的信息" className={`${fieldClass} min-h-20 resize-y`} />
              <span className="mt-1 block text-right text-xs text-slate-400">{note.length}/{NOTE_MAX_LENGTH}</span>
            </label>
            <div className="sm:col-span-2">
              <span className="mb-2 block text-sm font-semibold text-slate-800">图片 <span className="font-normal text-slate-400">（可选）</span></span>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="flex min-h-20 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500 hover:border-slate-400">
                {imageUrl ? <><img src={imageUrl} alt="" className="h-14 w-14 rounded-lg object-cover" /><span>点击更换图片</span></> : <><Camera className="h-5 w-5" /><span>上传图片</span></>}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) handleImageFile(file); event.target.value = ""; }} />
            </div>
          </div>

          {duplicate && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">list 中已有相同摊位号和制品名称；如确实需要，仍可继续添加。</p>}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-white px-5 py-4 sm:px-7">
          <p className="hidden max-w-xs text-xs leading-5 text-slate-500 sm:block">关联 CPP 后，摊位号和热度可以继续拉取最新数据。</p>
          <div className="ml-auto flex w-full gap-2 sm:w-auto">
            <button type="button" onClick={onClose} disabled={submitting} className="ui-btn-secondary min-h-11 flex-1 px-5 sm:flex-none">取消</button>
            <button type="button" onClick={() => void handleSubmit()} disabled={submitting} className="ui-btn-primary min-h-11 flex-1 px-5 disabled:opacity-60 sm:flex-none">
              {submitting ? "添加中…" : "添加到 list"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
