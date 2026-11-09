"use strict";

export {};

import { expect } from "chai";
import { readFileSync } from "node:fs";
import sinon from "sinon";
import Module from "node:module";
import type { Module as NodeModule } from "node:module";
import { afterEach, describe, it } from "mocha";
import type { BluetoothStatusEvent } from "../lib/bluetooth-client.ts";
import type {
  BluetoothAdapterState,
  BluetoothAdapterStatusProvider,
  BluetoothCandidate,
  BluetoothDiscoveryOptions,
  BluetoothScanner,
} from "../lib/bluetooth-transport.ts";

interface ModuleLoader {
  _load: (
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
  ) => unknown;
}

interface ScanResponse {
  result?: string;
  error?: string;
}

type BluetoothPhase = "p1" | "p2" | "p3";

interface PendingCircuitWrite {
  values: Partial<Record<BluetoothPhase, number>>;
  stateIds: Partial<Record<BluetoothPhase, string>>;
  sequence: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface ManualScanAdapter {
  connectionMode: string;
  unloading: boolean;
  bluetoothScanner: BluetoothScanner & BluetoothAdapterStatusProvider;
  bluetoothStartupComplete: boolean;
  bluetoothManualScanInFlight: boolean;
  bluetoothManualScanGeneration: number;
  bluetoothManualScanTask: Promise<readonly BluetoothCandidate[]> | null;
  bluetoothAdapterStateWrite: Promise<void>;
  bluetoothSearchReadinessWrite: Promise<void>;
  bluetoothPollInFlight: boolean;
  bluetoothWritesInFlight: number;
  bluetoothCircuitWrites: Map<string, PendingCircuitWrite>;
  bluetoothCircuitWritesInFlight: number;
  bluetoothReconnectInFlight: boolean;
  bluetoothConnections: Map<string, boolean>;
  bluetoothChargers: Array<{
    serialNumber: string;
    pin: string;
    name: string;
  }>;
  bluetoothConnectionErrors: Map<string, string>;
  bluetoothConnectionGenerations: Map<string, number>;
  bluetoothPauseRestore: Map<string, unknown>;
  bluetoothDisconnectWaiters: Map<string, Set<(disconnected: boolean) => void>>;
  handleBluetoothStatus(event: BluetoothStatusEvent): void;
  handleBluetoothStateChange(
    id: string,
    state: { val: unknown; ack: boolean },
  ): Promise<void>;
  flushBluetoothDynamicCircuitWrite(
    serial: string,
    pending: PendingCircuitWrite,
  ): Promise<void>;
  readBluetoothPoll: sinon.SinonStub;
  executeVerifiedBluetoothCommand: sinon.SinonStub;
  handleBluetoothConfigWrite: sinon.SinonStub;
  reportBluetoothWriteFailure: sinon.SinonStub;
  bluetoothPollTimer: unknown;
  bluetoothReconnectTimer: unknown;
  bluetoothReconnectDelay: number;
  config: Record<string, unknown>;
  setStateAsync: sinon.SinonStub;
  clearTimeout: sinon.SinonStub;
  scheduleBluetoothPoll: sinon.SinonStub;
  scheduleBluetoothReconnect: sinon.SinonStub;
  log: { info: sinon.SinonStub; warn: sinon.SinonStub };
  runBluetoothManualScan(): Promise<ScanResponse>;
  updateBluetoothAdapterState(state: BluetoothAdapterState): void;
  updateBluetoothSearchReadiness(): Promise<void>;
}

const moduleLoader = Module as unknown as ModuleLoader;
const originalLoad = moduleLoader._load;
moduleLoader._load = function (
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean,
) {
  if (request === "@iobroker/adapter-core") {
    return { Adapter: class {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const createAdapter = require("../main.ts");
moduleLoader._load = originalLoad;

function createHarness(
  state = "poweredOn",
  results: readonly BluetoothCandidate[] = [],
): {
  adapter: ManualScanAdapter;
  scanner: BluetoothScanner & {
    getAdapterState: sinon.SinonStub;
    discover: sinon.SinonStub;
  };
  stateWrites: sinon.SinonStub;
} {
  const adapter = Object.create(
    createAdapter.Easee.prototype,
  ) as ManualScanAdapter;
  const scanner = {
    getAdapterState: sinon.stub().returns(state),
    discover: sinon.stub().resolves(results),
    connect: sinon.stub(),
    close: sinon.stub().resolves(),
  } as unknown as BluetoothScanner & {
    getAdapterState: sinon.SinonStub;
    discover: sinon.SinonStub;
  };
  const stateWrites = sinon.stub().resolves();
  Object.assign(adapter, {
    connectionMode: "bluetooth",
    unloading: false,
    bluetoothScanner: scanner,
    bluetoothStartupComplete: true,
    bluetoothManualScanInFlight: false,
    bluetoothManualScanGeneration: 0,
    bluetoothManualScanTask: null,
    bluetoothAdapterStateWrite: Promise.resolve(),
    bluetoothSearchReadinessWrite: Promise.resolve(),
    bluetoothPollInFlight: false,
    bluetoothWritesInFlight: 0,
    bluetoothCircuitWrites: new Map(),
    bluetoothCircuitWritesInFlight: 0,
    bluetoothReconnectInFlight: false,
    bluetoothConnections: new Map([["EMX123456", true]]),
    bluetoothChargers: [
      { serialNumber: "EMX123456", pin: "secret-pin", name: "Garage" },
    ],
    bluetoothConnectionErrors: new Map(),
    bluetoothConnectionGenerations: new Map(),
    bluetoothPauseRestore: new Map(),
    bluetoothDisconnectWaiters: new Map(),
    handleBluetoothConfigWrite: sinon.stub().resolves(),
    readBluetoothPoll: sinon.stub().resolves({
      state: {
        dynamicCircuitCurrentP1: 0,
        dynamicCircuitCurrentP2: 0,
        dynamicCircuitCurrentP3: 0,
      },
    }),
    executeVerifiedBluetoothCommand: sinon.stub().resolves(),
    reportBluetoothWriteFailure: sinon.stub().resolves(),
    bluetoothPollTimer: null,
    bluetoothReconnectTimer: null,
    bluetoothReconnectDelay: 10000,
    config: {
      bluetoothChargerList: [
        { serialNumber: "EMX123456", pin: "secret-pin", name: "Garage" },
      ],
    },
    setStateAsync: stateWrites,
    clearTimeout: sinon.stub(),
    scheduleBluetoothPoll: sinon.stub(),
    scheduleBluetoothReconnect: sinon.stub(),
    log: { info: sinon.stub(), warn: sinon.stub() },
  });
  return { adapter, scanner, stateWrites };
}

function lastStateValue(stateWrites: sinon.SinonStub, id: string): unknown {
  return stateWrites
    .getCalls()
    .filter((call) => call.args[0] === id)
    .at(-1)?.args[1];
}

describe("manual Bluetooth search", () => {
  afterEach(() => sinon.restore());

  it("keeps the Admin request nonblocking and open for the 30-second scan", () => {
    const jsonConfig = JSON.parse(
      readFileSync("admin/jsonConfig.json", "utf8"),
    ) as {
      items: Record<string, { showProcess?: boolean; timeout?: number }>;
    };
    const manualSearch = jsonConfig.items._bluetoothManualSearch;

    expect(manualSearch.showProcess).to.equal(false);
    expect(manualSearch.timeout).to.be.greaterThan(30000);
  });

  it("searches for the Easee service and displays observed details without configuring devices", async () => {
    const candidates: BluetoothCandidate[] = [
      { id: "ble-id-1", name: "Easee Home secret-pin" },
      { id: "ble-id-2" },
    ];
    const { adapter, scanner, stateWrites } = createHarness(
      "poweredOn",
      candidates,
    );
    const originalConfig = JSON.stringify(adapter.config);
    adapter.bluetoothReconnectDelay = 300000;

    const response = await adapter.runBluetoothManualScan();

    expect(response).to.deep.equal({ result: "completed" });
    sinon.assert.calledOnce(scanner.discover);
    expect(scanner.discover.firstCall.args[1]).to.equal(30000);
    const infoMessages = adapter.log.info
      .getCalls()
      .map((call) => call.args[0]);
    expect(
      infoMessages.some((message) =>
        message.startsWith("Starting manual Bluetooth search"),
      ),
    ).to.equal(true);
    expect(
      infoMessages.some((message) =>
        /^Manual Bluetooth search completed in \d+ ms: 2 advertisement\(s\) matched the Easee service UUID or manufacturer ID 3118\.$/.test(
          message,
        ),
      ),
    ).to.equal(true);
    expect(infoMessages.join(" ")).not.to.contain("secret-pin");
    const finalState = stateWrites
      .getCalls()
      .map((call) => call.args[1])
      .find(
        (value) => typeof value === "string" && value.startsWith("Found 2"),
      );
    expect(finalState).to.contain("Easee Home [redacted]");
    expect(finalState).to.contain("ble-id-1");
    expect(finalState).to.contain("Name not broadcast");
    expect(finalState).to.contain("ble-id-2");
    expect(finalState).not.to.contain("EMX123456");
    expect(finalState).not.to.contain("secret-pin");
    const readiness = stateWrites
      .getCalls()
      .filter((call) => call.args[0] === "info.bluetoothSearchReadiness")
      .at(-1)?.args[1] as string;
    expect(readiness).to.contain("Ready to search");
    expect(readiness).not.to.contain("secret-pin");
    expect(JSON.stringify(adapter.config)).to.equal(originalConfig);
    sinon.assert.calledOnce(adapter.scheduleBluetoothPoll);
    sinon.assert.calledOnce(adapter.scheduleBluetoothReconnect);
    expect(adapter.bluetoothReconnectDelay).to.equal(10000);
  });

  it("persists live adapter states and ignores state events after shutdown", async () => {
    const { adapter, stateWrites } = createHarness();

    adapter.updateBluetoothAdapterState("poweredOn");
    await adapter.bluetoothAdapterStateWrite;
    expect(
      stateWrites
        .getCalls()
        .some(
          (call) =>
            call.args[0] === "info.bluetoothAdapterState" &&
            call.args[1] === "poweredOn",
        ),
    ).to.equal(true);
    expect(
      stateWrites
        .getCalls()
        .some(
          (call) =>
            call.args[0] === "info.bluetoothSearchReadiness" &&
            String(call.args[1]).startsWith("Ready to search"),
        ),
    ).to.equal(true);
    sinon.assert.calledWithExactly(
      adapter.log.info,
      "Local Bluetooth adapter state: poweredOn.",
    );

    const writesBeforeShutdown = stateWrites.callCount;
    adapter.unloading = true;
    adapter.updateBluetoothAdapterState("poweredOff");
    await adapter.bluetoothAdapterStateWrite;
    expect(stateWrites.callCount).to.equal(writesBeforeShutdown);
  });

  it("logs connection errors without exposing configured PINs", async () => {
    const { adapter, stateWrites } = createHarness();

    adapter.handleBluetoothStatus({
      serial: "EMX123456",
      name: "Garage",
      status: "connecting",
      error: new Error(
        "Authentication failed for charger EMX123456 at /org/bluez/hci0/dev_58_BF_25_22_05_3A (58:BF:25:22:05:3A) using PIN secret-pin",
      ),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const logs = [
      ...adapter.log.info.getCalls(),
      ...adapter.log.warn.getCalls(),
    ]
      .map((call) => call.args[0])
      .join(" ");
    expect(logs).to.contain(
      "Authentication failed for charger [redacted] at /org/bluez/hci0/dev_[redacted] ([redacted]) using PIN [redacted]",
    );
    expect(logs).not.to.contain("secret-pin");
    expect(logs).not.to.contain("EMX123456");
    expect(logs).not.to.contain("58:BF:25:22:05:3A");
    expect(logs).not.to.contain("dev_58_BF_25_22_05_3A");
    const states = JSON.stringify(
      stateWrites.getCalls().map((call) => call.args[1]),
    );
    expect(states).not.to.contain("secret-pin");
    expect(states).not.to.contain("EMX123456");
    expect(states).not.to.contain("58:BF:25:22:05:3A");
  });

  it("reports the local adapter as not ready without starting a search", async () => {
    const { adapter, scanner, stateWrites } = createHarness("unauthorized");

    const response = await adapter.runBluetoothManualScan();

    expect(response).to.deep.equal({ error: "notReady" });
    sinon.assert.notCalled(scanner.discover);
    expect(lastStateValue(stateWrites, "info.bluetoothScanResults")).to.contain(
      "unauthorized",
    );
    sinon.assert.calledWithMatch(
      adapter.log.warn,
      sinon.match((message: string) => message.includes("unauthorized")),
    );
    expect(adapter.bluetoothManualScanInFlight).to.equal(false);
  });

  it("does not search or create Bluetooth readiness states in Cloud mode", async () => {
    const { adapter, scanner, stateWrites } = createHarness();
    adapter.connectionMode = "cloud";

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "unavailable",
    });
    await adapter.updateBluetoothSearchReadiness();
    sinon.assert.notCalled(scanner.getAdapterState);
    sinon.assert.notCalled(scanner.discover);
    sinon.assert.notCalled(stateWrites);
  });

  it("distinguishes an empty result from adapter readiness", async () => {
    const { adapter, scanner, stateWrites } = createHarness("poweredOn", []);

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      result: "completed",
    });
    const finalState = lastStateValue(
      stateWrites,
      "info.bluetoothScanResults",
    ) as string;
    expect(finalState).to.contain("No matching advertisements");
    expect(finalState).to.contain(
      "does not establish whether a charger is available",
    );
    const infoMessages = adapter.log.info
      .getCalls()
      .map((call) => call.args[0] as string);
    expect(
      infoMessages.some((message) =>
        /^Manual Bluetooth search completed in \d+ ms: 0 advertisement\(s\) matched the Easee service UUID or manufacturer ID 3118\.$/.test(
          message,
        ),
      ),
    ).to.equal(true);
    expect(infoMessages.join(" ")).to.contain(
      "Unfiltered BLE diagnostics observed 0 advertisement(s)",
    );
    expect(
      (scanner.discover.firstCall.args[2] as BluetoothDiscoveryOptions)
        .scanWithoutServiceFilter,
    ).to.equal(true);
  });

  it("reports Easee manufacturer-signature matches without exposing advertisement data", async () => {
    const candidates: BluetoothCandidate[] = [
      { id: "easee-ble-id", name: "TEST0001", connectable: true },
    ];
    const { adapter, scanner, stateWrites } = createHarness(
      "poweredOn",
      candidates,
    );
    scanner.discover.callsFake(
      (
        _serviceUuid: string,
        _timeoutMs: number,
        options?: BluetoothDiscoveryOptions,
      ) => {
        options?.onAdvertisement?.({
          name: "TEST0001",
          serviceUuids: [],
          connectable: true,
          easeeManufacturerMatch: true,
        });
        return Promise.resolve(candidates);
      },
    );

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      result: "completed",
    });
    const finalState = lastStateValue(
      stateWrites,
      "info.bluetoothScanResults",
    ) as string;
    expect(finalState).to.contain("Found 1 matching advertisement");
    expect(finalState).to.contain(
      "TEST0001 [connectable; service UUIDs: none; manufacturer ID 3118: match]",
    );
    expect(finalState).not.to.contain("manufacturerData");
    expect(finalState).not.to.contain("de ad");
  });

  it("shows names, connectability and service UUIDs for nonmatching advertisements", async () => {
    const { adapter, scanner, stateWrites } = createHarness("poweredOn", []);
    scanner.discover.callsFake(
      (
        _serviceUuid: string,
        _timeoutMs: number,
        options?: BluetoothDiscoveryOptions,
      ) => {
        options?.onAdvertisement?.({
          name: "TEST0001",
          serviceUuids: ["180f"],
          connectable: false,
        });
        return Promise.resolve([]);
      },
    );
    const originalConfig = JSON.stringify(adapter.config);

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      result: "completed",
    });

    const finalState = lastStateValue(
      stateWrites,
      "info.bluetoothScanResults",
    ) as string;
    expect(finalState).to.contain("Noble observed 1 BLE advertisement(s)");
    expect(finalState).to.contain(
      "TEST0001 [not connectable; service UUIDs: 180f; manufacturer ID 3118: no match]",
    );
    expect(finalState).not.to.contain("secret-pin");
    expect(
      (scanner.discover.firstCall.args[2] as BluetoothDiscoveryOptions)
        .scanWithoutServiceFilter,
    ).to.equal(true);
    const infoMessages = adapter.log.info
      .getCalls()
      .map((call) => call.args[0])
      .join(" ");
    expect(infoMessages).to.contain(
      "TEST0001 [not connectable; service UUIDs: 180f; manufacturer ID 3118: no match]",
    );
    expect(infoMessages).not.to.contain("secret-pin");
    expect(JSON.stringify(adapter.config)).to.equal(originalConfig);
  });

