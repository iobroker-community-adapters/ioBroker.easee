import type { BluetoothAdapterState } from "./bluetooth-transport.ts";

export type BluetoothSearchReadinessReason =
  | "stopping"
  | "cloudMode"
  | "transportInitializing"
  | "transportUnavailable"
  | "adapterUnavailable"
  | "connecting"
  | "manualScan"
  | "polling"
  | "writes"
  | "circuitWrites"
  | "reconnecting"
  | "ready"
  | "waitingForAdapter";

export interface BluetoothSearchReadinessInput {
  readonly unloading: boolean;
  readonly bluetoothMode: boolean;
  readonly scannerAvailable: boolean;
  readonly startupComplete: boolean;
  readonly adapterState: BluetoothAdapterState | null;
  readonly scanInFlight: boolean;
  readonly pollInFlight: boolean;
  readonly activeWrites: number;
  readonly pendingCircuitWrites: number;
  readonly activeCircuitWrites: number;
  readonly reconnectInFlight: boolean;
}

export interface BluetoothSearchReadinessDetails {
  readonly adapterState: BluetoothAdapterState | "unknown";
  readonly scannerAvailable: boolean;
  readonly startupComplete: boolean;
  readonly scanInFlight: boolean;
  readonly pollInFlight: boolean;
  readonly activeWrites: number;
  readonly pendingCircuitWrites: number;
  readonly activeCircuitWrites: number;
  readonly reconnectInFlight: boolean;
}

export interface BluetoothSearchReadiness {
  readonly reason: BluetoothSearchReadinessReason;
  readonly canScan: boolean;
  readonly rawMessage: string;
  readonly displayMessageKey: string;
  readonly busyReason?: string;
  readonly details: BluetoothSearchReadinessDetails;
  readonly diagnostics: string;
}

export function deriveBluetoothSearchReadiness(
  input: BluetoothSearchReadinessInput,
): BluetoothSearchReadiness {
  const adapterState = input.adapterState ?? "unknown";
  const details: BluetoothSearchReadinessDetails = {
    adapterState,
    scannerAvailable: input.scannerAvailable,
    startupComplete: input.startupComplete,
    scanInFlight: input.scanInFlight,
    pollInFlight: input.pollInFlight,
    activeWrites: input.activeWrites,
    pendingCircuitWrites: input.pendingCircuitWrites,
    activeCircuitWrites: input.activeCircuitWrites,
    reconnectInFlight: input.reconnectInFlight,
  };
  const diagnostics = `adapterState=${adapterState}, scannerAvailable=${input.scannerAvailable}, startupComplete=${input.startupComplete}, scanInFlight=${input.scanInFlight}, pollInFlight=${input.pollInFlight}, writesInFlight=${input.activeWrites}, circuitWritesPending=${input.pendingCircuitWrites}, circuitWritesActive=${input.activeCircuitWrites}, reconnectInFlight=${input.reconnectInFlight}`;
  const readiness = (
    reason: BluetoothSearchReadinessReason,
    canScan: boolean,
    rawMessage: string,
    displayMessageKey: string,
    busyReason?: string,
  ): BluetoothSearchReadiness => ({
    reason,
    canScan,
    rawMessage,
    displayMessageKey,
    ...(busyReason ? { busyReason } : {}),
    details,
    diagnostics,
  });

  if (input.unloading) {
    return readiness(
      "stopping",
      false,
      "The adapter is stopping.",
      "The adapter is stopping.",
    );
  }
  if (!input.bluetoothMode) {
    return readiness(
      "cloudMode",
      false,
      "Bluetooth search is unavailable in Cloud mode.",
      "Bluetooth search is available only in Bluetooth mode.",
    );
  }
  if (!input.scannerAvailable) {
    return input.startupComplete
      ? readiness(
          "transportUnavailable",
          false,
          "Bluetooth transport is unavailable; check the adapter log.",
          "Bluetooth is not available. Check the adapter log for details.",
        )
      : readiness(
          "transportInitializing",
          false,
          "Initializing the local Bluetooth transport.",
          "Bluetooth is starting.",
        );
  }
  if (
    adapterState === "poweredOff" ||
    adapterState === "unauthorized" ||
    adapterState === "unsupported"
  ) {
    return readiness(
      "adapterUnavailable",
      false,
      `Not ready: the local Bluetooth adapter reports ${adapterState}.`,
      "Bluetooth is not available. Check that it is turned on and accessible.",
    );
  }

  const busy = (
    reason: BluetoothSearchReadinessReason,
    rawMessage: string,
    displayMessageKey: string,
    busyReason: string,
  ): BluetoothSearchReadiness =>
    readiness(reason, false, rawMessage, displayMessageKey, busyReason);

  if (!input.startupComplete) {
    return busy(
      "connecting",
      `Busy: the initial Bluetooth connection attempt is running (local adapter: ${adapterState}).`,
      "Bluetooth is connecting to the saved charger.",
      "initial Bluetooth connection attempt is still running",
    );
  }
  if (input.scanInFlight) {
    return busy(
      "manualScan",
      "A manual Bluetooth search is running.",
      "A Bluetooth search is already running.",
      "another manual Bluetooth search is already running",
    );
  }
  if (input.pollInFlight) {
    return busy(
      "polling",
      "Busy: Bluetooth polling is active.",
      "The adapter is checking the saved charger.",
      "Bluetooth polling is active",
    );
  }
  if (input.activeWrites > 0) {
    return busy(
      "writes",
      `Busy: ${input.activeWrites} Bluetooth write(s) are active.`,
      "The adapter is sending a command to the charger.",
      "a Bluetooth write is active",
    );
  }
  if (input.pendingCircuitWrites > 0 || input.activeCircuitWrites > 0) {
    return busy(
      "circuitWrites",
      "Busy: a Bluetooth current update is pending or active.",
      "The adapter is updating the charger settings.",
      "a Bluetooth current update is pending or active",
    );
  }
  if (input.reconnectInFlight) {
    return busy(
      "reconnecting",
      "Busy: Bluetooth reconnection is active.",
      "The adapter is reconnecting to the charger.",
      "Bluetooth reconnection is active",
    );
  }
  if (adapterState === "poweredOn") {
    return readiness(
      "ready",
      true,
      "Ready to search: the local adapter reports poweredOn; charger presence is not confirmed.",
      "Ready to search for nearby chargers.",
    );
  }
  return readiness(
    "waitingForAdapter",
    true,
    `Waiting for the local Bluetooth adapter to report poweredOn (current state: ${adapterState}).`,
    "Waiting for Bluetooth to become available.",
  );
}
