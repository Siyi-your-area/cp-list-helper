export async function loadExcelImagesConcurrently<T>(
  imageUrls: string[],
  loadImage: (imageUrl: string) => Promise<T | null>,
  concurrency = 6,
  timeoutMs = 15_000,
  onProgress?: (completed: number, total: number) => void
): Promise<Array<T | null>> {
  const results: Array<T | null> = Array.from({ length: imageUrls.length }, () => null);
  let nextIndex = 0;
  let completed = 0;

  async function loadWithTimeout(imageUrl: string) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        loadImage(imageUrl),
        new Promise<null>((resolve) => {
          timeoutId = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async function worker() {
    while (nextIndex < imageUrls.length) {
      const index = nextIndex;
      nextIndex += 1;
      const imageUrl = imageUrls[index];
      try {
        if (imageUrl) {
          results[index] = await loadWithTimeout(imageUrl);
        }
      } catch {
        results[index] = null;
      } finally {
        completed += 1;
        onProgress?.(completed, imageUrls.length);
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), imageUrls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
