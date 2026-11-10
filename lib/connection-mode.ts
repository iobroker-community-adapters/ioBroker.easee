"use strict";

export type ConnectionMode = "cloud" | "bluetooth";
export type BluetoothConfigurationSource = "input" | "stored";

export interface BluetoothChargerConfig {
  serialNumber: string;
  pin: string;
  name: string;
}

/** Safe diagnostic data that lets Admin render configuration errors in each locale. */
export type BluetoothConfigurationErrorDiagnostic =
  | {
      type: "validation";
      field: string;
      reason: string;
      entry?: number;
      setting?: string;
    }
  | {
      type: "message";
      key: string;
      parameters?: readonly (string | number)[];
    };

type BluetoothConfigurationErrorReason =
  | "not-a-list"
  | "not-settings"
  | "invalid-entry"
  | "invalid-serial-number"
  | "invalid-pin"
  | "missing-pin"
  | "invalid-name"
  | "duplicate-serial-number"
  | "empty-list";

const errorMessages: Record<
  BluetoothConfigurationErrorReason,
  { en: string; de: string }
> = {
  "not-a-list": { en: "must be a list", de: "muss eine Liste sein" },
  "not-settings": {
    en: "must be an object",
    de: "muss ein Objekt sein",
  },
  "invalid-entry": {
    en: "is invalid; expected an object",
    de: "ist ungültig; ein Objekt wurde erwartet",
  },
  "invalid-serial-number": {
    en: "needs a valid serial number",
    de: "benötigt eine gültige Seriennummer",
  },
  "invalid-pin": {
    en: "must be a string",
    de: "muss eine Zeichenkette sein",
  },
  "missing-pin": {
    en: "needs a Bluetooth PIN",
    de: "benötigt eine Bluetooth-PIN",
  },
  "invalid-name": {
    en: "must be a string",
    de: "muss eine Zeichenkette sein",
  },
  "duplicate-serial-number": {
    en: "Duplicate Bluetooth charger serial number",
    de: "Doppelte Bluetooth-Ladestations-Seriennummer",
  },
  "empty-list": {
    en: "Configure at least one Bluetooth charger",
    de: "Konfiguriere mindestens eine Bluetooth-Ladestation",
  },
};

/** A safe bilingual configuration diagnostic with its input origin. */
export class BluetoothConfigurationError extends Error {
  readonly source: BluetoothConfigurationSource;
  readonly messageEn: string;
  readonly messageDe: string;
  readonly diagnostic?: BluetoothConfigurationErrorDiagnostic;

  /**
   * @param message Safe English diagnostic text.
   * @param messageDe Safe German diagnostic text.
   * @param source Whether the diagnostic came from submitted input or stored settings.
   * @param diagnostic Optional translation details for the Device Manager.
   */
  constructor(
    message: string,
    messageDe: string,
    source: "input" | "stored",
    diagnostic?: BluetoothConfigurationErrorDiagnostic,
  ) {
    super(message);
    this.name = "BluetoothConfigurationError";
    this.source = source;
    this.messageEn = message;
    this.messageDe = messageDe;
    this.diagnostic = diagnostic;
  }
}

function configurationError(
  source: BluetoothConfigurationSource,
  field: string,
  reason: BluetoothConfigurationErrorReason,
  entry?: number,
  setting?: string,
): BluetoothConfigurationError {
  const description = errorMessages[reason];
  const locationEn = formatErrorLocation(source, field, entry, setting);
  const locationDe = formatErrorLocation(source, field, entry, setting, true);
  return new BluetoothConfigurationError(
    `${locationEn}: ${description.en}.`,
    `${locationDe}: ${description.de}.`,
    source,
    {
      type: "validation",
      field,
      reason: description.en,
      ...(entry !== undefined ? { entry } : {}),
      ...(setting !== undefined ? { setting } : {}),
    },
  );
}

