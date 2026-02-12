export type Logger = {
  enabled: boolean;
  debug: (message: string, meta?: unknown) => void;
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
};

function safeStringify(meta: unknown): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

function print(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const suffix = meta === undefined ? "" : ` ${safeStringify(meta)}`;
  const line = `[${ts}] [tangram] [${level}] ${message}${suffix}`;

  if (level === "ERROR") {
    // eslint-disable-next-line no-console
    console.error(line);
    return;
  }
  if (level === "WARN") {
    // eslint-disable-next-line no-console
    console.warn(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

export function createLogger(verbose: boolean): Logger {
  return {
    enabled: verbose,
    debug: (message, meta) => {
      if (!verbose) return;
      print("DEBUG", message, meta);
    },
    info: (message, meta) => {
      if (!verbose) return;
      print("INFO", message, meta);
    },
    warn: (message, meta) => {
      if (!verbose) return;
      print("WARN", message, meta);
    },
    error: (message, meta) => {
      print("ERROR", message, meta);
    },
  };
}
