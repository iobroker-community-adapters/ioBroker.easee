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
