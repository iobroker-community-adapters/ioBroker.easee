import type {
  Characteristic,
  Noble,
  Peripheral,
  Service,
} from "@stoprocent/noble";
import { systemBus } from "dbus-next";
import type { MessageBus } from "dbus-next";
import {
  BLUETOOTH_CHARACTERISTICS,
  BLUETOOTH_SERVICE_UUID,
} from "./bluetooth-protocol.ts";
import type { BluetoothChannel } from "./bluetooth-protocol.ts";
import type {
  BluetoothAdapterState,
  BluetoothAdapterStatusProvider,
  BluetoothCandidate,
  BluetoothDiscoveryOptions,
  BluetoothLink,
  BluetoothScanner,
} from "./bluetooth-transport.ts";

type NobleFactory = () => Promise<Noble>;
type NobleBluetoothScannerInterfaces = BluetoothScanner &
  BluetoothAdapterStatusProvider;
type NobleBinding = "default" | "hci" | "dbus" | "mac" | "win";

const NOBLE_BINDINGS = new Set(["hci", "dbus", "mac", "win"]);

/** Selects Noble's Linux binding while honoring an explicit binding override. */
export function resolveNobleBinding(
  platform: NodeJS.Platform,
  configuredBinding?: string,
): NobleBinding {
  const binding = configuredBinding?.trim().toLowerCase();
  if (binding && NOBLE_BINDINGS.has(binding)) {
    return binding as NobleBinding;
  }
  return platform === "linux" ? "dbus" : "default";
}

const CHANNELS = Object.keys(BLUETOOTH_CHARACTERISTICS) as BluetoothChannel[];
const CHARACTERISTIC_UUIDS = Object.values(BLUETOOTH_CHARACTERISTICS);
const BLUEZ_SERVICE = "org.bluez";
const BLUEZ_DEVICE_INTERFACE = "org.bluez.Device1";
const BLUEZ_OBJECT_MANAGER_INTERFACE = "org.freedesktop.DBus.ObjectManager";
const BLUEZ_PAIR_TIMEOUT_MS = 30_000;

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

function waitForAdapterPoweredOn(
  noble: Noble,
  timeoutMs: number,
  cancellation: Promise<never>,
): Promise<void> {
  if (noble.state === "poweredOn") {
    return Promise.resolve();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onStateChange: ((state: BluetoothAdapterState) => void) | undefined;
  const readiness = new Promise<void>((resolve, reject) => {
    onStateChange = (state) => {
      if (state === "poweredOn") {
        resolve();
      }
    };
    noble.on("stateChange", onStateChange);
    if (noble.state === "poweredOn") {
      resolve();
      return;
    }
    timer = setTimeout(
      () => reject(new Error("Timed out waiting for the BLE adapter")),
      timeoutMs,
    );
  });

  return Promise.race([readiness, cancellation]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
    if (onStateChange) {
      noble.removeListener("stateChange", onStateChange);
    }
  });
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  cancellation?: Promise<never>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race(
    cancellation ? [operation, timeout, cancellation] : [operation, timeout],
  ).finally(() => clearTimeout(timer));
}

function unwrapDbusValue(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value) {
    return value.value;
  }
  return value;
}

/**
 * Pairs the connected BlueZ device after an authenticated-write error.
 *
 * @param address The BlueZ device address associated with the connected peripheral.
 * @param timeoutMs Maximum time allowed for D-Bus discovery and pairing.
 * @param busFactory Creates the system bus used to call BlueZ.
 */
export async function pairBluezDevice(
  address: string,
  timeoutMs = BLUEZ_PAIR_TIMEOUT_MS,
  busFactory: () => MessageBus = systemBus,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("BlueZ pairing timeout must be positive");
  }
  const bus = busFactory();
  bus.on("error", () => undefined);
  const timeoutMessage = `BlueZ pairing timed out after ${timeoutMs} ms`;
  const operation = (async () => {
    const root = await bus.getProxyObject(BLUEZ_SERVICE, "/");
    const objectManager = root.getInterface(BLUEZ_OBJECT_MANAGER_INTERFACE);
    const objects = (await objectManager.GetManagedObjects()) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const normalizedAddress = address.toUpperCase();
    const devicePath = Object.entries(objects).find(([, interfaces]) => {
      const properties = interfaces[BLUEZ_DEVICE_INTERFACE];
      return (
        String(unwrapDbusValue(properties?.Address)).toUpperCase() ===
        normalizedAddress
      );
    })?.[0];
    if (!devicePath) {
      throw new Error(
        "BlueZ Device1 entry for the connected charger was not found",
      );
    }
    const deviceObject = await bus.getProxyObject(BLUEZ_SERVICE, devicePath);
    const device = deviceObject.getInterface(BLUEZ_DEVICE_INTERFACE);
    await device.Pair();
  })();

  try {
    await withTimeout(operation, timeoutMs, timeoutMessage);
  } catch (error) {
    if (error instanceof Error && error.message === timeoutMessage) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`BlueZ pairing failed: ${reason}`, { cause: error });
  } finally {
    try {
      bus.disconnect();
    } catch {
      // BlueZ may already have closed the system-bus connection.
    }
  }
}

