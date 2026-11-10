"use strict";

export {};

import { expect } from "chai";
import sinon from "sinon";
import axios from "axios";
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

interface RetryState {
  delay: number;
  retryAt: number;
  inFlight: Promise<unknown> | null;
}

interface CloudRuntimeAdapter {
  apiRetryState: Map<string, RetryState>;
  unloading: boolean;
  expireTime: number;
  polltime: number;
  chargerNameVersions: Map<string, number>;
  chargerIds: string[];
  sessionChargers: string[];
  sessionCursor: number;
  log: {
    debug: sinon.SinonStub;
    error: sinon.SinonStub;
    info: sinon.SinonStub;
    warn: sinon.SinonStub;
  };
  setStateAsync: sinon.SinonStub;
  getStateAsync: sinon.SinonStub;
  setObjectNotExistsAsync: sinon.SinonStub;
  extendObjectAsync: sinon.SinonStub;
  subscribeStates: sinon.SinonStub;
  getAllCharger: sinon.SinonStub;
  updateSessionChargers: sinon.SinonStub;
  scheduleCloudPoll: sinon.SinonStub;
  requestWithBackoff<T>(
    key: string,
    requestFn: () => Promise<T>,
    coalesceInFlight?: boolean,
  ): Promise<T>;
  readAllStates(): Promise<void>;
  runCloudPoll(): Promise<void>;
  setAllStatusObjects(charger: { id: string }): Promise<void>;
  changeChargingPrice(
    chargerId: string,
    site: { id: string; currencyId: string },
    netPrice: number,
    vat: number,
  ): Promise<void>;
}

interface AdapterFactory {
  Easee: new (...args: never[]) => object;
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
const createAdapter = require("../src/main.ts") as AdapterFactory;
moduleLoader._load = originalLoad;

function createHarness(): CloudRuntimeAdapter {
  const adapter = Object.create(
    createAdapter.Easee.prototype,
  ) as CloudRuntimeAdapter;
  adapter.apiRetryState = new Map();
  adapter.unloading = false;
  adapter.expireTime = Number.MAX_SAFE_INTEGER;
  adapter.polltime = 30;
  adapter.chargerNameVersions = new Map();
  adapter.chargerIds = [];
  adapter.sessionChargers = [];
  adapter.sessionCursor = 0;
  adapter.log = {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  };
  adapter.setStateAsync = sinon.stub().resolves();
  adapter.getStateAsync = sinon.stub().resolves(null);
  adapter.setObjectNotExistsAsync = sinon.stub().resolves();
  adapter.extendObjectAsync = sinon.stub().resolves();
  adapter.subscribeStates = sinon.stub();
  adapter.getAllCharger = sinon.stub().resolves([]);
  adapter.updateSessionChargers = sinon.stub();
  adapter.scheduleCloudPoll = sinon.stub();
  return adapter;
}

describe("Cloud runtime regressions", () => {
  afterEach(() => sinon.restore());

  it("serializes different writes that share a retry key", async () => {
    const adapter = createHarness();
    const requestResolves: Array<(value: string) => void> = [];
    const first = adapter.requestWithBackoff(
      "charging price charger-1",
      () =>
        new Promise<string>((resolve) => {
          requestResolves.push(resolve);
        }),
      false,
    );
    const second = adapter.requestWithBackoff(
      "charging price charger-1",
      () =>
        new Promise<string>((resolve) => {
          requestResolves.push(resolve);
        }),
      false,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestResolves).to.have.length(1);
    requestResolves[0]("first");
    expect(await first).to.equal("first");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestResolves).to.have.length(2);
    requestResolves[1]("second");
    expect(await second).to.equal("second");
  });

  it("marks Cloud unavailable and preserves lastUpdate after an incomplete poll", async () => {
    const adapter = createHarness();
    adapter.getAllCharger.resolves(undefined);

    await adapter.readAllStates();

    sinon.assert.calledWithExactly(
      adapter.setStateAsync,
      "info.connection",
      false,
      true,
    );
    sinon.assert.neverCalledWith(
      adapter.setStateAsync,
      "lastUpdate",
      sinon.match.any,
      true,
    );
    sinon.assert.calledOnce(adapter.scheduleCloudPoll);
  });

  it("marks Cloud available and updates lastUpdate after a complete poll", async () => {
    const adapter = createHarness();
    adapter.getAllCharger.resolves([]);

    await adapter.readAllStates();

    sinon.assert.calledWithExactly(
      adapter.setStateAsync,
      "info.connection",
      true,
      true,
    );
    sinon.assert.calledWith(
      adapter.setStateAsync,
      "lastUpdate",
      sinon.match.string,
      true,
    );
    sinon.assert.calledOnce(adapter.scheduleCloudPoll);
  });

  it("continues polling after an unexpected poll failure", async () => {
    const adapter = createHarness();
    adapter.readAllStates = sinon.stub().rejects(new Error("poll failed"));

    await adapter.runCloudPoll();

    sinon.assert.calledOnce(adapter.log.error);
    sinon.assert.calledOnce(adapter.scheduleCloudPoll);
  });

  it("preserves existing session token and owner values while creating objects", async () => {
    const adapter = createHarness();
    adapter.getStateAsync.callsFake((id: string) => {
      if (id.endsWith(".status.authToken")) {
        return { val: "existing-session-token", ack: true };
      }
      if (id.endsWith(".status.authTokenName")) {
        return { val: "Existing owner", ack: true };
      }
      return null;
    });

    await adapter.setAllStatusObjects({ id: "charger-1" });

    const initializedIds = adapter.setStateAsync
      .getCalls()
      .map((call) => call.args[0]);
    expect(initializedIds).not.to.include("charger-1.status.authToken");
    expect(initializedIds).not.to.include("charger-1.status.authTokenName");
  });

  it("uses distinct POSTs for consecutive charging-price changes", async () => {
    const adapter = createHarness();
    const requests: Array<{
      body: unknown;
      resolve: () => void;
    }> = [];
    const post = sinon.stub(axios, "post").callsFake(
      (_url: string, body: unknown) =>
        new Promise((resolve) => {
          requests.push({
            body,
            resolve: () => resolve({ data: {} }),
          });
        }),
    );
    const site = { id: "site-1", currencyId: "EUR" };

    const first = adapter.changeChargingPrice("charger-1", site, 0.2, 10);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = adapter.changeChargingPrice("charger-1", site, 0.3, 15);
    await new Promise<void>((resolve) => setImmediate(resolve));

    sinon.assert.calledOnce(post);
    expect(requests).to.have.length(1);
    requests[0].resolve();
    await first;
    await new Promise<void>((resolve) => setImmediate(resolve));

    sinon.assert.calledTwice(post);
    expect(requests).to.have.length(2);
    requests[1].resolve();
    await second;

    const bodies = requests.map(
      ({ body }) =>
        body as {
          currencyId: string;
          costPerKWh: number;
          vat: number;
          costPerKwhExcludeVat: number;
        },
    );
    expect(
      bodies.map(({ currencyId, vat, costPerKwhExcludeVat }) => ({
        currencyId,
        vat,
        costPerKwhExcludeVat,
      })),
    ).to.deep.equal([
      { currencyId: "EUR", vat: 10, costPerKwhExcludeVat: 0.2 },
      { currencyId: "EUR", vat: 15, costPerKwhExcludeVat: 0.3 },
    ]);
    expect(bodies[0].costPerKWh).to.be.closeTo(0.22, 1e-12);
    expect(bodies[1].costPerKWh).to.be.closeTo(0.345, 1e-12);
  });
});
