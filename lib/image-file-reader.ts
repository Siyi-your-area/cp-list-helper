export function readImageFileAsDataUrl(
  file: File,
  onProgress: (percent: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    onProgress(0);
    reader.onprogress = (event) => {
      if (!event.lengthComputable || event.total === 0) return;
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.onload = () => {
      onProgress(100);
      resolve(String(reader.result || ""));
    };
    reader.readAsDataURL(file);
  });
}