function formatErrorLocation(
  source: BluetoothConfigurationSource,
  field: string,
  entry: number | undefined,
  setting: string | undefined,
  german = false,
): string {
  if (source === "stored") {
    if (entry !== undefined && setting && setting !== field) {
      return german
        ? `Gespeicherte Einstellung ${setting}, Eintrag ${entry}, Feld ${field}`
        : `Stored setting ${setting}, entry ${entry}, field ${field}`;
    }
    if (entry !== undefined) {
      return german
        ? `Gespeicherter Eintrag ${entry}, Feld ${field}`
        : `Stored entry ${entry}, field ${field}`;
    }
    return german ? `Gespeichertes Feld ${field}` : `Stored field ${field}`;
  }

  if (entry !== undefined) {
    return german
      ? `Bluetooth-Ladestation, Eintrag ${entry}, Feld ${field}`
      : `Bluetooth charger entry ${entry}, field ${field}`;
  }
  return german
    ? `Bluetooth-Ladestation, Feld ${field}`
    : `Bluetooth charger field ${field}`;
}

interface ParseContext {
  source: BluetoothConfigurationSource;
  setting: string;
  allowEmpty?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChargerEntries(
  value: unknown,
  context: ParseContext,
): BluetoothChargerConfig[] {
  const entries = value;
  if (!Array.isArray(entries)) {
    throw configurationError(
      context.source,
      context.setting,
      "not-a-list",
      undefined,
      context.setting,
    );
  }

  if (entries.length === 0) {
    if (context.allowEmpty) {
      return [];
    }
    throw configurationError(
      context.source,
      context.setting,
      "empty-list",
      undefined,
      context.setting,
    );
  }

  const chargers: BluetoothChargerConfig[] = [];
  const serialNumbers = new Set<string>();
  for (const [index, item] of entries.entries()) {
    const entry = index + 1;
    if (!isRecord(item)) {
      throw configurationError(
        context.source,
        context.setting,
        "invalid-entry",
        entry,
        context.setting,
      );
    }

    const serialNumberField = "serialNumber";
    const pinField = "pin";
    const nameField = "name";
    const serialNumber =
      typeof item.serialNumber === "string" ? item.serialNumber.trim() : "";
    const pin = typeof item.pin === "string" ? item.pin.trim() : "";

    if (!/^[A-Za-z0-9_-]+$/.test(serialNumber)) {
      throw configurationError(
        context.source,
        serialNumberField,
        "invalid-serial-number",
        entry,
        context.setting,
      );
    }
    if (
      item.pin !== undefined &&
      item.pin !== null &&
      typeof item.pin !== "string"
    ) {
      throw configurationError(
        context.source,
        pinField,
        "invalid-pin",
        entry,
        context.setting,
      );
    }
    if (!pin) {
      throw configurationError(
        context.source,
        pinField,
        "missing-pin",
        entry,
        context.setting,
      );
    }
    if (
      item.name !== undefined &&
      item.name !== null &&
      typeof item.name !== "string"
    ) {
      throw configurationError(
        context.source,
        nameField,
        "invalid-name",
        entry,
        context.setting,
      );
    }

    const normalizedSerial = serialNumber.toLowerCase();
    if (serialNumbers.has(normalizedSerial)) {
      throw configurationError(
        context.source,
        serialNumberField,
        "duplicate-serial-number",
        entry,
        context.setting,
      );
    }

    const name = typeof item.name === "string" ? item.name.trim() : "";
    serialNumbers.add(normalizedSerial);
    chargers.push({ serialNumber, pin, name: name || serialNumber });
  }

  return chargers;
}

export function getConnectionMode(mode: unknown): ConnectionMode {
  return mode === "bluetooth" ? "bluetooth" : "cloud";
}

export function parseBluetoothChargers(
  value: unknown,
  source: BluetoothConfigurationSource = "input",
): BluetoothChargerConfig[] {
  return parseChargerEntries(value, {
    source,
    setting: "bluetoothChargerList",
  });
}

export function parseBluetoothChargerSettings(
  value: unknown,
): BluetoothChargerConfig[] {
  if (!isRecord(value)) {
    throw configurationError("stored", "settings", "not-settings");
  }

  const configuredChargers = value.bluetoothChargerList;
  if (configuredChargers === undefined || configuredChargers === null) {
    return [];
  }

  return parseChargerEntries(configuredChargers, {
    source: "stored",
    setting: "bluetoothChargerList",
    allowEmpty: true,
  });
}
