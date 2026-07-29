import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, createServiceRoleClient } from "@/lib/supabase-server";
import { hashLegacyClientId } from "@/lib/share-security";
import { getServerEnv } from "@/lib/server-env";

export async function POST(request: NextRequest) {
  try {
    const { user } = await authenticateRequest(request);
    if (getServerEnv("LEGACY_CLAIM_ENABLED") !== "true") {
      return NextResponse.json({ claimed: 0, legacyClaimDisabled: true });
    }
    const { clientId } = await request.json();
    if (typeof clientId !== "string") {
      return NextResponse.json({ error: "旧设备标识缺失" }, { status: 400 });
    }
    const service = createServiceRoleClient();
    const { data, error } = await service.rpc("claim_legacy_access", {
      p_user_id: user.id,
      p_client_id: clientId,
      p_client_id_hash: hashLegacyClientId(clientId),
    });
    if (error) throw error;
    return NextResponse.json({ claimed: Number(data || 0) });
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === "AUTH_REQUIRED";
    console.error("[Auth Claim API] error:", error);
    return NextResponse.json(
      { error: unauthorized ? "匿名登录状态无效" : "旧设备权限升级失败，请确认已执行 006 迁移" },
      { status: unauthorized ? 401 : 503 }
    );
  }
}
