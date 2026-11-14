import { hciStatusMessage } from "@stoprocent/noble";
import { createRequire } from "node:module";
import type {
  Characteristic,
  DisconnectReason,
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
import { applyNobleHciMtuWorkaround } from "./noble-hci-mtu-workaround.ts";
import {
  bluetoothDiagnosticNow,
  logBluetoothDiagnostic,
} from "./bluetooth-diagnostics.ts";
import type { BluetoothDiagnosticLogger } from "./bluetooth-diagnostics.ts";
import {
  raceWithAbortSignal,
  raceWithTimeoutAndAbort,
  withBluetoothTeardownTimeout,
} from "./bluetooth-transport.ts";
import type {
  BluetoothAdapterState,
  BluetoothAdapterStatusProvider,
  BluetoothCandidate,
  BluetoothDiscoveryOptions,
  BluetoothLink,
  BluetoothScanner,
  BluetoothTimerApi,
} from "./bluetooth-transport.ts";
import { validateTimeoutMs } from "./timeout.ts";

type NobleFactory = (binding?: NobleBinding) => Promise<Noble>;
type NobleBluetoothScannerInterfaces = BluetoothScanner &
  BluetoothAdapterStatusProvider;
type NobleBinding = "default" | "hci" | "dbus" | "mac" | "win";

const NOBLE_BINDINGS = new Set(["hci", "dbus", "mac", "win"]);

/**
 * Ensures the Noble package itself can resolve its optional D-Bus peer.
 *
 * @param resolveDependency Resolver rooted at Noble's module path.
 */
export function ensureNobleDbusDependency(
  resolveDependency: (moduleName: string) => string,
): void {
  try {
    resolveDependency("dbus-next");
  } catch (error) {
    throw new Error(
      'The Noble D-Bus binding cannot resolve "dbus-next". Reinstall the adapter dependencies so it is available to @stoprocent/noble.',
      { cause: error },
    );
  }
}

/**
 * Selects a Noble binding from the adapter setting and runtime platform.
 *
 * @param platform - Runtime platform.
 * @param configuredBinding - Adapter setting; `auto` selects the platform default.
 * @param automaticHciFallback - Whether Automatic should use Raw HCI as a fallback.
 */
export function resolveNobleBinding(
  platform: NodeJS.Platform,
  configuredBinding?: string,
  automaticHciFallback?: boolean,
): NobleBinding {
  const configured = configuredBinding?.trim().toLowerCase();
  if (configured && configured !== "auto" && NOBLE_BINDINGS.has(configured)) {
    return configured as NobleBinding;
  }

  if (platform === "linux" && automaticHciFallback) {
    return "hci";
  }

  return platform === "linux" ? "dbus" : "default";
}

const CHANNELS = Object.keys(BLUETOOTH_CHARACTERISTICS) as BluetoothChannel[];
const CHARACTERISTIC_UUIDS = Object.values(BLUETOOTH_CHARACTERISTICS);
const BLUEZ_SERVICE = "org.bluez";
const BLUEZ_DEVICE_INTERFACE = "org.bluez.Device1";
const BLUEZ_OBJECT_MANAGER_INTERFACE = "org.freedesktop.DBus.ObjectManager";
const BLUEZ_PAIR_TIMEOUT_MS = 30_000;
const CHARACTERISTIC_DISCOVERY_RETRY_QUIET_WINDOW_MS = 250;
const EASEE_MANUFACTURER_ID = 3118;
const CLIENT_CHARACTERISTIC_CONFIGURATION_UUIDS = new Set([
  "2902",
  "0000290200001000800000805f9b34fb",
]);

function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase().replace(/-/g, "");
}

function isAttributeNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /attribute (?:could not be found|not found)/i.test(message);
}

