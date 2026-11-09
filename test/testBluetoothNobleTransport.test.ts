"use strict";

export {};

import { EventEmitter } from "node:events";
import { expect } from "chai";
import { describe, it } from "mocha";
import type { Noble } from "@stoprocent/noble";
import type { MessageBus } from "dbus-next";
import {
  BLUETOOTH_CHARACTERISTICS,
  BLUETOOTH_SERVICE_UUID,
} from "../lib/bluetooth-protocol.ts";
import type { BluetoothChannel } from "../lib/bluetooth-protocol.ts";
import type { BluetoothDiagnosticLogger } from "../lib/bluetooth-diagnostics.ts";
import {
  createNobleBluetoothScanner,
  NobleBluetoothScanner,
  pairBluezDevice,
  resolveNobleBinding,
} from "../lib/noble-bluetooth-transport.ts";

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
  onSubscribe?: () => void;

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
    return Promise.resolve();
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
  state: "connected" | "disconnected" = "disconnected";
  connectable = true;
  connectCount = 0;
  disconnectCount = 0;
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

  disconnectAsync(): Promise<void> {
    this.disconnectCount++;
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

class FakeNoble extends EventEmitter {
  state: "poweredOn" | "poweredOff" = "poweredOn";
  waitTimeouts: number[] = [];
  scanFilters: string[][] = [];
  allowDuplicates: boolean[] = [];
  scanning = false;
  stopped = 0;
  stopScanningCount = 0;
  startScanDelayMs = 0;
  discoverOnScan: FakePeripheral[] = [];
  peripherals = new Map<string, FakePeripheral>();

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
    for (const peripheral of this.discoverOnScan) {
      setImmediate(() => this.emit("discover", peripheral));
    }
  }

  stopScanningAsync(): Promise<void> {
    this.stopScanningCount++;
    this.scanning = false;
    return Promise.resolve();
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
): NobleBluetoothScanner {
  return new NobleBluetoothScanner(
    noble as unknown as Noble,
    binding,
    diagnosticLogger,
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
  it("pairs the matching BlueZ Device1 object once", async () => {
    const counters = { pairCalls: 0, disconnects: 0 };
    const busFactory = (): MessageBus =>
      fakeBluezBus(() => Promise.resolve(), counters);
    await pairBluezDevice("58:BF:25:22:05:3A", 100, busFactory);

    expect(counters).to.deep.equal({ pairCalls: 1, disconnects: 1 });
  });

  it("surfaces Device1.Pair failures", async () => {
    const counters = { pairCalls: 0, disconnects: 0 };
    const busFactory = (): MessageBus =>
      fakeBluezBus(
        () => Promise.reject(new Error("AuthenticationCanceled")),
        counters,
      );
    const pairing = pairBluezDevice("58:BF:25:22:05:3A", 100, busFactory);
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
    const pairing = pairBluezDevice("58:BF:25:22:05:3A", 5, busFactory);
    await expectRejectedWithMessage(
      pairing,
      "BlueZ pairing timed out after 5 ms",
    );
    expect(counters).to.deep.equal({ pairCalls: 1, disconnects: 1 });
  });
});

describe("Noble Bluetooth transport", () => {
  it("uses BlueZ D-Bus by default on Linux and preserves binding precedence", () => {
    expect(resolveNobleBinding("linux")).to.equal("dbus");
    expect(resolveNobleBinding("linux", "hci")).to.equal("hci");
    expect(resolveNobleBinding("linux", "dbus")).to.equal("dbus");
    expect(resolveNobleBinding("linux", "default")).to.equal("dbus");
    expect(resolveNobleBinding("linux", "auto")).to.equal("dbus");
    expect(resolveNobleBinding("linux", "auto", "hci")).to.equal("hci");
    expect(resolveNobleBinding("linux", "hci", "dbus")).to.equal("hci");
    expect(resolveNobleBinding("darwin")).to.equal("default");
    expect(scanner(new FakeNoble(), "hci").getBinding()).to.equal("hci");
  });

  it("loads Noble lazily through withBindings only when its factory is called", async () => {
    const noble = new FakeNoble();
    let factoryCalls = 0;
    const transport = await createNobleBluetoothScanner(() => {
      factoryCalls++;
      return Promise.resolve(noble as unknown as Noble);
    });
    expect(factoryCalls).to.equal(1);
    await transport.close();
    expect(noble.stopped).to.equal(1);
  });

  it("passes the selected binding to Noble and reports it on the scanner", async () => {
    const noble = new FakeNoble();
    let selectedBinding: string | undefined;
    const transport = await createNobleBluetoothScanner((binding) => {
      selectedBinding = binding;
      return Promise.resolve(noble as unknown as Noble);
    }, "hci");

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
