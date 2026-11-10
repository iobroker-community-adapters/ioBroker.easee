"use strict";

import { expect } from "chai";
import sinon from "sinon";
import axios from "axios";
import * as signalR from "@microsoft/signalr";
import Module from "node:module";
import type { Module as NodeModule } from "node:module";
import { afterEach, describe, it } from "mocha";

interface ModuleLoader {
  _load: (
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
  ) => unknown;
}

const moduleLoader = Module as unknown as ModuleLoader;
const originalLoad = moduleLoader._load;
let nobleScannerFactoryOverride: (() => Promise<unknown>) | undefined;
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
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (
    request === "./lib/noble-bluetooth-transport.ts" &&
    parent?.filename.endsWith("/main.ts")
  ) {
    const transport = loaded as {
      createNobleBluetoothScanner: () => Promise<unknown>;
    };
    return {
      ...transport,
      createNobleBluetoothScanner: () =>
        nobleScannerFactoryOverride?.() ??
        transport.createNobleBluetoothScanner(),
    };
  }
  return loaded;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const createAdapter = require("./src/main.ts");
moduleLoader._load = originalLoad;

function createAdapterHarness(): ReturnType<typeof createAdapter> {
  const adapter = Object.create(createAdapter.Easee.prototype);
  adapter.log = {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  };
  adapter.setTimeout = (callback: () => void, delay: number) =>
    globalThis.setTimeout(callback, delay) as unknown as ioBroker.Timeout;
  adapter.clearTimeout = (timer: ioBroker.Timeout | undefined) => {
    if (timer !== null && timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  };
  adapter.setStateAsync = sinon.stub().resolves();
  adapter.getStateAsync = sinon.stub().resolves(null);
  adapter.apiRetryState = new Map();
  adapter.pendingSiteConfigRetries = new Map();
  adapter.unloading = false;
  adapter.dynamicCircuitCurrent = {
    p1: 0,
    p2: 0,
    p3: 0,
  };
  adapter.dynamicCircuitCurrentByCharger = new Map();
  adapter.dynamicCircuitCurrentByCircuit = new Map();
  adapter.dynamicCircuitCurrentSequence = 0;
  adapter.circuitMaxCurrentByCircuit = new Map();
  adapter.circuitMaxCurrentSequence = 0;
  adapter.dynamicCircuitCurrentTimers = new Set();
  adapter.signalRSubscribedChargers = new Set();
  adapter.observationVersions = new Map();
  adapter.observedStateWrites = new Map();
  adapter.lastChargerOpModes = new Map();
  adapter.chargerSessionStarts = new Map();
  adapter.chargerSessionGenerations = new Map();
  adapter.chargerSessionAuthTokenResolved = new Set();
  adapter.pendingSessionAuthTokenLookups = new Map();
  adapter.chargerIds = [];
  adapter.namespace = "easee.0";
  adapter.connectionMode = "cloud";
  adapter.reconcileModeSpecificObjects = sinon.stub().resolves();
  adapter.chargerNameQueue = Promise.resolve();
  adapter.chargerNameVersions = new Map();
  adapter.chargerNamePending = new Map();
  adapter.signalRSubscriptionPromises = new Map();
  adapter.sessionChargers = [];
  adapter.sessionCursor = 0;
  adapter.sessionPollTimer = null;
  adapter.sessionInFlight = null;
  adapter.sessionAbortController = null;
  adapter.sessionLastRequestAt = null;
  adapter.sessionRetryAt = 0;
  adapter.updateSiteConfigWithRetry = sinon
    .stub()
    .callsFake(
      (
        chargerId: string,
        _stateId: string,
        _description: string,
        update: (site: {
          id: string;
          circuits: { id: string; chargers: { id: string }[] }[];
        }) => Promise<void>,
      ) =>
        update({
          id: `site-${chargerId}`,
          circuits: [
            {
              id: `circuit-${chargerId}`,
              chargers: [{ id: chargerId }],
            },
          ],
        }),
    );
  adapter.getChargerSite = sinon.stub().callsFake((chargerId: string) =>
    Promise.resolve({
      id: `site-${chargerId}`,
      circuits: [
        {
          id: `circuit-${chargerId}`,
          chargers: [{ id: chargerId }],
        },
      ],
    }),
  );
  return adapter;
}

function createBluetoothStartupHarness(): ReturnType<typeof createAdapter> {
  const adapter = createAdapterHarness();
  adapter.connectionMode = "bluetooth";
  adapter.config = { bluetoothBinding: "auto" };
  adapter.configuredBluetoothChargers = [
    { serialNumber: "EMX12345", pin: "1234", name: "Garage charger" },
  ];
  adapter.bluetoothClient = null;
  adapter.bluetoothScanner = null;
  adapter.bluetoothAdapterStateWrite = Promise.resolve();
  adapter.bluetoothConnections = new Map();
  adapter.bluetoothConnectionErrors = new Map();
  adapter.bluetoothConnectingLogged = new Set();
  adapter.bluetoothConnectionGenerations = new Map();
  adapter.getConfiguredBluetoothChargers = sinon
    .stub()
    .returns(adapter.configuredBluetoothChargers);
  adapter.setObjectNotExistsAsync = sinon.stub().resolves();
  adapter.setAllStatusObjects = sinon.stub().resolves();
  adapter.setAllConfigObjects = sinon.stub().resolves();
  adapter.setBluetoothInfoObjects = sinon.stub().resolves();
  adapter.configurePollInterval = sinon.stub();
  adapter.updateBluetoothSearchReadiness = sinon.stub().resolves();
  adapter.scheduleBluetoothPoll = sinon.stub();
  adapter.scheduleBluetoothReconnect = sinon.stub();
  return adapter;
}

function attachObjectStore(
  adapter: ReturnType<typeof createAdapter>,
): Map<
  string,
  { type: string; common?: Record<string, unknown>; native?: unknown }
> {
  const objects = new Map<
    string,
    { type: string; common?: Record<string, unknown>; native?: unknown }
  >();
  adapter.setObjectNotExistsAsync = sinon.stub().callsFake((id, object) => {
    if (!objects.has(id)) {
      objects.set(id, object);
    }
    return Promise.resolve();
  });
  adapter.getObjectViewAsync = sinon
    .stub()
    .callsFake((_design: string, search: string) => {
      const objectType = search === "device" ? "device" : "state";
      return Promise.resolve({
        rows: [...objects.entries()]
          .filter(([, object]) => object.type === objectType)
          .map(([id, value]) => ({ id: `${adapter.namespace}.${id}`, value })),
      });
    });
  adapter.delObjectAsync = sinon.stub().callsFake((id: string) => {
    objects.delete(id);
    return Promise.resolve();
  });
  adapter.extendObjectAsync = sinon.stub().resolves();
  adapter.subscribeStates = sinon.stub();
  return objects;
}

describe("Bluetooth startup shutdown races", () => {
  afterEach(() => {
    nobleScannerFactoryOverride = undefined;
    sinon.restore();
  });

  it("closes a scanner created after unload without starting the Bluetooth client", async () => {
    const adapter = createBluetoothStartupHarness();
    const scanner = {
      close: sinon.stub().resolves(),
      getBinding: sinon.stub().returns("dbus"),
      getAdapterState: sinon.stub().returns("poweredOn"),
      onAdapterStateChange: sinon.stub().returns(sinon.stub()),
    };
    let resolveScanner!: (value: unknown) => void;
    let notifyFactoryCall!: () => void;
    const factoryCalled = new Promise<void>((resolve) => {
      notifyFactoryCall = resolve;
    });
    nobleScannerFactoryOverride = () => {
      notifyFactoryCall();
      return new Promise((resolve) => {
        resolveScanner = resolve;
      });
    };

    const startup = adapter.startBluetooth();
    await factoryCalled;
    adapter.unloading = true;
    resolveScanner(scanner);
    await startup;

    expect(scanner.close.calledOnce).to.equal(true);
    expect(scanner.onAdapterStateChange.called).to.equal(false);
    expect(adapter.bluetoothScanner).to.equal(null);
    expect(adapter.bluetoothClient).to.equal(null);
    expect(adapter.configurePollInterval.called).to.equal(false);
  });

  it("reports a valid empty configuration separately from an invalid one", async () => {
    const adapter = createBluetoothStartupHarness();
    adapter.getConfiguredBluetoothChargers.returns([]);
    const scanner = {
      close: sinon.stub().resolves(),
      getBinding: sinon.stub().returns("dbus"),
      getAdapterState: sinon.stub().returns("poweredOn"),
      onAdapterStateChange: sinon.stub().returns(sinon.stub()),
    };
    nobleScannerFactoryOverride = () => Promise.resolve(scanner);

    await adapter.startBluetooth();

    const infoLogs = JSON.stringify(adapter.log.info.args);
    const debugLogs = JSON.stringify(adapter.log.debug.args);
    expect(infoLogs).to.include("no chargers are configured");
    expect(debugLogs).to.include("Using Noble Bluetooth binding: dbus.");
    expect(infoLogs).not.to.include("Using Noble Bluetooth binding");
    expect(infoLogs).not.to.include("configuration is invalid");
    expect(adapter.log.error.called).to.equal(false);
  });

  it("reports invalid stored configuration without treating it as empty or logging secrets", async () => {
    const adapter = createBluetoothStartupHarness();
    const encryptedPin = "easee:v1:stored-ciphertext-secret";
    const decryptError = "decrypt-error-secret";
    adapter.config = {
      bluetoothChargerList: [
        {
          serialNumber: "EMX12345",
          pin: encryptedPin,
          name: "Garage charger",
        },
      ],
    };
    adapter.decrypt = sinon.stub().throws(new Error(decryptError));
    adapter.getConfiguredBluetoothChargers =
      createAdapter.Easee.prototype.getConfiguredBluetoothChargers.bind(
        adapter,
      );
    const scanner = {
      close: sinon.stub().resolves(),
      getBinding: sinon.stub().returns("dbus"),
      getAdapterState: sinon.stub().returns("poweredOn"),
      onAdapterStateChange: sinon.stub().returns(sinon.stub()),
    };
    nobleScannerFactoryOverride = () => Promise.resolve(scanner);

    await adapter.startBluetooth();

    const logs = JSON.stringify({
      error: adapter.log.error.args,
      info: adapter.log.info.args,
      warn: adapter.log.warn.args,
    });
    expect(logs).to.include("entry 1 field pin");
    expect(logs).to.include("configuration is invalid");
    expect(logs).not.to.include(encryptedPin);
    expect(logs).not.to.include(decryptError);
    expect(logs).not.to.include("no chargers are configured");
    expect(logs).not.to.include("0 configured charger(s)");
    expect(adapter.configuredBluetoothChargers).to.deep.equal([]);
  });

  it("stops initialization when unload begins during adapter status update", async () => {
    const adapter = createBluetoothStartupHarness();
    const scanner = {
      close: sinon.stub().resolves(),
      discover: sinon.stub().resolves([]),
      getBinding: sinon.stub().returns("dbus"),
      getAdapterState: sinon.stub().returns("poweredOn"),
      onAdapterStateChange: sinon.stub().returns(sinon.stub()),
      connect: sinon.stub(),
    };
    let releaseStatusWrite!: () => void;
    let notifyStatusWrite!: () => void;
    const statusWriteStarted = new Promise<void>((resolve) => {
      notifyStatusWrite = resolve;
    });
    adapter.setStateAsync = sinon
      .stub()
      .callsFake((id: string, value: unknown) => {
        if (id === "info.bluetoothAdapterState" && value === "poweredOn") {
          notifyStatusWrite();
          return new Promise<void>((resolve) => {
            releaseStatusWrite = resolve;
          });
        }
        return Promise.resolve();
      });
    nobleScannerFactoryOverride = () => Promise.resolve(scanner);

    const startup = adapter.startBluetooth();
    await statusWriteStarted;
    adapter.unloading = true;
    releaseStatusWrite();
    await startup;

    expect(adapter.bluetoothClient).to.equal(null);
    expect(adapter.configurePollInterval.called).to.equal(false);
    expect(scanner.discover.called).to.equal(false);
    await scanner.close();
  });
});

describe("Bluetooth reconnect backoff", () => {
  afterEach(() => sinon.restore());

  it("only increases backoff after an actual reconnect attempt", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const reconnect = sinon.stub().resolves();
    adapter.bluetoothStartupComplete = true;
    adapter.bluetoothClient = {
      hasReconnectAttemptsRemaining: sinon.stub().returns(true),
      reconnect,
    };
    adapter.bluetoothConnections = new Map([["TEST0001", false]]);
    adapter.bluetoothReconnectDelay = 10000;
    adapter.bluetoothReconnectTimer = null;
    adapter.bluetoothReconnectInFlight = false;
    adapter.bluetoothManualScanInFlight = false;
    adapter.updateBluetoothSearchReadiness = sinon.stub().resolves();

    adapter.scheduleBluetoothReconnect();
    expect(adapter.bluetoothReconnectDelay).to.equal(10000);

    adapter.clearTimeout(adapter.bluetoothReconnectTimer);
    adapter.bluetoothReconnectTimer = null;
    expect(adapter.bluetoothReconnectDelay).to.equal(10000);

    adapter.scheduleBluetoothReconnect();
    await clock.tickAsync(10000);

    expect(reconnect.calledOnce).to.equal(true);
    expect(adapter.bluetoothReconnectDelay).to.equal(20000);
  });

  it("stops scheduling when the client's retry limit is exhausted", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const hasAttempts = sinon.stub().returns(true);
    const reconnect = sinon.stub().callsFake(() => {
      hasAttempts.returns(false);
      return Promise.resolve();
    });
    adapter.bluetoothStartupComplete = true;
    adapter.bluetoothClient = {
      hasReconnectAttemptsRemaining: hasAttempts,
      reconnect,
    };
    adapter.bluetoothConnections = new Map([["TEST0001", false]]);
    adapter.bluetoothReconnectDelay = 10000;
    adapter.bluetoothReconnectTimer = null;
    adapter.bluetoothReconnectInFlight = false;
    adapter.bluetoothManualScanInFlight = false;
    adapter.updateBluetoothSearchReadiness = sinon.stub().resolves();

    adapter.scheduleBluetoothReconnect();
    await clock.tickAsync(10000);

    expect(reconnect.calledOnce).to.equal(true);
    expect(adapter.bluetoothReconnectTimer).to.equal(null);
    adapter.scheduleBluetoothReconnect();
    expect(adapter.bluetoothReconnectTimer).to.equal(null);
  });
});

