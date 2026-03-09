export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(count: number) {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`Semaphore count must be a positive integer, got: ${count}`);
    }
    this.permits = count;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
      return;
    }
    this.permits += 1;
  }

  availablePermits(): number {
    return this.permits;
  }

  queuedWaiters(): number {
    return this.waiters.length;
  }
}
