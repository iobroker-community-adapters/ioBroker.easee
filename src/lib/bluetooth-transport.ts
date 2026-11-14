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
  /** Whether the advertisement's company identifier is Easee's ID 3118; raw data is not exposed. */
  readonly easeeManufacturerMatch?: boolean;
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

/** Adapter-owned timers for operations that must stop with the adapter instance. */
export interface BluetoothTimerApi {
  /** Schedules a callback using the adapter's lifecycle-managed timer API. */
  setTimeout(
    callback: () => void,
    timeoutMs: number,
  ): ioBroker.Timeout | undefined;
  /** Cancels a timer created by this adapter. */
  clearTimeout(timer: ioBroker.Timeout | undefined): void;
}

export const BLUETOOTH_TEARDOWN_TIMEOUT_MS = 5000;

export interface BluetoothScanner {
  discover(
    serviceUuid: string,
    timeoutMs: number,
    options?: BluetoothDiscoveryOptions,
  ): Promise<readonly BluetoothCandidate[]>;
  connect(candidate: BluetoothCandidate): Promise<BluetoothLink>;
  close(): Promise<void>;
}

/**
 * Races an operation against cancellation and removes the abort listener on settlement.
 *
 * @param operation The operation whose completion to await.
 * @param signal The signal that cancels the operation.
 * @param createAbortError Creates the error used when cancellation wins.
 */
export function raceWithAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  createAbortError: () => Error,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort = (): void => undefined;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    onAbort = () => finish(() => reject(createAbortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      void operation.catch(() => undefined);
      return;
    }
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error ? error : new Error("BLE operation failed"),
          ),
        ),
    );
  });
}

/**
 * Bounds cleanup waits using an independent Node shutdown deadline.
 *
 * @param operation The cleanup operation to await.
 * @param description A short cleanup stage description for the timeout error.
 */
export function withBluetoothTeardownTimeout<T>(
  operation: Promise<T>,
  description: string,
): Promise<T> {
  return raceWithAbortSignal(
    operation,
    AbortSignal.timeout(BLUETOOTH_TEARDOWN_TIMEOUT_MS),
    () =>
      new Error(
        `BLE teardown timed out after ${BLUETOOTH_TEARDOWN_TIMEOUT_MS} ms: ${description}`,
      ),
  );
}

/**
 * Races an operation against a timeout and optional cancellation signal.
 *
 * @param operation The operation to await.
 * @param timeoutMs Maximum time to wait for the operation.
 * @param timers Adapter-owned timer functions.
 * @param createTimeoutError Creates the error used when the timeout wins.
 * @param cancellation Optional signal that aborts the operation.
 * @param createAbortError Creates the error used when cancellation wins.
 */
export function raceWithTimeoutAndAbort<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timers: BluetoothTimerApi,
  createTimeoutError: () => Error,
  cancellation?: AbortSignal,
  createAbortError: () => Error = () => new Error("BLE operation cancelled"),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ioBroker.Timeout | undefined;
    let onAbort = (): void => undefined;
    const cleanup = (): void => {
      if (timer) {
        timers.clearTimeout(timer);
      }
      if (cancellation) {
        cancellation.removeEventListener("abort", onAbort);
      }
    };
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    onAbort = () => finish(() => reject(createAbortError()));

    if (cancellation?.aborted) {
      void operation.catch(() => undefined);
      reject(createAbortError());
      return;
    }
    if (cancellation) {
      cancellation.addEventListener("abort", onAbort, { once: true });
      if (cancellation.aborted) {
        onAbort();
        void operation.catch(() => undefined);
        return;
      }
    }

    try {
      timer = timers.setTimeout(
        () => finish(() => reject(createTimeoutError())),
        timeoutMs,
      );
    } catch (error) {
      finish(() =>
        reject(error instanceof Error ? error : new Error("BLE timer failed")),
      );
      return;
    }
    if (settled) {
      if (timer) {
        timers.clearTimeout(timer);
      }
      return;
    }
    if (cancellation?.aborted) {
      onAbort();
      void operation.catch(() => undefined);
      return;
    }
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error ? error : new Error("BLE operation failed"),
          ),
        ),
    );
  });
}
