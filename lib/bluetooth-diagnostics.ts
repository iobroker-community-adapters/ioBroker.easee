import { performance } from "node:perf_hooks";

/** Receives privacy-filtered BLE phase diagnostics at debug level. */
export interface BluetoothDiagnosticLogger {
  debug(message: string): void;
}

export interface BluetoothDiagnosticDetails {
  readonly durationMs?: number;
  readonly error?: unknown;
  readonly fields?: Readonly<
    Record<string, string | number | boolean | undefined>
  >;
}

export function bluetoothDiagnosticNow(): number {
  return performance.now();
}

function safeFieldValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (
    typeof value === "string" &&
    value.length <= 80 &&
    !/^\d{4,}$/.test(value) &&
    /^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    return value;
  }
  return undefined;
}

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "BluetoothProtocolError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const SAFE_NODE_ERROR_CODES = new Set([
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISCONN",
  "EMFILE",
  "ENETDOWN",
  "ENETUNREACH",
  "ENODEV",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOTCONN",
  "ENOTFOUND",
  "ENOTSUP",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "ETIMEDOUT",
]);

const SAFE_BLUEZ_ERROR_CODES = new Set([
  "AlreadyExists",
  "AuthenticationCanceled",
  "AuthenticationFailed",
  "Failed",
  "InProgress",
  "InvalidArguments",
  "NotAuthorized",
  "NotAvailable",
  "NotConnected",
  "NotPermitted",
  "NotSupported",
]);

/**
 * Returns the normalized category for a BLE error message.
 *
 * @param errorText Error text to classify.
 */
export function getBluetoothErrorCategory(errorText: string): string {
  if (
    /unknown connection identifier|connection handle unknown/i.test(errorText)
  ) {
    return "hci_unknown_connection_identifier";
  }
  if (
    /connection failed to be established|disconnected\s+(?:62|0x3e)\b/i.test(
      errorText,
    )
  ) {
    return "hci_connection_failed";
  }
  if (/timed?\s*out|timeout|etimedout/i.test(errorText)) {
    return "timeout";
  }
  if (
    /insufficient[\s_-]*auth|authentication|not[\s_.-]*authorized|not[\s_.-]*paired/i.test(
      errorText,
    )
  ) {
    return "att_authentication";
  }
  if (/attribute\s+(?:could not be found|not found)/i.test(errorText)) {
    return "att_attribute_not_found";
  }
  if (
    /\b(?:att|gatt)\b[^\n]{0,40}\bread\b|\bread\b[^\n]{0,40}\b(?:att|gatt)\b/i.test(
      errorText,
    )
  ) {
    return "att_read_error";
  }
  if (
    /\b(?:att|gatt)\b[^\n]{0,40}\bnotif(?:y|ication)\b|\bnotif(?:y|ication)\b[^\n]{0,40}\b(?:att|gatt)\b/i.test(
      errorText,
    )
  ) {
    return "att_notification_error";
  }
  if (
    /\b(?:att|gatt)\b[^\n]{0,40}\bwrite\b|\bwrite\b[^\n]{0,40}\b(?:att|gatt)\b/i.test(
      errorText,
    )
  ) {
    return "att_write_error";
  }
  if (/not supported|unsupported|does not support/i.test(errorText)) {
    return "not_supported";
  }
  if (/cancelled|canceled/i.test(errorText)) {
    return "cancelled";
  }
  if (/disconnected|not connected/i.test(errorText)) {
    return "disconnected";
  }
  if (/invalid|must be a positive number/i.test(errorText)) {
    return "invalid_argument";
  }
  return "generic";
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const bluezCode = /^org\.bluez\.Error\.([A-Za-z]+)$/.exec(value);
  if (bluezCode && SAFE_BLUEZ_ERROR_CODES.has(bluezCode[1])) {
    return value;
  }
  return SAFE_NODE_ERROR_CODES.has(value) ? value : undefined;
}

function errorMetadata(error: unknown): {
  readonly name: string;
  readonly category: string;
  readonly code?: string;
  readonly status?: string;
} {
  const seen = new Set<object>();
  const chain: Record<string, unknown>[] = [];
  let current = error;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    chain.length < 4
  ) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    chain.push(record);
    current = record.cause;
  }

  const names = chain
    .map((item) => item.name)
    .filter((name): name is string => typeof name === "string");
  const name = names.find((item) => SAFE_ERROR_NAMES.has(item)) ?? "Error";
  const code = chain
    .map((item) => safeErrorCode(item.code) ?? safeErrorCode(item.type))
    .find((item) => item !== undefined);
  const status = chain
    .map((item) => item.status)
    .find(
      (item): item is number =>
        typeof item === "number" &&
        Number.isInteger(item) &&
        item >= 0 &&
        item <= 255,
    );
  const errorText = chain
    .flatMap((item) => [item.message, item.name, item.type, item.code])
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return {
    name,
    category: getBluetoothErrorCategory(errorText),
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status: String(status) } : {}),
  };
}

/**
 * Logs structured phase metadata without exposing raw error messages or payloads.
 *
 * @param logger
 * @param stage
 * @param state
 * @param details
 */
export function logBluetoothDiagnostic(
  logger: BluetoothDiagnosticLogger | undefined,
  stage: string,
  state: string,
  details: BluetoothDiagnosticDetails = {},
): void {
  if (!logger) {
    return;
  }

  const fields = [`stage=${stage}`, `state=${state}`];
  for (const [key, value] of Object.entries(details.fields ?? {})) {
    const safeValue = safeFieldValue(value);
    if (safeValue !== undefined) {
      fields.push(`${key}=${safeValue}`);
    }
  }
  if (details.durationMs !== undefined && Number.isFinite(details.durationMs)) {
    fields.push(`durationMs=${Math.max(0, Math.round(details.durationMs))}`);
  }
  if (details.error !== undefined) {
    try {
      const metadata = errorMetadata(details.error);
      fields.push(`errorName=${metadata.name}`);
      fields.push(`errorCategory=${metadata.category}`);
      if (metadata.code) {
        fields.push(`errorCode=${metadata.code}`);
      }
      if (metadata.status) {
        fields.push(`errorStatus=${metadata.status}`);
      }
    } catch {
      fields.push("errorName=Error");
      fields.push("errorCategory=generic");
    }
  }

  try {
    logger.debug(`[BLE] ${fields.join(" ")}`);
  } catch {
    // Diagnostic logging must not affect Bluetooth behavior.
  }
}