describe("Charger name updates", () => {
  afterEach(() => sinon.restore());

  const stateId = "easee.0.charger-b.name";
  const chargerA = {
    id: "charger-a",
    name: "First",
    position: 1,
    enabled: true,
  };
  const chargerB = {
    id: "charger-b",
    name: "Old",
    position: 2,
    enabled: false,
  };
  const site = {
    id: "site-1",
    circuits: [
      { id: "wrong-circuit", chargers: [{ id: "other" }] },
      {
        id: "right-circuit",
        chargers: [
          { id: "charger-a", siteOnly: true },
          { id: "charger-b", siteOnly: true },
        ],
      },
    ],
  };
  const flush = (): Promise<void> =>
    new Promise<void>((resolve) => setImmediate(resolve));

  function setup(): {
    adapter: ReturnType<typeof createAdapter>;
    get: sinon.SinonStub;
  } {
    const adapter = createAdapterHarness();
    adapter.getChargerSite.resolves(structuredClone(site));
    const get = sinon.stub(axios, "get");
    get
      .withArgs("https://api.easee.com/api/chargers/charger-a")
      .resolves({ data: { ...chargerA } });
    get
      .withArgs("https://api.easee.com/api/chargers/charger-b")
      .resolves({ data: { ...chargerB } });
    return { adapter, get };
  }

  it("updates the matching circuit with all charger details and confirms the reread name", async () => {
    const { adapter, get } = setup();
    let resolvePut!: (response: { data: object }) => void;
    const put = sinon.stub(axios, "put").returns(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );
    get
      .withArgs("https://api.easee.com/api/chargers/charger-b")
      .onSecondCall()
      .resolves({ data: { ...chargerB, name: "New" } });

    adapter.onStateChange(stateId, { val: "New", ack: false });
    await flush();
    expect(adapter.getChargerSite.calledOnceWithExactly("charger-b")).to.equal(
      true,
    );
    expect(get.callCount).to.equal(2);
    expect(put.calledOnce).to.equal(true);
    expect(put.firstCall.args[0]).to.equal(
      "https://api.easee.com/api/sites/site-1/circuits/right-circuit/chargers",
    );
    expect(put.firstCall.args[1]).to.deep.equal([
      chargerA,
      { ...chargerB, name: "New" },
    ]);
    expect(adapter.setStateAsync.called).to.equal(false);
    resolvePut({ data: {} });
    await flush();
    expect(get.callCount).to.equal(3);
    expect(get.lastCall.args[0]).to.equal(
      "https://api.easee.com/api/chargers/charger-b",
    );
    expect(
      adapter.setStateAsync.calledOnceWithExactly(
        "charger-b.name",
        "New",
        true,
      ),
    ).to.equal(true);
  });

  it("does not acknowledge when the reread name differs from the requested name", async () => {
    const { adapter, get } = setup();
    sinon.stub(axios, "put").resolves({ data: {} });
    get
      .withArgs("https://api.easee.com/api/chargers/charger-b")
      .onSecondCall()
      .resolves({ data: { ...chargerB, name: "Canonical" } });
    adapter.onStateChange(stateId, { val: "New", ack: false });
    await flush();
    expect(adapter.setStateAsync.called).to.equal(false);
  });

  for (const failure of ["site", "charger", "put", "confirmation"]) {
    it(`does not acknowledge a failed ${failure} request`, async () => {
      const { adapter, get } = setup();
      const put = sinon.stub(axios, "put").resolves({ data: {} });
      if (failure === "site") {
        adapter.getChargerSite.rejects(new Error("site failed"));
      }
      if (failure === "charger") {
        get
          .withArgs("https://api.easee.com/api/chargers/charger-a")
          .rejects(new Error("charger failed"));
      }
      if (failure === "put") {
        put.rejects(new Error("put failed"));
      }
      if (failure === "confirmation") {
        get
          .withArgs("https://api.easee.com/api/chargers/charger-b")
          .onSecondCall()
          .rejects(new Error("confirmation failed"));
      }
      adapter.onStateChange(stateId, { val: "New", ack: false });
      await flush();
      expect(adapter.setStateAsync.called).to.equal(false);
      if (failure === "site" || failure === "charger") {
        expect(put.called).to.equal(false);
      }
    });
  }

  for (const value of [null, 123, true]) {
    it(`rejects non-string name ${String(value)}`, async () => {
      const { adapter, get } = setup();
      const put = sinon.stub(axios, "put").resolves({ data: {} });
      adapter.onStateChange(stateId, { val: value, ack: false });
      await flush();
      expect(adapter.getChargerSite.called).to.equal(false);
      expect(get.called || put.called || adapter.setStateAsync.called).to.equal(
        false,
      );
    });
  }

  it("serializes consecutive name changes and only acknowledges the latest", async () => {
    const { adapter, get } = setup();
    let release!: (value: object) => void;
    const put = sinon.stub(axios, "put");
    put.onFirstCall().returns(new Promise((resolve) => (release = resolve)));
    put.onSecondCall().resolves({});
    const chargerGet = get.withArgs(
      "https://api.easee.com/api/chargers/charger-b",
    );
    chargerGet.onSecondCall().resolves({ data: { ...chargerB, name: "One" } });
    chargerGet.onThirdCall().resolves({ data: { ...chargerB, name: "One" } });
    chargerGet.onCall(3).resolves({ data: { ...chargerB, name: "Two" } });
    adapter.onStateChange(stateId, { val: "One", ack: false });
    await flush();
    adapter.onStateChange(stateId, { val: "Two", ack: false });
    await flush();
    expect(put.callCount).to.equal(1);
    release({});
    await adapter.chargerNameQueue;
    expect(put.callCount).to.equal(2);
    expect(
      adapter.setStateAsync.calledOnceWithExactly(
        "charger-b.name",
        "Two",
        true,
      ),
    ).to.equal(true);
  });

  it("does not overwrite a name with a stale poll during or after an update", async () => {
    const adapter = createAdapterHarness();
    adapter.setObservedState = sinon.stub().resolves();
    adapter.chargerNameVersions.set("charger-b", 1);
    adapter.chargerNamePending.set("charger-b", 1);
    await adapter.setNewStatusToCharger(chargerB, {}, {}, 1);
    adapter.chargerNamePending.delete("charger-b");
    adapter.chargerNameVersions.set("charger-b", 2);
    await adapter.setNewStatusToCharger(chargerB, {}, {}, 1);
    expect(adapter.setStateAsync.called).to.equal(false);
    await adapter.setNewStatusToCharger(chargerB, {}, {}, 2);
    expect(
      adapter.setStateAsync.calledOnceWithExactly(
        "charger-b.name",
        "Old",
        true,
      ),
    ).to.equal(true);
  });

  it("ignores acknowledged name updates", async () => {
    const { adapter, get } = setup();
    const put = sinon.stub(axios, "put").resolves({ data: {} });
    adapter.onStateChange(stateId, { val: "New", ack: true });
    await flush();
    expect(
      adapter.getChargerSite.called ||
        get.called ||
        put.called ||
        adapter.setStateAsync.called,
    ).to.equal(false);
  });

  for (const circuits of [
    undefined,
    [],
    [{ id: "other", chargers: [{ id: "charger-a" }] }],
    [{ id: "missing-chargers" }],
  ]) {
    it(`safely rejects an unmapped charger: ${JSON.stringify(circuits)}`, async () => {
      const { adapter, get } = setup();
      adapter.getChargerSite.resolves({ id: "site-1", circuits });
      const put = sinon.stub(axios, "put").resolves({ data: {} });
      adapter.onStateChange(stateId, { val: "New", ack: false });
      await flush();
      expect(get.called || put.called || adapter.setStateAsync.called).to.equal(
        false,
      );
    });
  }
});

