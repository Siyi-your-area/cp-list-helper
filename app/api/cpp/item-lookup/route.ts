import { NextRequest, NextResponse } from "next/server";
import { parseCPPProductLink } from "@/lib/cpp-link";
import {
  enrichCPPItemWithDetail,
  fetchCPPExternalDetail,
  getCPPCookieHeader,
} from "@/lib/cpp-external";
import {
  getCPPItemsByBooths,
  getEventMembership,
  resolveCPPMatchScope,
} from "@/lib/db-service";
import { authenticateRequest } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  try {
    const { client } = await authenticateRequest(request);
    const body = await request.json();
    const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
    const cppUrl = typeof body.cppUrl === "string" ? body.cppUrl.trim() : "";
    const doujinshiId = parseCPPProductLink(cppUrl);

    if (!eventId) {
      return NextResponse.json({ error: "缺少 list 信息" }, { status: 400 });
    }
    if (!doujinshiId) {
      return NextResponse.json({ error: "不是有效的 CPP 制品链接" }, { status: 400 });
    }
    if (!(await getEventMembership(eventId, client))) {
      return NextResponse.json({ error: "无权为这份 list 查询 CPP 制品" }, { status: 403 });
    }

    const scope = await resolveCPPMatchScope(eventId, client, false);
    const candidates = await getCPPItemsByBooths(
      scope.eventId,
      [],
      scope.dayIds,
      [doujinshiId],
      client
    );
    let item = candidates.find((candidate) => candidate.doujinshiId === doujinshiId);

    if (!item) {
      return NextResponse.json({ found: false, doujinshiId });
    }
    if (!item.description) {
      const detail = await fetchCPPExternalDetail(
        doujinshiId,
        getCPPCookieHeader(),
        performance.now() + 8_000
      );
      item = enrichCPPItemWithDetail(item, detail);
    }
    return NextResponse.json({ found: true, item });
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === "AUTH_REQUIRED";
    console.error("[CPP Item Lookup] failed", error);
    return NextResponse.json(
      { error: unauthorized ? "登录状态无效，请刷新后重试" : "CPP 制品读取失败，请稍后重试" },
      { status: unauthorized ? 401 : 500 }
    );
  }
}
