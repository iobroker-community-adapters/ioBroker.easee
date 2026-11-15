"use strict";

export {};

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { expect } from "chai";
import sinon from "sinon";
import { describe, it } from "mocha";
import type { Noble } from "@stoprocent/noble";
import type { MessageBus } from "dbus-next";
import {
  BLUETOOTH_CHARACTERISTICS,
  BLUETOOTH_SERVICE_UUID,
} from "../src/lib/bluetooth-protocol.ts";
import type { BluetoothChannel } from "../src/lib/bluetooth-protocol.ts";
import type { BluetoothDiagnosticLogger } from "../src/lib/bluetooth-diagnostics.ts";
import { BLUETOOTH_TEARDOWN_TIMEOUT_MS } from "../src/lib/bluetooth-transport.ts";
import type { BluetoothTimerApi } from "../src/lib/bluetooth-transport.ts";
import {
  createNobleBluetoothScanner,
  ensureNobleDbusDependency,
  NobleBluetoothScanner as AdapterNobleBluetoothScanner,
  pairBluezDevice,
  resolveNobleBinding,
} from "../src/lib/noble-bluetooth-transport.ts";
import { MAX_NODE_TIMEOUT_MS } from "../src/lib/timeout.ts";

const testTimers: BluetoothTimerApi = {
  setTimeout: (callback, timeoutMs) =>
    setTimeout(callback, timeoutMs) as unknown as ioBroker.Timeout,
  clearTimeout: (timer) => {
    if (timer) {
      clearTimeout(timer);
    }
  },
};

class NobleBluetoothScanner extends AdapterNobleBluetoothScanner {
  constructor(
    noble: Noble,
    binding: "hci" | "dbus" | "mac" = "hci",
    diagnosticLogger?: BluetoothDiagnosticLogger,
    timers: BluetoothTimerApi = testTimers,
  ) {
    super(noble, binding, timers, diagnosticLogger);
  }
}

