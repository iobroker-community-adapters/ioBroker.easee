"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import {
  CHARGER_STATE_OBSERVATION_IDS,
  observationsToChargerState,
  observationsToChargerStateWithTimestamps,
} from "../lib/observations.ts";
import * as easeeEnums from "../lib/enum.ts";

describe("Easee charger observations", () => {
  it("maps observations to the existing charger state fields", () => {
    const state = observationsToChargerState({
      observations: [
        { id: 30, value: true },
        { id: 103, value: true },
        { id: 109, value: 3 },
        { id: 120, value: 7.4 },
        { id: 194, value: 229.5 },
        { id: 250, value: true },
      ],
    });
    expect(state).to.include({
      lockCablePermanently: true,
      cableLocked: true,
      chargerOpMode: 3,
      totalPower: 7.4,
      inVoltageT2T3: 229.5,
      voltage: 229.5,
      isOnline: true,
    });
  });

  it("derives supply voltage from the configured line-neutral measurements", () => {
    const state = observationsToChargerState({
      observations: [
        { id: 190, value: 0.845 },
        { id: 191, value: 228.732 },
        { id: 192, value: 233.802 },
        { id: 193, value: 237.464 },
        { id: 194, value: 229.295 },
        { id: 195, value: 232.957 },
        { id: 196, value: 238.028 },
        { id: 197, value: 405.07 },
        { id: 198, value: 400.845 },
        { id: 199, value: 407.322 },
      ],
    });

    expect(state.voltage).to.equal(229.295);
  });

  it("falls back to another nominal line-neutral voltage when preferred pair is unavailable", () => {
    const state = observationsToChargerState({
      observations: [
        { id: 194, value: 410 },
        { id: 191, value: 120.4 },
      ],
    });

    expect(state.voltage).to.equal(120.4);
  });

  it("uses the current observation IDs", () => {
    expect(CHARGER_STATE_OBSERVATION_IDS).to.include.members([
      30, 80, 114, 250,
    ]);
    expect(CHARGER_STATE_OBSERVATION_IDS).not.to.include(82);
  });

  it("normalizes supported cable lock boolean formats", () => {
    for (const value of [true, 1, "1", "true"]) {
      expect(
        observationsToChargerState({
          observations: [{ id: 103, value }],
        }).cableLocked,
      ).to.equal(true);
    }
    for (const value of [false, 0, "0", "false"]) {
      expect(
        observationsToChargerState({
          observations: [{ id: 103, value }],
        }).cableLocked,
      ).to.equal(false);
    }
  });

  it("does not normalize invalid cable lock observations to false", () => {
    for (const value of [null, "yes", 2]) {
      expect(
        observationsToChargerState({
          observations: [{ id: 103, value }],
        }).cableLocked,
      ).to.equal(undefined);
    }
  });

  it("preserves source timestamps for valid observations", () => {
    const timestamp = "2026-10-31T12:34:56.000Z";
    const result = observationsToChargerStateWithTimestamps({
      observations: [{ id: 103, value: true, timestamp }],
    });
    expect(result.timestamps.cableLocked).to.equal(Date.parse(timestamp));
  });

  it("leaves absent and null observations unset instead of clearing states", () => {
    const state = observationsToChargerState({
      observations: [
        { id: 103, value: null },
        { id: 120, value: undefined },
      ],
    });

    expect(state.cableLocked).to.equal(undefined);
    expect(state.totalPower).to.equal(undefined);
  });

  it("routes smart-charging and permanent cable-lock updates to config states", () => {
    expect(easeeEnums.getNameByEnum(102)).to.equal(".config.smartCharging");
    expect(easeeEnums.getNameByEnum(30)).to.equal(
      ".config.lockCablePermanently",
    );
  });

  it("keeps the permanent lock setting distinct from the cable lock state", () => {
    const state = observationsToChargerState({
      observations: [
        { id: 30, value: true },
        { id: 103, value: false },
      ],
    });

    expect(state.lockCablePermanently).to.equal(true);
    expect(state.cableLocked).to.equal(false);
  });

  it("handles missing optional observations", () => {
    const state = observationsToChargerState({ observations: [] });
    expect(state.isOnline).to.equal(undefined);
    expect(state.voltage).to.equal(null);
    expect(state.totalPower).to.equal(undefined);
  });
});
