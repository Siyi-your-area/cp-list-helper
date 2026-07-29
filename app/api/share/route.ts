import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, createServiceRoleClient } from "@/lib/supabase-server";
import { deriveShareCode, hashClientIp, hashShareCode, newShareSeed } from "@/lib/share-security";

const UNIFORM_REDEEM_ERROR = "list识别码无效或暂时无法使用，请稍后重试";

export async function GET(request: NextRequest) {
  const eventId = request.nextUrl.searchParams.get("eventId") || "";
  if (!eventId) return NextResponse.json({ error: "缺少 eventId" }, { status: 400 });
  try {
    const { user } = await authenticateRequest(request);
    const service = createServiceRoleClient();
    let replacementSeed = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { data, error } = await service.rpc("get_event_share_material", {
        p_user_id: user.id,
        p_event_id: eventId,
      });
      if (error) throw error;
      const row = data?.[0];
      if (!row) return NextResponse.json({ error: "无权读取这份list的识别码" }, { status: 403 });
      const currentSeed = String(row.seed);
      const currentHash = row.code_hash ? String(row.code_hash) : null;
      const seed = replacementSeed || currentSeed;
      const code = deriveShareCode(seed);
      const codeHash = hashShareCode(code);
      if (currentHash !== codeHash || replacementSeed) {
        const { data: saved, error: saveError } = await service.rpc("set_event_share_material", {
          p_user_id: user.id,
          p_event_id: eventId,
          p_expected_seed: currentSeed,
          p_expected_code_hash: currentHash,
          p_seed: seed,
          p_code_hash: codeHash,
        });
        if (saveError?.code === "23505") {
          replacementSeed = newShareSeed();
          continue;
        }
        if (saveError) throw saveError;
        if (!saved) {
          replacementSeed = "";
          continue;
        }
        return NextResponse.json({ code });
      }
      return NextResponse.json({ code });
    }
    throw new Error("SHARE_CODE_COLLISION");
  } catch (error) {
    console.error("[Share API] GET error:", error);
    return NextResponse.json({ error: "获取识别码失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await authenticateRequest(request);
    const { code } = await request.json();
    const normalized = typeof code === "string" ? code.toUpperCase().trim() : "";
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(normalized)) {
      return NextResponse.json({ error: UNIFORM_REDEEM_ERROR }, { status: 400 });
    }
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const service = createServiceRoleClient();
    const { data, error } = await service.rpc("redeem_share_code", {
      p_user_id: user.id,
      p_code_hash: hashShareCode(normalized),
      p_ip_hash: hashClientIp(ip),
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row) return NextResponse.json({ error: UNIFORM_REDEEM_ERROR }, { status: 400 });
    return NextResponse.json({ eventId: row.event_id, eventName: row.event_name });
  } catch (error) {
    console.error("[Share API] POST error:", error);
    return NextResponse.json({ error: UNIFORM_REDEEM_ERROR }, { status: 400 });
  }
}
