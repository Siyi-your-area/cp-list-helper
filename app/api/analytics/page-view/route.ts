import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, createServiceRoleClient } from "@/lib/supabase-server";

const MAX_BODY_BYTES = 256;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE_HEADERS });
}

function isPageViewPayload(value: unknown): value is { viewId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "viewId" &&
    typeof (value as { viewId?: unknown }).viewId === "string" &&
    UUID_PATTERN.test((value as { viewId: string }).viewId)
  );
}

function sqlStateOf(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function noContent() {
  return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
}

export async function POST(request: NextRequest) {
  let userId: string;
  try {
    const { user } = await authenticateRequest(request);
    userId = user.id;
  } catch {
    return jsonError("登录状态无效", 401);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "application/json") {
    return jsonError("请求格式无效", 400);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonError("请求内容过大", 413);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonError("请求内容过大", 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonError("请求格式无效", 400);
  }
  if (!isPageViewPayload(payload)) {
    return jsonError("请求参数无效", 400);
  }

  try {
    const service = createServiceRoleClient();
    const { error } = await service.rpc("record_page_view", {
      p_user_id: userId,
      p_view_id: payload.viewId,
    });
    if (error) throw error;
  } catch (error) {
    console.warn("[Analytics API] metric write failed", {
      code: "ANALYTICS_RPC_FAILED",
      sqlstate: sqlStateOf(error),
    });
  }

  return noContent();
}
