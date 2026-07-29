"use client";

import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

let sessionPromise: Promise<Session> | null = null;

export class AuthenticationSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationSetupError";
  }
}

async function setRealtimeSession(session: Session): Promise<Session> {
  try {
    await supabase.realtime.setAuth(session.access_token);
  } catch {
    throw new AuthenticationSetupError("实时同步身份配置失败，请刷新后重试");
  }
  return session;
}

export async function ensureAnonymousSession(): Promise<Session> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const { data: existing, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw new AuthenticationSetupError(`读取登录状态失败：${sessionError.message}`);
    if (existing.session) return setRealtimeSession(existing.session);

    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.session) {
      throw new AuthenticationSetupError(
        `匿名登录不可用，请确认 Supabase Anonymous Sign-Ins 已启用${error?.message ? `：${error.message}` : ""}`
      );
    }
    return setRealtimeSession(data.session);
  })().catch((error) => {
    sessionPromise = null;
    throw error;
  });
  return sessionPromise;
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  await ensureAnonymousSession();
  let { data, error } = await supabase.auth.getSession();
  if (error) throw new AuthenticationSetupError(`刷新登录状态失败：${error.message}`);
  if (!data.session) {
    sessionPromise = null;
    await ensureAnonymousSession();
    ({ data, error } = await supabase.auth.getSession());
  }
  const session = data.session;
  if (error || !session) throw new AuthenticationSetupError("匿名登录状态已失效，请刷新后重试");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);
  return fetch(input, { ...init, headers });
}

export async function claimLegacyAccess(clientId: string): Promise<number> {
  const response = await authFetch("/api/auth/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AuthenticationSetupError(result.error || "旧设备权限升级失败");
  }
  return Number(result.claimed || 0);
}
