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
const createAdapter = require("./main.ts");
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
          circuits: { id: string }[];
        }) => Promise<void>,
      ) =>
        update({
          id: `site-${chargerId}`,
          circuits: [{ id: `circuit-${chargerId}` }],
        }),
    );
  adapter.getChargerSite = sinon.stub().callsFake((chargerId: string) =>
    Promise.resolve({
      id: `site-${chargerId}`,
      circuits: [{ id: `circuit-${chargerId}` }],
    }),
  );
  return adapter;
}

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
      ((site: { id: string; circuits: { id: string }[] }) => void) | undefined;
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
      new Promise<{ id: string; circuits: { id: string }[] }>((resolve) => {
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
      circuits: [{ id: "circuit-charger" }],
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
        circuits: [{ id: "shared-circuit" }],
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
        circuits: [{ id: "shared-circuit" }],
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
        return adapter;
      }

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
    adapter.setNewSessionToCharger = sinon.stub().resolves();

    adapter.updateSessionChargers([{ id: "charger-a" }]);
    await clock.tickAsync(0);
    expect(requestSignal!.aborted).to.equal(false);
    adapter.onUnload(() => {});
    expect(requestSignal!.aborted).to.equal(true);
    await clock.tickAsync(0);
    expect(clock.countTimers()).to.equal(0);
  });
});