describe("Cloud site responses", () => {
  afterEach(() => sinon.restore());

  function adapterWithSiteResponse(
    data: unknown,
  ): ReturnType<typeof createAdapter> {
    const adapter = createAdapterHarness();
    adapter.getChargerSite = createAdapter.Easee.prototype.getChargerSite;
    adapter.requestWithBackoff = sinon.stub().resolves({ data });
    return adapter;
  }

  it("preserves valid site and circuit data", async () => {
    const response = {
      id: "site-1",
      currencyId: "EUR",
      costPerKWh: 0.5,
      costPerKwhExcludeVat: 0.4,
      vat: 25,
      circuits: [{ id: "circuit-1", chargers: [{ id: "charger-1" }] }],
    };
    const adapter = adapterWithSiteResponse(response);

    expect(await adapter.getChargerSite("charger-1")).to.deep.equal(response);
  });

  it("normalizes finite numeric site, circuit, and charger IDs", async () => {
    const adapter = adapterWithSiteResponse({
      id: 123,
      currencyId: " NOK ",
      costPerKWh: 1.5,
      costPerKwhExcludeVat: 1.2,
      vat: 25,
      circuits: [{ id: 456, chargers: [{ id: 789 }] }],
    });

    expect(await adapter.getChargerSite("789")).to.deep.equal({
      id: "123",
      currencyId: "NOK",
      costPerKWh: 1.5,
      costPerKwhExcludeVat: 1.2,
      vat: 25,
      circuits: [{ id: "456", chargers: [{ id: "789" }] }],
    });
  });

  it("accepts missing site fields and sanitizes incomplete optional circuits", async () => {
    const adapter = adapterWithSiteResponse({
      currencyId: 42,
      costPerKWh: "1.5",
      costPerKwhExcludeVat: -1,
      vat: 100,
      circuits: [
        { id: 456, chargers: [{ id: "charger-1" }, { id: null }] },
        { id: Infinity, chargers: "invalid" },
        null,
      ],
    });

    expect(await adapter.getChargerSite("charger-1")).to.deep.equal({
      circuits: [{ id: "456" }, {}, {}],
    });
  });

  for (const data of [null, 123, true, []]) {
    it(`returns no site data for a non-object response: ${String(data)}`, async () => {
      const adapter = adapterWithSiteResponse(data);

      expect(await adapter.getChargerSite("charger-1")).to.equal(undefined);
    });
  }

  it("declines a site write when optional circuit data is incomplete", async () => {
    const adapter = adapterWithSiteResponse({
      id: "site-1",
      circuits: [{ id: 456, chargers: [{ id: "charger-1" }, {}] }],
    });
    const get = sinon.stub(axios, "get");
    const put = sinon.stub(axios, "put");

    let failure: unknown;
    try {
      await adapter.changeChargerName("charger-1", "New", 1);
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.equal(
      "Could not uniquely identify the charger circuit",
    );
    expect(get.called || put.called).to.equal(false);
  });

  it("reports a clear failure for a site command without site data", async () => {
    const adapter = adapterWithSiteResponse(null);

    let failure: unknown;
    try {
      await adapter.changeChargerName("charger-1", "New", 1);
    } catch (error) {
      failure = error;
    }

    expect((failure as Error).message).to.equal(
      "No site data available for charger charger-1",
    );
  });

  it("continues Cloud state and config updates when the site response is not an object", async () => {
    const adapter = adapterWithSiteResponse(null);
    adapter.config = { signalR: false };
    adapter.refreshToken = sinon.stub().resolves();
    adapter.getAllCharger = sinon.stub().resolves([{ id: "charger-1" }]);
    adapter.setAllStatusObjects = sinon.stub().resolves();
    adapter.setAllConfigObjects = sinon.stub().resolves();
    adapter.subscribeChargerToSignalR = sinon.stub().resolves();
    adapter.getChargerState = sinon
      .stub()
      .resolves({ state: {}, timestamps: {} });
    adapter.getChargerConfig = sinon.stub().resolves({});
    adapter.setNewStatusToCharger = sinon.stub().resolves();
    adapter.setConfigStatus = sinon.stub().resolves();

    await adapter.readAllStates();

    expect(adapter.setNewStatusToCharger.calledOnce).to.equal(true);
    expect(
      adapter.setConfigStatus.calledOnceWithExactly(
        { id: "charger-1", name: "charger-1" },
        {},
        undefined,
      ),
    ).to.equal(true);
    await new Promise<void>((resolve) => adapter.onUnload(resolve));
  });
});

describe("Easee polling regressions", () => {
  afterEach(() => sinon.restore());

  it("coalesces all phase changes inside the debounce window", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const changeCircuitConfig = sinon.stub().resolves();
    adapter.changeCircuitConfig = changeCircuitConfig;

    adapter.onStateChange("easee.0.charger.config.dynamicCircuitCurrentP1", {
      val: 10,
      ack: false,
    });
    adapter.onStateChange("easee.0.charger.config.dynamicCircuitCurrentP2", {
      val: 12,
      ack: false,
    });
    adapter.onStateChange("easee.0.charger.config.dynamicCircuitCurrentP3", {
      val: 14,
      ack: false,
    });
    await clock.tickAsync(1000);

    expect(changeCircuitConfig.calledOnce).to.equal(true);
    expect(changeCircuitConfig.firstCall.args).to.deep.equal([
      "site-charger",
      "circuit-charger",
      { p1: 10, p2: 12, p3: 14 },
    ]);
    expect(
      adapter.dynamicCircuitCurrentByCharger.get("charger").pendingValues,
    ).to.deep.equal({});
  });

  it("serializes writes for the same charger in request order", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    let resolveFirstWrite: (() => void) | undefined;
    const changeCircuitConfig = sinon.stub();
    changeCircuitConfig.onFirstCall().returns(
      new Promise<void>((resolve) => {
        resolveFirstWrite = resolve;
      }),
    );
    changeCircuitConfig.onSecondCall().resolves();
    adapter.changeCircuitConfig = changeCircuitConfig;

    adapter.onStateChange("easee.0.charger.config.dynamicCircuitCurrentP1", {
      val: 10,
      ack: false,
    });
    await clock.tickAsync(1000);
    expect(changeCircuitConfig.callCount).to.equal(1);

    adapter.onStateChange("easee.0.charger.config.dynamicCircuitCurrentP1", {
      val: 16,
      ack: false,
    });
    await clock.tickAsync(1000);
    expect(changeCircuitConfig.callCount).to.equal(1);

    resolveFirstWrite!();
    await clock.tickAsync(0);
    expect(changeCircuitConfig.callCount).to.equal(2);
    expect(changeCircuitConfig.secondCall.args[2]).to.deep.equal({
      p1: 16,
      p2: 0,
      p3: 0,
    });
  });

  it("keeps a site retry inside the queue ahead of a newer reduction", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const changeCircuitConfig = sinon.stub().resolves();
    adapter.changeCircuitConfig = changeCircuitConfig;
    const getChargerSite = adapter.getChargerSite;
    let resolveRetrySite:
      | ((site: {
          id: string;
          circuits: { id: string; chargers: { id: string }[] }[];
        }) => void)
      | undefined;
    getChargerSite.onFirstCall().callsFake(() => {
      adapter.apiRetryState.set("charger site charger", {
        retryAt: Date.now() + 30000,
      });
      const error = Object.assign(new Error("temporary site failure"), {
        retryDeferred: true,
      });
      throw error;
    });
    getChargerSite.onSecondCall().returns(
      new Promise<{
        id: string;
        circuits: { id: string; chargers: { id: string }[] }[];
      }>((resolve) => {
        resolveRetrySite = resolve;
      }),
    );

    adapter.onStateChange("easee.0.charger.config.dynamicCircuitCurrentP1", {
      val: 16,
      ack: false,
    });
    await clock.tickAsync(500);
    expect(changeCircuitConfig.callCount).to.equal(0);

    adapter.onStateChange("easee.0.charger.config.dynamicCircuitCurrentP1", {
      val: 6,
      ack: false,
    });
    await clock.tickAsync(30500);
    expect(getChargerSite.callCount).to.equal(2);
    resolveRetrySite!({
      id: "site-charger",
      circuits: [
        {
          id: "circuit-charger",
          chargers: [{ id: "charger" }],
        },
      ],
    });
    await clock.tickAsync(500);
    expect(changeCircuitConfig.callCount).to.equal(1);
    expect(changeCircuitConfig.firstCall.args[2]).to.deep.equal({
      p1: 6,
      p2: 0,
      p3: 0,
    });
  });

  it("merges phase changes from chargers sharing a circuit", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const changeCircuitConfig = sinon.stub().resolves();
    adapter.changeCircuitConfig = changeCircuitConfig;
    adapter.getChargerSite.callsFake(() =>
      Promise.resolve({
        id: "shared-site",
        circuits: [
          {
            id: "shared-circuit",
            chargers: [{ id: "chargerA" }, { id: "chargerB" }],
          },
        ],
      }),
    );

    adapter.onStateChange("easee.0.chargerA.config.dynamicCircuitCurrentP1", {
      val: 16,
      ack: false,
    });
    adapter.onStateChange("easee.0.chargerB.config.dynamicCircuitCurrentP2", {
      val: 10,
      ack: false,
    });
    await clock.tickAsync(1000);
    expect(changeCircuitConfig.callCount).to.equal(1);
    expect(changeCircuitConfig.firstCall.args).to.deep.equal([
      "shared-site",
      "shared-circuit",
      { p1: 16, p2: 10, p3: 0 },
    ]);
  });

  it("sends current-limit summaries during continuous updates", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const changeCircuitConfig = sinon.stub().resolves();
    adapter.changeCircuitConfig = changeCircuitConfig;

    for (let index = 0; index < 9; index++) {
      for (const [phase, value] of [
        ["P1", index + 1],
        ["P2", index + 2],
        ["P3", index + 3],
      ]) {
        adapter.onStateChange(
          `easee.0.charger.config.dynamicCircuitCurrent${phase}`,
          { val: value, ack: false },
        );
      }
      await clock.tickAsync(750);
    }

    expect(changeCircuitConfig.callCount).to.be.greaterThan(0);
    expect(changeCircuitConfig.callCount).to.be.at.least(6);
    expect(changeCircuitConfig.lastCall.args[2].p1).to.equal(8);
    await clock.tickAsync(500);
    expect(changeCircuitConfig.lastCall.args[2].p1).to.equal(9);
  });

  it("discards an old max-current retry superseded on a shared circuit", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const changeMaxCircuitConfig = sinon.stub().resolves();
    adapter.changeMaxCircuitConfig = changeMaxCircuitConfig;
    adapter.updateSiteConfigWithRetry =
      createAdapter.Easee.prototype.updateSiteConfigWithRetry;
    adapter.getChargerSite.onFirstCall().callsFake(() => {
      adapter.apiRetryState.set("charger site chargerA", {
        retryAt: Date.now() + 30000,
      });
      const error = Object.assign(new Error("temporary site failure"), {
        retryDeferred: true,
      });
      throw error;
    });
    adapter.getChargerSite.callsFake(() =>
      Promise.resolve({
        id: "shared-site",
        circuits: [
          {
            id: "shared-circuit",
            chargers: [{ id: "chargerA" }, { id: "chargerB" }],
          },
        ],
      }),
    );

    adapter.onStateChange("easee.0.chargerA.config.circuitMaxCurrentP1", {
      val: 16,
      ack: false,
    });
    await clock.tickAsync(0);
    adapter.onStateChange("easee.0.chargerB.config.circuitMaxCurrentP1", {
      val: 6,
      ack: false,
    });
    await clock.tickAsync(0);

    expect(
      changeMaxCircuitConfig.calledOnceWithExactly(
        "shared-site",
        "shared-circuit",
        "p1",
        6,
      ),
    ).to.equal(true);
    await clock.tickAsync(30000);
    expect(changeMaxCircuitConfig.callCount).to.equal(1);
  });

  it("clears each phase buffer when taking a snapshot despite an active write", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    let resolveFirstWrite: (() => void) | undefined;
    const changeCircuitConfig = sinon.stub();
    changeCircuitConfig.onFirstCall().returns(
      new Promise<void>((resolve) => {
        resolveFirstWrite = resolve;
      }),
    );
    changeCircuitConfig.onSecondCall().resolves();
    adapter.changeCircuitConfig = changeCircuitConfig;

    adapter.onStateChange("easee.0.charger.config.dynamicCircuitCurrentP1", {
      val: 10,
      ack: false,
    });
    await clock.tickAsync(1000);
    await Promise.resolve();
    expect(changeCircuitConfig.firstCall.args[2]).to.deep.equal({
      p1: 10,
      p2: 0,
      p3: 0,
    });

    adapter.onStateChange("easee.0.charger.config.dynamicCircuitCurrentP2", {
      val: 12,
      ack: false,
    });
    await clock.tickAsync(1000);
    expect(changeCircuitConfig.callCount).to.equal(1);

    resolveFirstWrite!();
    await clock.tickAsync(0);
    expect(changeCircuitConfig.secondCall.args[2]).to.deep.equal({
      p1: 0,
      p2: 12,
      p3: 0,
    });
  });

  it("keeps dynamic-current phase values separate per charger", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const changeCircuitConfig = sinon.stub().resolves();
    adapter.changeCircuitConfig = changeCircuitConfig;

    adapter.onStateChange("easee.0.chargerA.config.dynamicCircuitCurrentP2", {
      val: 16,
      ack: false,
    });
    await clock.tickAsync(1000);

    adapter.onStateChange("easee.0.chargerB.config.dynamicCircuitCurrentP1", {
      val: 6,
      ack: false,
    });
    await clock.tickAsync(1000);

    expect(changeCircuitConfig.secondCall.args).to.deep.equal([
      "site-chargerB",
      "circuit-chargerB",
      { p1: 6, p2: 0, p3: 0 },
    ]);
  });

  it("preserves the last online state when the observation is missing", async () => {
    const adapter = createAdapterHarness();
    adapter.setNewStatusToCharger =
      createAdapter.Easee.prototype.setNewStatusToCharger;

    await adapter.setNewStatusToCharger({ id: "charger", name: "Charger" }, {});

    expect(
      adapter.setStateAsync.calledWith("charger.status.isOnline"),
    ).to.equal(false);
  });

  it("normalizes SignalR cable-lock events and isolates chargers", async () => {
    const adapter = createAdapterHarness();

    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger-a",
      dataType: 2,
      value: true,
    });
    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger-b",
      dataType: 2,
      value: "1",
    });
    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger-a",
      dataType: 2,
      value: "false",
    });
    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger-b",
      dataType: 2,
      value: "true",
    });
    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger-b",
      dataType: 2,
      value: "0",
    });
    await Promise.all([...adapter.observedStateWrites.values()]);

    expect(adapter.setStateAsync.args).to.deep.equal([
      ["charger-a.status.cableLocked", true, true],
      ["charger-b.status.cableLocked", true, true],
      ["charger-a.status.cableLocked", false, true],
      ["charger-b.status.cableLocked", true, true],
      ["charger-b.status.cableLocked", false, true],
    ]);
  });

  it("repairs existing lastUpdate metadata without changing its string value", async () => {
    const adapter = createAdapterHarness();
    adapter.setObjectNotExistsAsync = sinon.stub().resolves();
    adapter.extendObjectAsync = sinon.stub().resolves();

    await adapter.ensureLastUpdateObject();

    expect(adapter.setObjectNotExistsAsync.firstCall.args[1].common).to.include(
      {
        type: "string",
        role: "text",
      },
    );
    expect(
      adapter.extendObjectAsync.calledWithExactly("lastUpdate", {
        common: { type: "string", role: "text" },
      }),
    ).to.equal(true);
  });

  it("redacts unknown SignalR payloads and failure details from logs", async () => {
    const adapter = createAdapterHarness();
    const testPin = "TEST-PIN-7194";
    const testToken = "TEST-RFID-TOKEN-64af";

    adapter.handleSignalRProductUpdate({
      id: 128,
      mid: testPin,
      dataType: 4,
      value: testToken,
    });
    adapter.setStateAsync = sinon
      .stub()
      .rejects(new Error(`Failed for ${testPin} and ${testToken}`));
    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger-a",
      dataType: 2,
      value: true,
    });
    await Promise.allSettled([...adapter.observedStateWrites.values()]);

    const loggedText = [
      ...adapter.log.debug.args.flat(),
      ...adapter.log.warn.args.flat(),
    ].join("\\n");
    expect(loggedText).to.contain("Unknown SignalR observation (id=128");
    expect(loggedText).to.contain("SignalR state update failed (Error).");
    expect(loggedText).not.to.contain(testPin);
    expect(loggedText).not.to.contain(testToken);
  });

  it("serializes SignalR updates to the same state in arrival order", async () => {
    const adapter = createAdapterHarness();
    let releaseFirstWrite: (() => void) | undefined;
    const write = sinon.stub();
    write.onFirstCall().returns(
      new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      }),
    );
    write.onSecondCall().resolves();
    adapter.setStateAsync = write;

    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger-a",
      dataType: 2,
      value: true,
    });
    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger-a",
      dataType: 2,
      value: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(write.callCount).to.equal(1);
    releaseFirstWrite!();
    await Promise.all([...adapter.observedStateWrites.values()]);

    expect(write.args).to.deep.equal([
      ["charger-a.status.cableLocked", true, true],
      ["charger-a.status.cableLocked", false, true],
    ]);
  });

  it("ignores a stale REST observation after a SignalR update", async () => {
    const adapter = createAdapterHarness();
    adapter.setNewStatusToCharger =
      createAdapter.Easee.prototype.setNewStatusToCharger;
    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger",
      dataType: 2,
      timestamp: new Date(200).toISOString(),
      value: "true",
    });
    await Promise.all([...adapter.observedStateWrites.values()]);

    await adapter.setNewStatusToCharger(
      { id: "charger", name: "Charger" },
      { cableLocked: false },
      { cableLocked: 100 },
    );

    expect(
      adapter.setStateAsync.calledWithExactly(
        "charger.status.cableLocked",
        true,
        true,
      ),
    ).to.equal(true);
    expect(
      adapter.setStateAsync.calledWithExactly(
        "charger.status.cableLocked",
        false,
        true,
      ),
    ).to.equal(false);
  });

  it("accepts same-timestamp REST confirmations for config observations", async () => {
    const adapter = createAdapterHarness();
    adapter.setNewStatusToCharger =
      createAdapter.Easee.prototype.setNewStatusToCharger;
    const timestamp = 200;
    const charger = { id: "charger", name: "Charger" };
    const timestamps = {
      lockCablePermanently: timestamp,
      dynamicChargerCurrent: timestamp,
      smartCharging: timestamp,
    };

    await adapter.setNewStatusToCharger(
      charger,
      {
        lockCablePermanently: true,
        dynamicChargerCurrent: 6,
        smartCharging: true,
      },
      timestamps,
    );
    adapter.setStateAsync.resetHistory();

    await adapter.setNewStatusToCharger(
      charger,
      {
        lockCablePermanently: false,
        dynamicChargerCurrent: 8,
        smartCharging: false,
      },
      timestamps,
    );

    expect(adapter.setStateAsync.args).to.deep.equal([
      ["charger.name", "Charger", true],
      ["charger.config.lockCablePermanently", false, true],
      ["charger.config.dynamicChargerCurrent", 8, true],
      ["charger.config.smartCharging", false, true],
    ]);
  });

  it("accepts same-timestamp SignalR confirmations for config observations", async () => {
    const adapter = createAdapterHarness();
    const timestamp = new Date(200).toISOString();
    const observations = [
      {
        id: 30,
        stateId: "charger.config.lockCablePermanently",
        dataType: 2,
        value: "false",
      },
      {
        id: 48,
        stateId: "charger.config.dynamicChargerCurrent",
        dataType: 3,
        value: "8",
      },
      {
        id: 102,
        stateId: "charger.config.smartCharging",
        dataType: 2,
        value: "false",
      },
    ];
    for (const observation of observations) {
      adapter.observationVersions.set(observation.stateId, {
        timestamp: Date.parse(timestamp),
        source: "REST",
      });
      adapter.handleSignalRProductUpdate({
        id: observation.id,
        mid: "charger",
        dataType: observation.dataType,
        timestamp,
        value: observation.value,
      });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(adapter.setStateAsync.args).to.deep.equal([
      ["charger.config.lockCablePermanently", false, true],
      ["charger.config.dynamicChargerCurrent", 8, true],
      ["charger.config.smartCharging", false, true],
    ]);
    for (const observation of observations) {
      expect(
        adapter.observationVersions.get(observation.stateId),
      ).to.deep.equal({ timestamp: Date.parse(timestamp), source: "SignalR" });
    }
  });

  it("ignores a SignalR event with an older source timestamp", () => {
    const adapter = createAdapterHarness();
    adapter.observationVersions.set("charger.status.cableLocked", {
      timestamp: 200,
      source: "REST",
    });

    adapter.handleSignalRProductUpdate({
      id: 103,
      mid: "charger",
      dataType: 2,
      timestamp: new Date(100).toISOString(),
      value: "false",
    });

    expect(adapter.setStateAsync.called).to.equal(false);
    expect(
      adapter.observationVersions.get("charger.status.cableLocked"),
    ).to.deep.equal({ timestamp: 200, source: "REST" });
  });

  it("does not clear cable-lock state when REST omits observation 103", async () => {
    const adapter = createAdapterHarness();
    adapter.setNewStatusToCharger =
      createAdapter.Easee.prototype.setNewStatusToCharger;

    await adapter.setNewStatusToCharger({ id: "charger", name: "Charger" }, {});

    expect(
      adapter.setStateAsync.calledWith("charger.status.cableLocked"),
    ).to.equal(false);
  });

  it("creates and clears a read-only authorization token state", async () => {
    const adapter = createAdapterHarness();
    const setObjectNotExistsAsync = sinon.stub().resolves();
    adapter.setObjectNotExistsAsync = setObjectNotExistsAsync;
    adapter.extendObjectAsync = sinon.stub().resolves();
    adapter.subscribeStates = sinon.stub();

    await adapter.setAllStatusObjects({ id: "charger", name: "Charger" });

    expect(
      setObjectNotExistsAsync.calledWith(
        "charger.status.authToken",
        sinon.match({
          common: sinon.match({
            name: "Authorization token used for the last completed charging session",
            type: "string",
            role: "text",
            read: true,
            write: false,
          }),
        }),
      ),
    ).to.equal(true);
    expect(
      adapter.extendObjectAsync.calledWithExactly("charger.status.authToken", {
        common: {
          name: "Authorization token used for the last completed charging session",
        },
      }),
    ).to.equal(true);
    expect(
      adapter.setStateAsync.calledWithExactly(
        "charger.status.authToken",
        "",
        true,
      ),
    ).to.equal(true);
    expect(
      setObjectNotExistsAsync.calledWith(
        "charger.status.authTokenName",
        sinon.match({
          common: sinon.match({ type: "string", read: true, write: false }),
        }),
      ),
    ).to.equal(true);
    expect(
      adapter.setStateAsync.calledWithExactly(
        "charger.status.authTokenName",
        "",
        true,
      ),
    ).to.equal(true);
    expect(
      setObjectNotExistsAsync.calledWith(
        "charger.control.start",
        sinon.match({
          common: sinon.match({
            role: "button.start",
            read: false,
            write: true,
          }),
        }),
      ),
    ).to.equal(true);
    expect(
      setObjectNotExistsAsync.calledWith(
        "charger.control.reboot",
        sinon.match({
          common: sinon.match({
            role: "button",
            read: false,
            write: true,
          }),
        }),
      ),
    ).to.equal(true);
  });

  it("clears the previous authorization token once when charging starts", async () => {
    const adapter = createAdapterHarness();
    adapter.lastChargerOpModes.set("charger", 1);
    adapter.chargerSessionAuthTokenResolved.add("charger");
    adapter.updateCurrentSessionAuthToken = sinon.stub().resolves();

    await adapter.writeObservedState(
      "charger.status.chargerOpMode",
      3,
      100,
      "SignalR",
    );
    await adapter.writeObservedState(
      "charger.status.chargerOpMode",
      3,
      200,
      "SignalR",
    );

    expect(
      adapter.setStateAsync.args.filter(
        (args: unknown[]) => args[0] === "charger.status.authToken",
      ),
    ).to.deep.equal([["charger.status.authToken", "", true]]);
    expect(
      adapter.setStateAsync.calledWithExactly(
        "charger.status.authTokenName",
        "",
        true,
      ),
    ).to.equal(true);
    expect(adapter.updateCurrentSessionAuthToken.called).to.equal(false);
    expect(adapter.chargerSessionAuthTokenResolved.has("charger")).to.equal(
      false,
    );
  });

  it("requests a completed session token when charging is manually stopped", async () => {
    const adapter = createAdapterHarness();
    adapter.lastChargerOpModes.set("charger", 3);
    adapter.chargerSessionStarts.set("charger", {
      timestamp: 100,
      reliable: true,
    });
    adapter.chargerSessionGenerations.set("charger", 1);
    adapter.updateCurrentSessionAuthToken = sinon.stub().resolves();

    await adapter.writeObservedState(
      "charger.status.chargerOpMode",
      4,
      200,
      "SignalR",
    );

    expect(adapter.updateCurrentSessionAuthToken.calledOnce).to.equal(true);
    expect(adapter.updateCurrentSessionAuthToken.firstCall.args).to.deep.equal([
      "charger",
      100,
      1,
    ]);
  });

  it("retries the completed session lookup after car disconnection", async () => {
    const adapter = createAdapterHarness();
    adapter.lastChargerOpModes.set("charger", 4);
    adapter.chargerSessionStarts.set("charger", {
      timestamp: 100,
      reliable: true,
    });
    adapter.chargerSessionGenerations.set("charger", 1);
    adapter.updateCurrentSessionAuthToken = sinon.stub().resolves();

    await adapter.writeObservedState(
      "charger.status.chargerOpMode",
      1,
      300,
      "SignalR",
    );

    expect(adapter.updateCurrentSessionAuthToken.calledOnce).to.equal(true);
    expect(adapter.updateCurrentSessionAuthToken.firstCall.args).to.deep.equal([
      "charger",
      100,
      1,
    ]);
    expect(adapter.chargerSessionStarts.has("charger")).to.equal(false);
  });

  it("reads the completed session token without selecting an old or active session", async () => {
    const adapter = createAdapterHarness();
    const sessionStartAt = Date.parse("2026-11-07T12:15:00.000Z");
    adapter.chargerSessionGenerations.set("charger", 1);
    const get = sinon.stub(axios, "get");
    get.onFirstCall().resolves({
      data: [
        {
          isComplete: true,
          authToken: "old-token",
          carConnected: "2026-11-07T11:00:00.000Z",
        },
        {
          isComplete: false,
          authToken: "active-token",
          carConnected: "2026-11-07T12:20:00.000Z",
        },
        {
          isComplete: true,
          authToken: "completed-token",
          carConnected: "2026-11-07T12:20:00.000Z",
        },
      ],
    });

    get
      .onSecondCall()
      .resolves({ data: [{ id: "COMPLETED-TOKEN", owner: "Alice" }] });
    await adapter.updateCurrentSessionAuthToken("charger", sessionStartAt, 1);

    expect(get.calledTwice).to.equal(true);
    expect(get.secondCall.args[0]).to.equal(
      "https://api.easee.com/api/accounts/easeekeys",
    );
    expect(get.firstCall.args[0]).to.match(
      /^https:\/\/api\.easee\.com\/api\/sessions\/charger\/charger\/sessions\//,
    );
    expect(decodeURIComponent(get.firstCall.args[0])).to.include(
      new Date(sessionStartAt - 5 * 60 * 1000).toISOString(),
    );
    expect(adapter.setStateAsync.args).to.deep.equal([
      ["charger.status.authToken", "completed-token", true],
      ["charger.status.authTokenName", "Alice", true],
    ]);
    expect(adapter.chargerSessionAuthTokenResolved.has("charger")).to.equal(
      true,
    );
    expect(adapter.log.debug.args.flat().join(" ")).not.to.include(
      "completed-token",
    );
    expect(adapter.log.warn.args.flat().join(" ")).not.to.include(
      "completed-token",
    );
  });

  for (const outcome of ["missing", "empty", "error"]) {
    it(`shows unknown when the authorization token name is ${outcome}`, async () => {
      const adapter = createAdapterHarness();
      adapter.chargerSessionGenerations.set("charger", 1);
      const get = sinon.stub(axios, "get");
      get
        .onFirstCall()
        .resolves({ data: [{ isComplete: true, authToken: "token" }] });
      if (outcome === "error") {
        get.onSecondCall().rejects(new Error("unavailable"));
      } else {
        get.onSecondCall().resolves({
          data:
            outcome === "empty"
              ? [{ id: "token", owner: " " }]
              : [{ id: "other", owner: "Other" }],
        });
      }
      await adapter.updateCurrentSessionAuthToken("charger", undefined, 1);
      expect(
        adapter.setStateAsync.calledWithExactly(
          "charger.status.authToken",
          "token",
          true,
        ),
      ).to.equal(true);
      expect(
        adapter.setStateAsync.calledWithExactly(
          "charger.status.authTokenName",
          "unknown",
          true,
        ),
      ).to.equal(true);
    });
  }

  it("does not write an old token name after a new charging session starts", async () => {
    const adapter = createAdapterHarness();
    adapter.chargerSessionGenerations.set("charger", 1);
    let releaseKeys!: (value: unknown) => void;
    const get = sinon.stub(axios, "get");
    get
      .onFirstCall()
      .resolves({ data: [{ isComplete: true, authToken: "token" }] });
    get.onSecondCall().returns(
      new Promise((resolve) => {
        releaseKeys = resolve;
      }),
    );
    const lookup = adapter.updateCurrentSessionAuthToken(
      "charger",
      undefined,
      1,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    adapter.chargerSessionGenerations.set("charger", 2);
    releaseKeys({ data: [{ id: "token", owner: "Alice" }] });
    await lookup;
    expect(
      adapter.setStateAsync.calledWith("charger.status.authTokenName"),
    ).to.equal(false);
  });

  it("skips a completed token queued before a newer charging session starts", async () => {
    const adapter = createAdapterHarness();
    adapter.chargerSessionGenerations.set("charger", 1);
    let releasePreviousWrite!: () => void;
    const previousWrite = new Promise<void>((resolve) => {
      releasePreviousWrite = resolve;
    });
    const stateId = "charger.status.authToken";
    adapter.observedStateWrites.set(stateId, previousWrite);
    sinon.stub(axios, "get").resolves({
      data: [
        {
          isComplete: true,
          authToken: "completed-token",
          carConnected: "2026-11-07T12:20:00.000Z",
        },
      ],
    });

    const lookup = adapter.updateCurrentSessionAuthToken(
      "charger",
      undefined,
      1,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    adapter.chargerSessionGenerations.set("charger", 2);
    releasePreviousWrite();
    await lookup;

    expect(adapter.setStateAsync.called).to.equal(false);
    expect(adapter.chargerSessionAuthTokenResolved.has("charger")).to.equal(
      false,
    );
  });

  it("resubscribes all known chargers after SignalR reconnects", () => {
    const adapter = createAdapterHarness();
    const connection = {};
    const subscribe = sinon.stub();
    adapter.signalRConnection = connection;
    adapter.chargerIds = ["charger-a", "charger-b"];
    adapter.signalRSubscribedChargers.add("charger-a");
    adapter.subscribeChargerToSignalR = subscribe;

    adapter.resubscribeSignalRChargers(connection);

    expect(adapter.signalRSubscribedChargers.size).to.equal(0);
    expect(subscribe.args).to.deep.equal([["charger-a"], ["charger-b"]]);
  });

  it("subscribes a charger discovered after SignalR connected", async () => {
    const adapter = createAdapterHarness();
    const send = sinon.stub().resolves();
    adapter.signalRConnection = {
      state: signalR.HubConnectionState.Connected,
      send,
    };

    await adapter.subscribeChargerToSignalR("charger-late");
    await adapter.subscribeChargerToSignalR("charger-late");

    expect(
      send.calledOnceWithExactly(
        "SubscribeWithCurrentState",
        "charger-late",
        true,
      ),
    ).to.equal(true);
  });

  it("writes the normalized cable-lock value through the REST update path", async () => {
    const adapter = createAdapterHarness();
    adapter.getChargerState = createAdapter.Easee.prototype.getChargerState;
    adapter.setNewStatusToCharger =
      createAdapter.Easee.prototype.setNewStatusToCharger;
    const timestamp = "2026-10-30T12:34:56.000Z";
    sinon.stub(axios, "get").resolves({
      data: {
        observations: [
          { id: 30, value: "true", timestamp },
          { id: 103, value: "1", timestamp },
        ],
      },
    });

    const result = await adapter.getChargerState("charger-1");
    await adapter.setNewStatusToCharger(
      { id: "charger-1", name: "Charger 1" },
      result.state,
      result.timestamps,
    );

    expect(
      adapter.setStateAsync.calledWithExactly(
        "charger-1.status.cableLocked",
        true,
        true,
      ),
    ).to.equal(true);
    expect(
      adapter.observationVersions.get("charger-1.status.cableLocked"),
    ).to.deep.equal({ timestamp: Date.parse(timestamp), source: "REST" });
    expect(
      adapter.setStateAsync.calledWithExactly(
        "charger-1.config.lockCablePermanently",
        true,
        true,
      ),
    ).to.equal(true);
  });

  it("keeps REST polling active when SignalR is disabled", async () => {
    const adapter = createAdapterHarness();
    adapter.config = { signalR: false };
    adapter.refreshToken = sinon.stub().resolves();
    adapter.getAllCharger = sinon.stub().resolves([{ id: "charger" }]);
    adapter.setAllStatusObjects = sinon.stub().resolves();
    adapter.setAllConfigObjects = sinon.stub().resolves();
    adapter.subscribeChargerToSignalR = sinon.stub().resolves();
    adapter.getChargerState = sinon
      .stub()
      .resolves({ state: {}, timestamps: {} });
    adapter.getChargerConfig = sinon.stub().resolves({});
    adapter.getChargerSite = sinon.stub().resolves({});
    adapter.setNewStatusToCharger = sinon.stub().resolves();
    adapter.setConfigStatus = sinon.stub().resolves();

    await adapter.readAllStates();
    expect(adapter.getChargerState.calledOnceWithExactly("charger")).to.equal(
      true,
    );
    await new Promise<void>((resolve) => adapter.onUnload(resolve));
  });

  it("exposes the permanent cable lock setting as a separate writable config state", async () => {
    const adapter = createAdapterHarness();
    const setObjectNotExistsAsync = sinon.stub().resolves();
    adapter.setObjectNotExistsAsync = setObjectNotExistsAsync;
    adapter.extendObjectAsync = sinon.stub().resolves();
    adapter.subscribeStates = sinon.stub();

    await adapter.setAllConfigObjects({ id: "charger", name: "Charger" });

    expect(
      setObjectNotExistsAsync.calledWith(
        "charger.config.lockCablePermanently",
        sinon.match({
          common: sinon.match({
            type: "boolean",
            read: true,
            write: true,
          }),
        }),
      ),
    ).to.equal(true);
    expect(
      adapter.subscribeStates.calledWithExactly(
        "charger.config.lockCablePermanently",
      ),
    ).to.equal(true);
  });

  it("subscribes to phase 3 circuit limits and assigns a supported switch role", async () => {
    const adapter = createAdapterHarness();
    const setObjectNotExistsAsync = sinon.stub().resolves();
    adapter.setObjectNotExistsAsync = setObjectNotExistsAsync;
    adapter.extendObjectAsync = sinon.stub().resolves();
    adapter.subscribeStates = sinon.stub();

    await adapter.setAllConfigObjects({ id: "charger", name: "Charger" });

    expect(
      adapter.subscribeStates.calledWithExactly(
        "charger.config.circuitMaxCurrentP3",
      ),
    ).to.equal(true);
    expect(
      setObjectNotExistsAsync.calledWith(
        "charger.config.isEnabled",
        sinon.match({
          common: sinon.match({
            role: "switch.enable",
            read: true,
            write: true,
          }),
        }),
      ),
    ).to.equal(true);
  });

  it("writes the configured phase 2 circuit limit to the phase 2 state", async () => {
    const adapter = createAdapterHarness();

    await adapter.setConfigStatus(
      { id: "charger" },
      {
        isEnabled: true,
        phaseMode: 2,
        ledStripBrightness: 50,
        smartButtonEnabled: true,
        wiFiSSID: "network",
        maxChargerCurrent: 32,
        circuitMaxCurrentP1: 16,
        circuitMaxCurrentP2: 20,
        circuitMaxCurrentP3: 24,
      },
      null,
    );

    expect(
      adapter.setStateAsync.calledWithExactly(
        "charger.config.circuitMaxCurrentP2",
        { val: 20, ack: true },
      ),
    ).to.equal(true);
  });

  it("sends only supported phase modes to Cloud settings", () => {
    const adapter = createAdapterHarness();
    const changeConfig = sinon.stub().resolves();
    adapter.changeConfig = changeConfig;
    adapter.connectionMode = "cloud";
    const stateId = "easee.0.charger.config.phaseMode";

    for (const value of [1, 2, 3]) {
      adapter.onStateChange(stateId, { val: value, ack: false });
    }
    for (const value of [0, -1, 4, 1.5, "1", true, null]) {
      adapter.onStateChange(stateId, { val: value, ack: false });
    }

    expect(changeConfig.args).to.deep.equal([
      ["charger", "phaseMode", 1],
      ["charger", "phaseMode", 2],
      ["charger", "phaseMode", 3],
    ]);
    expect(adapter.setStateAsync.called).to.equal(false);
    expect(adapter.log.error.callCount).to.equal(7);
  });

  it("acknowledges only supported Cloud phase modes from charger configuration", async () => {
    const config = {
      isEnabled: true,
      ledStripBrightness: 50,
      smartButtonEnabled: true,
      wiFiSSID: "network",
      maxChargerCurrent: 32,
      circuitMaxCurrentP1: 16,
      circuitMaxCurrentP2: 20,
      circuitMaxCurrentP3: 24,
    };

    for (const phaseMode of [1, 2, 3]) {
      const adapter = createAdapterHarness();
      await adapter.setConfigStatus(
        { id: "charger" },
        { ...config, phaseMode },
        null,
      );
      expect(
        adapter.setStateAsync.calledWithExactly("charger.config.phaseMode", {
          val: phaseMode,
          ack: true,
        }),
      ).to.equal(true);
    }

    for (const phaseMode of [0, -1, 4, 1.5, "1", true, null]) {
      const adapter = createAdapterHarness();
      await adapter.setConfigStatus(
        { id: "charger" },
        { ...config, phaseMode },
        null,
      );
      expect(
        adapter.setStateAsync.calledWith(
          "charger.config.phaseMode",
          sinon.match({ ack: true }),
        ),
      ).to.equal(false);
    }
  });

  it("updates only access metadata on an existing permanent cable lock state", async () => {
    const adapter = createAdapterHarness();
    adapter.setObjectNotExistsAsync = sinon.stub().resolves();
    const extendObjectAsync = sinon.stub().resolves();
    adapter.extendObjectAsync = extendObjectAsync;
    adapter.subscribeStates = sinon.stub();

    await adapter.setAllConfigObjects({ id: "charger", name: "Charger" });

    expect(
      extendObjectAsync.calledWithExactly(
        "charger.config.lockCablePermanently",
        { common: { read: true, write: true } },
      ),
    ).to.equal(true);
  });

  it("sends boolean permanent cable-lock changes through charger settings", () => {
    const adapter = createAdapterHarness();
    const changeConfig = sinon.stub().resolves();
    adapter.changeConfig = changeConfig;

    adapter.onStateChange("easee.0.charger.config.lockCablePermanently", {
      val: true,
      ack: false,
    });
    adapter.onStateChange("easee.0.charger.config.lockCablePermanently", {
      val: false,
      ack: false,
    });
    adapter.onStateChange("easee.0.charger.config.lockCablePermanently", {
      val: 1,
      ack: false,
    });

    expect(changeConfig.args).to.deep.equal([
      ["charger", "lockCablePermanently", true],
      ["charger", "lockCablePermanently", false],
    ]);
    expect(adapter.log.error.calledOnce).to.equal(true);
  });

  it("logs successful config updates at debug level with charger and setting context", async () => {
    const adapter = createAdapterHarness();
    const post = sinon.stub(axios, "post").resolves({ data: {} });

    await adapter.changeConfig("charger", "lockCablePermanently", true);

    expect(post.calledOnce).to.equal(true);
    expect(adapter.log.info.called).to.equal(false);
    expect(
      adapter.log.debug.calledWith(
        "Config update successful for charger charger (lockCablePermanently)",
      ),
    ).to.equal(true);
  });

  it("posts the permanent cable-lock setting and does not confirm failed updates", async () => {
    const adapter = createAdapterHarness();
    const post = sinon.stub(axios, "post").rejects(new Error("request failed"));

    await adapter.changeConfig("charger", "lockCablePermanently", true);

    expect(post.calledOnce).to.equal(true);
    expect(post.firstCall.args[0]).to.equal(
      "https://api.easee.com/api/chargers/charger/settings",
    );
    expect(post.firstCall.args[1]).to.deep.equal({
      lockCablePermanently: true,
    });
    expect(adapter.setStateAsync.called).to.equal(false);
  });

  it("bounds charger observation requests with a finite timeout", async () => {
    const adapter = createAdapterHarness();
    const get = sinon
      .stub(axios, "get")
      .resolves({ data: { observations: [] } });

    await adapter.getChargerState("charger-1");

    expect(get.firstCall.args[1]!.timeout).to.equal(30000);
  });

  it("does not continue a poll after unload begins during the charger-list request", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    let resolveChargerList: ((chargers: { id: string }[]) => void) | undefined;
    adapter.refreshToken = sinon.stub().resolves();
    adapter.getAllCharger = () =>
      new Promise((resolve) => {
        resolveChargerList = resolve;
      });
    const polling = adapter.readAllStates();

    await Promise.resolve();
    adapter.unloading = true;
    resolveChargerList!([]);
    await polling;

    expect(adapter.setStateAsync.called).to.equal(false);
    expect(clock.countTimers()).to.equal(0);
  });

  for (const chargerCount of [1, 2, 3, 5]) {
    it(`polls each of ${chargerCount} chargers every seven-minute slot`, async () => {
      const adapter = createAdapterHarness();
      const clock = sinon.useFakeTimers();
      const chargerIds = Array.from(
        { length: chargerCount },
        (_, index) => `charger-${index + 1}`,
      );
      const getSession = sinon.stub().resolves([]);
      adapter.getChargerSession = getSession;
      adapter.setNewSessionToCharger = sinon.stub().resolves();

      adapter.updateSessionChargers(chargerIds.map((id) => ({ id })));
      await clock.tickAsync(0);
      expect(getSession.firstCall.args[0]).to.equal(chargerIds[0]);
      for (let index = 1; index < chargerCount; index++) {
        await clock.tickAsync(7 * 60 * 1000);
        expect(getSession.getCall(index).args[0]).to.equal(chargerIds[index]);
      }
      await clock.tickAsync(7 * 60 * 1000);
      expect(getSession.getCall(chargerCount).args[0]).to.equal(chargerIds[0]);
      expect(adapter.sessionLastRequestAt).to.equal(clock.now);
    });
  }

  it("uses a manually configured per-charger interval without breaking the API floor", () => {
    const adapter = createAdapterHarness();
    adapter.sessionPollMode = "manual";
    adapter.sessionManualInterval = 20;
    adapter.sessionChargers = ["charger-a", "charger-b"];

    expect(adapter.getSessionRequestInterval()).to.equal(10 * 60 * 1000);
  });

  it("spreads manual session polling evenly and persists the last request", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    adapter.sessionPollMode = "manual";
    adapter.sessionManualInterval = 20;
    const getSession = sinon.stub().resolves([]);
    adapter.getChargerSession = getSession;
    adapter.setNewSessionToCharger = sinon.stub().resolves();

    adapter.updateSessionChargers([{ id: "charger-a" }, { id: "charger-b" }]);
    await clock.tickAsync(0);
    expect(getSession.calledOnce).to.equal(true);
    expect(
      adapter.setStateAsync.calledWithExactly(
        "info.sessionPollLastRequest",
        clock.now,
        true,
      ),
    ).to.equal(true);
    await clock.tickAsync(10 * 60 * 1000 - 1);
    expect(getSession.calledOnce).to.equal(true);
    await clock.tickAsync(1);
    expect(getSession.secondCall.args[0]).to.equal("charger-b");
  });

  it("clamps a manual interval below the recommendation and reports the effective value", async () => {
    const adapter = createAdapterHarness();
    adapter.sessionPollMode = "manual";
    adapter.sessionManualInterval = 8;
    adapter.sessionChargers = ["charger-a", "charger-b", "charger-c"];

    expect(adapter.getSessionRequestInterval()).to.equal(7 * 60 * 1000);
    await adapter.updateSessionPollInfo();
    expect(adapter.setStateAsync.args).to.deep.equal([
      ["info.sessionPollChargerCount", 3, true],
      ["info.sessionPollRecommendedInterval", 21, true],
      ["info.sessionPollEffectiveInterval", 21, true],
    ]);
  });

  it("defaults to automatic mode and a valid interval for legacy settings", () => {
    const adapter = createAdapterHarness();
    adapter.config = {};

    adapter.configureSessionPolling();

    expect(adapter.sessionPollMode).to.equal("auto");
    expect(adapter.sessionManualInterval).to.equal(60);
  });

  it("caps configured manual session intervals to a safe timer range", () => {
    const adapter = createAdapterHarness();
    adapter.config = {
      sessionPollMode: "manual",
      sessionPollInterval: Number.MAX_SAFE_INTEGER,
    };

    adapter.configureSessionPolling();

    expect(adapter.sessionManualInterval).to.equal(
      Math.floor(2_147_483_647 / 60_000),
    );
  });

  it("starts immediately and never overlaps or duplicates session requests", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    let resolveRequest: ((sessions: unknown[]) => void) | undefined;
    const getSession = sinon.stub().returns(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    adapter.getChargerSession = getSession;
    adapter.setNewSessionToCharger = sinon.stub().resolves();

    adapter.updateSessionChargers([{ id: "charger-a" }, { id: "charger-b" }]);
    await clock.tickAsync(0);
    expect(getSession.calledOnce).to.equal(true);
    adapter.updateSessionChargers([{ id: "charger-a" }, { id: "charger-b" }]);
    await clock.tickAsync(14 * 60 * 1000);
    expect(getSession.calledOnce).to.equal(true);

    resolveRequest!([]);
    await clock.tickAsync(0);
    await clock.tickAsync(7 * 60 * 1000);
    expect(getSession.secondCall.args[0]).to.equal("charger-b");
  });

  it("updates the round-robin list when chargers are added and removed", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const getSession = sinon.stub().resolves([]);
    adapter.getChargerSession = getSession;
    adapter.setNewSessionToCharger = sinon.stub().resolves();

    adapter.updateSessionChargers([{ id: "charger-a" }, { id: "charger-b" }]);
    await clock.tickAsync(0);
    adapter.updateSessionChargers([{ id: "charger-b" }, { id: "charger-c" }]);
    await clock.tickAsync(7 * 60 * 1000);

    expect(getSession.secondCall.args[0]).to.equal("charger-b");
    expect(adapter.sessionChargers).to.deep.equal(["charger-b", "charger-c"]);
  });

  it("honors Retry-After seconds and HTTP-date values", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers({
      now: new Date("2026-10-18T12:00:00Z"),
    });
    adapter.requestWithBackoff =
      createAdapter.Easee.prototype.requestWithBackoff;
    const requests = [
      sinon.stub().rejects({
        response: { status: 429, headers: { "retry-after": "120" } },
      }),
      sinon.stub().rejects({
        response: {
          status: 429,
          headers: { "retry-after": "Sun, 18 Oct 2026 12:05:00 GMT" },
        },
      }),
    ];
    for (const [index, request] of requests.entries()) {
      try {
        await adapter.requestWithBackoff(`charger session ${index}`, request);
      } catch (error) {
        expect(error).to.have.property("retryDeferred", true);
      }
      expect(
        adapter.apiRetryState.get(`charger session ${index}`).retryAt,
      ).to.equal(clock.now + (index === 0 ? 120000 : 300000));
    }
  });

  it("uses a seven-minute fallback for 429 without rate-limit headers", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    adapter.requestWithBackoff =
      createAdapter.Easee.prototype.requestWithBackoff;
    try {
      await adapter.requestWithBackoff(
        "charger session charger-a",
        sinon.stub().rejects({ response: { status: 429 } }),
      );
    } catch (error) {
      expect(error).to.have.property("retryDeferred", true);
    }
    expect(
      adapter.apiRetryState.get("charger session charger-a").retryAt,
    ).to.equal(clock.now + 7 * 60 * 1000);
  });

  it("caps an excessive Retry-After value to the maximum Node timer delay", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    adapter.requestWithBackoff =
      createAdapter.Easee.prototype.requestWithBackoff;

    try {
      await adapter.requestWithBackoff(
        "charger config charger-a",
        sinon.stub().rejects({
          response: { status: 429, headers: { "retry-after": "999999999" } },
        }),
      );
    } catch (error) {
      expect(error).to.have.property("retryDeferred", true);
    }

    expect(
      adapter.apiRetryState.get("charger config charger-a").retryAt,
    ).to.equal(clock.now + 2_147_483_647);
  });

  it("uses standard rate-limit reset headers when the bucket is empty", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    adapter.requestWithBackoff =
      createAdapter.Easee.prototype.requestWithBackoff;
    try {
      await adapter.requestWithBackoff(
        "charger session charger-a",
        sinon.stub().rejects({
          response: {
            status: 429,
            headers: { "ratelimit-remaining": "0", "ratelimit-reset": "900" },
          },
        }),
      );
    } catch (error) {
      expect(error).to.have.property("retryDeferred", true);
    }
    expect(
      adapter.apiRetryState.get("charger session charger-a").retryAt,
    ).to.equal(clock.now + 900000);
  });

  it("applies a session Retry-After to the shared polling schedule", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    adapter.requestWithBackoff =
      createAdapter.Easee.prototype.requestWithBackoff;
    try {
      await adapter.requestWithBackoff(
        "charger session charger-a",
        sinon.stub().rejects({
          response: { status: 429, headers: { "retry-after": "900" } },
        }),
      );
    } catch (error) {
      expect(error).to.have.property("retryDeferred", true);
    }

    const getSession = sinon.stub().resolves([]);
    adapter.getChargerSession = getSession;
    adapter.setNewSessionToCharger = sinon.stub().resolves();
    adapter.updateSessionChargers([{ id: "charger-a" }, { id: "charger-b" }]);
    await clock.tickAsync(0);
    expect(getSession.called).to.equal(false);
    await clock.tickAsync(15 * 60 * 1000 - 1);
    expect(getSession.called).to.equal(false);
    await clock.tickAsync(1);
    expect(getSession.calledOnce).to.equal(true);
    expect(getSession.firstCall.args[0]).to.equal("charger-a");
  });

  it("continues after a temporary session error and retries that charger later", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    const getSession = sinon.stub();
    getSession.onFirstCall().rejects(new Error("temporary failure"));
    getSession.onSecondCall().resolves([]);
    adapter.getChargerSession = getSession;
    adapter.setNewSessionToCharger = sinon.stub().resolves();

    adapter.updateSessionChargers([{ id: "charger-a" }, { id: "charger-b" }]);
    await clock.tickAsync(0);
    await clock.tickAsync(7 * 60 * 1000);
    expect(getSession.secondCall.args[0]).to.equal("charger-b");
    await clock.tickAsync(7 * 60 * 1000);
    expect(getSession.thirdCall.args[0]).to.equal("charger-a");
  });

  it("runs session polling despite status/config errors and clears its timer on unload", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    adapter.refreshToken = sinon.stub().resolves();
    adapter.getAllCharger = sinon
      .stub()
      .resolves([{ id: "charger-a" }, { id: "charger-b" }]);
    adapter.setAllStatusObjects = sinon.stub().resolves();
    adapter.setAllConfigObjects = sinon.stub().resolves();
    adapter.subscribeChargerToSignalR = sinon.stub().resolves();
    adapter.getChargerState = sinon.stub().rejects(new Error("status failed"));
    const getSession = sinon.stub().resolves([]);
    adapter.getChargerSession = getSession;
    adapter.setNewSessionToCharger = sinon.stub().resolves();

    await adapter.readAllStates();
    await clock.tickAsync(0);
    expect(
      getSession.calledOnceWithExactly("charger-a", sinon.match.any),
    ).to.equal(true);
    adapter.onUnload(() => {});
    expect(adapter.sessionPollTimer).to.equal(null);
    expect(clock.countTimers()).to.equal(0);
  });

  it("runs session polling despite config errors", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    adapter.refreshToken = sinon.stub().resolves();
    adapter.getAllCharger = sinon
      .stub()
      .resolves([{ id: "config-error-charger" }]);
    adapter.setAllStatusObjects = sinon.stub().resolves();
    adapter.setAllConfigObjects = sinon.stub().resolves();
    adapter.subscribeChargerToSignalR = sinon.stub().resolves();
    adapter.getChargerState = sinon.stub().resolves({});
    adapter.getChargerConfig = sinon.stub().rejects(new Error("config failed"));
    adapter.getChargerSession = sinon.stub().resolves([]);
    adapter.setNewSessionToCharger = sinon.stub().resolves();

    await adapter.readAllStates();
    await clock.tickAsync(0);
    expect(adapter.getChargerSession.calledOnce).to.equal(true);
    adapter.onUnload(() => {});
    expect(clock.countTimers()).to.equal(0);
  });

  describe("Bluetooth write routing", () => {
    afterEach(() => sinon.restore());

    function createBluetoothAdapterHarness(): ReturnType<
      typeof createAdapterHarness
    > {
      const adapter = createAdapterHarness();
      adapter.bluetoothConnections = new Map([["EMX12345", true]]);
      adapter.bluetoothConnectionGenerations = new Map([["EMX12345", 1]]);
      adapter.bluetoothConnectionErrors = new Map();
      adapter.bluetoothPauseRestore = new Map();
      adapter.applyBluetoothPoll = sinon.stub().resolves();
      adapter.updateBluetoothSearchReadiness = sinon.stub().resolves();
      adapter.bluetoothWritesInFlight = 0;
      return adapter;
    }

    it("acknowledges only supported Bluetooth phase modes after matching readback", async () => {
      for (const phaseMode of [1, 2, 3]) {
        const adapter = createBluetoothAdapterHarness();
        const stateId = "easee.0.EMX12345.config.phaseMode";
        const command = sinon.stub().resolves({ id: 7, code: 1 });
        const poll = sinon
          .stub()
          .resolves({ config: { phaseMode }, state: {}, values: {} });
        adapter.bluetoothClient = { command, poll };

        await adapter.handleBluetoothStateChange(stateId, {
          val: phaseMode,
          ack: false,
        });

        expect(
          command.calledOnceWithExactly("EMX12345", {
            type: "setPhaseMode",
            mode: phaseMode,
          }),
        ).to.equal(true);
        expect(
          adapter.setStateAsync.calledWith(stateId, {
            val: phaseMode,
            ack: true,
          }),
        ).to.equal(true);
      }
    });

    it("rejects invalid Bluetooth phase modes without sending or acknowledging them", async () => {
      for (const phaseMode of [0, -1, 4, 1.5, "1", true, null]) {
        const adapter = createBluetoothAdapterHarness();
        const stateId = "easee.0.EMX12345.config.phaseMode";
        const command = sinon.stub();
        adapter.bluetoothClient = { command, poll: sinon.stub() };

        await adapter.handleBluetoothStateChange(stateId, {
          val: phaseMode,
          ack: false,
        });

        expect(command.called).to.equal(false);
        expect(
          adapter.setStateAsync.calledWith(stateId, {
            val: phaseMode,
            ack: true,
          }),
        ).to.equal(false);
        expect(adapter.log.error.called).to.equal(true);
      }
    });

    it("acknowledges a setting only after a positive reply and matching readback", async () => {
      const adapter = createBluetoothAdapterHarness();
      const stateId = "easee.0.EMX12345.config.isEnabled";
      const command = sinon.stub().resolves({ id: 29, code: 1 });
      const poll = sinon
        .stub()
        .resolves({ config: { isEnabled: 1 }, state: {}, values: {} });
      adapter.bluetoothClient = { command, poll };

      await adapter.handleBluetoothStateChange(stateId, {
        val: true,
        ack: false,
      });

      expect(
        command.calledOnceWithExactly("EMX12345", {
          type: "setEnabled",
          enabled: true,
        }),
      ).to.equal(true);
      expect(
        adapter.setStateAsync.calledWith(stateId, { val: true, ack: true }),
      ).to.equal(true);
    });

    it("does not acknowledge a command rejected by the charger", async () => {
      const adapter = createBluetoothAdapterHarness();
      const stateId = "easee.0.EMX12345.config.isEnabled";
      const command = sinon
        .stub()
        .rejects(new Error("The charger refused BLE command 29"));
      adapter.bluetoothClient = { command, poll: sinon.stub() };

      await adapter.handleBluetoothStateChange(stateId, {
        val: true,
        ack: false,
      });

      expect(command.calledOnce).to.equal(true);
      expect(
        adapter.setStateAsync.calledWith(stateId, { val: true, ack: true }),
      ).to.equal(false);
      expect(adapter.log.error.called).to.equal(true);
    });

    it("rejects Cloud-only writes without sending or acknowledging them", async () => {
      const adapter = createBluetoothAdapterHarness();
      const stateId = "easee.0.EMX12345.control.start";
      const command = sinon.stub();
      adapter.bluetoothClient = { command, poll: sinon.stub() };

      await adapter.handleBluetoothStateChange(stateId, {
        val: true,
        ack: false,
      });

      expect(command.called).to.equal(false);
      expect(
        adapter.setStateAsync.calledWith(stateId, { val: true, ack: true }),
      ).to.equal(false);
      expect(adapter.log.error.called).to.equal(true);
    });

    it("does not send a pre-disconnect pause after the connection changes", async () => {
      const adapter = createBluetoothAdapterHarness();
      const stateId = "easee.0.EMX12345.control.pause";
      const command = sinon.stub();
      adapter.bluetoothClient = { command, poll: sinon.stub() };
      adapter.readBluetoothPoll = sinon.stub().callsFake(() => {
        adapter.bluetoothConnectionGenerations.set("EMX12345", 2);
        return Promise.resolve({
          config: {},
          state: { dynamicChargerCurrent: 16 },
          values: {},
        });
      });

      await adapter.handleBluetoothStateChange(stateId, {
        val: true,
        ack: false,
      });

      expect(command.called).to.equal(false);
      expect(
        adapter.setStateAsync.calledWith(stateId, { val: true, ack: true }),
      ).to.equal(false);
      expect(adapter.log.error.called).to.equal(true);
    });
  });

  it("aborts an in-flight session request during unload", async () => {
    const adapter = createAdapterHarness();
    const clock = sinon.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    adapter.getChargerSession = sinon
      .stub()
      .callsFake((_chargerId: string, signal: AbortSignal) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });

    adapter.setNewSessionToCharger = sinon.stub().resolves();

    adapter.updateSessionChargers([{ id: "charger-a" }]);
    await clock.tickAsync(0);
    expect(requestSignal!.aborted).to.equal(false);
    adapter.onUnload(() => {});
    expect(requestSignal!.aborted).to.equal(true);
    await clock.tickAsync(0);
    expect(clock.countTimers()).to.equal(0);
  });

  describe("Cloud control writes", () => {
    afterEach(() => sinon.restore());

    it("sends whitelisted charging commands through the shared POST helper", async () => {
      const adapter = createAdapterHarness();
      const post = sinon.stub(axios, "post").resolves({});

      await adapter.startCharging("charger");
      await adapter.stopCharging("charger");
      await adapter.pauseCharging("charger");
      await adapter.resumeCharging("charger");
      await adapter.rebootCharging("charger");

      expect(
        post.args.map(([url, body]) => [
          new URL(String(url)).pathname.split("/").pop(),
          body,
        ]),
      ).to.deep.equal([
        ["start_charging", {}],
        ["stop_charging", {}],
        ["pause_charging", {}],
        ["resume_charging", {}],
        ["reboot", {}],
      ]);
      expect(
        adapter.log.info.args.map((args: unknown[]) => args[0]),
      ).to.deep.equal([
        "Start charging successful",
        "Stop charging successful",
        "Pause charging successful",
        "Resume charging successful",
        "Reboot charging successful",
      ]);
    });

    it("forwards failed command requests without converting them to success", async () => {
      const adapter = createAdapterHarness();
      const failure = new Error("request failed");
      sinon.stub(axios, "post").rejects(failure);

      try {
        await adapter.pauseCharging("charger");
        throw new Error("Expected the request to reject");
      } catch (error) {
        expect(error).to.equal(failure);
      }
      expect(adapter.log.info.called).to.equal(false);
      expect(
        adapter.log.error.args.map((args: unknown[]) => args[0]),
      ).to.deep.equal(["Pause charging error", "request failed"]);
    });

    it("does not execute acknowledged button state updates", () => {
      const adapter = createAdapterHarness();
      adapter.connectionMode = "cloud";
      adapter.startCharging = sinon.stub().resolves();

      adapter.onStateChange("easee.0.charger.control.start", {
        val: true,
        ack: true,
      });

      expect(adapter.startCharging.called).to.equal(false);
    });

    it("acknowledges a Cloud button only after the request succeeds", async () => {
      const adapter = createAdapterHarness();
      const stateId = "easee.0.charger.control.start";
      adapter.startCharging = sinon.stub().resolves();

      await adapter.executeCloudControlWrite(stateId, "charger", "start", true);

      expect(adapter.startCharging.calledOnceWithExactly("charger")).to.equal(
        true,
      );
      expect(
        adapter.setStateAsync.calledWith(stateId, { val: true, ack: true }),
      ).to.equal(true);
    });

    it("does not acknowledge or send a failed Cloud command", async () => {
      const adapter = createAdapterHarness();
      const stateId = "easee.0.charger.control.start";
      adapter.startCharging = sinon.stub().rejects(new Error("request failed"));

      await adapter.executeCloudControlWrite(stateId, "charger", "start", true);

      expect(
        adapter.setStateAsync.calledWith(stateId, { val: true, ack: true }),
      ).to.equal(false);
      expect(adapter.log.error.called).to.equal(true);
    });

    it("ignores false button writes", async () => {
      const adapter = createAdapterHarness();
      adapter.startCharging = sinon.stub().resolves();

      await adapter.executeCloudControlWrite(
        "easee.0.charger.control.start",
        "charger",
        "start",
        false,
      );

      expect(adapter.startCharging.called).to.equal(false);
      expect(adapter.setStateAsync.called).to.equal(false);
    });
  });

  describe("Connection-mode datapoints", () => {
    afterEach(() => sinon.restore());

    it("keeps supported states and removes stale mode-specific states on switches", async () => {
      const adapter = createAdapterHarness();
      adapter.reconcileModeSpecificObjects =
        createAdapter.Easee.prototype.reconcileModeSpecificObjects.bind(
          adapter,
        );
      const objects = attachObjectStore(adapter);
      objects.set("userDevice", {
        type: "device",
        common: { name: "User device" },
      });
      objects.set("userDevice.status.authToken", {
        type: "state",
        common: { name: "User data" },
      });
      objects.set("userDevice.info.bluetoothRSSI", {
        type: "state",
        common: { name: "User data" },
      });
      objects.set("charger.userCreated", {
        type: "state",
        common: { name: "User data" },
      });
      objects.set("charger.status.chargerOpMode", {
        type: "state",
        common: { name: "Customized operation mode" },
        native: { preserve: true },
      });

      const staleCloudIds = [
        "lastUpdate",
        "info.sessionPollLastRequest",
        "charger.control.start",
        "charger.control.stop",
        "charger.status.cableLocked",
        "charger.status.authToken",
        "charger.status.authTokenName",
        "charger.status.wiFiRSSI",
        "charger.status.chargerFirmware",
        "charger.status.outputCurrent",
        "charger.status.inVoltageT1T2",
        "charger.status.inVoltageT1T3",
        "charger.status.inVoltageT1T4",
        "charger.status.inVoltageT1T5",
        "charger.status.isOnline",
        "charger.status.wiFiAPEnabled",
        "charger.status.TempMax",
        "charger.config.costPerKWh",
        "charger.config.costPerKwhExcludeVat",
        "charger.config.vat",
        "charger.config.smartCharging",
        "charger.config.smartButtonEnabled",
        "charger.session.2025.total_year",
        "charger.session.2025.3.totalEnergyUsage",
        "charger.session.2025.3.totalCost",
      ];
      for (const id of [
        ...staleCloudIds,
        "info.bluetoothAdapterState",
        "info.bluetoothSearchReadiness",
      ]) {
        objects.set(id, { type: "state" });
      }

      adapter.connectionMode = "bluetooth";
      await adapter.setAllStatusObjects({ id: "charger", name: "Charger" });
      await adapter.setAllConfigObjects({ id: "charger", name: "Charger" });
      await adapter.setBluetoothInfoObjects({
        id: "charger",
        name: "Charger",
      });
      const bluetoothCreatedIds = adapter.setObjectNotExistsAsync.args.map(
        (args: unknown[]) => args[0] as string,
      );
      for (const id of staleCloudIds.filter((id) =>
        id.startsWith("charger."),
      )) {
        expect(bluetoothCreatedIds).not.to.include(id);
      }
      await adapter.reconcileModeSpecificObjects();
      const bluetoothStates = new Set(
        [...objects.entries()]
          .filter(([, object]) => object.type === "state")
          .map(([id]) => id),
      );
      for (const id of [
        "charger.id",
        "charger.name",
        "charger.status.chargerOpMode",
        "charger.status.reasonForNoCurrent",
        "charger.status.totalPower",
        "charger.status.inCurrentT2",
        "charger.status.inCurrentT3",
        "charger.status.inCurrentT4",
        "charger.status.inCurrentT5",
        "charger.status.inVoltageT2T3",
        "charger.status.inVoltageT2T4",
        "charger.status.inVoltageT2T5",
        "charger.status.inVoltageT3T4",
        "charger.status.inVoltageT3T5",
        "charger.status.inVoltageT4T5",
        "charger.status.voltage",
        "charger.status.ledMode",
        "charger.status.lifetimeEnergy",
        "charger.config.isEnabled",
        "charger.config.phaseMode",
        "charger.config.maxChargerCurrent",
        "charger.config.dynamicChargerCurrent",
        "charger.config.dynamicCircuitCurrentP1",
        "charger.config.dynamicCircuitCurrentP2",
        "charger.config.dynamicCircuitCurrentP3",
        "charger.config.circuitMaxCurrentP1",
        "charger.config.circuitMaxCurrentP2",
        "charger.config.circuitMaxCurrentP3",
        "charger.config.ledStripBrightness",
        "charger.config.lockCablePermanently",
        "charger.config.wiFiSSID",
        "charger.info.bluetoothConnection",
        "charger.info.bluetoothError",
        "charger.info.bluetoothRSSI",
        "info.bluetoothAdapterState",
        "info.bluetoothSearchReadiness",
        "charger.userCreated",
        "userDevice.status.authToken",
      ]) {
        expect(
          bluetoothStates.has(id),
          `${id} should remain in Bluetooth mode`,
        ).to.equal(true);
      }
      for (const id of staleCloudIds) {
        expect(
          bluetoothStates.has(id),
          `${id} should be absent in Bluetooth mode`,
        ).to.equal(false);
      }
      expect(bluetoothStates.has("userDevice.info.bluetoothRSSI")).to.equal(
        true,
      );
      expect(objects.get("charger.status.chargerOpMode")).to.deep.include({
        common: { name: "Customized operation mode" },
        native: { preserve: true },
      });
      expect(
        adapter.extendObjectAsync.calledWith("charger.name", {
          common: { role: "text", write: false },
        }),
      ).to.equal(true);
      expect(
        adapter.extendObjectAsync.calledWith("charger.config.wiFiSSID", {
          common: { read: true, write: false },
        }),
      ).to.equal(true);
      expect(
        adapter.extendObjectAsync.calledWith(
          "charger.config.ledStripBrightness",
          { common: { role: "level.dimmer", unit: "%", min: 0, max: 100 } },
        ),
      ).to.equal(true);
      expect(
        adapter.extendObjectAsync.calledWith(
          "charger.config.lockCablePermanently",
          { common: { read: true, write: true } },
        ),
      ).to.equal(true);

      adapter.connectionMode = "cloud";
      await adapter.setAllStatusObjects({ id: "charger", name: "Charger" });
      await adapter.setAllConfigObjects({ id: "charger", name: "Charger" });
      for (const id of [
        "lastUpdate",
        "info.sessionPollLastRequest",
        "info.bluetoothAdapterState",
        "info.bluetoothAdapterStateDisplay",
        "info.bluetoothSearchReadiness",
        "info.bluetoothSearchReadinessDisplay",
        "info.bluetoothScanResults",
        "info.bluetoothScanResultsDisplay",
        "charger.session.2025.3.totalCost",
      ]) {
        objects.set(id, { type: "state" });
      }
      await adapter.reconcileModeSpecificObjects();
      expect(
        adapter.extendObjectAsync.calledWith("charger.status.cableLocked", {
          common: { role: "indicator", read: true, write: false },
        }),
      ).to.equal(true);

      const cloudStates = new Set(
        [...objects.entries()]
          .filter(([, object]) => object.type === "state")
          .map(([id]) => id),
      );
      for (const id of [
        "lastUpdate",
        "info.sessionPollLastRequest",
        "charger.control.start",
        "charger.control.stop",
        "charger.status.authToken",
        "charger.status.authTokenName",
        "charger.status.cableLocked",
        "charger.status.TempMax",
        "charger.config.costPerKWh",
        "charger.config.smartCharging",
        "charger.config.wiFiSSID",
        "charger.session.2025.3.totalCost",
        "charger.userCreated",
        "userDevice.info.bluetoothRSSI",
      ]) {
        expect(
          cloudStates.has(id),
          `${id} should remain in Cloud mode`,
        ).to.equal(true);
      }
      for (const id of [
        "info.bluetoothAdapterState",
        "info.bluetoothAdapterStateDisplay",
        "info.bluetoothSearchReadiness",
        "info.bluetoothSearchReadinessDisplay",
        "info.bluetoothScanResults",
        "info.bluetoothScanResultsDisplay",
        "charger.info.bluetoothConnection",
        "charger.info.bluetoothError",
        "charger.info.bluetoothRSSI",
      ]) {
        expect(
          cloudStates.has(id),
          `${id} should be absent in Cloud mode`,
        ).to.equal(false);
      }
      expect(
        adapter.extendObjectAsync.calledWith("charger.name", {
          common: { role: "text", write: true },
        }),
      ).to.equal(true);
      expect(
        adapter.extendObjectAsync.calledWith("charger.config.wiFiSSID", {
          common: { read: true, write: true },
        }),
      ).to.equal(true);
    });
  });

  describe("External object ID validation", () => {
    it("ignores SignalR updates that could create unsafe object paths", () => {
      const adapter = createAdapterHarness();

      adapter.handleSignalRProductUpdate({
        id: 103,
        mid: "../outside",
        dataType: 2,
        value: true,
      });

      expect(adapter.setStateAsync.called).to.equal(false);
      expect(adapter.log.warn.calledOnce).to.equal(true);
    });

    it("does not create Cloud objects from charger IDs containing path separators", async () => {
      const adapter = createAdapterHarness();
      const clock = sinon.useFakeTimers();
      const updateSessionChargers = sinon.stub();
      adapter.refreshToken = sinon.stub().resolves();
      adapter.getAllCharger = sinon
        .stub()
        .resolves([{ id: "../outside", name: "Unexpected" }]);
      adapter.updateSessionChargers = updateSessionChargers;
      adapter.setAllStatusObjects = sinon.stub().resolves();
      adapter.setAllConfigObjects = sinon.stub().resolves();

      await adapter.readAllStates();

      expect(updateSessionChargers.called).to.equal(false);
      expect(adapter.setAllStatusObjects.called).to.equal(false);
      expect(adapter.setAllConfigObjects.called).to.equal(false);
      adapter.onUnload(() => {});
      await clock.tickAsync(0);
    });

    it("does not create session objects from invalid calendar values", async () => {
      const adapter = createAdapterHarness();
      const setObjectNotExistsAsync = sinon.stub().resolves();
      adapter.setObjectNotExistsAsync = setObjectNotExistsAsync;

      await adapter.setNewSessionToCharger({ id: "charger" }, [
        {
          year: 2026,
          month: 13,
          totalEnergyUsage: 10,
          totalCost: 2,
        },
      ]);

      expect(setObjectNotExistsAsync.called).to.equal(false);
      expect(adapter.log.warn.calledOnce).to.equal(true);
    });
  });
});