  it("shows newly observed devices live during the bounded search", async () => {
    const { adapter, scanner, stateWrites } = createHarness();
    let finishSearch!: (results: readonly BluetoothCandidate[]) => void;
    scanner.discover.callsFake(
      (
        _serviceUuid: string,
        _timeoutMs: number,
        options?: BluetoothDiscoveryOptions,
      ) =>
        new Promise<readonly BluetoothCandidate[]>((resolve) => {
          finishSearch = resolve;
          options?.onAdvertisement?.({
            name: "TEST0001",
            serviceUuids: [],
            connectable: true,
          });
        }),
    );

    const search = adapter.runBluetoothManualScan();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const liveResults = stateWrites
      .getCalls()
      .filter(
        (call) =>
          call.args[0] === "info.bluetoothScanResults" &&
          typeof call.args[1] === "string" &&
          call.args[1].startsWith("Searching"),
      )
      .map((call) => call.args[1] as string);
    expect(liveResults.at(-1)).to.contain(
      "TEST0001 [connectable; service UUIDs: none; manufacturer ID 3118: no match]",
    );
    expect(adapter.bluetoothManualScanInFlight).to.equal(true);
    expect(scanner.discover.firstCall.args[1]).to.equal(30000);

    finishSearch([]);
    await search;
    expect(lastStateValue(stateWrites, "info.bluetoothScanResults")).to.contain(
      "No matching advertisements",
    );
  });

