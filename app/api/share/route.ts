/**
 * 分享码 API
 *
 * GET  ?eventId=xxx  → 获取/生成展会的分享码
 * POST { code: "A3K7" }  → 通过分享码查找展会
 */

import { NextRequest, NextResponse } from "next/server";
import { getOrCreateShareCode, resolveShareCode } from "@/lib/db-service";

export async function GET(request: NextRequest) {
  const eventId = request.nextUrl.searchParams.get("eventId");
  if (!eventId) {
    return NextResponse.json({ error: "缺少 eventId" }, { status: 400 });
  }

  try {
    const code = await getOrCreateShareCode(eventId);
    if (code === "NEED_MIGRATION") {
      return NextResponse.json(
        { error: "数据库需要迁移：请在 Supabase SQL Editor 执行 ALTER TABLE events ADD COLUMN IF NOT EXISTS share_code TEXT UNIQUE;" },
        { status: 503 }
      );
    }
    return NextResponse.json({ code });
  } catch (error) {
    console.error("[Share API] GET error:", error);
    return NextResponse.json({ error: "获取分享码失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { code } = await request.json();
    if (!code || typeof code !== "string") {
      return NextResponse.json({ error: "缺少 code" }, { status: 400 });
    }

    // 只允许 4 位字母数字
    const normalized = code.toUpperCase().trim();
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(normalized)) {
      return NextResponse.json({ error: "邀请码格式不正确（应为4位字母数字）" }, { status: 400 });
    }

    const result = await resolveShareCode(normalized);
    if (!result) {
      return NextResponse.json({ error: "找不到对应的展会，请检查邀请码" }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Share API] POST error:", error);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}
