export class RateLimiter {
  private timestamps: number[] = [];
  private rpm: number;

  constructor(rpm: number) {
    this.rpm = rpm;
  }

  async wait(): Promise<void> {
    while (true) {
      const now = Date.now();
      // 60초(60000ms) 이전의 타임스탬프 제거
      this.timestamps = this.timestamps.filter((t) => now - t < 60000);

      if (this.timestamps.length < this.rpm) {
        this.timestamps.push(now);
        return;
      }

      // 가장 오래된 요청이 60초가 지날 때까지 대기
      const oldest = this.timestamps[0];
      const waitTime = 60000 - (now - oldest);
      await new Promise((resolve) => setTimeout(resolve, waitTime + 50)); // 50ms 여유 시간
    }
  }
}

export async function processWithConcurrency<T, R>(
  items: T[],
  limit: number,
  processor: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const worker = async () => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await processor(items[index], index);
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}
