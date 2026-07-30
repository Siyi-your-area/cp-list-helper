"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { authFetch } from "@/lib/auth-client";
import { createCompatibleUUID } from "@/lib/client-id";

export function PageViewTracker() {
  const pathname = usePathname();
  const previousPath = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || previousPath.current === pathname) return;
    previousPath.current = pathname;

    const viewId = createCompatibleUUID();
    void authFetch("/api/analytics/page-view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewId }),
      cache: "no-store",
    }).catch(() => undefined);
  }, [pathname]);

  return null;
}
