"use strict";

export type ConnectionMode = "cloud" | "bluetooth";

export interface BluetoothChargerConfig {
  serialNumber: string;
  pin: string;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getConnectionMode(mode: unknown): ConnectionMode {
  return mode === "bluetooth" ? "bluetooth" : "cloud";
}

export function parseBluetoothChargers(
  value: unknown,
): BluetoothChargerConfig[] {
  let entries: unknown = value;
  if (typeof value === "string") {
    try {
      entries = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Bluetooth charger configuration must be valid JSON");
    }
  }
  if (!Array.isArray(entries)) {
    throw new Error("Bluetooth charger configuration must be a list");
  }

  const chargers: BluetoothChargerConfig[] = [];
  const serialNumbers = new Set<string>();
  for (const [index, item] of entries.entries()) {
    if (!isRecord(item)) {
      throw new Error(`Bluetooth charger entry ${index + 1} is invalid`);
    }

    const serialNumber =
      typeof item.serialNumber === "string" ? item.serialNumber.trim() : "";
    const pin = typeof item.pin === "string" ? item.pin.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";

    if (!/^[A-Za-z0-9_-]+$/.test(serialNumber)) {
      throw new Error(
        `Bluetooth charger entry ${index + 1} needs a valid serial number`,
      );
    }
    if (!pin) {
      throw new Error(
        `Bluetooth charger entry ${index + 1} needs a Bluetooth PIN`,
      );
    }
    const normalizedSerial = serialNumber.toLowerCase();
    if (serialNumbers.has(normalizedSerial)) {
      throw new Error(
        `Duplicate Bluetooth charger serial number: ${serialNumber}`,
      );
    }

    serialNumbers.add(normalizedSerial);
    chargers.push({ serialNumber, pin, name: name || serialNumber });
  }

  if (chargers.length === 0) {
    throw new Error("Configure at least one Bluetooth charger");
  }

  return chargers;
}

export function parseBluetoothChargerSettings(
  value: unknown,
): BluetoothChargerConfig[] {
  if (!isRecord(value)) {
    throw new Error("Bluetooth charger settings must be an object");
  }

  const formEntries: Record<string, string>[] = [];
  for (let index = 1; index <= 10; index++) {
    const serialNumber = value[`bluetoothCharger${index}SerialNumber`];
    const pin = value[`bluetoothCharger${index}Pin`];
    const name = value[`bluetoothCharger${index}Name`];
    if (
      [serialNumber, pin, name].some(
        (field) => typeof field === "string" && field.trim() !== "",
      )
    ) {
      formEntries.push({
        serialNumber: typeof serialNumber === "string" ? serialNumber : "",
        pin: typeof pin === "string" ? pin : "",
        name: typeof name === "string" ? name : "",
      });
    }
  }

  if (formEntries.length > 0) {
    return parseBluetoothChargers(formEntries);
  }

  return parseBluetoothChargers(value.bluetoothChargers);
}
