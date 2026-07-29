import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  try {
    const { client } = await authenticateRequest(request);
    const { id, name, days, cppEventId } = await request.json();

    if (!id || !name || !Array.isArray(days)) {
      return NextResponse.json({ error: "创建参数不完整" }, { status: 400 });
    }

    const { data, error } = await client.rpc("create_event_secure", {
      p_id: id,
      p_name: name,
      p_days: days,
      p_cpp_event_id: cppEventId || null,
    });
    if (error) throw error;
    return NextResponse.json({
      id: data.id,
      name: data.name,
      date: days.map((day: { name: string }) => day.name).join(" / "),
      items: [],
      accessRole: "owner",
      isCreator: true,
    });
  } catch (error) {
    console.error("[Exhibits API] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error && error.message === "AUTH_REQUIRED" ? "登录状态无效，请刷新后重试" : "创建list失败" },
      { status: error instanceof Error && error.message === "AUTH_REQUIRED" ? 401 : 500 }
    );
  }
}
