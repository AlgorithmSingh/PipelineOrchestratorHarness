import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { MetricEntry } from "../types.js";

export async function appendMetric(path: string, metric: MetricEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(metric)}\n`, "utf8");
}
