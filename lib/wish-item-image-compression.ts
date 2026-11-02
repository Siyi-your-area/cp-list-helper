import { IMAGE_TOO_LARGE_MESSAGE, WISH_ITEM_UPLOAD_MAX_BYTES } from "./wish-item-image-policy";

type OutputType = "image/webp" | "image/jpeg" | "image/png";

function encode(canvas: HTMLCanvasElement, type: OutputType, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function hasTransparency(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] < 255) return true;
  }
  return false;
}

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    throw new Error("请选择可读取的图片文件。");
  }
  const originalIsUploadable = ["image/jpeg", "image/png", "image/webp"].includes(file.type)
    && file.size <= WISH_ITEM_UPLOAD_MAX_BYTES;
  if (file.type === "image/webp" && file.size <= WISH_ITEM_UPLOAD_MAX_BYTES) return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片无法读取，请换一张重试。"));
      image.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    let outputType: OutputType = "image/webp";
    let smallest: Blob | null = null;

    for (const [maxEdge, quality] of [[1600, 0.8], [1280, 0.72], [1024, 0.66], [1024, 0.5]] as const) {
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("当前浏览器无法压缩图片，请换用其他浏览器重试。");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      let encoded = await encode(canvas, outputType, quality);
      if (outputType === "image/webp" && encoded?.type !== "image/webp") {
        outputType = hasTransparency(context, canvas.width, canvas.height) ? "image/png" : "image/jpeg";
        if (outputType === "image/jpeg") {
          context.globalCompositeOperation = "destination-over";
          context.fillStyle = "#fff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.globalCompositeOperation = "source-over";
        }
        encoded = await encode(canvas, outputType, quality);
      }
      if (!encoded || encoded.size === 0 || encoded.type !== outputType) {
        if (originalIsUploadable) return file;
        throw new Error("当前浏览器无法压缩图片，请换用其他浏览器重试。");
      }
      if (!smallest || encoded.size < smallest.size) smallest = encoded;
      if (encoded.size <= WISH_ITEM_UPLOAD_MAX_BYTES) break;
    }

    if ((!smallest || smallest.size > WISH_ITEM_UPLOAD_MAX_BYTES) && originalIsUploadable) {
      return file;
    }
    if (!smallest || smallest.size > WISH_ITEM_UPLOAD_MAX_BYTES) {
      throw new Error(IMAGE_TOO_LARGE_MESSAGE);
    }
    if (originalIsUploadable && file.size < smallest.size) return file;
    const extension = outputType === "image/webp" ? "webp" : outputType === "image/png" ? "png" : "jpg";
    return new File([smallest], `${file.name.replace(/\.[^.]+$/, "")}.${extension}`, {
      type: outputType,
      lastModified: file.lastModified,
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
