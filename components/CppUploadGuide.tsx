"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Info, X } from "@phosphor-icons/react";

type GuidePlatform = "pc" | "app";

interface GuideStep {
  image: string;
  alt: string;
  title: string;
  description: string;
}

const GUIDE_FLOWS: Record<
  GuidePlatform,
  { label: string; steps: GuideStep[] }
> = {
  pc: {
    label: "CPP 网页版",
    steps: [
      {
        image: "/guides/cpp-upload/pc-1.png",
        alt: "CPP 网页版首页打开我的菜单并选择心愿单",
        title: "进入我的心愿单",
        description: "在 CPP 首页右上角打开「我的」，选择「心愿单」。",
      },
      {
        image: "/guides/cpp-upload/pc-2.png",
        alt: "CPP 网页版心愿单页面选择活动下拉菜单",
        title: "筛选计划参加的展会",
        description: "在心愿单页面打开「选择活动」，筛选你想去的展会。",
      },
      {
        image: "/guides/cpp-upload/pc-3.png",
        alt: "CPP 网页版选择全部并点击导出心愿单",
        title: "选择全部并导出",
        description:
          "筹备状态与类型细分均选择「全部」，然后点击「导出心愿单」。",
      },
      {
        image: "/guides/cpp-upload/upload.png",
        alt: "CP list帮手上传 CPP 心愿单 Excel 文件",
        title: "上传下载的 CPP 心愿单",
        description: "回到这里，选择刚刚下载的 Excel 文件并上传。",
      },
    ],
  },
  app: {
    label: "CPP 手机 App",
    steps: [
      {
        image: "/guides/cpp-upload/app-1.png",
        alt: "CPP 手机 App 我的页面中逛展交流区域的心愿单入口",
        title: "进入我的心愿单",
        description: "打开 CPP App，选择「我的」→「逛展交流」→「心愿单」。",
      },
      {
        image: "/guides/cpp-upload/app-2.png",
        alt: "CPP 手机 App 生成离线攻略并选择导出表格",
        title: "生成离线攻略表格",
        description:
          "在「我的心愿单」选择生成离线攻略，展示方式选择「导出表格」，选择活动届次后确认。",
      },
      {
        image: "/guides/cpp-upload/upload.png",
        alt: "CP list帮手上传 CPP 心愿单 Excel 文件",
        title: "上传导出的 CPP 心愿单",
        description: "回到这里，选择刚刚导出的表格文件并上传。",
      },
    ],
  },
};

export function CppUploadGuide() {
  const [isOpen, setIsOpen] = useState(false);
  const [platform, setPlatform] = useState<GuidePlatform>("pc");
  const [stepIndex, setStepIndex] = useState(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const wheelLockedRef = useRef(false);

  const flow = GUIDE_FLOWS[platform];
  const step = flow.steps[stepIndex];

  const closeGuide = useCallback(() => {
    setIsOpen(false);
    setPlatform("pc");
    setStepIndex(0);
  }, []);

  const moveStep = useCallback(
    (direction: 1 | -1) => {
      setStepIndex((current) =>
        Math.min(
          Math.max(current + direction, 0),
          GUIDE_FLOWS[platform].steps.length - 1
        )
      );
    },
    [platform]
  );

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeGuide();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeGuide, isOpen]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    if (Math.abs(delta) < 24 || wheelLockedRef.current) return;
    event.preventDefault();
    moveStep(delta > 0 ? 1 : -1);
    wheelLockedRef.current = true;
    window.setTimeout(() => {
      wheelLockedRef.current = false;
    }, 420);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-50"
      >
        <Info className="h-4 w-4" />
        如何从 CPP 导出？
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-3 backdrop-blur-sm sm:p-6"
          onClick={closeGuide}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="cpp-upload-guide-title"
            className="flex max-h-[92dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 sm:px-6">
              <div>
                <h2
                  id="cpp-upload-guide-title"
                  className="text-lg font-bold text-slate-900 font-display"
                >
                  如何从 CPP 导出心愿单
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  选择你使用的 CPP 版本，按图完成导出后再上传。
                </p>
              </div>
              <button
                type="button"
                onClick={closeGuide}
                aria-label="关闭导出指引"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
              <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
                {(["pc", "app"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setPlatform(value);
                      setStepIndex(0);
                    }}
                    className={`min-h-10 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      platform === value
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-slate-600 hover:bg-white/70"
                    }`}
                  >
                    {GUIDE_FLOWS[value].label}
                  </button>
                ))}
              </div>

              <figure>
                <div
                  className="flex min-h-52 touch-pan-y select-none items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-2 sm:min-h-80"
                  onWheel={handleWheel}
                  onTouchStart={(event) => {
                    const touch = event.touches[0];
                    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
                  }}
                  onTouchEnd={(event) => {
                    const start = touchStartRef.current;
                    const touch = event.changedTouches[0];
                    touchStartRef.current = null;
                    if (!start || !touch) return;
                    const deltaX = touch.clientX - start.x;
                    const deltaY = touch.clientY - start.y;
                    if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY)) {
                      moveStep(deltaX < 0 ? 1 : -1);
                    }
                  }}
                  aria-label="滑动或滚动切换操作步骤"
                >
                  <img
                    key={step.image}
                    src={step.image}
                    alt={step.alt}
                    className="max-h-[52dvh] w-full object-contain"
                  />
                </div>

                <div
                  className="mt-4 flex justify-center gap-2"
                  aria-label={`${flow.label}操作步骤`}
                >
                  {flow.steps.map((item, index) => (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => setStepIndex(index)}
                      aria-label={`查看第 ${index + 1} 步：${item.title}`}
                      aria-current={index === stepIndex ? "step" : undefined}
                      className={`h-2.5 rounded-full transition-all ${
                        index === stepIndex
                          ? "w-7 bg-indigo-600"
                          : "w-2.5 bg-slate-300 hover:bg-slate-400"
                      }`}
                    />
                  ))}
                </div>

                <figcaption className="mx-auto mt-4 max-w-2xl text-center">
                  <p className="text-xs font-medium text-indigo-600">
                    第 {stepIndex + 1} / {flow.steps.length} 步
                  </p>
                  <h3 className="mt-1 text-base font-semibold text-slate-900">
                    {step.title}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {step.description}
                  </p>
                </figcaption>
              </figure>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
