import type { BluetoothChannel } from "./bluetooth-protocol.ts";

export interface BluetoothCandidate {
  readonly id: string;
  readonly name?: string;
}

export interface BluetoothLink {
  subscribe(
    channel: BluetoothChannel,
    listener: (data: Buffer) => void,
  ): Promise<void>;
  write(channel: BluetoothChannel, data: Buffer): Promise<void>;
  onDisconnect(listener: () => void): void;
  disconnect(): Promise<void>;
}

export interface BluetoothScanner {
  discover(
    serviceUuid: string,
    timeoutMs: number,
  ): Promise<readonly BluetoothCandidate[]>;
  connect(candidate: BluetoothCandidate): Promise<BluetoothLink>;
  close(): Promise<void>;
}

export type BluetoothTransportFactory = () => BluetoothScanner;
