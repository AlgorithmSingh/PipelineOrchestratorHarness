import pino, { type Logger } from "pino";

export interface LoggerOptions {
  level?: "debug" | "info" | "warn" | "error";
  base?: Record<string, unknown>;
}

export function createLogger(options?: LoggerOptions): Logger {
  return pino({
    level: options?.level ?? process.env.LOG_LEVEL ?? "info",
    base: options?.base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
