"use client";

import { ensureAnonymousSession } from "@/lib/auth-client";
import { compressImage } from "@/lib/wish-item-image-compression";
import { WISH_ITEM_IMAGE_MAX_BYTES, WISH_ITEM_UPLOAD_MAX_BYTES } from "@/lib/wish-item-image-policy";

export { WISH_ITEM_IMAGE_MAX_BYTES } from "@/lib/wish-item-image-policy";

export async function uploadWishItemImage(
  eventId: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<string> {
  onProgress?.(0);
  if (file.size > WISH_ITEM_IMAGE_MAX_BYTES) throw new Error("图片大小不能超过 5 MB。");
  const uploadFile = await compressImage(file);
  if (uploadFile.size > WISH_ITEM_UPLOAD_MAX_BYTES) throw new Error("图片压缩后仍超过 350 KB，请裁剪后重试。");
  const session = await ensureAnonymousSession();
  const formData = new FormData();
  formData.append("eventId", eventId);
  formData.append("file", uploadFile);

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/wish-items/image");
    request.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress?.(Math.min(95, 5 + Math.round((event.loaded / event.total) * 90)));
    };
    request.onerror = () => reject(new Error("图片上传失败，请检查网络后重试。"));
    request.onload = () => {
      let result: { imageUrl?: string; error?: string } = {};
      try {
        result = JSON.parse(request.responseText || "{}");
      } catch {
        reject(new Error("图片上传结果无法读取，请重试。"));
        return;
      }
      if (request.status < 200 || request.status >= 300 || !result.imageUrl) {
        reject(new Error(result.error || "图片上传失败，请重试。"));
        return;
      }
      onProgress?.(100);
      resolve(result.imageUrl);
    };
    onProgress?.(5);
    request.send(formData);
  });
}