async function expectRejectedWithMessage(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected rejection containing "${message}"`);
}

class FakeCharacteristic extends EventEmitter {
  readonly writes: { data: Buffer; withoutResponse: boolean }[] = [];
  subscriptions = 0;
  unsubscriptions = 0;
  descriptorDiscoveries = 0;
  descriptorUuids = ["2902"];
  failSubscribe = false;
  subscribeError?: Error;
  unsubscribePromise?: Promise<void>;
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;

  constructor(
    readonly uuid: string,
    readonly properties: string[] = ["notify", "write"],
  ) {
    super();
  }

  subscribeAsync(): Promise<void> {
    this.subscriptions++;
    this.onSubscribe?.();
    if (this.subscribeError) {
      return Promise.reject(this.subscribeError);
    }
    if (this.failSubscribe) {
      return Promise.reject(new Error("subscribe refused"));
    }
    return Promise.resolve();
  }

  unsubscribeAsync(): Promise<void> {
    this.unsubscriptions++;
    this.onUnsubscribe?.();
    return this.unsubscribePromise ?? Promise.resolve();
  }

  discoverDescriptorsAsync(): Promise<{ uuid: string }[]> {
    this.descriptorDiscoveries++;
    return Promise.resolve(this.descriptorUuids.map((uuid) => ({ uuid })));
  }

  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void> {
    this.writes.push({ data, withoutResponse });
    return Promise.resolve();
  }
}

class FakeService extends EventEmitter {
  requestedCharacteristics: string[] = [];
  discoveryCalls = 0;
  discoveryResults: FakeCharacteristic[][] = [];
  characteristics: FakeCharacteristic[];

  constructor(
    readonly uuid: string,
    characteristics: FakeCharacteristic[],
  ) {
    super();
    this.characteristics = characteristics;
  }

  discoverCharacteristicsAsync(uuids: string[]): Promise<FakeCharacteristic[]> {
    this.discoveryCalls++;
    this.requestedCharacteristics = uuids;
    const characteristics =
      this.discoveryResults.shift() ?? this.characteristics;
    return Promise.resolve(
      characteristics.filter((characteristic) =>
        uuids.includes(characteristic.uuid.toLowerCase().replace(/-/g, "")),
      ),
    );
  }
}

class FakePeripheral extends EventEmitter {
  readonly address = "58:BF:25:22:05:3A";
  state: "connecting" | "connected" | "disconnecting" | "disconnected" =
    "disconnected";
  connectable = true;
  connectCount = 0;
  cancelConnectCount = 0;
  disconnectCount = 0;
  onCancelConnect?: () => void;
  nativeDisconnectFailure?: Error;
  nativeDisconnectThrows = false;
  onNativeDisconnect?: () => void;
  requestedServices: string[] = [];
  services: FakeService[];

  constructor(
    readonly id: string,
    readonly advertisement: {
      localName: string;
      serviceUuids: string[];
      manufacturerData?: Buffer;
    },
    services: FakeService[],
  ) {
    super();
    this.services = services;
  }

  connectAsync(): Promise<void> {
    this.connectCount++;
    this.state = "connected";
    return Promise.resolve();
  }

  cancelConnect(): void {
    if (this.state !== "connecting") {
      return;
    }
    this.cancelConnectCount++;
    this.emit("connect", new Error("connection canceled!"));
    this.state = "disconnected";
    this.onCancelConnect?.();
  }

  disconnectAsync(): Promise<void> {
    this.disconnectCount++;
    this.onNativeDisconnect?.();
    if (this.nativeDisconnectThrows) {
      throw (
        this.nativeDisconnectFailure ?? new Error("Native disconnect failed")
      );
    }
    if (this.nativeDisconnectFailure) {
      return Promise.reject(this.nativeDisconnectFailure);
    }
    this.state = "disconnected";
    this.emit("disconnect", 0);
    return Promise.resolve();
  }

  discoverServicesAsync(uuids: string[]): Promise<FakeService[]> {
    this.requestedServices = uuids;
    return Promise.resolve(
      this.services.filter((service) =>
        uuids.includes(service.uuid.toLowerCase().replace(/-/g, "")),
      ),
    );
  }
}

type FakeDbusDeviceProxy = {
  getInterface(name: string): { Connect: () => Promise<void> };
};

class FakeNoble extends EventEmitter {
  state: "poweredOn" | "poweredOff" = "poweredOn";
  waitTimeouts: number[] = [];
  scanFilters: string[][] = [];
  allowDuplicates: boolean[] = [];
  scanning = false;
  stopped = 0;
  onStop?: () => void;
  stopScanningCount = 0;
  stopScanningNeverResolves = false;
  stopScanningPromise?: Promise<void>;
  startScanDelayMs = 0;
  onScanStart?: () => void;
  onScanStop?: () => void;
  discoverOnScan: FakePeripheral[] = [];
  peripherals = new Map<string, FakePeripheral>();
  readonly _devices = new Map<string, { proxy?: FakeDbusDeviceProxy }>();
  onDeviceProxy?: (id: string) => Promise<FakeDbusDeviceProxy>;
  onBeforeNativeConnect?: (id: string) => Promise<void>;
  onNativeConnect?: (id: string) => Promise<void>;
  onNativeDisconnect?: (id: string) => Promise<void>;
  readonly _bindings = {
    _devices: this._devices,
    _ensureDeviceProxy: (
      id: string,
    ): Promise<{ proxy?: FakeDbusDeviceProxy }> => {
      let device = this._devices.get(id);
      if (!device) {
        device = {};
        this._devices.set(id, device);
      }
      if (device.proxy) {
        return Promise.resolve(device);
      }
      return (
        this.onDeviceProxy?.(id) ?? Promise.resolve(this.createDeviceProxy(id))
      ).then((proxy) => {
        device.proxy = proxy;
        return device;
      });
    },
    _connect: async (id: string): Promise<void> => {
      const device = await this._bindings._ensureDeviceProxy(id);
      await this.onBeforeNativeConnect?.(id);
      await device.proxy?.getInterface("org.bluez.Device1").Connect();
    },
    _disconnect: (id: string): Promise<void> => {
      if (!this._devices.get(id)?.proxy) {
        return Promise.resolve();
      }
      return this.onNativeDisconnect?.(id) ?? Promise.resolve();
    },
  };

  createDeviceProxy(id: string): FakeDbusDeviceProxy {
    const deviceInterface = {
      Connect: () => this.onNativeConnect?.(id) ?? Promise.resolve(),
    };
    return {
      getInterface: (_name) => deviceInterface,
    };
  }

  waitForPoweredOnAsync(timeout?: number): Promise<void> {
    if (timeout !== undefined) {
      this.waitTimeouts.push(timeout);
    }
    if (this.state !== "poweredOn") {
      return Promise.reject(new Error("Adapter is not powered on"));
    }
    return Promise.resolve();
  }

  async startScanningAsync(
    uuids: string[] = [],
    allowDuplicates = false,
  ): Promise<void> {
    this.scanFilters.push(uuids);
    this.allowDuplicates.push(allowDuplicates);
    if (this.startScanDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.startScanDelayMs),
      );
    }
    this.scanning = true;
    this.onScanStart?.();
    for (const peripheral of this.discoverOnScan) {
      setImmediate(() => this.emit("discover", peripheral));
    }
  }

  stopScanningAsync(): Promise<void> {
    this.stopScanningCount++;
    this.scanning = false;
    this.onScanStop?.();
    return this.stopScanningNeverResolves
      ? (this.stopScanningPromise ?? new Promise<void>(() => undefined))
      : Promise.resolve();
  }

  async connectAsync(id: string): Promise<FakePeripheral> {
    const peripheral = this.peripherals.get(id);
    if (!peripheral) {
      throw new Error("Peripheral missing");
    }
    await peripheral.connectAsync();
    return peripheral;
  }

  stop(): void {
    this.stopped++;
    this.onStop?.();
  }
}

function makePeripheral(
  options: {
    readonly id?: string;
    readonly serviceUuids?: string[];
    readonly serviceUuid?: string;
    readonly connectable?: boolean;
    readonly manufacturerData?: Buffer;
    readonly characteristicUuids?: string[];
  } = {},
): {
  readonly peripheral: FakePeripheral;
  readonly service: FakeService;
  readonly characteristics: FakeCharacteristic[];
} {
  const characteristicUuids =
    options.characteristicUuids ?? Object.values(BLUETOOTH_CHARACTERISTICS);
  const characteristics = characteristicUuids.map(
    (uuid) => new FakeCharacteristic(uuid),
  );
  const service = new FakeService(
    options.serviceUuid ?? BLUETOOTH_SERVICE_UUID,
    characteristics,
  );
  const peripheral = new FakePeripheral(
    options.id ?? "charger-id",
    {
      localName: "Easee charger",
      serviceUuids: options.serviceUuids ?? [
        BLUETOOTH_SERVICE_UUID.replace(/-/g, ""),
      ],
      ...(options.manufacturerData
        ? { manufacturerData: options.manufacturerData }
        : {}),
    },
    [service],
  );
  peripheral.connectable = options.connectable ?? true;
  return { peripheral, service, characteristics };
}

function scanner(
  noble: FakeNoble,
  binding: "hci" | "dbus" | "mac" = "hci",
  diagnosticLogger?: BluetoothDiagnosticLogger,
  timers: BluetoothTimerApi = testTimers,
): NobleBluetoothScanner {
  return new NobleBluetoothScanner(
    noble as unknown as Noble,
    binding,
    diagnosticLogger,
    timers,
  );
}

function fakeBluezBus(
  pair: () => Promise<void>,
  counters: { pairCalls: number; disconnects: number },
): MessageBus {
  const devicePath = "/org/bluez/hci0/dev_58_BF_25_22_05_3A";
  const bus = {
    on: () => bus,
    getProxyObject: (_service: string, path: string) =>
      Promise.resolve(
        path === "/"
          ? {
              getInterface: () => ({
                GetManagedObjects: () =>
                  Promise.resolve({
                    [devicePath]: {
                      "org.bluez.Device1": {
                        Address: { value: "58:BF:25:22:05:3A" },
                      },
                    },
                  }),
              }),
            }
          : {
              getInterface: () => ({
                Pair: () => {
                  counters.pairCalls++;
                  return pair();
                },
              }),
            },
      ),
    disconnect: () => counters.disconnects++,
  };
  return bus as unknown as MessageBus;
}

describe("BlueZ pairing", () => {
  it("rejects invalid or over-limit timeouts before opening D-Bus", async () => {
    let busFactoryCalls = 0;
    for (const timeoutMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_NODE_TIMEOUT_MS + 1,
    ]) {
      await expectRejectedWithMessage(
        pairBluezDevice("58:BF:25:22:05:3A", testTimers, timeoutMs, () => {
          busFactoryCalls++;
          return fakeBluezBus(() => Promise.resolve(), {
            pairCalls: 0,
            disconnects: 0,
          });
        }),
        "BlueZ pairing timeout",
      );
    }
    expect(busFactoryCalls).to.equal(0);
  });

  it("pairs the matching BlueZ Device1 object once", async () => {
    const counters = { pairCalls: 0, disconnects: 0 };
    const busFactory = (): MessageBus =>
      fakeBluezBus(() => Promise.resolve(), counters);
    await pairBluezDevice("58:BF:25:22:05:3A", testTimers, 100, busFactory);

    expect(counters).to.deep.equal({ pairCalls: 1, disconnects: 1 });
  });

  it("does not open D-Bus when pairing is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let busFactoryCalls = 0;

    await expectRejectedWithMessage(
      pairBluezDevice(
        "58:BF:25:22:05:3A",
        testTimers,
        100,
        () => {
          busFactoryCalls++;
          return fakeBluezBus(() => Promise.resolve(), {
            pairCalls: 0,
            disconnects: 0,
          });
        },
        controller.signal,
      ),
      "BLE scanner is closed",
    );

    expect(busFactoryCalls).to.equal(0);
  });

  it("does not call Pair if cancellation wins while the device proxy resolves", async () => {
    const controller = new AbortController();
    const devicePath = "/org/bluez/hci0/dev_58_BF_25_22_05_3A";
    let notifyDeviceProxyRequested!: () => void;
    const deviceProxyRequested = new Promise<void>((resolve) => {
      notifyDeviceProxyRequested = resolve;
    });
    let resolveDeviceProxy!: (deviceObject: {
      getInterface: () => { Pair: () => Promise<void> };
    }) => void;
    const deviceProxy = new Promise<{
      getInterface: () => { Pair: () => Promise<void> };
    }>((resolve) => {
      resolveDeviceProxy = resolve;
    });
    let pairCalls = 0;
    let disconnects = 0;
    const bus = {
      on: () => undefined,
      getProxyObject: (_service: string, path: string) =>
        path === "/"
          ? Promise.resolve({
              getInterface: () => ({
                GetManagedObjects: () =>
                  Promise.resolve({
                    [devicePath]: {
                      "org.bluez.Device1": {
                        Address: { value: "58:BF:25:22:05:3A" },
                      },
                    },
                  }),
              }),
            })
          : (notifyDeviceProxyRequested(), deviceProxy),
      disconnect: () => disconnects++,
    } as unknown as MessageBus;

    const pairing = pairBluezDevice(
      "58:BF:25:22:05:3A",
      testTimers,
      100,
      () => bus,
      controller.signal,
    );
    await deviceProxyRequested;
    resolveDeviceProxy({
      getInterface: () => ({
        Pair: () => {
          pairCalls++;
          return Promise.resolve();
        },
      }),
    });
    controller.abort();

    await expectRejectedWithMessage(pairing, "BLE scanner is closed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pairCalls).to.equal(0);
    expect(disconnects).to.equal(1);
  });

  it("surfaces Device1.Pair failures", async () => {
    const counters = { pairCalls: 0, disconnects: 0 };
    const busFactory = (): MessageBus =>
      fakeBluezBus(
        () => Promise.reject(new Error("AuthenticationCanceled")),
        counters,
      );
    const pairing = pairBluezDevice(
      "58:BF:25:22:05:3A",
      testTimers,
      100,
      busFactory,
    );
    await expectRejectedWithMessage(
      pairing,
      "BlueZ pairing failed: AuthenticationCanceled",
    );
    expect(counters).to.deep.equal({ pairCalls: 1, disconnects: 1 });
  });

  it("times out a stalled Device1.Pair call and closes the D-Bus bus", async () => {
    const counters = { pairCalls: 0, disconnects: 0 };
    const busFactory = (): MessageBus =>
      fakeBluezBus(() => new Promise(() => undefined), counters);
    const pairing = pairBluezDevice(
      "58:BF:25:22:05:3A",
      testTimers,
      5,
      busFactory,
    );
    await expectRejectedWithMessage(
      pairing,
      "BlueZ pairing timed out after 5 ms",
    );
    expect(counters).to.deep.equal({ pairCalls: 1, disconnects: 1 });
  });

  it("cancels a pending Device1.Pair on scanner close and disconnects its bus", async () => {
    const counters = { pairCalls: 0, disconnects: 0 };
    const pairingTimers = new Set<ioBroker.Timeout>();
    let scheduledPairingTimers = 0;
    let clearedPairingTimers = 0;
    const timers: BluetoothTimerApi = {
      setTimeout: (callback, timeoutMs) => {
        const timer = setTimeout(
          callback,
          timeoutMs,
        ) as unknown as ioBroker.Timeout;
        if (timeoutMs === 30_000) {
          pairingTimers.add(timer);
          scheduledPairingTimers++;
        }
        return timer;
      },
      clearTimeout: (timer) => {
        if (timer && pairingTimers.delete(timer)) {
          clearedPairingTimers++;
        }
        if (timer) {
          clearTimeout(timer);
        }
      },
    };
    let resolvePairStarted!: () => void;
    const pairStarted = new Promise<void>((resolve) => {
      resolvePairStarted = resolve;
    });
    const busFactory = (): MessageBus =>
      fakeBluezBus(() => {
        resolvePairStarted();
        return new Promise<void>(() => undefined);
      }, counters);
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = new AdapterNobleBluetoothScanner(
      noble as unknown as Noble,
      "dbus",
      timers,
      undefined,
      busFactory,
    );
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    const pair = link.pair;
    if (!pair) {
      throw new Error("Expected BlueZ pairing support");
    }
    const pairing = pair.call(link);
    await pairStarted;

    await transport.close();
    await expectRejectedWithMessage(pairing, "BLE scanner is closed");

    expect(counters).to.deep.equal({ pairCalls: 1, disconnects: 1 });
    expect(scheduledPairingTimers).to.equal(1);
    expect(clearedPairingTimers).to.equal(scheduledPairingTimers);
    expect(pairingTimers.size).to.equal(0);
  });
});

describe("Noble Bluetooth transport", () => {
  it("rejects invalid discovery timeouts before starting a scan", async () => {
    const noble = new FakeNoble();
    const transport = scanner(noble);
    for (const timeoutMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_NODE_TIMEOUT_MS + 1,
    ]) {
      await expectRejectedWithMessage(
        transport.discover(BLUETOOTH_SERVICE_UUID, timeoutMs),
        "BLE discovery timeout",
      );
    }
    expect(noble.scanFilters).to.deep.equal([]);
    await transport.close();
  });

  it("uses and clears the injected adapter timers during discovery", async () => {
    const noble = new FakeNoble();
    let scheduled = 0;
    let cleared = 0;
    const timers: BluetoothTimerApi = {
      setTimeout: (callback, timeoutMs) => {
        scheduled++;
        return testTimers.setTimeout(callback, timeoutMs);
      },
      clearTimeout: (timer) => {
        cleared++;
        testTimers.clearTimeout(timer);
      },
    };
    const transport = new AdapterNobleBluetoothScanner(
      noble as unknown as Noble,
      "hci",
      timers,
    );

    await transport.discover(BLUETOOTH_SERVICE_UUID, 10);
    await transport.close();

    expect(scheduled).to.be.greaterThan(0);
    expect(cleared).to.equal(scheduled);
  });

  it("selects concrete platform defaults and preserves explicit binding precedence", () => {
    expect(resolveNobleBinding("linux")).to.equal("dbus");
    expect(resolveNobleBinding("linux", "hci")).to.equal("hci");
    expect(resolveNobleBinding("linux", "dbus")).to.equal("dbus");
    expect(resolveNobleBinding("linux", "default")).to.equal("dbus");
    expect(resolveNobleBinding("linux", "auto")).to.equal("dbus");
    expect(resolveNobleBinding("linux", "auto", true)).to.equal("hci");
    expect(resolveNobleBinding("linux", "auto", false)).to.equal("dbus");
    expect(resolveNobleBinding("linux", "dbus", true)).to.equal("dbus");
    expect(resolveNobleBinding("darwin")).to.equal("mac");
    expect(resolveNobleBinding("darwin", "auto")).to.equal("mac");
    expect(resolveNobleBinding("darwin", "win")).to.equal("win");
    expect(resolveNobleBinding("win32")).to.equal("win");
    expect(resolveNobleBinding("win32", "auto")).to.equal("win");
    expect(resolveNobleBinding("win32", "mac")).to.equal("mac");
    expect(resolveNobleBinding("freebsd")).to.equal("hci");
    expect(resolveNobleBinding("freebsd", "dbus")).to.equal("dbus");
    expect(scanner(new FakeNoble(), "hci").getBinding()).to.equal("hci");
  });

  it("does not evaluate Noble's root entry while loading transport helpers", () => {
    const nobleRootPath =
      createRequire(__filename).resolve("@stoprocent/noble");
    expect(require.cache[nobleRootPath]).to.equal(undefined);
  });

  it("reports when Noble cannot resolve its optional D-Bus dependency", () => {
    expect(() =>
      ensureNobleDbusDependency(() => {
        throw new Error("MODULE_NOT_FOUND");
      }),
    ).to.throw('The Noble D-Bus binding cannot resolve "dbus-next"');
    expect(() =>
      ensureNobleDbusDependency(() => "/node_modules/dbus-next"),
    ).not.to.throw();
  });

  it("loads Noble lazily through withBindings only when its factory is called", async () => {
    const noble = new FakeNoble();
    let factoryCalls = 0;
    const transport = await createNobleBluetoothScanner(
      () => {
        factoryCalls++;
        return Promise.resolve(noble as unknown as Noble);
      },
      undefined,
      undefined,
      testTimers,
    );
    expect(factoryCalls).to.equal(1);
    await transport.close();
    expect(noble.stopped).to.equal(1);
  });

  it("passes the selected binding to Noble and reports it on the scanner", async () => {
    const noble = new FakeNoble();
    let selectedBinding: string | undefined;
    const transport = await createNobleBluetoothScanner(
      (binding) => {
        selectedBinding = binding;
        return Promise.resolve(noble as unknown as Noble);
      },
      "hci",
      undefined,
      testTimers,
    );

    expect(selectedBinding).to.equal("hci");
    expect(transport.getBinding()).to.equal("hci");
    await transport.close();
  });

  it("performs finite UUID-filtered discovery and removes its event listener", async () => {
    const noble = new FakeNoble();
    const advertised = makePeripheral();
    const wrongService = makePeripheral({
      id: "other-device",
      serviceUuids: ["180f"],
    });
    noble.discoverOnScan = [advertised.peripheral, wrongService.peripheral];
    const transport = scanner(noble);

    const candidates = await transport.discover(BLUETOOTH_SERVICE_UUID, 10);

    expect(candidates).to.deep.equal([
      { id: "charger-id", name: "Easee charger", connectable: true },
    ]);
    expect(noble.scanFilters).to.deep.equal([
      [BLUETOOTH_SERVICE_UUID.replace(/-/g, "")],
    ]);
    expect(noble.allowDuplicates).to.deep.equal([false]);
    expect(noble.stopScanningCount).to.equal(1);
    expect(noble.listenerCount("discover")).to.equal(0);
    await transport.close();
  });

  it("scans without a controller-side filter and reports advertisements without addresses", async () => {
    const noble = new FakeNoble();
    const matching = makePeripheral();
    const unrelated = makePeripheral({
      id: "unrelated-device-address",
      serviceUuids: ["180f"],
    });
    unrelated.peripheral.advertisement.localName = "TEST0001";
    noble.discoverOnScan = [matching.peripheral, unrelated.peripheral];
    const transport = scanner(noble);
    const reports: {
      name?: string;
      serviceUuids: readonly string[];
      connectable?: boolean;
      easeeManufacturerMatch?: boolean;
    }[] = [];

    const candidates = await transport.discover(BLUETOOTH_SERVICE_UUID, 20, {
      scanWithoutServiceFilter: true,
      onAdvertisement: (report) => reports.push(report),
    });

    expect(noble.scanFilters).to.deep.equal([[]]);
    expect(noble.allowDuplicates).to.deep.equal([true]);
    expect(candidates).to.deep.equal([
      { id: "charger-id", name: "Easee charger", connectable: true },
    ]);
    expect(reports).to.deep.equal([
      {
        name: "Easee charger",
        serviceUuids: [BLUETOOTH_SERVICE_UUID.replace(/-/g, "")],
        connectable: true,
        easeeManufacturerMatch: false,
      },
      {
        name: "TEST0001",
        serviceUuids: ["180f"],
        connectable: true,
        easeeManufacturerMatch: false,
      },
    ]);
    expect(JSON.stringify(reports)).not.to.contain("unrelated-device-address");
    expect(noble.listenerCount("discover")).to.equal(0);
    expect(noble.stopScanningCount).to.equal(1);
    await transport.close();
  });

  it("matches Easee manufacturer data in unfiltered searches without exposing its payload", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral({
      id: "easee-manufacturer-device",
      serviceUuids: [],
      manufacturerData: Buffer.from([0x2e, 0x0c, 0xde, 0xad]),
    });
    fixture.peripheral.advertisement.localName = "TEST0001";
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble);
    const reports: {
      name?: string;
      serviceUuids: readonly string[];
      connectable?: boolean;
      easeeManufacturerMatch?: boolean;
    }[] = [];

    const candidates = await transport.discover(BLUETOOTH_SERVICE_UUID, 20, {
      scanWithoutServiceFilter: true,
      onAdvertisement: (report) => reports.push(report),
    });

    expect(candidates).to.deep.equal([
      {
        id: "easee-manufacturer-device",
        name: "TEST0001",
        connectable: true,
      },
    ]);
    expect(reports).to.deep.equal([
      {
        name: "TEST0001",
        serviceUuids: [],
        connectable: true,
        easeeManufacturerMatch: true,
      },
    ]);
    expect(JSON.stringify(reports)).not.to.contain("dead");
    await transport.close();

    const autoNoble = new FakeNoble();
    const otherName = makePeripheral({
      id: "easee-without-configured-name",
      serviceUuids: [],
      manufacturerData: Buffer.from([0x2e, 0x0c, 0xde, 0xad]),
    });
    otherName.peripheral.advertisement.localName = "OTHERDEVICE";
    autoNoble.discoverOnScan = [otherName.peripheral];
    const autoTransport = scanner(autoNoble);
    expect(
      await autoTransport.discover(BLUETOOTH_SERVICE_UUID, 20, {
        fallbackLocalName: "TEST0001",
      }),
    ).to.deep.equal([]);
    await autoTransport.close();
  });

  it("reports connectability as unknown for the BlueZ D-Bus binding", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral({
      id: "serial-peripheral",
      serviceUuids: [],
      connectable: false,
    });
    fixture.peripheral.advertisement.localName = "TEST0001";
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble, "dbus");
    const reports: {
      name?: string;
      serviceUuids: readonly string[];
      connectable?: boolean;
      easeeManufacturerMatch?: boolean;
    }[] = [];

    const candidates = await transport.discover(BLUETOOTH_SERVICE_UUID, 20, {
      fallbackLocalName: "TEST0001",
      onAdvertisement: (report) => reports.push(report),
    });

    expect(candidates).to.deep.equal([
      { id: "serial-peripheral", name: "TEST0001" },
    ]);
    expect(reports).to.deep.equal([
      {
        name: "TEST0001",
        serviceUuids: [],
        easeeManufacturerMatch: false,
      },
    ]);
    const link = await transport.connect(candidates[0]);
    expect(link.pair).to.be.a("function");
    await link.disconnect();
    expect(fixture.peripheral.connectCount).to.equal(1);
    await transport.close();
  });

  it("accepts only an exact configured serial name when the UUID is absent", async () => {
    const noble = new FakeNoble();
    const matching = makePeripheral({
      id: "serial-peripheral",
      serviceUuids: [],
    });
    matching.peripheral.advertisement.localName = "TEST0001";
    const similar = makePeripheral({
      id: "similar-peripheral",
      serviceUuids: [],
    });
    similar.peripheral.advertisement.localName = "TEST0001-2";
    noble.discoverOnScan = [matching.peripheral, similar.peripheral];
    const transport = scanner(noble);

    const candidates = await transport.discover(BLUETOOTH_SERVICE_UUID, 20, {
      fallbackLocalName: "TEST0001",
    });

    expect(noble.scanFilters).to.deep.equal([[]]);
    expect(noble.allowDuplicates).to.deep.equal([true]);
    expect(candidates).to.deep.equal([
      { id: "serial-peripheral", name: "TEST0001", connectable: true },
    ]);
    const link = await transport.connect(candidates[0]);
    await link.disconnect();
    expect(matching.peripheral.disconnectCount).to.equal(1);
    await transport.close();
  });

  it("does not attempt a matching advertisement that is not connectable", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral({
      id: "non-connectable-serial",
      serviceUuids: [],
      connectable: false,
    });
    fixture.peripheral.advertisement.localName = "TEST0001";
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble);

    const candidates = await transport.discover(BLUETOOTH_SERVICE_UUID, 20, {
      fallbackLocalName: "TEST0001",
    });

    expect(candidates).to.deep.equal([
      { id: "non-connectable-serial", name: "TEST0001", connectable: false },
    ]);
    await expectRejectedWithMessage(
      transport.connect(candidates[0]),
      "not currently connectable",
    );
    expect(fixture.peripheral.connectCount).to.equal(0);
    await transport.close();
  });

  it("rejects a name-matched candidate that lacks the Easee GATT service", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral({
      id: "serial-without-easee-service",
      serviceUuid: "180f",
      serviceUuids: [],
    });
    fixture.peripheral.advertisement.localName = "TEST0001";
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble);

    const candidates = await transport.discover(BLUETOOTH_SERVICE_UUID, 20, {
      fallbackLocalName: "TEST0001",
    });

    expect(candidates).to.have.length(1);
    await expectRejectedWithMessage(
      transport.connect(candidates[0]),
      "Expected exactly one BLE service",
    );
    expect(fixture.peripheral.disconnectCount).to.equal(1);
    await transport.close();
  });

  it("stops a hanging scan start after the bounded discovery timeout", async () => {
    const noble = new FakeNoble();
    noble.startScanDelayMs = 50;
    const transport = scanner(noble);
    const started = Date.now();

    await expectRejectedWithMessage(
      transport.discover(BLUETOOTH_SERVICE_UUID, 5),
      "Timed out starting BLE discovery",
    );

    expect(Date.now() - started).to.be.lessThan(45);
    expect(noble.stopScanningCount).to.equal(1);
    await transport.close();
  });

  it("resolves exact GATT UUIDs, forwards notifications and writes with response", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble);
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    expect(link.pair).to.equal(undefined);
    const received: Buffer[] = [];
    const hello = fixture.characteristics.find(
      (characteristic) =>
        characteristic.uuid === BLUETOOTH_CHARACTERISTICS.hello,
    )!;
    hello.onSubscribe = () => hello.emit("data", Buffer.from([0]), true);

    await link.subscribe("hello", (data) => received.push(data));
    hello.emit("data", Buffer.from([1, 2, 3]), true);
    hello.emit("data", Buffer.from([9]), false);
    await link.write("hello", Buffer.from([4, 5]));

    expect(received).to.deep.equal([Buffer.from([0]), Buffer.from([1, 2, 3])]);
    expect(hello.writes).to.deep.equal([
      { data: Buffer.from([4, 5]), withoutResponse: false },
    ]);
    expect(fixture.peripheral.requestedServices).to.deep.equal([
      BLUETOOTH_SERVICE_UUID.replace(/-/g, ""),
    ]);
    expect(fixture.service.requestedCharacteristics).to.deep.equal(
      Object.values(BLUETOOTH_CHARACTERISTICS).map((uuid) =>
        uuid.replace(/-/g, ""),
      ),
    );

    await link.disconnect();
    expect(hello.unsubscriptions).to.equal(1);
    expect(fixture.peripheral.disconnectCount).to.equal(1);
    await transport.close();
  });

  it("logs timed GATT and disconnect stages without BLE identifiers or payloads", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral({ id: "58:BF:25:22:05:3A" });
    fixture.peripheral.advertisement.localName = "EMX12345";
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const diagnostics: string[] = [];
    const transport = scanner(noble, "hci", {
      debug: (message) => diagnostics.push(message),
    });
    const [candidate] = await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect(candidate);

    await link.subscribe("hello", () => undefined);
    await link.write("hello", Buffer.from("sensitive hello payload"));
    await link.disconnect();
    await transport.close();

    const output = diagnostics.join("\n");
    expect(output).to.include("stage=transport.discovery state=completed");
    expect(output).to.include("stage=transport.link_connect state=completed");
    expect(output).to.include("stage=gatt.service_discovery state=completed");
    expect(output).to.include(
      "stage=gatt.characteristic_discovery state=completed",
    );
    expect(output).to.include(
      "stage=transport.notification_setup state=completed",
    );
    expect(output).to.include("stage=transport.write state=completed");
    expect(output).to.match(
      /stage=gatt.characteristic_resolved state=completed channel=hello uuid=[a-f0-9]+ notify=true indicate=false write=true writeWithoutResponse=false/,
    );
    expect(output).to.match(
      /channel=hello uuid=[a-f0-9]+ byteLength=23 responseMode=with_response withoutResponse=false disconnectedBeforeWrite=false/,
    );
    expect(output).to.include(
      "stage=transport.cccd_discovery state=completed channel=hello descriptorCount=1 cccdPresent=true",
    );
    expect(output).to.match(
      /stage=transport.disconnect state=completed durationMs=\d+/,
    );
    expect(output).not.to.include("58:BF:25:22:05:3A");
    expect(output).not.to.include("EMX12345");
    expect(output).not.to.include("sensitive hello payload");
  });

  it("logs raw characteristic event metadata and third-argument errors without payloads", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const diagnostics: string[] = [];
    const transport = scanner(noble, "hci", {
      debug: (message) => diagnostics.push(message),
    });
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    const hello = fixture.characteristics.find(
      (characteristic) =>
        characteristic.uuid === BLUETOOTH_CHARACTERISTICS.hello,
    )!;
    const received: Buffer[] = [];
    const privatePayload = Buffer.from("PRIVATE-ATT-PAYLOAD");

    await link.subscribe("hello", (data) => received.push(data));
    hello.emit(
      "data",
      privatePayload,
      true,
      new Error("ATT notification failed for TEST0001, PIN 1234"),
    );
    hello.emit("data", Buffer.from("IGNORED-DATA"), false);

    expect(received).to.deep.equal([privatePayload]);
    const output = diagnostics.join("\n");
    expect(output).to.include(
      "stage=transport.cccd_discovery state=completed channel=hello descriptorCount=1 cccdPresent=true",
    );
    expect(output).to.match(
      /stage=transport.characteristic_data state=accepted channel=hello uuid=[a-f0-9]+ byteLength=19 isNotification=true accepted=true .*errorCategory=att_notification_error/,
    );
    expect(output).to.match(
      /stage=transport.characteristic_data state=ignored channel=hello uuid=[a-f0-9]+ byteLength=12 isNotification=false accepted=false ignoreReason=not_notification/,
    );
    expect(output).not.to.include("PRIVATE-ATT-PAYLOAD");
    expect(output).not.to.include("IGNORED-DATA");
    expect(output).not.to.include("TEST0001");
    expect(output).not.to.include("1234");

    await link.disconnect();
    await transport.close();
  });

  it("logs whether a failed write was already disconnected without payloads", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const diagnostics: string[] = [];
    const transport = scanner(noble, "hci", {
      debug: (message) => diagnostics.push(message),
    });
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    const hello = fixture.characteristics.find(
      (characteristic) =>
        characteristic.uuid === BLUETOOTH_CHARACTERISTICS.hello,
    )!;
    hello.writeAsync = () => {
      fixture.peripheral.state = "disconnected";
      fixture.peripheral.emit("disconnect", 0);
      return Promise.reject(
        new Error("write failed for TEST0001 PIN 1234 PRIVATE-WRITE"),
      );
    };

    await expectRejectedWithMessage(
      link.write("hello", Buffer.from("PRIVATE-WRITE")),
      "write failed",
    );

    const output = diagnostics.join("\n");
    expect(output).to.match(
      /stage=transport.write state=failed channel=hello uuid=2f7b83dbae66d0beae4578ecf4509b3d byteLength=13 responseMode=with_response disconnectedBeforeWrite=false alreadyDisconnected=true/,
    );
    expect(output).not.to.include("PRIVATE-WRITE");
    expect(output).not.to.include("TEST0001");
    expect(output).not.to.include("1234");

    await link.disconnect();
    await transport.close();
  });

  it("logs the Noble disconnect status without identifying the peripheral", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral({ id: "58:BF:25:22:05:3A" });
    fixture.peripheral.advertisement.localName = "EMX12345";
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const diagnostics: string[] = [];
    const transport = scanner(noble, "hci", {
      debug: (message) => diagnostics.push(message),
    });
    const [candidate] = await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    await transport.connect(candidate);

    fixture.peripheral.state = "disconnected";
    fixture.peripheral.emit("disconnect", 0x3e);

    const output = diagnostics.join("\n");
    expect(output).to.include(
      "stage=transport.disconnect state=observed source=peripheral_event status=62 statusDescription=Connection_Failed_to_be_Established",
    );
    expect(output).not.to.include("58:BF:25:22:05:3A");
    expect(output).not.to.include("EMX12345");
    await transport.close();
  });

  it("retains the CoreBluetooth callback after a CCCD subscription error", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble, "mac");
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    const hello = fixture.characteristics.find(
      (characteristic) =>
        characteristic.uuid === BLUETOOTH_CHARACTERISTICS.hello,
    )!;
    hello.subscribeError = new Error("The attribute could not be found");
    const received: Buffer[] = [];

    await link.subscribe("hello", (data) => received.push(data));
    expect(hello.listenerCount("data")).to.equal(1);

    hello.emit("data", Buffer.from([7, 8]), false);
    expect(received).to.deep.equal([Buffer.from([7, 8])]);

    const command = fixture.characteristics.find(
      (characteristic) =>
        characteristic.uuid === BLUETOOTH_CHARACTERISTICS.command,
    )!;
    command.subscribeError = new Error("subscribe refused");
    await expectRejectedWithMessage(
      link.subscribe("command", () => undefined),
      "subscribe refused",
    );
    expect(command.listenerCount("data")).to.equal(0);

    await link.disconnect();
    expect(hello.listenerCount("data")).to.equal(0);
    expect(hello.unsubscriptions).to.equal(1);
    await transport.close();
  });

  it("explains when BlueZ D-Bus cannot subscribe without a CCCD", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble, "dbus");
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    const hello = fixture.characteristics.find(
      (characteristic) =>
        characteristic.uuid === BLUETOOTH_CHARACTERISTICS.hello,
    )!;
    hello.subscribeError = new Error("The attribute could not be found");
    const received: Buffer[] = [];

    await expectRejectedWithMessage(
      link.subscribe("hello", (data) => received.push(data)),
      "This Noble binding exposes no supported CCCD-less subscription API",
    );

    expect(hello.descriptorDiscoveries).to.equal(0);
    expect(hello.subscriptions).to.equal(1);
    expect(hello.listenerCount("data")).to.equal(0);
    hello.emit("data", Buffer.from([1]), true);
    expect(received).to.deep.equal([]);
    await link.disconnect();
    await transport.close();
  });

  it("receives HCI notifications without a CCCD without subscribing or unsubscribing", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const diagnostics: string[] = [];
    const transport = scanner(noble, "hci", {
      debug: (message) => diagnostics.push(message),
    });
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    const hello = fixture.characteristics.find(
      (characteristic) =>
        characteristic.uuid === BLUETOOTH_CHARACTERISTICS.hello,
    )!;
    hello.descriptorUuids = [];
    const received: Buffer[] = [];

    await link.subscribe("hello", (data) => received.push(data));
    expect(hello.descriptorDiscoveries).to.equal(1);
    expect(hello.subscriptions).to.equal(0);
    expect(diagnostics.join("\n")).to.include(
      "stage=transport.cccd_discovery state=completed channel=hello descriptorCount=0 cccdPresent=false",
    );

    hello.emit("data", Buffer.from([7, 8]), true);
    hello.emit("data", Buffer.from([9]), false);
    expect(received).to.deep.equal([Buffer.from([7, 8])]);

    await link.disconnect();
    expect(hello.listenerCount("data")).to.equal(0);
    expect(hello.unsubscriptions).to.equal(0);
    await transport.close();
  });

  it("disconnects and cleans partially subscribed GATT on close", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble);
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    const subscribed: BluetoothChannel[] = [];

    await link.subscribe("hello", () => subscribed.push("hello"));
    await link.subscribe("command", () => subscribed.push("command"));
    await transport.close();

    expect(subscribed).to.deep.equal([]);
    expect(fixture.peripheral.disconnectCount).to.equal(1);
    expect(fixture.characteristics[0].unsubscriptions).to.equal(1);
    expect(fixture.characteristics[1].unsubscriptions).to.equal(1);
    expect(noble.stopped).to.equal(1);
  });

  it("disconnects and awaits a peripheral in GATT setup before stopping Noble", async () => {
    const order: string[] = [];
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    noble.onStop = () => order.push("noble.stop");
    const transport = scanner(noble);
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);

    let notifyGattStarted!: () => void;
    const gattStarted = new Promise<void>((resolve) => {
      notifyGattStarted = resolve;
    });
    let resolveServices!: (services: FakeService[]) => void;
    fixture.peripheral.discoverServicesAsync = () => {
      notifyGattStarted();
      return new Promise<FakeService[]>((resolve) => {
        resolveServices = resolve;
      });
    };
    let resolveDisconnect!: () => void;
    fixture.peripheral.disconnectAsync = () => {
      fixture.peripheral.disconnectCount++;
      order.push("peripheral.disconnect");
      return new Promise<void>((resolve) => {
        resolveDisconnect = () => {
          fixture.peripheral.state = "disconnected";
          resolve();
        };
      });
    };

    const connecting = transport.connect({ id: fixture.peripheral.id });
    const connectCancelled = expectRejectedWithMessage(
      connecting,
      "BLE scanner is closed",
    );
    await gattStarted;
    let closing: Promise<void> | undefined;
    try {
      closing = transport.close();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(order).to.deep.equal(["peripheral.disconnect"]);
      expect(noble.stopped).to.equal(0);

      resolveDisconnect();
      await closing;
      await connectCancelled;
      expect(order).to.deep.equal(["peripheral.disconnect", "noble.stop"]);
      expect(fixture.peripheral.disconnectCount).to.equal(1);
    } finally {
      resolveDisconnect?.();
      resolveServices?.([fixture.service]);
      await closing?.catch(() => undefined);
    }
  });

  it("waits for the BlueZ disconnect call after canceling an unresolved connection", async () => {
    const order: string[] = [];
    const diagnostics: string[] = [];
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    noble.onStop = () => order.push("noble.stop");
    const transport = scanner(noble, "dbus", {
      debug: (message) => diagnostics.push(message),
    });
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    noble._devices.set(fixture.peripheral.id, {
      proxy: noble.createDeviceProxy(fixture.peripheral.id),
    });

    let notifyConnectionStarted!: () => void;
    const connectionStarted = new Promise<void>((resolve) => {
      notifyConnectionStarted = resolve;
    });
    let notifyNativeConnectStarted!: () => void;
    const nativeConnectStarted = new Promise<void>((resolve) => {
      notifyNativeConnectStarted = resolve;
    });
    let connectCalls = 0;
    noble.onNativeConnect = (id) => {
      expect(id).to.equal(fixture.peripheral.id);
      connectCalls++;
      order.push("Device1.Connect");
      notifyNativeConnectStarted();
      return Promise.resolve();
    };
    fixture.peripheral.connectAsync = () => {
      // Noble stays connecting while BlueZ reports Connected but not ServicesResolved.
      fixture.peripheral.connectCount++;
      fixture.peripheral.state = "connecting";
      notifyConnectionStarted();
      return new Promise<void>((resolve, reject) => {
        fixture.peripheral.once("connect", (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        void noble._bindings
          ._connect(fixture.peripheral.id)
          .catch((error: unknown) => fixture.peripheral.emit("connect", error));
      });
    };

    let notifyDisconnectStarted!: () => void;
    const disconnectStarted = new Promise<void>((resolve) => {
      notifyDisconnectStarted = resolve;
    });
    let resolveDisconnect!: () => void;
    let nativeDisconnectCount = 0;
    noble.onNativeDisconnect = (id) => {
      expect(id).to.equal(fixture.peripheral.id);
      nativeDisconnectCount++;
      order.push("Device1.Disconnect");
      notifyDisconnectStarted();
      return new Promise<void>((resolve) => {
        resolveDisconnect = resolve;
      });
    };
    fixture.peripheral.onCancelConnect = () => {
      order.push("backend.cancelConnect");
      void noble._bindings._disconnect(fixture.peripheral.id);
    };

    const connecting = transport.connect({ id: fixture.peripheral.id });
    const connectionCancelled = expectRejectedWithMessage(
      connecting,
      "BLE scanner is closed",
    );
    await connectionStarted;
    await nativeConnectStarted;
    expect(connectCalls).to.equal(1);
    expect(fixture.peripheral.state).to.equal("connecting");

    let closing: Promise<void> | undefined;
    try {
      closing = transport.close();
      await connectionCancelled;
      await disconnectStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(order).to.deep.equal([
        "Device1.Connect",
        "backend.cancelConnect",
        "Device1.Disconnect",
      ]);
      expect(nativeDisconnectCount).to.equal(1);
      expect(noble.stopped).to.equal(0);

      resolveDisconnect();
      await closing;
      expect(order).to.deep.equal([
        "Device1.Connect",
        "backend.cancelConnect",
        "Device1.Disconnect",
        "noble.stop",
      ]);
      expect(fixture.peripheral.cancelConnectCount).to.equal(1);
      expect(fixture.peripheral.disconnectCount).to.equal(0);
      expect(fixture.peripheral.state).to.equal("disconnected");
      const output = diagnostics.join("\n");
      expect(output).to.include(
        "stage=transport.disconnect state=cleanup_finished",
      );
      expect(output).not.to.include("state=cleanup_completed");
    } finally {
      resolveDisconnect?.();
      await closing?.catch(() => undefined);
    }
  });

  it("waits for a late BlueZ connect event after Noble cancels connectAsync", async () => {
    const order: string[] = [];
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    noble.onStop = () => order.push("noble.stop");
    const transport = scanner(noble, "dbus");
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);

    let notifyConnectionStarted!: () => void;
    const connectionStarted = new Promise<void>((resolve) => {
      notifyConnectionStarted = resolve;
    });
    let notifyBackendConnectStarted!: () => void;
    const backendConnectStarted = new Promise<void>((resolve) => {
      notifyBackendConnectStarted = resolve;
    });
    let resolveBackendConnect!: () => void;
    noble.onNativeConnect = (id) => {
      expect(id).to.equal(fixture.peripheral.id);
      notifyBackendConnectStarted();
      return new Promise<void>((resolve) => {
        resolveBackendConnect = resolve;
      });
    };
    fixture.peripheral.connectAsync = () => {
      fixture.peripheral.connectCount++;
      fixture.peripheral.state = "connecting";
      notifyConnectionStarted();
      return new Promise<void>((resolve, reject) => {
        fixture.peripheral.once("connect", (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        void noble._bindings._connect(fixture.peripheral.id);
      });
    };
    fixture.peripheral.onCancelConnect = () => {
      order.push("backend.cancelConnect");
      void noble._bindings._disconnect(fixture.peripheral.id);
    };

    let notifyDisconnectStarted!: () => void;
    const disconnectStarted = new Promise<void>((resolve) => {
      notifyDisconnectStarted = resolve;
    });
    let resolveDisconnect!: () => void;
    fixture.peripheral.disconnectAsync = () => {
      fixture.peripheral.disconnectCount++;
      fixture.peripheral.state = "disconnecting";
      order.push("peripheral.disconnect");
      notifyDisconnectStarted();
      return new Promise<void>((resolve) => {
        resolveDisconnect = () => {
          fixture.peripheral.state = "disconnected";
          resolve();
        };
      });
    };

    const connecting = transport.connect({ id: fixture.peripheral.id });
    const connectionCancelled = expectRejectedWithMessage(
      connecting,
      "BLE scanner is closed",
    );
    await connectionStarted;
    await backendConnectStarted;

    let closing: Promise<void> | undefined;
    try {
      closing = transport.close();
      await connectionCancelled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).to.deep.equal(["backend.cancelConnect"]);
      expect(fixture.peripheral.state).to.equal("disconnected");
      expect(noble.stopped).to.equal(0);

      // Noble can emit a later success after connectAsync was canceled.
      fixture.peripheral.state = "connected";
      order.push("late.connect");
      fixture.peripheral.emit("connect");
      resolveBackendConnect();
      await disconnectStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).to.deep.equal([
        "backend.cancelConnect",
        "late.connect",
        "peripheral.disconnect",
      ]);
      expect(fixture.peripheral.state).to.equal("disconnecting");
      expect(noble.stopped).to.equal(0);

      resolveDisconnect();
      await closing;
      expect(order).to.deep.equal([
        "backend.cancelConnect",
        "late.connect",
        "peripheral.disconnect",
        "noble.stop",
      ]);
      expect(fixture.peripheral.disconnectCount).to.equal(1);
    } finally {
      resolveBackendConnect?.();
      resolveDisconnect?.();
      await closing?.catch(() => undefined);
    }
  });

  it("does not disconnect a BlueZ device when canceled before proxy initialization", async () => {
    const order: string[] = [];
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    noble.onStop = () => order.push("noble.stop");

    let notifyProxyInitializationStarted!: () => void;
    const proxyInitializationStarted = new Promise<void>((resolve) => {
      notifyProxyInitializationStarted = resolve;
    });
    let resolveProxy!: (proxy: FakeDbusDeviceProxy) => void;
    noble.onDeviceProxy = (id) => {
      expect(id).to.equal(fixture.peripheral.id);
      notifyProxyInitializationStarted();
      return new Promise<FakeDbusDeviceProxy>((resolve) => {
        resolveProxy = resolve;
      });
    };

    let disconnectCalls = 0;
    noble.onNativeDisconnect = (id) => {
      expect(id).to.equal(fixture.peripheral.id);
      disconnectCalls++;
      order.push("Device1.Disconnect");
      return Promise.resolve();
    };
    let connectCalls = 0;
    noble.onNativeConnect = (id) => {
      expect(id).to.equal(fixture.peripheral.id);
      connectCalls++;
      order.push("Device1.Connect");
      return Promise.resolve();
    };

    const transport = scanner(noble, "dbus");
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    fixture.peripheral.connectAsync = () => {
      fixture.peripheral.connectCount++;
      fixture.peripheral.state = "connecting";
      return new Promise<void>((resolve, reject) => {
        fixture.peripheral.once("connect", (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        void noble._bindings
          ._connect(fixture.peripheral.id)
          .catch((error: unknown) => fixture.peripheral.emit("connect", error));
      });
    };
    fixture.peripheral.onCancelConnect = () => {
      order.push("backend.cancelConnect");
      void noble._bindings._disconnect(fixture.peripheral.id);
    };

    const connecting = transport.connect({ id: fixture.peripheral.id });
    const connectionCancelled = expectRejectedWithMessage(
      connecting,
      "BLE scanner is closed",
    );
    await proxyInitializationStarted;

    let closing: Promise<void> | undefined;
    try {
      const retrying = transport.connect({ id: fixture.peripheral.id });
      const retryCancelled = expectRejectedWithMessage(
        retrying,
        "BLE scanner is closed",
      );
      closing = transport.close();
      expect(retrying).not.to.equal(connecting);
      expect(fixture.peripheral.connectCount).to.equal(1);
      await Promise.all([connectionCancelled, retryCancelled]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).to.deep.equal(["backend.cancelConnect"]);
      expect(noble.stopped).to.equal(0);

      resolveProxy(noble.createDeviceProxy(fixture.peripheral.id));
      await closing;
      expect(order).to.deep.equal(["backend.cancelConnect", "noble.stop"]);
      expect(connectCalls).to.equal(0);
      expect(disconnectCalls).to.equal(0);
      expect(noble.stopped).to.equal(1);
    } finally {
      resolveProxy?.(noble.createDeviceProxy(fixture.peripheral.id));
      await closing?.catch(() => undefined);
    }
  });

  it("does not disconnect a BlueZ device when shutdown wins before Connect", async () => {
    const order: string[] = [];
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    noble.onStop = () => order.push("noble.stop");

    let notifyBeforeNativeConnect!: () => void;
    const beforeNativeConnect = new Promise<void>((resolve) => {
      notifyBeforeNativeConnect = resolve;
    });
    let resumeNativeConnect!: () => void;
    noble.onBeforeNativeConnect = async (id) => {
      expect(id).to.equal(fixture.peripheral.id);
      notifyBeforeNativeConnect();
      await new Promise<void>((resolve) => {
        resumeNativeConnect = resolve;
      });
    };

    let disconnectCalls = 0;
    noble.onNativeDisconnect = (id) => {
      expect(id).to.equal(fixture.peripheral.id);
      disconnectCalls++;
      order.push("Device1.Disconnect");
      return Promise.resolve();
    };
    let connectCalls = 0;
    noble.onNativeConnect = (id) => {
      expect(id).to.equal(fixture.peripheral.id);
      connectCalls++;
      order.push("Device1.Connect");
      return Promise.resolve();
    };

    const transport = scanner(noble, "dbus");
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    fixture.peripheral.connectAsync = () => {
      fixture.peripheral.connectCount++;
      fixture.peripheral.state = "connecting";
      return new Promise<void>((resolve, reject) => {
        fixture.peripheral.once("connect", (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        void noble._bindings
          ._connect(fixture.peripheral.id)
          .catch((error: unknown) => fixture.peripheral.emit("connect", error));
      });
    };
    fixture.peripheral.onCancelConnect = () => {
      order.push("backend.cancelConnect");
      void noble._bindings._disconnect(fixture.peripheral.id);
    };

    const connecting = transport.connect({ id: fixture.peripheral.id });
    const connectionCancelled = expectRejectedWithMessage(
      connecting,
      "BLE scanner is closed",
    );
    await beforeNativeConnect;

    let closing: Promise<void> | undefined;
    try {
      closing = transport.close();
      await connectionCancelled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).to.deep.equal(["backend.cancelConnect"]);
      expect(noble.stopped).to.equal(0);

      resumeNativeConnect();
      await closing;
      expect(connectCalls).to.equal(0);
      expect(disconnectCalls).to.equal(0);
      expect(order).to.deep.equal(["backend.cancelConnect", "noble.stop"]);
      expect(noble.stopped).to.equal(1);
    } finally {
      resumeNativeConnect?.();
      await closing?.catch(() => undefined);
    }
  });

  it("keeps a shared BlueZ link open until its current owner releases it", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];

    let notifyConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      notifyConnectStarted = resolve;
    });
    let resolveNativeConnect!: () => void;
    noble.onNativeConnect = () => {
      notifyConnectStarted();
      return new Promise<void>((resolve) => {
        resolveNativeConnect = resolve;
      });
    };

    const transport = scanner(noble, "dbus");
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    let peripheralConnectOperation: Promise<void> | undefined;
    fixture.peripheral.connectAsync = () => {
      fixture.peripheral.connectCount++;
      fixture.peripheral.state = "connecting";
      peripheralConnectOperation = new Promise<void>((resolve, reject) => {
        fixture.peripheral.once("connect", (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      void noble._bindings._connect(fixture.peripheral.id).then(
        () => {
          fixture.peripheral.state = "connected";
          fixture.peripheral.emit("connect");
        },
        (error: unknown) => fixture.peripheral.emit("connect", error),
      );
      return peripheralConnectOperation;
    };

    const candidate = { id: fixture.peripheral.id };
    const abandonedOpening = transport.connect(candidate);
    const abandonedCleanup = abandonedOpening.then((link) => link.disconnect());
    await connectStarted;
    const currentOpening = transport.connect(candidate);
    expect(fixture.peripheral.connectCount).to.equal(1);

    resolveNativeConnect();
    const currentLink = await currentOpening;
    await abandonedCleanup;
    expect(fixture.peripheral.disconnectCount).to.equal(0);
    expect(fixture.peripheral.state).to.equal("connected");

    await currentLink.subscribe("hello", () => undefined);
    await currentLink.disconnect();
    expect(fixture.peripheral.disconnectCount).to.equal(1);
    await transport.close();
  });

  it("disconnects active links while waiting for in-flight BlueZ cleanup", async () => {
    const order: string[] = [];
    const noble = new FakeNoble();
    const activeFixture = makePeripheral({ id: "active-link" });
    const connectingFixture = makePeripheral({ id: "connecting-link" });
    noble.peripherals.set(
      activeFixture.peripheral.id,
      activeFixture.peripheral,
    );
    noble.peripherals.set(
      connectingFixture.peripheral.id,
      connectingFixture.peripheral,
    );
    noble.discoverOnScan = [
      activeFixture.peripheral,
      connectingFixture.peripheral,
    ];
    noble.onStop = () => order.push("noble.stop");

    let notifyConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      notifyConnectStarted = resolve;
    });
    noble.onNativeConnect = (id) => {
      if (id === connectingFixture.peripheral.id) {
        order.push("B.Device1.Connect");
        notifyConnectStarted();
      }
      return Promise.resolve();
    };

    let notifyDisconnectStarted!: () => void;
    const disconnectStarted = new Promise<void>((resolve) => {
      notifyDisconnectStarted = resolve;
    });
    let resolveDisconnect!: () => void;
    noble.onNativeDisconnect = (id) => {
      expect(id).to.equal(connectingFixture.peripheral.id);
      order.push("B.Device1.Disconnect");
      notifyDisconnectStarted();
      return new Promise<void>((resolve) => {
        resolveDisconnect = () => {
          order.push("B.Device1.Disconnect finished");
          resolve();
        };
      });
    };

    const transport = scanner(noble, "dbus");
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const activeLink = await transport.connect({
      id: activeFixture.peripheral.id,
    });
    await activeLink.subscribe("hello", () => undefined);

    let notifyUnsubscribeStarted!: () => void;
    const unsubscribeStarted = new Promise<void>((resolve) => {
      notifyUnsubscribeStarted = resolve;
    });
    let resolveUnsubscribe!: () => void;
    activeFixture.characteristics[0].onUnsubscribe = () => {
      order.push("A.unsubscribe");
      notifyUnsubscribeStarted();
    };
    activeFixture.characteristics[0].unsubscribePromise = new Promise<void>(
      (resolve) => {
        resolveUnsubscribe = resolve;
      },
    );

    let notifyActiveDisconnectStarted!: () => void;
    const activeDisconnectStarted = new Promise<void>((resolve) => {
      notifyActiveDisconnectStarted = resolve;
    });
    let resolveActiveDisconnect!: () => void;
    activeFixture.peripheral.disconnectAsync = () => {
      order.push("A.disconnect");
      notifyActiveDisconnectStarted();
      return new Promise<void>((resolve) => {
        resolveActiveDisconnect = () => {
          order.push("A.disconnect finished");
          activeFixture.peripheral.state = "disconnected";
          resolve();
        };
      });
    };

    let connectingOperation: Promise<void> | undefined;
    connectingFixture.peripheral.connectAsync = () => {
      connectingFixture.peripheral.connectCount++;
      connectingFixture.peripheral.state = "connecting";
      connectingOperation = new Promise<void>((resolve, reject) => {
        connectingFixture.peripheral.once("connect", (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      void noble._bindings
        ._connect(connectingFixture.peripheral.id)
        .catch((error: unknown) =>
          connectingFixture.peripheral.emit("connect", error),
        );
      return connectingOperation;
    };
    connectingFixture.peripheral.onCancelConnect = () => {
      order.push("B.cancelConnect");
      void noble._bindings._disconnect(connectingFixture.peripheral.id);
    };

    const connecting = transport.connect({
      id: connectingFixture.peripheral.id,
    });
    const connectionCancelled = expectRejectedWithMessage(
      connecting,
      "BLE scanner is closed",
    );
    await connectStarted;

    let closing: Promise<void> | undefined;
    try {
      closing = transport.close();
      await connectionCancelled;
      await disconnectStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).to.include("A.unsubscribe");
      expect(noble.stopped).to.equal(0);

      resolveUnsubscribe();
      await unsubscribeStarted;
      await activeDisconnectStarted;
      expect(order).to.include("A.disconnect");
      expect(noble.stopped).to.equal(0);

      resolveActiveDisconnect();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).not.to.include("noble.stop");

      resolveDisconnect();
      await closing;
      expect(order.indexOf("A.unsubscribe")).to.be.lessThan(
        order.indexOf("B.Device1.Disconnect finished"),
      );
      expect(order.indexOf("A.disconnect finished")).to.be.lessThan(
        order.indexOf("noble.stop"),
      );
      expect(order.indexOf("B.Device1.Disconnect finished")).to.be.lessThan(
        order.indexOf("noble.stop"),
      );
    } finally {
      resolveUnsubscribe?.();
      resolveDisconnect?.();
      if (closing) {
        await activeDisconnectStarted;
        resolveActiveDisconnect?.();
        await closing.catch(() => undefined);
      }
    }
  });

  it("fails closed when the vendor service or a unique channel is absent", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral({
      serviceUuid: "180f",
      serviceUuids: [BLUETOOTH_SERVICE_UUID.replace(/-/g, "")],
    });
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble);
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);

    await expectRejectedWithMessage(
      transport.connect({ id: fixture.peripheral.id }),
      "Expected exactly one BLE service",
    );
    expect(fixture.peripheral.disconnectCount).to.equal(1);
    await transport.close();
  });

  it("recovers from incomplete first HCI characteristic discovery", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    fixture.service.discoveryResults = [
      fixture.characteristics.slice(1),
      fixture.characteristics,
    ];
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const diagnostics: string[] = [];
    const transport = scanner(noble, "hci", {
      debug: (message) => diagnostics.push(message),
    });
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);

    const startedAt = Date.now();
    const link = await transport.connect({ id: fixture.peripheral.id });

    expect(fixture.service.discoveryCalls).to.equal(2);
    expect(Date.now() - startedAt).to.be.at.least(200);
    expect(diagnostics.join("\n")).to.include(
      "stage=gatt.characteristic_discovery state=retry attempt=1 missingCount=1 quietWindowMs=250",
    );
    await link.disconnect();
    await transport.close();
  });

  it("disconnects a connected peripheral when teardown times out during unsubscribe", async () => {
    const order: string[] = [];
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble);
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    const hello = fixture.characteristics.find(
      (characteristic) =>
        characteristic.uuid === BLUETOOTH_CHARACTERISTICS.hello,
    )!;
    let notifyUnsubscribeStarted!: () => void;
    const unsubscribeStarted = new Promise<void>((resolve) => {
      notifyUnsubscribeStarted = resolve;
    });
    let resolveUnsubscribe!: () => void;
    hello.unsubscribePromise = new Promise<void>((resolve) => {
      resolveUnsubscribe = resolve;
    });
    hello.onUnsubscribe = () => {
      order.push("unsubscribe");
      notifyUnsubscribeStarted();
    };
    fixture.peripheral.onNativeDisconnect = () =>
      order.push("peripheral.disconnect");
    noble.onStop = () => order.push("noble.stop");
    await link.subscribe("hello", () => undefined);

    const timeoutController = new AbortController();
    const timeoutSignal = sinon
      .stub(AbortSignal, "timeout")
      .returns(timeoutController.signal);
    let closing: Promise<void> | undefined;
    try {
      closing = transport.close();
      const closed = expectRejectedWithMessage(
        closing,
        "BLE teardown timed out after 5000 ms",
      );
      await unsubscribeStarted;
      timeoutController.abort();
      await closed;

      expect(order).to.deep.equal([
        "unsubscribe",
        "peripheral.disconnect",
        "noble.stop",
      ]);
      expect(fixture.peripheral.disconnectCount).to.equal(1);
      expect(noble.stopped).to.equal(1);

      resolveUnsubscribe();
      await link.disconnect();
    } finally {
      timeoutController.abort();
      resolveUnsubscribe();
      timeoutSignal.restore();
      await closing?.catch(() => undefined);
    }
  });

  it("continues stopping Noble when native disconnect fallback fails", async () => {
    for (const throwsSynchronously of [true, false]) {
      const order: string[] = [];
      const diagnostics: string[] = [];
      const noble = new FakeNoble();
      const fixture = makePeripheral();
      noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
      noble.discoverOnScan = [fixture.peripheral];
      const transport = scanner(noble, "hci", {
        debug: (message) => diagnostics.push(message),
      });
      await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
      const link = await transport.connect({ id: fixture.peripheral.id });
      const hello = fixture.characteristics.find(
        (characteristic) =>
          characteristic.uuid === BLUETOOTH_CHARACTERISTICS.hello,
      )!;
      let notifyUnsubscribeStarted!: () => void;
      const unsubscribeStarted = new Promise<void>((resolve) => {
        notifyUnsubscribeStarted = resolve;
      });
      let resolveUnsubscribe!: () => void;
      hello.unsubscribePromise = new Promise<void>((resolve) => {
        resolveUnsubscribe = resolve;
      });
      hello.onUnsubscribe = () => {
        order.push("unsubscribe");
        notifyUnsubscribeStarted();
      };
      const nativeDisconnectFailure = new Error("native disconnect failed");
      fixture.peripheral.nativeDisconnectFailure = nativeDisconnectFailure;
      fixture.peripheral.nativeDisconnectThrows = throwsSynchronously;
      fixture.peripheral.onNativeDisconnect = () =>
        order.push("peripheral.disconnect");
      noble.onStop = () => order.push("noble.stop");
      await link.subscribe("hello", () => undefined);

      const timeoutController = new AbortController();
      const timeoutSignal = sinon
        .stub(AbortSignal, "timeout")
        .returns(timeoutController.signal);
      let closing: Promise<void> | undefined;
      try {
        closing = transport.close();
        const closed = expectRejectedWithMessage(
          closing,
          "BLE teardown timed out after 5000 ms",
        );
        await unsubscribeStarted;
        timeoutController.abort();
        await closed;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(order.slice(0, 3)).to.deep.equal([
          "unsubscribe",
          "peripheral.disconnect",
          "noble.stop",
        ]);
        expect(noble.stopped).to.equal(1);
        expect(diagnostics.join("\n")).to.include(
          "stage=transport.disconnect state=failed",
        );

        resolveUnsubscribe();
        await link.disconnect().catch(() => undefined);
      } finally {
        timeoutController.abort();
        resolveUnsubscribe();
        timeoutSignal.restore();
        await closing?.catch(() => undefined);
      }
    }
  });

  it("bounds scanner close when Noble scan stop never settles", async () => {
    const order: string[] = [];
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    fixture.peripheral.onNativeDisconnect = () =>
      order.push("peripheral.disconnect");
    noble.onStop = () => order.push("noble.stop");
    noble.onScanStop = () => order.push("scan.stop");
    let notifyScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      notifyScanStarted = resolve;
    });
    noble.onScanStart = notifyScanStarted;
    const transport = new AdapterNobleBluetoothScanner(
      noble as unknown as Noble,
      "hci",
      testTimers,
    );
    const discovery = transport.discover(BLUETOOTH_SERVICE_UUID, 60_000);
    const discoveryCancelled = expectRejectedWithMessage(
      discovery,
      "BLE discovery cancelled",
    );
    await scanStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await transport.connect({ id: fixture.peripheral.id });
    let resolveScanStop!: () => void;
    noble.stopScanningPromise = new Promise<void>((resolve) => {
      resolveScanStop = resolve;
    });
    noble.stopScanningNeverResolves = true;
    const timeoutController = new AbortController();
    const timeoutSignal = sinon
      .stub(AbortSignal, "timeout")
      .returns(timeoutController.signal);

    try {
      const closing = transport.close();
      const closed = expectRejectedWithMessage(
        closing,
        "BLE teardown timed out after 5000 ms",
      );
      sinon.assert.calledOnceWithExactly(
        timeoutSignal,
        BLUETOOTH_TEARDOWN_TIMEOUT_MS,
      );
      await discoveryCancelled;
      timeoutController.abort();
      await closed;
      expect(noble.stopScanningCount).to.equal(1);
      expect(fixture.peripheral.disconnectCount).to.equal(1);
      expect(noble.stopped).to.equal(1);
      expect(order).to.deep.equal([
        "scan.stop",
        "peripheral.disconnect",
        "noble.stop",
      ]);

      resolveScanStop();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(noble.stopped).to.equal(1);
    } finally {
      timeoutController.abort();
      resolveScanStop();
      timeoutSignal.restore();
    }
  });

  it("joins discovery's pending scan stop when closing the scanner", async () => {
    const noble = new FakeNoble();
    let notifyScanStopStarted!: () => void;
    const scanStopStarted = new Promise<void>((resolve) => {
      notifyScanStopStarted = resolve;
    });
    noble.onScanStop = notifyScanStopStarted;
    let resolveScanStop!: () => void;
    noble.stopScanningPromise = new Promise<void>((resolve) => {
      resolveScanStop = resolve;
    });
    noble.stopScanningNeverResolves = true;
    const transport = new AdapterNobleBluetoothScanner(
      noble as unknown as Noble,
      "hci",
      testTimers,
    );
    const discovery = transport.discover(BLUETOOTH_SERVICE_UUID, 25);
    const discoveryCancelled = expectRejectedWithMessage(
      discovery,
      "BLE discovery cancelled",
    );
    await scanStopStarted;

    const timeoutController = new AbortController();
    const timeoutSignal = sinon
      .stub(AbortSignal, "timeout")
      .returns(timeoutController.signal);
    try {
      const closing = transport.close();
      const closed = expectRejectedWithMessage(
        closing,
        "BLE teardown timed out after 5000 ms",
      );
      await discoveryCancelled;
      expect(noble.stopScanningCount).to.equal(1);
      timeoutController.abort();
      await closed;
      expect(noble.stopped).to.equal(1);

      resolveScanStop();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(noble.stopScanningCount).to.equal(1);
      expect(noble.stopped).to.equal(1);
    } finally {
      timeoutController.abort();
      resolveScanStop();
      timeoutSignal.restore();
    }
  });

  it("clears the characteristic retry quiet window when closed", async () => {
    let quietWindowStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      quietWindowStarted = resolve;
    });
    let quietTimer: ioBroker.Timeout | undefined;
    let quietTimerClears = 0;
    let quietTimerFired = false;
    const timers: BluetoothTimerApi = {
      setTimeout: (callback, timeoutMs) => {
        const timer = setTimeout(() => {
          if (timer === quietTimer) {
            quietTimerFired = true;
          }
          callback();
        }, timeoutMs) as unknown as ioBroker.Timeout;
        if (timeoutMs === 250) {
          quietTimer = timer;
          quietWindowStarted();
        }
        return timer;
      },
      clearTimeout: (timer) => {
        if (timer === quietTimer) {
          quietTimerClears++;
        }
        if (timer) {
          clearTimeout(timer);
        }
      },
    };
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    fixture.service.discoveryResults = [fixture.characteristics.slice(1)];
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble, "hci", undefined, timers);
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);

    const connecting = transport.connect({ id: fixture.peripheral.id });
    await started;
    await transport.close();

    await expectRejectedWithMessage(connecting, "BLE scanner is closed");
    expect(quietTimerClears).to.equal(1);
    expect(quietTimerFired).to.equal(false);
    expect(fixture.service.discoveryCalls).to.equal(1);
    expect(fixture.peripheral.disconnectCount).to.equal(1);
  });

  it("does not retry incomplete characteristic discovery on non-HCI bindings", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    fixture.service.discoveryResults = [
      fixture.characteristics.slice(1),
      fixture.characteristics,
    ];
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const diagnostics: string[] = [];
    const transport = scanner(noble, "dbus", {
      debug: (message) => diagnostics.push(message),
    });
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);

    const startedAt = Date.now();
    await expectRejectedWithMessage(
      transport.connect({ id: fixture.peripheral.id }),
      "Expected exactly one BLE characteristic",
    );

    expect(fixture.service.discoveryCalls).to.equal(1);
    expect(Date.now() - startedAt).to.be.lessThan(200);
    expect(diagnostics.join("\n")).not.to.include("state=retry");
    expect(fixture.peripheral.disconnectCount).to.equal(1);
    await transport.close();
  });

  it("does not delay complete HCI characteristic discovery", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble, "hci");
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);

    const startedAt = Date.now();
    const link = await transport.connect({ id: fixture.peripheral.id });

    expect(fixture.service.discoveryCalls).to.equal(1);
    expect(Date.now() - startedAt).to.be.lessThan(200);
    await link.disconnect();
    await transport.close();
  });

  it("reports a second incomplete HCI characteristic discovery and disconnects", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral({
      characteristicUuids: Object.values(BLUETOOTH_CHARACTERISTICS).filter(
        (uuid) => uuid !== BLUETOOTH_CHARACTERISTICS.command,
      ),
    });
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const diagnostics: string[] = [];
    const transport = scanner(noble, "hci", {
      debug: (message) => diagnostics.push(message),
    });
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);

    await expectRejectedWithMessage(
      transport.connect({ id: fixture.peripheral.id }),
      "Expected exactly one BLE characteristic",
    );

    expect(fixture.service.discoveryCalls).to.equal(2);
    const retryFailure = diagnostics.find((message) =>
      message.includes("state=retry_failed"),
    );
    expect(retryFailure).to.include("attempt=2 missingCount=1");
    expect(retryFailure).to.include("errorName=Error");
    expect(fixture.peripheral.disconnectCount).to.equal(1);
    await transport.close();
  });

  it("notifies disconnect listeners and ignores later notifications", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral();
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble);
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);
    const link = await transport.connect({ id: fixture.peripheral.id });
    let disconnected = 0;
    let notifications = 0;
    link.onDisconnect(() => disconnected++);
    await link.subscribe("hello", () => notifications++);

    fixture.peripheral.state = "disconnected";
    fixture.peripheral.emit("disconnect", 0);
    fixture.characteristics[0].emit("data", Buffer.from([1]), true);

    expect(disconnected).to.equal(1);
    expect(notifications).to.equal(0);
    expect(fixture.characteristics[0].listenerCount("data")).to.equal(0);
    await transport.close();
  });

  it("rejects candidates that were not discovered by this scanner", async () => {
    const noble = new FakeNoble();
    const transport = scanner(noble);
    await expectRejectedWithMessage(
      transport.connect({ id: "unrelated-address" }),
      "not from this scanner's discovery",
    );
    await transport.close();
  });
});
