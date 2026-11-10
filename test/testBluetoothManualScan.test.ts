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

interface AdminConfigItem {
  type?: string;
  label?: string;
  hidden?: string;
  text?: string;
  help?: string;
  oid?: string;
  showProcess?: boolean;
  timeout?: number;
  items?: Record<string, AdminConfigItem>;
}

interface AdminConfigPanel extends AdminConfigItem {
  items: Record<string, AdminConfigItem>;
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
  bluetoothConnectingLogged: Set<string>;
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
  log: {
    debug: sinon.SinonStub;
    error: sinon.SinonStub;
    info: sinon.SinonStub;
    warn: sinon.SinonStub;
  };
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
    return {
      Adapter: class {},
      I18n: {
        init: () => Promise.resolve(),
        t: (key: string, ...args: (string | number | boolean | null)[]) =>
          args.reduce<string>(
            (text, arg) =>
              text.replace("%s", arg === null ? "null" : String(arg)),
            key,
          ),
      },
    };
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
    bluetoothConnectingLogged: new Set(),
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
    log: {
      debug: sinon.stub(),
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    },
  });
  return { adapter, scanner, stateWrites };
}

function lastStateValue(stateWrites: sinon.SinonStub, id: string): unknown {
  return stateWrites
    .getCalls()
    .filter((call) => call.args[0] === id)
    .at(-1)?.args[1];
}

function readBluetoothTabs(): {
  root: AdminConfigItem;
  connection: AdminConfigPanel;
  advanced: AdminConfigPanel;
} {
  const root = JSON.parse(
    readFileSync("admin/jsonConfig.json", "utf8"),
  ) as AdminConfigItem;
  const connection = root.items?.connection;
  const advanced = root.items?.bluetoothAdvanced;
  if (
    root.type !== "tabs" ||
    !root.items ||
    !connection?.items ||
    !advanced?.items
  ) {
    throw new Error("Bluetooth settings tabs are not configured");
  }
  return {
    root,
    connection: connection as AdminConfigPanel,
    advanced: advanced as AdminConfigPanel,
  };
}