  it("shows scan errors and schedules the regular workflow again", async () => {
    const { adapter, scanner, stateWrites } = createHarness();
    scanner.discover.rejects(new Error("scan permission denied"));

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "failed",
    });
    expect(lastStateValue(stateWrites, "info.bluetoothScanResults")).to.contain(
      "scan permission denied",
    );
    sinon.assert.calledOnce(adapter.log.warn);
    sinon.assert.calledOnce(adapter.scheduleBluetoothPoll);
    sinon.assert.calledOnce(adapter.scheduleBluetoothReconnect);
  });

  it("reports a bounded scan timeout without treating it as a charger state", async () => {
    const { adapter, scanner, stateWrites } = createHarness();
    scanner.discover.rejects(
      new Error("Timed out waiting for the BLE adapter"),
    );

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "failed",
    });
    expect(lastStateValue(stateWrites, "info.bluetoothScanResults")).to.contain(
      "Timed out waiting for the BLE adapter",
    );
  });

  it("rejects overlapping searches and searches during polling or reconnect", async () => {
    const { adapter, scanner } = createHarness();
    let finishSearch!: (results: readonly BluetoothCandidate[]) => void;
    scanner.discover.returns(
      new Promise<readonly BluetoothCandidate[]>((resolve) => {
        finishSearch = resolve;
      }),
    );

    const firstSearch = adapter.runBluetoothManualScan();
    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "busy",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    sinon.assert.calledOnce(scanner.discover);
    finishSearch([]);
    await firstSearch;

    adapter.bluetoothPollInFlight = true;
    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "busy",
    });
    adapter.bluetoothPollInFlight = false;
    adapter.bluetoothReconnectInFlight = true;
    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "busy",
    });
    sinon.assert.calledOnce(scanner.discover);
  });

  it("reports why a scan is rejected during automatic reconnection", async () => {
    const { adapter, scanner, stateWrites } = createHarness();
    adapter.bluetoothReconnectInFlight = true;

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "busy",
    });
    expect(stateWrites.lastCall.args[1]).to.contain(
      "Bluetooth reconnection is active",
    );
    expect(
      stateWrites
        .getCalls()
        .filter((call) => call.args[0] === "info.bluetoothSearchReadiness")
        .at(-1)?.args[1],
    ).to.equal("Busy: Bluetooth reconnection is active.");
    sinon.assert.calledWithExactly(
      adapter.log.info,
      "Manual Bluetooth search not started: Bluetooth reconnection is active (startupComplete=true, scanInFlight=false, pollInFlight=false, writesInFlight=0, circuitWritesPending=0, circuitWritesActive=0, reconnectInFlight=true).",
    );
    sinon.assert.notCalled(scanner.discover);
  });

  it("shows when the initial charger connection blocks a manual search", async () => {
    const { adapter, scanner, stateWrites } = createHarness();
    adapter.bluetoothStartupComplete = false;

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "busy",
    });
    expect(
      stateWrites
        .getCalls()
        .filter((call) => call.args[0] === "info.bluetoothSearchReadiness")
        .at(-1)?.args[1],
    ).to.contain("initial Bluetooth connection attempt is running");
    sinon.assert.notCalled(scanner.discover);
  });

  it("rejects a manual scan while a BLE write is in flight", async () => {
    const { adapter, scanner } = createHarness();
    adapter.bluetoothWritesInFlight = 1;

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "busy",
    });
    sinon.assert.notCalled(scanner.discover);
  });

  it("rejects a manual scan while a dynamic current update is pending", async () => {
    const { adapter, scanner, stateWrites } = createHarness();
    adapter.bluetoothCircuitWrites.set("EMX123456", {
      values: { p1: 12 },
      stateIds: { p1: "easee.0.EMX123456.config.dynamicCircuitCurrentP1" },
      sequence: 1,
    });

    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "busy",
    });
    expect(stateWrites.lastCall.args[1]).to.contain(
      "Bluetooth current update is pending or active",
    );
    sinon.assert.notCalled(scanner.discover);
  });

  it("blocks a manual scan while a dynamic current update is flushing", async () => {
    const { adapter, scanner } = createHarness();
    const serial = "EMX123456";
    adapter.bluetoothConnectionGenerations.set(serial, 0);
    let finishWrite!: () => void;
    let notifyWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      notifyWriteStarted = resolve;
    });
    adapter.executeVerifiedBluetoothCommand.callsFake(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
          notifyWriteStarted();
        }),
    );

    const flush = adapter.flushBluetoothDynamicCircuitWrite(serial, {
      values: { p1: 12 },
      stateIds: { p1: `easee.0.${serial}.config.dynamicCircuitCurrentP1` },
      sequence: 1,
    });
    await writeStarted;
    expect(adapter.bluetoothCircuitWritesInFlight).to.equal(1);
    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "busy",
    });
    sinon.assert.notCalled(scanner.discover);

    finishWrite();
    await flush;
    expect(adapter.bluetoothCircuitWritesInFlight).to.equal(0);
  });

  it("rejects BLE writes received during a manual scan", async () => {
    const { adapter } = createHarness();
    adapter.bluetoothManualScanInFlight = true;

    await adapter.handleBluetoothStateChange(
      "easee.0.EMX123456.config.maxChargerCurrent",
      { val: 32, ack: false },
    );

    sinon.assert.calledOnce(adapter.reportBluetoothWriteFailure);
    sinon.assert.notCalled(adapter.handleBluetoothConfigWrite);
    expect(adapter.bluetoothWritesInFlight).to.equal(0);
  });

  it("blocks a manual scan until an active BLE write completes", async () => {
    const { adapter, scanner } = createHarness();
    let finishWrite!: () => void;
    adapter.handleBluetoothConfigWrite.returns(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );

    const write = adapter.handleBluetoothStateChange(
      "easee.0.EMX123456.config.maxChargerCurrent",
      { val: 32, ack: false },
    );
    expect(adapter.bluetoothWritesInFlight).to.equal(1);
    expect(await adapter.runBluetoothManualScan()).to.deep.equal({
      error: "busy",
    });
    sinon.assert.notCalled(scanner.discover);

    finishWrite();
    await write;
    expect(adapter.bluetoothWritesInFlight).to.equal(0);
  });

  it("does not publish results from an invalidated scan", async () => {
    const { adapter, scanner, stateWrites } = createHarness("poweredOn", [
      { id: "old-result", name: "Stale charger" },
    ]);
    let finishSearch!: (results: readonly BluetoothCandidate[]) => void;
    scanner.discover.returns(
      new Promise<readonly BluetoothCandidate[]>((resolve) => {
        finishSearch = resolve;
      }),
    );

    const search = adapter.runBluetoothManualScan();
    await new Promise<void>((resolve) => setImmediate(resolve));
    adapter.unloading = true;
    adapter.bluetoothManualScanGeneration += 1;
    adapter.bluetoothManualScanInFlight = false;
    finishSearch([{ id: "old-result", name: "Stale charger" }]);
    await search;

    expect(stateWrites.getCalls().map((call) => call.args[1])).not.to.include(
      "Found 1 matching advertisement(s):\n- Stale charger [connectability unknown] (observed BLE identifier: old-result)",
    );
  });
});
