import type { AdapterState } from "@stoprocent/noble";
import type { BluetoothChannel } from "./bluetooth-protocol.ts";

/** The exact adapter-state values exposed by Noble. */
export type BluetoothAdapterState = AdapterState;

export interface BluetoothCandidate {
  readonly id: string;
  readonly name?: string;
  /** Noble-reported connectability; undefined means the scanner did not report it. */
  readonly connectable?: boolean;
}

/** Advertisement data surfaced by an explicitly requested diagnostic scan. */
export interface BluetoothAdvertisementReport {
  readonly name?: string;
  readonly serviceUuids: readonly string[];
  readonly connectable?: boolean;
}

/** Optional controls and callbacks for BLE discovery. */
export interface BluetoothDiscoveryOptions {
  /** Scans without a controller-side service UUID filter. */
  readonly scanWithoutServiceFilter?: boolean;
  /** Accepts an exact advertised local-name match as a candidate fallback. */
  readonly fallbackLocalName?: string;
  /** Receives advertisement names, service UUIDs and connectability, but no addresses. */
  readonly onAdvertisement?: (report: BluetoothAdvertisementReport) => void;
}

/** Reads local Bluetooth adapter status without implying charger availability. */
export interface BluetoothAdapterStatusProvider {
  /** Returns the current state reported by the Bluetooth library. */
  getAdapterState(): BluetoothAdapterState;
  /** Subscribes to changes of the local adapter state and returns an unsubscribe function. */
  onAdapterStateChange(
    listener: (state: BluetoothAdapterState) => void,
  ): () => void;
}

export interface BluetoothLink {
  subscribe(
    channel: BluetoothChannel,
    listener: (data: Buffer) => void,
  ): Promise<void>;
  write(channel: BluetoothChannel, data: Buffer): Promise<void>;
  /** Requests BLE link pairing when the backend supports it (BlueZ only). */
  pair?(): Promise<void>;
  onDisconnect(listener: () => void): void;
  disconnect(): Promise<void>;
}

export interface BluetoothScanner {
  discover(
    serviceUuid: string,
    timeoutMs: number,
    options?: BluetoothDiscoveryOptions,
  ): Promise<readonly BluetoothCandidate[]>;
  connect(candidate: BluetoothCandidate): Promise<BluetoothLink>;
  close(): Promise<void>;
}

export type BluetoothTransportFactory = () => BluetoothScanner;