describe("manual Bluetooth search", () => {
  afterEach(() => sinon.restore());

  it("keeps the Admin request nonblocking and open for the 30-second scan", () => {
    const { advanced } = readBluetoothTabs();
    const manualSearch = advanced.items._bluetoothManualSearch;

    expect(manualSearch.showProcess).to.equal(false);
    expect(manualSearch.timeout).to.be.greaterThan(30000);
  });

  it("keeps connection settings and advanced Bluetooth functions in two tabs", () => {
    const { root, connection, advanced } = readBluetoothTabs();
    const connectionItems = connection.items;
    const advancedItems = advanced.items;
    const info = connectionItems._bluetoothInfo;

    expect(root.type).to.equal("tabs");
    expect(Object.keys(root.items!)).to.deep.equal([
      "connection",
      "bluetoothAdvanced",
    ]);
    expect(connection.type).to.equal("panel");
    expect(connection.label).to.equal("Connection");
    expect(connection.items.connectionMode.label).to.equal("Connection mode");
    expect(connectionItems).to.have.property("username");
    expect(connectionItems).to.have.property("polltime");
    expect(connectionItems).to.have.property("_bluetoothInfo");
    expect(connectionItems).to.have.property("_bluetoothDeviceManager");
    expect(advanced.type).to.equal("panel");
    expect(advanced.label).to.equal("Advanced Bluetooth functions");
    expect(advanced.hidden).to.equal("data.connectionMode !== 'bluetooth'");
    expect(Object.keys(advancedItems)).to.deep.equal([
      "bluetoothBinding",
      "_bluetoothAdapterStatusLabel",
      "_bluetoothAdapterStatus",
      "_bluetoothSearchReadinessLabel",
      "_bluetoothSearchReadiness",
      "_bluetoothManualSearch",
      "_bluetoothScanResultsLabel",
      "_bluetoothScanResults",
    ]);
    for (const advancedKey of Object.keys(advancedItems)) {
      expect(connectionItems).not.to.have.property(advancedKey);
    }
    expect(info.text).to.contain("ID or serial number and Bluetooth PIN");
    expect(info.text).to.contain("Save the settings and restart the adapter");
    expect(info.text).to.contain(
      "Manual search is optional and does not replace the ID or PIN",
    );
    expect(advancedItems.bluetoothBinding.label).to.equal(
      "Bluetooth connection method",
    );
    expect(advancedItems._bluetoothAdapterStatus.oid).to.equal(
      "info.bluetoothAdapterStateDisplay",
    );
    expect(advancedItems._bluetoothSearchReadiness.oid).to.equal(
      "info.bluetoothSearchReadinessDisplay",
    );
    expect(advancedItems._bluetoothManualSearch.label).to.equal(
      "Search for nearby Easee chargers",
    );
    expect(advancedItems._bluetoothScanResults.oid).to.equal(
      "info.bluetoothScanResults",
    );
    const settingText = JSON.stringify([info, ...Object.values(advancedItems)]);
    for (const technicalTerm of [
      "poweredOn",
      "NOBLE_BINDINGS",
      "CAP_NET_RAW",
      "BlueZ",
    ]) {
      expect(settingText).not.to.contain(technicalTerm);
    }
  });

  it("provides Bluetooth display text in every supported Admin language", () => {
    const languages = [
      "de",
      "en",
      "es",
      "fr",
      "it",
      "nl",
      "pl",
      "pt",
      "ru",
      "uk",
      "zh-cn",
    ];
    const keys = [
      "Connection",
      "Advanced Bluetooth functions",
      "1. In the device manager below, enter each charger's ID or serial number and Bluetooth PIN. 2. Save the settings and restart the adapter. 3. Manual search is optional and does not replace the ID or PIN.",
      "Search results show detected names, identifiers, and technical scan details. Use the device manager to add chargers.",
      "Bluetooth status",
      "Bluetooth connection method",
      "Search for nearby Easee chargers",
      "Shows whether Bluetooth on the computer running ioBroker is available. It does not show whether a charger was found or connected.",
      "Can a search be started?",
      "Shows whether the adapter can start a search right now.",
      "Use Automatic unless you need to choose a connection method. The default works best on most systems. See the Bluetooth guide if a search does not work.",
      "Automatic (recommended)",
      "System Bluetooth service (Linux)",
      "Direct adapter access (advanced)",
      "The local Bluetooth adapter is ready.",
      "Bluetooth is turned off.",
      "Bluetooth access is not allowed.",
      "Bluetooth is not supported on this device.",
      "Bluetooth status is unknown.",
      "The adapter is stopping.",
      "Bluetooth search is available only in Bluetooth mode.",
      "Bluetooth search failed. Check that Bluetooth is on and that ioBroker is allowed to use it. See the adapter log for details.",
      "The local Bluetooth adapter is not ready.",
      "Bluetooth is starting.",
      "Bluetooth is not available. Check the adapter log for details.",
      "Bluetooth is not available. Check that it is turned on and accessible.",
      "Bluetooth is connecting to the saved charger.",
      "A Bluetooth search is already running.",
      "The adapter is checking the saved charger.",
      "The adapter is sending a command to the charger.",
      "The adapter is updating the charger settings.",
      "The adapter is reconnecting to the charger.",
      "Ready to search for nearby chargers.",
      "Waiting for Bluetooth to become available.",
      "No search has been run yet.",
      "Bluetooth is busy. Please try again in a moment.",
      "Bluetooth is not available. Check that it is turned on and accessible.",
      "Searching for nearby Easee chargers. Please wait up to %s seconds.",
      "Bluetooth devices were detected, but no Easee charger was recognized. The charger may be out of range or not ready for Bluetooth.",
      "No Easee charger was detected. It may be out of range or not ready for Bluetooth.",
      "Found one possible Easee charger.",
      "Found %s possible Easee chargers.",
      "Device name not available.",
      "And %s more.",
    ];

    for (const language of languages) {
      const catalog = JSON.parse(
        readFileSync(`admin/i18n/${language}.json`, "utf8"),
      ) as Record<string, string>;
      for (const key of keys) {
        expect(catalog[key], `${language}: ${key}`).to.be.a("string").and.not
          .empty;
      }
    }
  });

  it("keeps the Device Manager directly below the setup info in the Connection tab", () => {
    const { connection, advanced } = readBluetoothTabs();
    const connectionItems = connection.items;
    const advancedItems = advanced.items;
    const deviceManager = connectionItems._bluetoothDeviceManager;

    expect(deviceManager.type).to.equal("deviceManager");
    expect(deviceManager.hidden).to.equal(
      "data.connectionMode !== 'bluetooth'",
    );
    expect(connectionItems._bluetoothInfo.type).to.equal("infoBox");
    expect(connectionItems._bluetoothInfo.hidden).to.equal(
      "data.connectionMode !== 'bluetooth'",
    );
    const connectionItemKeys = Object.keys(connectionItems);
    const bluetoothInfoIndex = connectionItemKeys.indexOf("_bluetoothInfo");
    expect(
      connectionItemKeys.slice(bluetoothInfoIndex, bluetoothInfoIndex + 2),
    ).to.deep.equal(["_bluetoothInfo", "_bluetoothDeviceManager"]);
    expect(advancedItems).to.have.property("_bluetoothManualSearch");
    expect(advancedItems).to.have.property("_bluetoothScanResults");
  });

  it("shows useful scan identifiers while redacting PINs without configuring devices", async () => {
    const candidates: BluetoothCandidate[] = [
      {
        id: "58:BF:25:22:05:3A",
        name: "Easee Home EMX123456 secret-pin PIN=1234 PIN 5678",
      },
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
    expect(finalState).to.contain(
      "Easee Home EMX123456 [redacted] PIN [redacted] PIN [redacted]",
    );
    expect(finalState).not.to.contain("5678");
    expect(finalState).to.contain("58:BF:25:22:05:3A");
    expect(finalState).to.contain("Name not broadcast");
    expect(finalState).to.contain("ble-id-2");
    expect(finalState).not.to.contain("secret-pin");
    expect(finalState).not.to.contain("[redacted] at");
    expect(finalState).to.contain("Noble observed 0 BLE advertisement(s)");
    const displayResults = lastStateValue(
      stateWrites,
      "info.bluetoothScanResultsDisplay",
    ) as string;
    expect(displayResults).to.contain("Found 2 possible Easee chargers.");
    expect(displayResults).to.contain("Easee Home EMX123456 [redacted]");
    expect(displayResults).not.to.contain("ble-id");
    expect(displayResults).not.to.contain("Noble observed");
    expect(displayResults).not.to.contain("service UUID");
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

    adapter.updateBluetoothAdapterState("unknown");
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
    expect(
      lastStateValue(stateWrites, "info.bluetoothAdapterStateDisplay"),
    ).to.equal("The local Bluetooth adapter is ready.");
    expect(
      lastStateValue(stateWrites, "info.bluetoothSearchReadinessDisplay"),
    ).to.equal("Ready to search for nearby chargers.");
    sinon.assert.calledWithExactly(
      adapter.log.debug,
      "Local Bluetooth adapter state: unknown.",
    );
    sinon.assert.calledWithExactly(
      adapter.log.debug,
      "Local Bluetooth adapter state changed from unknown to poweredOn.",
    );
    sinon.assert.notCalled(adapter.log.info);

    const writesBeforeShutdown = stateWrites.callCount;
    adapter.unloading = true;
    adapter.updateBluetoothAdapterState("poweredOff");
    await adapter.bluetoothAdapterStateWrite;
    expect(stateWrites.callCount).to.equal(writesBeforeShutdown);
  });

  it("keeps the internal stop status while showing a friendly status", async () => {
    const { adapter, stateWrites } = createHarness();
    adapter.unloading = true;

    await adapter.updateBluetoothSearchReadiness();

    expect(
      lastStateValue(stateWrites, "info.bluetoothSearchReadiness"),
    ).to.equal("The adapter is stopping.");
    expect(
      lastStateValue(stateWrites, "info.bluetoothSearchReadinessDisplay"),
    ).to.equal("The adapter is stopping.");
  });

  it("logs one connecting state and reports failure only after three attempts", () => {
    const { adapter } = createHarness();
    const identity = { serial: "EMX123456", name: "Garage" };

    adapter.handleBluetoothStatus({
      ...identity,
      status: "scanning",
      attempt: 1,
      maxAttempts: 3,
    });
    adapter.handleBluetoothStatus({
      ...identity,
      status: "connecting",
      attempt: 1,
      maxAttempts: 3,
    });
    adapter.handleBluetoothStatus({
      ...identity,
      status: "connecting",
      error: new Error("Unknown Connection Identifier (0x2)"),
      attempt: 1,
      maxAttempts: 3,
    });
    adapter.handleBluetoothStatus({
      ...identity,
      status: "disconnected",
      error: new Error("Unknown Connection Identifier (0x2)"),
      attempt: 1,
      maxAttempts: 3,
    });
    adapter.handleBluetoothStatus({
      ...identity,
      status: "scanning",
      attempt: 2,
      maxAttempts: 3,
    });
    adapter.handleBluetoothStatus({
      ...identity,
      status: "connecting",
      attempt: 2,
      maxAttempts: 3,
    });
    adapter.handleBluetoothStatus({
      ...identity,
      status: "disconnected",
      error: new Error("Disconnected 62"),
      attempt: 2,
      maxAttempts: 3,
    });
    adapter.handleBluetoothStatus({
      ...identity,
      status: "scanning",
      attempt: 3,
      maxAttempts: 3,
    });
    adapter.handleBluetoothStatus({
      ...identity,
      status: "connecting",
      attempt: 3,
      maxAttempts: 3,
    });
    adapter.handleBluetoothStatus({
      ...identity,
      status: "disconnected",
      error: new Error("Disconnected 62"),
      attempt: 3,
      maxAttempts: 3,
      retryExhausted: true,
    });

    sinon.assert.calledOnceWithExactly(
      adapter.log.info,
      "Bluetooth connection state: connecting",
    );
    sinon.assert.calledOnceWithExactly(
      adapter.log.error,
      "Bluetooth connection failed after 3 attempts for Garage: Disconnected 62",
    );
    sinon.assert.notCalled(adapter.log.warn);
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
      ...adapter.log.debug.getCalls(),
      ...adapter.log.error.getCalls(),
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
    expect(
      lastStateValue(stateWrites, "info.bluetoothScanResultsDisplay"),
    ).to.equal("The local Bluetooth adapter is not ready.");
    expect(
      lastStateValue(stateWrites, "info.bluetoothAdapterStateDisplay"),
    ).to.equal("Bluetooth access is not allowed.");
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
    expect(
      lastStateValue(stateWrites, "info.bluetoothScanResultsDisplay"),
    ).to.equal(
      "No Easee charger was detected. It may be out of range or not ready for Bluetooth.",
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
      {
        id: "58:BF:25:22:05:3A",
        name: "TEST0001 EMX123456 secret-pin",
        connectable: true,
      },
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
          name: "TEST0001 EMX123456 secret-pin",
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
      "TEST0001 EMX123456 [redacted] [connectable; service UUIDs: none; manufacturer ID 3118: match]",
    );
    expect(finalState).to.contain("58:BF:25:22:05:3A");
    expect(finalState).not.to.contain("secret-pin");
    expect(finalState).not.to.contain("manufacturerData");
    expect(finalState).not.to.contain("de ad");
    const infoMessages = adapter.log.info
      .getCalls()
      .map((call) => call.args[0] as string)
      .join(" ");
    expect(infoMessages).to.contain("TEST0001 [redacted] [redacted]");
    expect(infoMessages).not.to.contain("EMX123456");
    expect(infoMessages).not.to.contain("secret-pin");
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
      lastStateValue(stateWrites, "info.bluetoothScanResultsDisplay"),
    ).to.equal(
      "Bluetooth devices were detected, but no Easee charger was recognized. The charger may be out of range or not ready for Bluetooth.",
    );
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
    const liveDisplay = stateWrites
      .getCalls()
      .filter(
        (call) =>
          call.args[0] === "info.bluetoothScanResultsDisplay" &&
          typeof call.args[1] === "string" &&
          call.args[1].startsWith("Searching"),
      )
      .at(-1)?.args[1] as string;
    expect(liveDisplay).to.equal(
      "Searching for nearby Easee chargers. Please wait up to 30 seconds.",
    );
    expect(liveDisplay).not.to.contain("advertisement");
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
    expect(
      lastStateValue(stateWrites, "info.bluetoothScanResultsDisplay"),
    ).to.equal(
      "Bluetooth search failed. Check that Bluetooth is on and that ioBroker is allowed to use it. See the adapter log for details.",
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
    expect(lastStateValue(stateWrites, "info.bluetoothScanResults")).to.contain(
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
      "Manual Bluetooth search not started: Bluetooth reconnection is active (adapterState=unknown, scannerAvailable=true, startupComplete=true, scanInFlight=false, pollInFlight=false, writesInFlight=0, circuitWritesPending=0, circuitWritesActive=0, reconnectInFlight=true).",
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
    expect(lastStateValue(stateWrites, "info.bluetoothScanResults")).to.contain(
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
