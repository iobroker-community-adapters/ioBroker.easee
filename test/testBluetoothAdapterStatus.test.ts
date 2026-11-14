"use strict";

export {};

import { expect } from "chai";
import { EventEmitter } from "node:events";
import sinon from "sinon";
import { describe, it } from "mocha";
import type { AdapterState, Noble } from "@stoprocent/noble";
import { NobleBluetoothScanner as AdapterNobleBluetoothScanner } from "../src/lib/noble-bluetooth-transport.ts";
import type { BluetoothTimerApi } from "../src/lib/bluetooth-transport.ts";

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
  constructor(noble: Noble) {
    super(noble, "hci", testTimers);
  }
}

function scannerWithState(state: AdapterState): NobleBluetoothScanner {
  return new NobleBluetoothScanner({ state } as Noble);
}

describe("Noble Bluetooth adapter status", () => {
  it("reports poweredOn directly from the injected Noble instance", () => {
    const transport = scannerWithState("poweredOn");

    expect(transport.getAdapterState()).to.equal("poweredOn");
  });

  it("preserves not-ready Noble states without translating them", () => {
    const notReadyStates: AdapterState[] = [
      "unknown",
      "poweredOff",
      "unauthorized",
      "unsupported",
      "resetting",
    ];
    for (const state of notReadyStates) {
      const transport = scannerWithState(state);

      expect(transport.getAdapterState()).to.equal(state);
    }
  });

  it("waits for the local adapter to become powered on before scanning", async () => {
    const noble = Object.assign(new EventEmitter(), {
      state: "unknown",
      startScanningAsync: sinon.stub().resolves(),
      stopScanningAsync: sinon.stub().resolves(),
      stop: sinon.stub(),
    });
    const transport = new NobleBluetoothScanner(noble as unknown as Noble);
    const discovery = transport.discover("1234", 1000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    noble.state = "poweredOn";
    noble.emit("stateChange", "poweredOn");
    await new Promise<void>((resolve) => setImmediate(resolve));
    sinon.assert.calledOnce(noble.startScanningAsync);

    await transport.close();
    await discovery.catch(() => undefined);
  });

  it("notifies subscribers of adapter-state changes and supports cleanup", () => {
    const noble = new EventEmitter() as unknown as Noble;
    const transport = new NobleBluetoothScanner(noble);
    const listener = sinon.spy();
    const unsubscribe = transport.onAdapterStateChange(listener);

    noble.emit("stateChange", "poweredOn");
    sinon.assert.calledOnceWithExactly(listener, "poweredOn");
    unsubscribe();
    noble.emit("stateChange", "poweredOff");
    sinon.assert.calledOnce(listener);
  });

  it("serializes discovery and stops its timer and listener when closed", async () => {
    const stopScanning = sinon.stub().resolves();
    const stop = sinon.stub();
    const noble = Object.assign(new EventEmitter(), {
      state: "poweredOn",
      waitForPoweredOnAsync: sinon.stub().resolves(),
      startScanningAsync: sinon.stub().resolves(),
      stopScanningAsync: stopScanning,
      stop,
    }) as unknown as Noble;
    const transport = new NobleBluetoothScanner(noble);
    const discovery = transport.discover("1234", 30000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const overlapping = await transport.discover("1234", 1000).then(
      () => null,
      (error: Error) => error,
    );
    expect(overlapping?.message).to.equal(
      "BLE discovery is already in progress",
    );

    await transport.close();
    const cancelled = await discovery.then(
      () => null,
      (error: Error) => error,
    );
    expect(cancelled?.message).to.equal("BLE discovery cancelled");
    expect(noble.listenerCount("discover")).to.equal(0);
    sinon.assert.calledOnce(stopScanning);
    sinon.assert.calledOnce(stop);
  });
});
