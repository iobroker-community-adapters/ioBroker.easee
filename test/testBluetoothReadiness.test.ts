import { expect } from "chai";
import { describe, it } from "mocha";
import { deriveBluetoothSearchReadiness } from "../src/lib/bluetooth-readiness.ts";
import type { BluetoothSearchReadinessInput } from "../src/lib/bluetooth-readiness.ts";

const readyInput: BluetoothSearchReadinessInput = {
  unloading: false,
  bluetoothMode: true,
  scannerAvailable: true,
  startupComplete: true,
  adapterState: "poweredOn",
  scanInFlight: false,
  pollInFlight: false,
  activeWrites: 0,
  pendingCircuitWrites: 0,
  activeCircuitWrites: 0,
  reconnectInFlight: false,
};

describe("Bluetooth search readiness", () => {
  it("allows a search only when the scanner is ready and idle", () => {
    expect(deriveBluetoothSearchReadiness(readyInput)).to.include({
      reason: "ready",
      canScan: true,
      displayMessageKey: "Ready to search for nearby chargers.",
    });
  });

  it("distinguishes startup from a missing transport", () => {
    expect(
      deriveBluetoothSearchReadiness({
        ...readyInput,
        scannerAvailable: false,
        startupComplete: false,
      }),
    ).to.include({ reason: "transportInitializing", canScan: false });
    expect(
      deriveBluetoothSearchReadiness({
        ...readyInput,
        scannerAvailable: false,
      }),
    ).to.include({ reason: "transportUnavailable", canScan: false });
    expect(
      deriveBluetoothSearchReadiness({
        ...readyInput,
        startupComplete: false,
      }),
    ).to.include({ reason: "connecting", canScan: false });
  });

  it("blocks unavailable adapter states", () => {
    for (const adapterState of [
      "poweredOff",
      "unauthorized",
      "unsupported",
    ] as const) {
      expect(
        deriveBluetoothSearchReadiness({ ...readyInput, adapterState }),
      ).to.include({ reason: "adapterUnavailable", canScan: false });
    }
  });

  it("reports each operation that temporarily blocks a scan", () => {
    const blockedInputs: Array<
      [string, Partial<BluetoothSearchReadinessInput>, string]
    > = [
      ["manual scan", { scanInFlight: true }, "manualScan"],
      ["poll", { pollInFlight: true }, "polling"],
      ["write", { activeWrites: 1 }, "writes"],
      ["pending circuit write", { pendingCircuitWrites: 1 }, "circuitWrites"],
      ["active circuit write", { activeCircuitWrites: 1 }, "circuitWrites"],
      ["reconnect", { reconnectInFlight: true }, "reconnecting"],
    ];

    for (const [label, overrides, reason] of blockedInputs) {
      const result = deriveBluetoothSearchReadiness({
        ...readyInput,
        ...overrides,
      });
      expect(result, label).to.include({ reason, canScan: false });
      expect(result.busyReason, label).to.be.a("string");
      expect(result.details.scannerAvailable).to.equal(true);
    }
  });

  it("reports shutdown and cloud mode as unavailable", () => {
    expect(
      deriveBluetoothSearchReadiness({ ...readyInput, unloading: true }),
    ).to.include({ reason: "stopping", canScan: false });
    expect(
      deriveBluetoothSearchReadiness({ ...readyInput, bluetoothMode: false }),
    ).to.include({ reason: "cloudMode", canScan: false });
  });

  it("keeps unknown adapter status eligible while reporting that it is waiting", () => {
    expect(
      deriveBluetoothSearchReadiness({ ...readyInput, adapterState: null }),
    ).to.include({ reason: "waitingForAdapter", canScan: true });
  });
});
