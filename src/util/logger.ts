import pino, { type Logger } from "pino";

export interface LoggerOptions {
  level?: "debug" | "info" | "warn" | "error";
  base?: Record<string, unknown>;
}

export function createLogger(options?: LoggerOptions): Logger {
  const level = options?.level ?? process.env.LOG_LEVEL ?? "info";
  const pretty = process.env.LOG_FORMAT !== "json" && process.stdout.isTTY;

  return pino({
    level,
    base: options?.base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
          translateTime: "HH:MM:ss",
          messageFormat: "{pipeline} {ticketId} {event} | {msg}",
        },
      },
    }),
  });
}
