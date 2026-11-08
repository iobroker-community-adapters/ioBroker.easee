import type {
  Characteristic,
  Noble,
  Peripheral,
  Service,
} from "@stoprocent/noble";
import {
  BLUETOOTH_CHARACTERISTICS,
  BLUETOOTH_SERVICE_UUID,
} from "./bluetooth-protocol.ts";
import type { BluetoothChannel } from "./bluetooth-protocol.ts";
import type {
  BluetoothCandidate,
  BluetoothLink,
  BluetoothScanner,
} from "./bluetooth-transport.ts";

type NobleFactory = () => Promise<Noble>;

const CHANNELS = Object.keys(BLUETOOTH_CHARACTERISTICS) as BluetoothChannel[];
const CHARACTERISTIC_UUIDS = Object.values(BLUETOOTH_CHARACTERISTICS);

function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase().replace(/-/g, "");
}

function hasService(peripheral: Peripheral, serviceUuid: string): boolean {
  const advertised = peripheral.advertisement?.serviceUuids;
  return (
    Array.isArray(advertised) &&
    advertised.some(
      (uuid) => normalizeUuid(uuid) === normalizeUuid(serviceUuid),
    )
  );
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function loadDefaultNoble(): Promise<Noble> {
  const nobleModule = await import("@stoprocent/noble");
  return nobleModule.withBindings("default");
}

function exactCharacteristic(
  characteristics: readonly Characteristic[],
  uuid: string,
): Characteristic {
  const matches = characteristics.filter(
    (characteristic) =>
      normalizeUuid(characteristic.uuid) === normalizeUuid(uuid),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one BLE characteristic ${uuid}; found ${matches.length}`,
    );
  }
  return matches[0];
}

async function resolveCharacteristics(
  peripheral: Peripheral,
): Promise<ReadonlyMap<BluetoothChannel, Characteristic>> {
  const services = await peripheral.discoverServicesAsync([
    normalizeUuid(BLUETOOTH_SERVICE_UUID),
  ]);
  const matchingServices = services.filter(
    (service) =>
      normalizeUuid(service.uuid) === normalizeUuid(BLUETOOTH_SERVICE_UUID),
  );
  if (matchingServices.length !== 1) {
    throw new Error(
      `Expected exactly one BLE service ${BLUETOOTH_SERVICE_UUID}; found ${matchingServices.length}`,
    );
  }

  const service: Service = matchingServices[0];
  const characteristics = await service.discoverCharacteristicsAsync(
    CHARACTERISTIC_UUIDS.map(normalizeUuid),
  );
  const resolved = new Map<BluetoothChannel, Characteristic>();
  for (const channel of CHANNELS) {
    const uuid = BLUETOOTH_CHARACTERISTICS[channel];
    resolved.set(channel, exactCharacteristic(characteristics, uuid));
  }
  return resolved;
}

class NobleBluetoothLink implements BluetoothLink {
  private readonly notificationListeners = new Map<
    BluetoothChannel,
    (data: Buffer, isNotification: boolean) => void
  >();
  private disconnectListener?: () => void;
  private disconnected = false;
  private closing?: Promise<void>;

  constructor(
    private readonly peripheral: Peripheral,
    private readonly characteristics: ReadonlyMap<
      BluetoothChannel,
      Characteristic
    >,
  ) {
    peripheral.on("disconnect", this.handleDisconnect);
  }

  async subscribe(
    channel: BluetoothChannel,
    listener: (data: Buffer) => void,
  ): Promise<void> {
    this.assertConnected();
    const characteristic = this.getCharacteristic(channel);
    if (
      !characteristic.properties.some(
        (property) => property === "notify" || property === "indicate",
      )
    ) {
      throw new Error(
        `BLE ${channel} characteristic does not support notifications`,
      );
    }
    if (this.notificationListeners.has(channel)) {
      throw new Error(`BLE ${channel} characteristic is already subscribed`);
    }

    const onData = (data: Buffer, isNotification: boolean): void => {
      if (!this.disconnected && isNotification) {
        listener(Buffer.from(data));
      }
    };
    characteristic.on("data", onData);
    this.notificationListeners.set(channel, onData);
    try {
      await characteristic.subscribeAsync();
    } catch (error) {
      characteristic.removeListener("data", onData);
      this.notificationListeners.delete(channel);
      throw error;
    }
  }

  async write(channel: BluetoothChannel, data: Buffer): Promise<void> {
    this.assertConnected();
    const characteristic = this.getCharacteristic(channel);
    const withoutResponse =
      characteristic.properties.includes("writeWithoutResponse") &&
      !characteristic.properties.includes("write");
    if (
      !characteristic.properties.includes("write") &&
      !characteristic.properties.includes("writeWithoutResponse")
    ) {
      throw new Error(`BLE ${channel} characteristic does not support writes`);
    }
    await characteristic.writeAsync(Buffer.from(data), withoutResponse);
  }

  onDisconnect(listener: () => void): void {
    this.disconnectListener = listener;
    if (this.disconnected) {
      listener();
    }
  }

  disconnect(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.closing = this.close();
    return this.closing;
  }

  private async close(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.peripheral.removeListener("disconnect", this.handleDisconnect);
    const subscriptions = [...this.notificationListeners.entries()];
    this.notificationListeners.clear();
    await Promise.all(
      subscriptions.map(async ([channel, onData]) => {
        const characteristic = this.getCharacteristic(channel);
        characteristic.removeListener("data", onData);
        try {
          await characteristic.unsubscribeAsync();
        } catch {
          // A disconnect may already have removed the remote subscription.
        }
      }),
    );
    if (this.peripheral.state === "connected") {
      await this.peripheral.disconnectAsync();
    }
  }

  private getCharacteristic(channel: BluetoothChannel): Characteristic {
    const characteristic = this.characteristics.get(channel);
    if (!characteristic) {
      throw new Error(`BLE ${channel} characteristic was not resolved`);
    }
    return characteristic;
  }

  private assertConnected(): void {
    if (this.disconnected || this.peripheral.state !== "connected") {
      throw new Error("BLE peripheral is disconnected");
    }
  }

  private readonly handleDisconnect = (): void => {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    for (const [channel, onData] of this.notificationListeners) {
      this.getCharacteristic(channel).removeListener("data", onData);
    }
    this.notificationListeners.clear();
    this.disconnectListener?.();
  };
}

export class NobleBluetoothScanner implements BluetoothScanner {
  private readonly peripherals = new Map<string, Peripheral>();
  private readonly activeLinks = new Set<NobleBluetoothLink>();
  private scanning = false;
  private closed = false;

  constructor(private readonly noble: Noble) {}

  async discover(
    serviceUuid: string = BLUETOOTH_SERVICE_UUID,
    timeoutMs: number,
  ): Promise<readonly BluetoothCandidate[]> {
    this.assertOpen();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("BLE discovery timeout must be a positive number");
    }
    if (this.scanning) {
      throw new Error("BLE discovery is already in progress");
    }

    const deadline = Date.now() + timeoutMs;
    await withTimeout(
      this.noble.waitForPoweredOnAsync(timeoutMs),
      deadline - Date.now(),
      "Timed out waiting for the BLE adapter",
    );
    this.peripherals.clear();
    const discovered = new Map<string, BluetoothCandidate>();
    const onDiscover = (peripheral: Peripheral): void => {
      if (!hasService(peripheral, serviceUuid)) {
        return;
      }
      const id = peripheral.id;
      if (!id) {
        return;
      }
      this.peripherals.set(id, peripheral);
      discovered.set(
        id,
        peripheral.advertisement.localName
          ? { id, name: peripheral.advertisement.localName }
          : { id },
      );
    };

    this.scanning = true;
    this.noble.on("discover", onDiscover);
    try {
      const startScanning = this.noble.startScanningAsync(
        [normalizeUuid(serviceUuid)],
        false,
      );
      try {
        await withTimeout(
          startScanning,
          deadline - Date.now(),
          "Timed out starting BLE discovery",
        );
      } catch (error) {
        void startScanning.then(
          () => this.noble.stopScanningAsync().catch(() => undefined),
          () => undefined,
        );
        throw error;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
      }
      return [...discovered.values()];
    } finally {
      this.noble.removeListener("discover", onDiscover);
      if (this.scanning) {
        this.scanning = false;
        await this.noble.stopScanningAsync().catch(() => undefined);
      }
    }
  }

  async connect(candidate: BluetoothCandidate): Promise<BluetoothLink> {
    this.assertOpen();
    const peripheral = this.peripherals.get(candidate.id);
    if (!peripheral) {
      throw new Error("BLE candidate is not from this scanner's discovery");
    }
    if (
      candidate.name &&
      candidate.name !== peripheral.advertisement.localName
    ) {
      throw new Error(
        "BLE candidate name no longer matches the discovered peripheral",
      );
    }
    if (peripheral.state !== "connected") {
      await peripheral.connectAsync();
    }

    let characteristics: ReadonlyMap<BluetoothChannel, Characteristic>;
    try {
      characteristics = await resolveCharacteristics(peripheral);
    } catch (error) {
      if (peripheral.state === "connected") {
        await peripheral.disconnectAsync().catch(() => undefined);
      }
      throw error;
    }
    const link = new NobleBluetoothLink(peripheral, characteristics);
    this.activeLinks.add(link);
    link.onDisconnect(() => this.activeLinks.delete(link));
    return link;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.scanning) {
      this.scanning = false;
      await this.noble.stopScanningAsync().catch(() => undefined);
    }
    await Promise.all(
      [...this.activeLinks].map((link) =>
        link.disconnect().catch(() => undefined),
      ),
    );
    this.activeLinks.clear();
    this.peripherals.clear();
    this.noble.stop();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("BLE scanner is closed");
    }
  }
}

export async function createNobleBluetoothScanner(
  factory: NobleFactory = loadDefaultNoble,
): Promise<NobleBluetoothScanner> {
  return new NobleBluetoothScanner(await factory());
}
