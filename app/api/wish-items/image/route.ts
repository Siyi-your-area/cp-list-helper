import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, createServiceRoleClient } from "@/lib/supabase-server";

const BUCKET = "wish-item-images";
const MAX_BYTES = 5 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function POST(request: NextRequest) {
  try {
    const { user, client } = await authenticateRequest(request);
    const formData = await request.formData();
    const eventId = String(formData.get("eventId") || "").trim();
    const file = formData.get("file");

    if (!eventId || !(file instanceof File)) {
      return NextResponse.json({ error: "缺少 list 或图片文件。" }, { status: 400 });
    }
    const extension = MIME_EXTENSIONS[file.type];
    if (!extension) {
      return NextResponse.json({ error: "仅支持 JPG、PNG 和 WebP 图片。" }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return NextResponse.json({ error: "图片大小不能超过 5MB。" }, { status: 400 });
    }

    const { data: membership, error: membershipError } = await client
      .from("list_members")
      .select("event_id")
      .eq("event_id", eventId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) {
      return NextResponse.json({ error: "你没有编辑这个 list 的权限。" }, { status: 403 });
    }

    const service = createServiceRoleClient();
    const objectPath = `${eventId}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await service.storage
      .from(BUCKET)
      .upload(objectPath, await file.arrayBuffer(), {
        cacheControl: "31536000",
        contentType: file.type,
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const { data } = service.storage.from(BUCKET).getPublicUrl(objectPath);
    return NextResponse.json({ imageUrl: data.publicUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "图片上传失败";
    const status = message === "AUTH_REQUIRED" ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? "登录状态已失效，请刷新后重试。" : message },
      { status }
    );
  }
}