function isPeripheralConnected(peripheral: Peripheral): boolean {
  return peripheral.state === "connected";
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

function hasEaseeManufacturerId(peripheral: Peripheral): boolean {
  const data = peripheral.advertisement?.manufacturerData;
  return (
    Buffer.isBuffer(data) &&
    data.length >= 2 &&
    data.readUInt16LE(0) === EASEE_MANUFACTURER_ID
  );
}

function waitForAdapterPoweredOn(
  noble: Noble,
  timeoutMs: number,
  cancellation: AbortSignal,
  timers: BluetoothTimerApi,
): Promise<void> {
  if (noble.state === "poweredOn") {
    return Promise.resolve();
  }

  let timer: ioBroker.Timeout | undefined;
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
    timer = timers.setTimeout(
      () => reject(new Error("Timed out waiting for the BLE adapter")),
      timeoutMs,
    );
  });

  return raceWithAbortSignal(
    readiness,
    cancellation,
    () => new Error("BLE discovery cancelled"),
  ).finally(() => {
    if (timer) {
      timers.clearTimeout(timer);
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
  timers: BluetoothTimerApi,
  cancellation?: AbortSignal,
  cancellationMessage = "BLE operation cancelled",
): Promise<T> {
  return raceWithTimeoutAndAbort(
    operation,
    timeoutMs,
    timers,
    () => new Error(message),
    cancellation,
    () => new Error(cancellationMessage),
  );
}

type RegisterCloseCancellation = (cancel: () => void) => () => void;

function withScannerClose<T>(
  operation: Promise<T>,
  scannerClosed: AbortSignal,
): Promise<T> {
  return raceWithAbortSignal(
    operation,
    scannerClosed,
    () => new Error("BLE scanner is closed"),
  );
}

function waitForCharacteristicRetryQuietWindow(
  timers: BluetoothTimerApi,
  registerCloseCancellation: RegisterCloseCancellation,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ioBroker.Timeout | undefined;
    let settled = false;
    let unregister = (): void => undefined;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      unregister();
      unregister = (): void => undefined;
      if (timer) {
        timers.clearTimeout(timer);
        timer = undefined;
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    unregister = registerCloseCancellation(() =>
      finish(new Error("BLE scanner is closed")),
    );
    if (!settled) {
      timer = timers.setTimeout(
        () => finish(),
        CHARACTERISTIC_DISCOVERY_RETRY_QUIET_WINDOW_MS,
      );
    }
  });
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
 * @param timers Adapter-owned timer API.
 * @param timeoutMs Maximum time allowed for D-Bus discovery and pairing.
 * @param busFactory Creates the system bus used to call BlueZ.
 * @param scannerClosed Signal aborted when scanner closure cancels pairing.
 */
export async function pairBluezDevice(
  address: string,
  timers: BluetoothTimerApi,
  timeoutMs = BLUEZ_PAIR_TIMEOUT_MS,
  busFactory: () => MessageBus = systemBus,
  scannerClosed?: AbortSignal,
): Promise<void> {
  validateTimeoutMs(timeoutMs, "BlueZ pairing timeout");
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
    await withTimeout(
      operation,
      timeoutMs,
      timeoutMessage,
      timers,
      scannerClosed,
      "BLE scanner is closed",
    );
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

function canNobleResolveDependency(moduleName: string): boolean {
  try {
    const requireFromAdapter = createRequire(__filename);
    const noblePath = requireFromAdapter.resolve("@stoprocent/noble");
    createRequire(noblePath).resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

function canNobleResolveDbusDependency(): boolean {
  return canNobleResolveDependency("dbus-next");
}

function canNobleResolveHciDependency(): boolean {
  return canNobleResolveDependency("@stoprocent/bluetooth-hci-socket");
}

async function loadDefaultNoble(binding?: NobleBinding): Promise<Noble> {
  const selectedBinding = binding ?? resolveNobleBinding(process.platform);

  const requireFromAdapter = createRequire(__filename);
  if (selectedBinding === "dbus") {
    const noblePath = requireFromAdapter.resolve("@stoprocent/noble");
    const requireFromNoble = createRequire(noblePath);
    ensureNobleDbusDependency((moduleName) =>
      requireFromNoble.resolve(moduleName),
    );
  }

  if (selectedBinding === "hci") {
    try {
      const gattConstructor = requireFromAdapter(
        "@stoprocent/noble/lib/hci-socket/gatt.js",
      ) as { prototype?: unknown };
      const bindingsConstructor = requireFromAdapter(
        "@stoprocent/noble/lib/hci-socket/bindings.js",
      ) as { prototype?: unknown };
      applyNobleHciMtuWorkaround(
        selectedBinding,
        typeof gattConstructor === "function"
          ? gattConstructor.prototype
          : undefined,
        typeof bindingsConstructor === "function"
          ? bindingsConstructor.prototype
          : undefined,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Raw HCI ATT MTU workaround is incompatible")
      ) {
        throw error;
      }
      throw new Error(
        "Raw HCI ATT MTU workaround could not load or patch @stoprocent/noble's expected HCI GATT implementation",
        { cause: error },
      );
    }
  }

  const nobleModule = await import("@stoprocent/noble");
  // Noble 2.8 supports D-Bus at runtime, but omits it from the published BindingType union.
  return nobleModule.withBindings(
    selectedBinding as Parameters<typeof nobleModule.withBindings>[0],
  );
}

function matchingCharacteristics(
  characteristics: readonly Characteristic[],
  uuid: string,
): Characteristic[] {
  return characteristics.filter(
    (characteristic) =>
      normalizeUuid(characteristic.uuid) === normalizeUuid(uuid),
  );
}

function exactCharacteristic(
  characteristics: readonly Characteristic[],
  uuid: string,
): Characteristic {
  const matches = matchingCharacteristics(characteristics, uuid);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one BLE characteristic ${uuid}; found ${matches.length}`,
    );
  }
  return matches[0];
}

async function resolveCharacteristics(
  peripheral: Peripheral,
  timers: BluetoothTimerApi,
  diagnosticLogger: BluetoothDiagnosticLogger | undefined,
  retryIncompleteCharacteristics: boolean,
  scannerClosed: AbortSignal,
  registerCloseCancellation: RegisterCloseCancellation,
): Promise<ReadonlyMap<BluetoothChannel, Characteristic>> {
  const serviceDiscoveryStartedAt = bluetoothDiagnosticNow();
  logBluetoothDiagnostic(diagnosticLogger, "gatt.service_discovery", "started");
  let service: Service;
  try {
    const services = await withScannerClose(
      peripheral.discoverServicesAsync([normalizeUuid(BLUETOOTH_SERVICE_UUID)]),
      scannerClosed,
    );
    const matchingServices = services.filter(
      (candidate) =>
        normalizeUuid(candidate.uuid) === normalizeUuid(BLUETOOTH_SERVICE_UUID),
    );
    if (matchingServices.length !== 1) {
      throw new Error(
        `Expected exactly one BLE service ${BLUETOOTH_SERVICE_UUID}; found ${matchingServices.length}`,
      );
    }
    service = matchingServices[0];
    logBluetoothDiagnostic(
      diagnosticLogger,
      "gatt.service_discovery",
      "completed",
      {
        durationMs: bluetoothDiagnosticNow() - serviceDiscoveryStartedAt,
        fields: { matches: matchingServices.length },
      },
    );
  } catch (error) {
    logBluetoothDiagnostic(
      diagnosticLogger,
      "gatt.service_discovery",
      "failed",
      {
        durationMs: bluetoothDiagnosticNow() - serviceDiscoveryStartedAt,
        error,
      },
    );
    throw error;
  }

  const characteristicDiscoveryStartedAt = bluetoothDiagnosticNow();
  logBluetoothDiagnostic(
    diagnosticLogger,
    "gatt.characteristic_discovery",
    "started",
  );
  let attempt = 0;
  let missingCount: number | undefined;
  try {
    let characteristics: readonly Characteristic[] = [];
    while (true) {
      attempt++;
      missingCount = undefined;
      characteristics = await withScannerClose(
        service.discoverCharacteristicsAsync(
          CHARACTERISTIC_UUIDS.map(normalizeUuid),
        ),
        scannerClosed,
      );
      const missingChannels: BluetoothChannel[] = [];
      for (const channel of CHANNELS) {
        const uuid = BLUETOOTH_CHARACTERISTICS[channel];
        const matches = matchingCharacteristics(characteristics, uuid);
        if (matches.length > 1) {
          exactCharacteristic(characteristics, uuid);
        }
        if (matches.length === 0) {
          missingChannels.push(channel);
        }
      }
      missingCount = missingChannels.length;
      if (missingCount === 0) {
        break;
      }
      if (attempt === 1 && retryIncompleteCharacteristics) {
        logBluetoothDiagnostic(
          diagnosticLogger,
          "gatt.characteristic_discovery",
          "retry",
          {
            durationMs:
              bluetoothDiagnosticNow() - characteristicDiscoveryStartedAt,
            fields: {
              attempt,
              missingCount,
              quietWindowMs: CHARACTERISTIC_DISCOVERY_RETRY_QUIET_WINDOW_MS,
            },
          },
        );
        await waitForCharacteristicRetryQuietWindow(
          timers,
          registerCloseCancellation,
        );
        continue;
      }
      exactCharacteristic(
        characteristics,
        BLUETOOTH_CHARACTERISTICS[missingChannels[0]],
      );
    }

    const resolved = new Map<BluetoothChannel, Characteristic>();
    for (const channel of CHANNELS) {
      const uuid = BLUETOOTH_CHARACTERISTICS[channel];
      const characteristic = exactCharacteristic(characteristics, uuid);
      resolved.set(channel, characteristic);
      logBluetoothDiagnostic(
        diagnosticLogger,
        "gatt.characteristic_resolved",
        "completed",
        {
          fields: {
            channel,
            uuid: normalizeUuid(characteristic.uuid),
            notify: characteristic.properties.includes("notify"),
            indicate: characteristic.properties.includes("indicate"),
            write: characteristic.properties.includes("write"),
            writeWithoutResponse: characteristic.properties.includes(
              "writeWithoutResponse",
            ),
          },
        },
      );
    }
    logBluetoothDiagnostic(
      diagnosticLogger,
      "gatt.characteristic_discovery",
      "completed",
      {
        durationMs: bluetoothDiagnosticNow() - characteristicDiscoveryStartedAt,
        fields: { count: resolved.size },
      },
    );
    return resolved;
  } catch (error) {
    if (attempt > 1) {
      logBluetoothDiagnostic(
        diagnosticLogger,
        "gatt.characteristic_discovery",
        "retry_failed",
        {
          durationMs:
            bluetoothDiagnosticNow() - characteristicDiscoveryStartedAt,
          fields: { attempt, missingCount },
          error,
        },
      );
    }
    logBluetoothDiagnostic(
      diagnosticLogger,
      "gatt.characteristic_discovery",
      "failed",
      {
        durationMs: bluetoothDiagnosticNow() - characteristicDiscoveryStartedAt,
        error,
      },
    );
    throw error;
  }
}

class NobleBluetoothLink implements BluetoothLink {
  private readonly notificationListeners = new Map<
    BluetoothChannel,
    (data: Buffer, isNotification: boolean) => void
  >();
  private readonly passiveNotificationChannels = new Set<BluetoothChannel>();
  private disconnectListener?: () => void;
  private disconnected = false;
  private closing?: Promise<void>;
  private readonly connectedAt = bluetoothDiagnosticNow();
  readonly pair?: () => Promise<void>;

  constructor(
    private readonly peripheral: Peripheral,
    private readonly characteristics: ReadonlyMap<
      BluetoothChannel,
      Characteristic
    >,
    pairDevice?: () => Promise<void>,
    private readonly allowCoreBluetoothCccdFallback = false,
    private readonly allowHciCccdlessNotifications = false,
    private readonly diagnosticLogger?: BluetoothDiagnosticLogger,
  ) {
    this.pair = pairDevice;
    peripheral.on("disconnect", this.handleDisconnect);
  }

  async subscribe(
    channel: BluetoothChannel,
    listener: (data: Buffer) => void,
  ): Promise<void> {
    const startedAt = bluetoothDiagnosticNow();
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "transport.notification_setup",
      "started",
      { fields: { channel } },
    );
    let descriptorCount: number | undefined;
    let cccdPresent: boolean | undefined;
    try {
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

      let acceptNonNotificationData = false;
      const onData = (
        data: Buffer,
        isNotification: boolean,
        error?: Error,
      ): void => {
        const accepted =
          !this.disconnected && (isNotification || acceptNonNotificationData);
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.characteristic_data",
          accepted ? "accepted" : "ignored",
          {
            ...(error === undefined ? {} : { error }),
            fields: {
              channel,
              uuid: normalizeUuid(characteristic.uuid),
              byteLength: Buffer.isBuffer(data) ? data.length : 0,
              isNotification,
              accepted,
              ...(!accepted
                ? {
                    ignoreReason: this.disconnected
                      ? "disconnected"
                      : "not_notification",
                  }
                : {}),
            },
          },
        );
        if (accepted) {
          listener(Buffer.from(data));
        }
      };
      characteristic.on("data", onData);
      this.notificationListeners.set(channel, onData);
      try {
        if (this.allowHciCccdlessNotifications) {
          const descriptors = await characteristic.discoverDescriptorsAsync();
          descriptorCount = descriptors.length;
          cccdPresent = descriptors.some((descriptor) =>
            CLIENT_CHARACTERISTIC_CONFIGURATION_UUIDS.has(
              normalizeUuid(descriptor.uuid),
            ),
          );
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "transport.cccd_discovery",
            "completed",
            {
              durationMs: bluetoothDiagnosticNow() - startedAt,
              fields: { channel, descriptorCount, cccdPresent },
            },
          );
          if (!cccdPresent) {
            // Raw HCI dispatches unsolicited ATT notifications without a CCCD write.
            this.passiveNotificationChannels.add(channel);
            logBluetoothDiagnostic(
              this.diagnosticLogger,
              "transport.notification_setup",
              "completed",
              {
                durationMs: bluetoothDiagnosticNow() - startedAt,
                fields: {
                  channel,
                  mode: "passive",
                  descriptorCount,
                  cccdPresent,
                },
              },
            );
            return;
          }
        }
        await characteristic.subscribeAsync();
      } catch (error) {
        if (
          isAttributeNotFoundError(error) &&
          this.allowCoreBluetoothCccdFallback
        ) {
          acceptNonNotificationData = true;
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "transport.notification_setup",
            "completed",
            {
              durationMs: bluetoothDiagnosticNow() - startedAt,
              fields: {
                channel,
                mode: "corebluetooth_fallback",
                ...(descriptorCount === undefined ? {} : { descriptorCount }),
                ...(cccdPresent === undefined ? {} : { cccdPresent }),
              },
            },
          );
          return;
        }
        characteristic.removeListener("data", onData);
        this.notificationListeners.delete(channel);
        if (isAttributeNotFoundError(error)) {
          throw new Error(
            `BLE ${channel} notification subscription failed with ATT Attribute Not Found. This Noble binding exposes no supported CCCD-less subscription API, so the Easee no-CCCD workaround cannot be used by this transport.`,
          );
        }
        throw error;
      }
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.notification_setup",
        "completed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          fields: {
            channel,
            mode: "subscribed",
            ...(descriptorCount === undefined ? {} : { descriptorCount }),
            ...(cccdPresent === undefined ? {} : { cccdPresent }),
          },
        },
      );
    } catch (error) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.notification_setup",
        "failed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          error,
          fields: {
            channel,
            ...(descriptorCount === undefined ? {} : { descriptorCount }),
            ...(cccdPresent === undefined ? {} : { cccdPresent }),
          },
        },
      );
      throw error;
    }
  }

  async write(channel: BluetoothChannel, data: Buffer): Promise<void> {
    const startedAt = bluetoothDiagnosticNow();
    const byteLength = Buffer.isBuffer(data) ? data.length : 0;
    const characteristicUuid = normalizeUuid(
      BLUETOOTH_CHARACTERISTICS[channel],
    );
    let responseMode = "unknown";
    const disconnectedBeforeWrite =
      this.disconnected || this.peripheral.state !== "connected";
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "transport.write",
      "started",
      {
        fields: {
          channel,
          uuid: characteristicUuid,
          byteLength,
          responseMode,
          disconnectedBeforeWrite,
        },
      },
    );
    try {
      this.assertConnected();
      const characteristic = this.getCharacteristic(channel);
      const withoutResponse =
        characteristic.properties.includes("writeWithoutResponse") &&
        !characteristic.properties.includes("write");
      responseMode = withoutResponse
        ? "without_response"
        : characteristic.properties.includes("write")
          ? "with_response"
          : "unsupported";
      if (
        !characteristic.properties.includes("write") &&
        !characteristic.properties.includes("writeWithoutResponse")
      ) {
        throw new Error(
          `BLE ${channel} characteristic does not support writes`,
        );
      }
      await characteristic.writeAsync(Buffer.from(data), withoutResponse);
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.write",
        "completed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          fields: {
            channel,
            uuid: characteristicUuid,
            byteLength,
            responseMode,
            withoutResponse,
            disconnectedBeforeWrite,
          },
        },
      );
    } catch (error) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.write",
        "failed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          error,
          fields: {
            channel,
            uuid: characteristicUuid,
            byteLength,
            responseMode,
            disconnectedBeforeWrite,
            alreadyDisconnected:
              this.disconnected || this.peripheral.state !== "connected",
          },
        },
      );
      throw error;
    }
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
    const startedAt = bluetoothDiagnosticNow();
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "transport.disconnect",
      "started",
    );
    if (this.disconnected) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.disconnect",
        "completed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          fields: { alreadyDisconnected: true },
        },
      );
      return;
    }
    this.disconnected = true;
    this.peripheral.removeListener("disconnect", this.handleDisconnect);
    const subscriptions = [...this.notificationListeners.entries()];
    this.notificationListeners.clear();
    try {
      await Promise.all(
        subscriptions.map(async ([channel, onData]) => {
          const characteristic = this.getCharacteristic(channel);
          characteristic.removeListener("data", onData);
          if (this.passiveNotificationChannels.delete(channel)) {
            return;
          }
          try {
            await characteristic.unsubscribeAsync();
          } catch (error) {
            logBluetoothDiagnostic(
              this.diagnosticLogger,
              "transport.notification_teardown",
              "failed",
              { error, fields: { channel } },
            );
            // A disconnect may already have removed the remote subscription.
          }
        }),
      );
      if (this.peripheral.state === "connected") {
        await this.peripheral.disconnectAsync();
      }
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.disconnect",
        "completed",
        { durationMs: bluetoothDiagnosticNow() - startedAt },
      );
    } catch (error) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.disconnect",
        "failed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          error,
        },
      );
      throw error;
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

  private readonly handleDisconnect = (reason: DisconnectReason): void => {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "transport.disconnect",
      "observed",
      {
        durationMs: bluetoothDiagnosticNow() - this.connectedAt,
        fields: {
          source: "peripheral_event",
          status: reason,
          ...(typeof reason === "number"
            ? {
                statusDescription: hciStatusMessage(reason).replace(
                  /[^A-Za-z0-9_.-]+/g,
                  "_",
                ),
              }
            : {}),
        },
      },
    );
    for (const [channel, onData] of this.notificationListeners) {
      this.getCharacteristic(channel).removeListener("data", onData);
    }
    this.notificationListeners.clear();
    this.passiveNotificationChannels.clear();
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
  private readonly closeCancellations = new Set<() => void>();
  private readonly closeController = new AbortController();

  /**
   * Creates a scanner using the selected Noble binding.
   *
   * @param noble Initialized Noble instance.
   * @param binding Binding used to access the local adapter.
   * @param timers Adapter-owned timer API.
   * @param diagnosticLogger Optional logger for sanitized BLE phase diagnostics.
   * @param bluezBusFactory Creates the bus used for BlueZ pairing.
   */
  constructor(
    private readonly noble: Noble,
    private readonly binding: NobleBinding,
    private readonly timers: BluetoothTimerApi,
    private readonly diagnosticLogger?: BluetoothDiagnosticLogger,
    private readonly bluezBusFactory: () => MessageBus = systemBus,
  ) {}

  /** Returns the Noble binding selected for this scanner. */
  getBinding(): NobleBinding {
    return this.binding;
  }

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
    validateTimeoutMs(timeoutMs, "BLE discovery timeout");
    if (this.discoveryInFlight) {
      throw new Error("BLE discovery is already in progress");
    }

    this.discoveryInFlight = true;
    const discoveryStartedAt = bluetoothDiagnosticNow();
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "transport.discovery",
      "started",
      { fields: { timeoutMs } },
    );
    const deadline = Date.now() + timeoutMs;
    let scanDelayTimer: ioBroker.Timeout | undefined;
    const discoveryCancellation = new AbortController();
    this.cancelDiscovery = () => {
      if (scanDelayTimer) {
        this.timers.clearTimeout(scanDelayTimer);
      }
      discoveryCancellation.abort();
    };
    let onDiscover: ((peripheral: Peripheral) => void) | undefined;
    let discoveredCount = 0;
    let discoverySucceeded = false;
    try {
      const readinessStartedAt = bluetoothDiagnosticNow();
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.adapter_readiness",
        "started",
        { fields: { adapterState: this.noble.state } },
      );
      try {
        await waitForAdapterPoweredOn(
          this.noble,
          Math.max(0, deadline - Date.now()),
          discoveryCancellation.signal,
          this.timers,
        );
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.adapter_readiness",
          "completed",
          {
            durationMs: bluetoothDiagnosticNow() - readinessStartedAt,
            fields: { adapterState: this.noble.state },
          },
        );
      } catch (error) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.adapter_readiness",
          "failed",
          {
            durationMs: bluetoothDiagnosticNow() - readinessStartedAt,
            error,
            fields: { adapterState: this.noble.state },
          },
        );
        throw error;
      }
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
        const matchesManufacturer = hasEaseeManufacturerId(peripheral);
        options?.onAdvertisement?.({
          ...(name ? { name } : {}),
          serviceUuids,
          ...(connectable === undefined ? {} : { connectable }),
          easeeManufacturerMatch: matchesManufacturer,
        });
        const matchesService = hasService(peripheral, serviceUuid);
        const matchesFallbackName =
          options?.fallbackLocalName !== undefined &&
          name === options.fallbackLocalName;
        const matchesManualSignature =
          options?.scanWithoutServiceFilter === true && matchesManufacturer;
        if (
          !matchesService &&
          !matchesFallbackName &&
          !matchesManualSignature
        ) {
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
      const scanStartStartedAt = bluetoothDiagnosticNow();
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.scan_start",
        "started",
      );
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
          this.timers,
          discoveryCancellation.signal,
          "BLE discovery cancelled",
        );
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.scan_start",
          "completed",
          { durationMs: bluetoothDiagnosticNow() - scanStartStartedAt },
        );
      } catch (error) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.scan_start",
          "failed",
          {
            durationMs: bluetoothDiagnosticNow() - scanStartStartedAt,
            error,
          },
        );
        void startScanning.then(
          () => this.noble.stopScanningAsync().catch(() => undefined),
          () => undefined,
        );
        throw error;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await raceWithAbortSignal(
          new Promise<void>((resolve) => {
            scanDelayTimer = this.timers.setTimeout(resolve, remainingMs);
          }),
          discoveryCancellation.signal,
          () => new Error("BLE discovery cancelled"),
        );
      }
      const results = [...discovered.values()];
      discoveredCount = results.length;
      discoverySucceeded = true;
      return results;
    } catch (error) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.discovery",
        "failed",
        {
          durationMs: bluetoothDiagnosticNow() - discoveryStartedAt,
          error,
        },
      );
      throw error;
    } finally {
      if (scanDelayTimer) {
        this.timers.clearTimeout(scanDelayTimer);
      }
      if (onDiscover) {
        this.noble.removeListener("discover", onDiscover);
      }
      if (this.scanning) {
        this.scanning = false;
        const scanStopStartedAt = bluetoothDiagnosticNow();
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.scan_stop",
          "started",
        );
        try {
          await this.noble.stopScanningAsync();
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "transport.scan_stop",
            "completed",
            { durationMs: bluetoothDiagnosticNow() - scanStopStartedAt },
          );
        } catch (error) {
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "transport.scan_stop",
            "failed",
            {
              durationMs: bluetoothDiagnosticNow() - scanStopStartedAt,
              error,
            },
          );
        }
      }
      if (discoverySucceeded) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.discovery",
          "completed",
          {
            durationMs: bluetoothDiagnosticNow() - discoveryStartedAt,
            fields: { candidates: discoveredCount },
          },
        );
      }
      this.discoveryInFlight = false;
      this.cancelDiscovery = undefined;
    }
  }

  async connect(candidate: BluetoothCandidate): Promise<BluetoothLink> {
    const connectStartedAt = bluetoothDiagnosticNow();
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "transport.connect",
      "started",
    );
    try {
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
        const linkConnectStartedAt = bluetoothDiagnosticNow();
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.link_connect",
          "started",
        );
        try {
          const connecting = peripheral.connectAsync();
          void connecting.then(
            () => {
              if (this.closed && isPeripheralConnected(peripheral)) {
                void Promise.resolve()
                  .then(() => peripheral.disconnectAsync())
                  .catch(() => undefined);
              }
            },
            () => undefined,
          );
          await withScannerClose(connecting, this.closeController.signal);
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "transport.link_connect",
            "completed",
            {
              durationMs: bluetoothDiagnosticNow() - linkConnectStartedAt,
            },
          );
        } catch (error) {
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "transport.link_connect",
            "failed",
            {
              durationMs: bluetoothDiagnosticNow() - linkConnectStartedAt,
              error,
            },
          );
          throw error;
        }
      } else {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.link_connect",
          "reused",
        );
      }

      const gattDiscoveryStartedAt = bluetoothDiagnosticNow();
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "gatt.discovery",
        "started",
      );
      let characteristics: ReadonlyMap<BluetoothChannel, Characteristic>;
      try {
        characteristics = await resolveCharacteristics(
          peripheral,
          this.timers,
          this.diagnosticLogger,
          this.binding === "hci",
          this.closeController.signal,
          (cancel) => this.registerCloseCancellation(cancel),
        );
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "gatt.discovery",
          "completed",
          {
            durationMs: bluetoothDiagnosticNow() - gattDiscoveryStartedAt,
            fields: { characteristics: characteristics.size },
          },
        );
      } catch (error) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "gatt.discovery",
          "failed",
          {
            durationMs: bluetoothDiagnosticNow() - gattDiscoveryStartedAt,
            error,
          },
        );
        if (peripheral.state === "connected") {
          const cleanupStartedAt = bluetoothDiagnosticNow();
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "transport.disconnect",
            "cleanup_started",
          );
          const disconnecting = Promise.resolve().then(() =>
            peripheral.disconnectAsync(),
          );
          try {
            await withScannerClose(disconnecting, this.closeController.signal);
            logBluetoothDiagnostic(
              this.diagnosticLogger,
              "transport.disconnect",
              "cleanup_completed",
              {
                durationMs: bluetoothDiagnosticNow() - cleanupStartedAt,
              },
            );
          } catch (disconnectError) {
            if (this.closed) {
              void disconnecting.catch(() => undefined);
            } else {
              logBluetoothDiagnostic(
                this.diagnosticLogger,
                "transport.disconnect",
                "cleanup_failed",
                {
                  durationMs: bluetoothDiagnosticNow() - cleanupStartedAt,
                  error: disconnectError,
                },
              );
            }
          }
        }
        throw error;
      }
      const pairDevice =
        this.binding === "dbus"
          ? async () => {
              const pairingStartedAt = bluetoothDiagnosticNow();
              logBluetoothDiagnostic(
                this.diagnosticLogger,
                "transport.pairing",
                "started",
              );
              try {
                await pairBluezDevice(
                  peripheral.address,
                  this.timers,
                  BLUEZ_PAIR_TIMEOUT_MS,
                  this.bluezBusFactory,
                  this.closeController.signal,
                );
                logBluetoothDiagnostic(
                  this.diagnosticLogger,
                  "transport.pairing",
                  "completed",
                  {
                    durationMs: bluetoothDiagnosticNow() - pairingStartedAt,
                  },
                );
              } catch (error) {
                logBluetoothDiagnostic(
                  this.diagnosticLogger,
                  "transport.pairing",
                  "failed",
                  {
                    durationMs: bluetoothDiagnosticNow() - pairingStartedAt,
                    error,
                  },
                );
                throw error;
              }
            }
          : undefined;
      const allowCoreBluetoothCccdFallback =
        this.binding === "mac" ||
        (this.binding === "default" && process.platform === "darwin");
      const link = new NobleBluetoothLink(
        peripheral,
        characteristics,
        pairDevice,
        allowCoreBluetoothCccdFallback,
        this.binding === "hci",
        this.diagnosticLogger,
      );
      this.activeLinks.add(link);
      link.onDisconnect(() => this.activeLinks.delete(link));
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.connect",
        "completed",
        { durationMs: bluetoothDiagnosticNow() - connectStartedAt },
      );
      return link;
    } catch (error) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.connect",
        "failed",
        {
          durationMs: bluetoothDiagnosticNow() - connectStartedAt,
          error,
        },
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    const startedAt = bluetoothDiagnosticNow();
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "transport.scanner_close",
      "started",
    );
    if (this.closed) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.scanner_close",
        "completed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          fields: { alreadyClosed: true },
        },
      );
      return;
    }
    this.closed = true;
    for (const cancel of [...this.closeCancellations]) {
      cancel();
    }
    this.closeController.abort();
    const closeOperation = (async (): Promise<void> => {
      this.cancelDiscovery?.();
      if (this.scanning) {
        this.scanning = false;
        try {
          await this.noble.stopScanningAsync();
        } catch (error) {
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "transport.scan_stop",
            "failed",
            { error },
          );
        }
      }
      await Promise.all(
        [...this.activeLinks].map((link) =>
          link.disconnect().catch(() => undefined),
        ),
      );
      this.activeLinks.clear();
      this.peripherals.clear();
      this.noble.stop();
    })();
    try {
      await withBluetoothTeardownTimeout(
        closeOperation,
        "Noble Bluetooth scanner close",
      );
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.scanner_close",
        "completed",
        { durationMs: bluetoothDiagnosticNow() - startedAt },
      );
    } catch (error) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "transport.scanner_close",
        "failed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          error,
        },
      );
      for (const link of [...this.activeLinks]) {
        void Promise.resolve()
          .then(() => link.disconnect())
          .catch((disconnectError: unknown) =>
            logBluetoothDiagnostic(
              this.diagnosticLogger,
              "transport.disconnect",
              "failed",
              { error: disconnectError },
            ),
          );
      }
      this.activeLinks.clear();
      this.peripherals.clear();
      try {
        this.noble.stop();
      } catch (stopError) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "transport.scanner_stop",
          "failed",
          { error: stopError },
        );
      }
      throw error instanceof Error
        ? error
        : new Error("Noble Bluetooth scanner close failed");
    }
  }

  private registerCloseCancellation(cancel: () => void): () => void {
    if (this.closed) {
      cancel();
      return () => undefined;
    }
    this.closeCancellations.add(cancel);
    return () => this.closeCancellations.delete(cancel);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("BLE scanner is closed");
    }
  }
}

/**
 * Creates a Noble scanner and binds optional phase diagnostics to the adapter logger.
 *
 * @param factory Lazy Noble factory.
 * @param configuredBinding Optional adapter-selected binding.
 * @param diagnosticLogger Optional logger for sanitized BLE phase diagnostics.
 * @param timers Adapter-owned timer API.
 */
export async function createNobleBluetoothScanner(
  factory: NobleFactory | undefined,
  configuredBinding: string | undefined,
  diagnosticLogger: BluetoothDiagnosticLogger | undefined,
  timers: BluetoothTimerApi,
): Promise<NobleBluetoothScanner> {
  const selectedFactory = factory ?? loadDefaultNoble;
  const selectedBinding = resolveNobleBinding(
    process.platform,
    configuredBinding,
  );
  const automaticHciFallback =
    selectedFactory === loadDefaultNoble &&
    selectedBinding === "dbus" &&
    !canNobleResolveDbusDependency() &&
    canNobleResolveHciDependency();
  const binding = resolveNobleBinding(
    process.platform,
    configuredBinding,
    automaticHciFallback,
  );
  if (automaticHciFallback && binding === "hci") {
    diagnosticLogger?.debug(
      'Noble D-Bus binding cannot resolve "dbus-next"; Automatic is falling back to Raw HCI.',
    );
  }
  return new NobleBluetoothScanner(
    await selectedFactory(binding),
    binding,
    timers,
    diagnosticLogger,
  );
}
