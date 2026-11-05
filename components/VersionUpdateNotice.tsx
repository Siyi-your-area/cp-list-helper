"use client";

import { useEffect, useState } from "react";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_BUILD_VERSION;

export function VersionUpdateNotice() {
  const [newVersionReady, setNewVersionReady] = useState(false);
  const [latestVersion, setLatestVersion] = useState("");
  const [manualOffline, setManualOffline] = useState(false);

  useEffect(() => {
    const updateMode = () => setManualOffline(document.body.dataset.manualOffline === "true");
    updateMode();
    window.addEventListener("cp-list-offline-mode", updateMode);
    return () => window.removeEventListener("cp-list-offline-mode", updateMode);
  }, []);

  useEffect(() => {
    if (!CURRENT_VERSION) return;
    let active = true;
    const check = async () => {
      if (!navigator.onLine) return;
      try {
        const response = await fetch("/api/version", { cache: "no-store" });
        if (!response.ok) return;
        const result: { version?: string } = await response.json();
        if (active && result.version) {
          setLatestVersion(result.version);
          setNewVersionReady(result.version !== CURRENT_VERSION);
        }
      } catch {
        // 网络暂不可用时保留当前页面，不提示刷新。
      }
    };
    void check();
    const timer = window.setInterval(check, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
    };
  }, []);

  if (!newVersionReady || manualOffline) return null;
  const refreshToLatest = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("app-version", latestVersion);
    window.location.replace(url.toString());
  };
  return (
    <button
      type="button"
      onClick={refreshToLatest}
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] left-1/2 z-30 min-h-11 -translate-x-1/2 rounded-full bg-[#5d695d] px-5 py-2 text-sm font-medium text-white shadow-lg"
    >
      新版本已就绪，点击刷新
    </button>
  );
}
