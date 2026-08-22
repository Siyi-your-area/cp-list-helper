"use client";

import { ensureAnonymousSession } from "@/lib/auth-client";

export const WISH_ITEM_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export async function uploadWishItemImage(
  eventId: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<string> {
  const session = await ensureAnonymousSession();
  const formData = new FormData();
  formData.append("eventId", eventId);
  formData.append("file", file);

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/wish-items/image");
    request.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress?.(Math.min(95, Math.round((event.loaded / event.total) * 95)));
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
    onProgress?.(0);
    request.send(formData);
  });
}
