"use strict";

export {};

import { EventEmitter } from "node:events";
import { expect } from "chai";
import { describe, it } from "mocha";
import type { Noble } from "@stoprocent/noble";
import {
  BLUETOOTH_CHARACTERISTICS,
  BLUETOOTH_SERVICE_UUID,
} from "../lib/bluetooth-protocol.ts";
import type { BluetoothChannel } from "../lib/bluetooth-protocol.ts";
import {
  createNobleBluetoothScanner,
  NobleBluetoothScanner,
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
  failSubscribe = false;

  constructor(
    readonly uuid: string,
    readonly properties: string[] = ["notify", "write"],
  ) {
    super();
  }

  subscribeAsync(): Promise<void> {
    this.subscriptions++;
    if (this.failSubscribe) {
      return Promise.reject(new Error("subscribe refused"));
    }
    return Promise.resolve();
  }

  unsubscribeAsync(): Promise<void> {
    this.unsubscriptions++;
    return Promise.resolve();
  }

  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void> {
    this.writes.push({ data, withoutResponse });
    return Promise.resolve();
  }
}

class FakeService extends EventEmitter {
  requestedCharacteristics: string[] = [];
  characteristics: FakeCharacteristic[];

  constructor(
    readonly uuid: string,
    characteristics: FakeCharacteristic[],
  ) {
    super();
    this.characteristics = characteristics;
  }

  discoverCharacteristicsAsync(uuids: string[]): Promise<FakeCharacteristic[]> {
    this.requestedCharacteristics = uuids;
    return Promise.resolve(
      this.characteristics.filter((characteristic) =>
        uuids.includes(characteristic.uuid.toLowerCase().replace(/-/g, "")),
      ),
    );
  }
}

class FakePeripheral extends EventEmitter {
  state: "connected" | "disconnected" = "disconnected";
  connectCount = 0;
  disconnectCount = 0;
  requestedServices: string[] = [];
  services: FakeService[];

  constructor(
    readonly id: string,
    readonly advertisement: {
      localName: string;
      serviceUuids: string[];
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
  return {
    peripheral: new FakePeripheral(
      options.id ?? "charger-id",
      {
        localName: "Easee charger",
        serviceUuids: options.serviceUuids ?? [
          BLUETOOTH_SERVICE_UUID.replace(/-/g, ""),
        ],
      },
      [service],
    ),
    service,
    characteristics,
  };
}

function scanner(noble: FakeNoble): NobleBluetoothScanner {
  return new NobleBluetoothScanner(noble as unknown as Noble);
}

describe("Noble Bluetooth transport", () => {
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
      { id: "charger-id", name: "Easee charger" },
    ]);
    expect(noble.scanFilters).to.deep.equal([
      [BLUETOOTH_SERVICE_UUID.replace(/-/g, "")],
    ]);
    expect(noble.allowDuplicates).to.deep.equal([false]);
    expect(noble.stopScanningCount).to.equal(1);
    expect(noble.listenerCount("discover")).to.equal(0);
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
    const received: Buffer[] = [];

    await link.subscribe("hello", (data) => received.push(data));
    const hello = fixture.characteristics.find(
      (characteristic) =>
        characteristic.uuid === BLUETOOTH_CHARACTERISTICS.hello,
    )!;
    hello.emit("data", Buffer.from([1, 2, 3]), true);
    hello.emit("data", Buffer.from([9]), false);
    await link.write("hello", Buffer.from([4, 5]));

    expect(received).to.deep.equal([Buffer.from([1, 2, 3])]);
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

  it("disconnects when a requested GATT characteristic is missing", async () => {
    const noble = new FakeNoble();
    const fixture = makePeripheral({
      characteristicUuids: Object.values(BLUETOOTH_CHARACTERISTICS).filter(
        (uuid) => uuid !== BLUETOOTH_CHARACTERISTICS.command,
      ),
    });
    noble.peripherals.set(fixture.peripheral.id, fixture.peripheral);
    noble.discoverOnScan = [fixture.peripheral];
    const transport = scanner(noble);
    await transport.discover(BLUETOOTH_SERVICE_UUID, 20);

    await expectRejectedWithMessage(
      transport.connect({ id: fixture.peripheral.id }),
      "Expected exactly one BLE characteristic",
    );
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
