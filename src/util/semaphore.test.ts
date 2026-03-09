import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("acquires and releases permits", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    expect(semaphore.availablePermits()).toBe(0);
    semaphore.release();
    expect(semaphore.availablePermits()).toBe(1);
  });

  it("queues waiters when permits are unavailable", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();

    const pending = semaphore.acquire();
    expect(semaphore.queuedWaiters()).toBe(1);

    semaphore.release();
    await pending;
    expect(semaphore.queuedWaiters()).toBe(0);
  });
});
