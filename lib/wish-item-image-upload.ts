"use client";

import { ensureAnonymousSession } from "@/lib/auth-client";

export const WISH_ITEM_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_TARGET_BYTES = 350 * 1024;

export async function compressImage(file: File): Promise<File> {
  if (file.size <= IMAGE_TARGET_BYTES) return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片无法读取，请换一张重试。"));
      image.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    let smallest: Blob | null = null;
    let outputType = "image/webp";
    for (const [maxEdge, quality] of [[1600, 0.8], [1280, 0.72], [1024, 0.66]] as const) {
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前浏览器无法压缩图片，请换用其他浏览器重试。");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      let encoded = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, outputType, quality);
      });
      if (outputType === "image/webp" && encoded?.type !== "image/webp") {
        // Keep JPEG or PNG (including transparency) on browsers without WebP encoding.
        outputType = file.type;
        encoded = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, outputType, quality);
        });
      }
      if (!encoded || encoded.type !== outputType) return file;
      if (!smallest || encoded.size < smallest.size) smallest = encoded;
      if (encoded.size <= IMAGE_TARGET_BYTES) break;
    }

    if (!smallest || smallest.size >= file.size) return file;
    const extension = outputType === "image/webp" ? "webp" : outputType === "image/png" ? "png" : "jpg";
    return new File([smallest], `${file.name.replace(/\.[^.]+$/, "")}.${extension}`, {
      type: outputType,
      lastModified: file.lastModified,
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function uploadWishItemImage(
  eventId: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<string> {
  onProgress?.(0);
  const uploadFile = await compressImage(file);
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
