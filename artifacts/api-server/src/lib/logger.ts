import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const sensitiveFieldNames = new Set([
  "signed_url",
  "signedUrl",
  "uploadURL",
  "credentials",
  "authorization",
]);

function redactSensitiveFields(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const existingCopy = seen.get(value);
  if (existingCopy !== undefined) {
    return existingCopy;
  }

  if (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof URL ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }

  const copy: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : {};
  seen.set(value, copy);

  for (const [key, nestedValue] of Object.entries(value)) {
    if (sensitiveFieldNames.has(key)) {
      Reflect.set(copy, key, "[Redacted]");
      continue;
    }

    Reflect.set(copy, key, redactSensitiveFields(nestedValue, seen));
  }

  return copy;
}

function protectChildBindings(
  loggerInstance: pino.Logger,
  createChild: pino.Logger["child"] = loggerInstance.child,
): pino.Logger {
  loggerInstance.child = ((bindings, options) =>
    protectChildBindings(
      createChild.call(
        loggerInstance,
        redactSensitiveFields(bindings) as pino.Bindings,
        options,
      ),
      createChild,
    )) as pino.Logger["child"];
  return loggerInstance;
}

export const logger = protectChildBindings(pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    bindings(bindings) {
      return redactSensitiveFields(bindings) as Record<string, unknown>;
    },
    log(object) {
      return redactSensitiveFields(object) as Record<string, unknown>;
    },
  },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
}));