async function loadDefaultNoble(): Promise<Noble> {
  const nobleModule = await import("@stoprocent/noble");
  const binding = resolveNobleBinding(
    process.platform,
    process.env.NOBLE_BINDINGS,
  );
  // Noble 2.8 supports D-Bus at runtime, but omits it from the published BindingType union.
  return nobleModule.withBindings(
    binding as Parameters<typeof nobleModule.withBindings>[0],
  );
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
  readonly pair?: () => Promise<void>;

  constructor(
    private readonly peripheral: Peripheral,
    private readonly characteristics: ReadonlyMap<
      BluetoothChannel,
      Characteristic
    >,
    pairDevice?: () => Promise<void>,
  ) {
    this.pair = pairDevice;
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

export class NobleBluetoothScanner implements NobleBluetoothScannerInterfaces {
  private readonly peripherals = new Map<string, Peripheral>();
  private readonly activeLinks = new Set<NobleBluetoothLink>();
  private scanning = false;
  private discoveryInFlight = false;
  private cancelDiscovery?: () => void;
  private closed = false;

  constructor(
    private readonly noble: Noble,
    private readonly binding: NobleBinding = resolveNobleBinding(
      process.platform,
      process.env.NOBLE_BINDINGS,
    ),
  ) {}

  /** Returns Noble's current local adapter state without starting a scan. */
  getAdapterState(): BluetoothAdapterState {
    return this.noble.state;
  }

  /**
   * Subscribes to Noble adapter-state changes and returns a cleanup function.
   *
   * @param listener Receives each state reported by Noble.
   * @returns A function that removes the listener.
   */
  onAdapterStateChange(
    listener: (state: BluetoothAdapterState) => void,
  ): () => void {
    this.noble.on("stateChange", listener);
    return () => this.noble.removeListener("stateChange", listener);
  }

  async discover(
    serviceUuid: string = BLUETOOTH_SERVICE_UUID,
    timeoutMs: number,
    options?: BluetoothDiscoveryOptions,
  ): Promise<readonly BluetoothCandidate[]> {
    this.assertOpen();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("BLE discovery timeout must be a positive number");
    }
    if (this.discoveryInFlight) {
      throw new Error("BLE discovery is already in progress");
    }

    this.discoveryInFlight = true;
    const deadline = Date.now() + timeoutMs;
    let rejectCancellation: ((error: Error) => void) | undefined;
    let scanDelayTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    this.cancelDiscovery = () => {
      if (scanDelayTimer) {
        clearTimeout(scanDelayTimer);
      }
      rejectCancellation?.(new Error("BLE discovery cancelled"));
    };
    let onDiscover: ((peripheral: Peripheral) => void) | undefined;
    try {
      await waitForAdapterPoweredOn(
        this.noble,
        Math.max(0, deadline - Date.now()),
        cancelled,
      );
      this.peripherals.clear();
      const discovered = new Map<string, BluetoothCandidate>();
      onDiscover = (peripheral: Peripheral): void => {
        const advertisement = peripheral.advertisement;
        const serviceUuids = Array.isArray(advertisement?.serviceUuids)
          ? advertisement.serviceUuids
          : [];
        const name = advertisement?.localName;
        const connectable =
          this.binding === "dbus" ? undefined : peripheral.connectable;
        options?.onAdvertisement?.({
          ...(name ? { name } : {}),
          serviceUuids,
          ...(connectable === undefined ? {} : { connectable }),
        });
        const matchesService = hasService(peripheral, serviceUuid);
        const matchesFallbackName =
          options?.fallbackLocalName !== undefined &&
          name === options.fallbackLocalName;
        if (!matchesService && !matchesFallbackName) {
          return;
        }
        const id = peripheral.id;
        if (!id) {
          return;
        }
        this.peripherals.set(id, peripheral);
        discovered.set(id, {
          id,
          ...(name ? { name } : {}),
          ...(connectable === undefined ? {} : { connectable }),
        });
      };

      this.scanning = true;
      this.noble.on("discover", onDiscover);
      const startScanning = this.noble.startScanningAsync(
        options?.scanWithoutServiceFilter ||
          options?.fallbackLocalName !== undefined
          ? []
          : [normalizeUuid(serviceUuid)],
        options?.scanWithoutServiceFilter === true ||
          options?.fallbackLocalName !== undefined,
      );
      try {
        await withTimeout(
          startScanning,
          deadline - Date.now(),
          "Timed out starting BLE discovery",
          cancelled,
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
        await Promise.race([
          new Promise<void>((resolve) => {
            scanDelayTimer = setTimeout(resolve, remainingMs);
          }),
          cancelled,
        ]);
      }
      return [...discovered.values()];
    } finally {
      if (scanDelayTimer) {
        clearTimeout(scanDelayTimer);
      }
      if (onDiscover) {
        this.noble.removeListener("discover", onDiscover);
      }
      if (this.scanning) {
        this.scanning = false;
        await this.noble.stopScanningAsync().catch(() => undefined);
      }
      this.discoveryInFlight = false;
      this.cancelDiscovery = undefined;
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
    if (this.binding !== "dbus" && !peripheral.connectable) {
      throw new Error("BLE peripheral is not currently connectable");
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
    const pairDevice =
      this.binding === "dbus"
        ? () => pairBluezDevice(peripheral.address)
        : undefined;
    const link = new NobleBluetoothLink(
      peripheral,
      characteristics,
      pairDevice,
    );
    this.activeLinks.add(link);
    link.onDisconnect(() => this.activeLinks.delete(link));
    return link;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelDiscovery?.();
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
