import { NextRequest, NextResponse } from "next/server";
import { createExhibitInDB } from "@/lib/db-service";

export async function POST(request: NextRequest) {
  try {
    const { id, name, days, cppEventId, clientId } = await request.json();

    if (!id || !name || !Array.isArray(days) || !clientId) {
      return NextResponse.json({ error: "创建参数不完整" }, { status: 400 });
    }

    const exhibit = await createExhibitInDB(id, name, days, cppEventId, clientId);
    return NextResponse.json(exhibit);
  } catch (error) {
    console.error("[Exhibits API] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建list失败" },
      { status: 500 }
    );
  }
}
