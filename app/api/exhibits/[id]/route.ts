import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/supabase-server";

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { client } = await authenticateRequest(request);
    const { data, error } = await client.rpc("delete_or_leave_event", { p_event_id: params.id });
    if (error) throw error;
    return NextResponse.json({ action: data });
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === "AUTH_REQUIRED";
    console.error("[Exhibits API] DELETE error:", error);
    return NextResponse.json(
      { error: unauthorized ? "登录状态无效，请刷新后重试" : "无权删除或移除这份list" },
      { status: unauthorized ? 401 : 403 }
    );
  }
}
