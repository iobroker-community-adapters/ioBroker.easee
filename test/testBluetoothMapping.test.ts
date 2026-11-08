"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import { mapBluetoothPoll } from "../lib/bluetooth-mapping.ts";
import type { BluetoothPollResult } from "../lib/bluetooth-client.ts";

describe("Bluetooth datapoint mapping", () => {
  it("maps only matching BLE values and keeps units and phase labels", () => {
    const result: BluetoothPollResult = {
      config: {
        isEnabled: 1,
        maxChargerCurrent: 32,
        phaseMode: 2,
        ledStripBrightness: 80,
        wifiSSID: "Home Wi-Fi",
        circuitMaxCurrentP1: 40,
        circuitMaxCurrentP2: 30,
        circuitMaxCurrentP3: 20,
        cableLocked: 1,
      },
      state: {
        chargerOpMode: 3,
        reasonForNoCurrent: 0,
        totalPower: 7.4,
        lifetimeEnergy: 1200,
        energyPerHour: 4.1,
        currentN: 0,
        currentL1: 16,
        currentL2: 0,
        currentL3: 0,
        voltageL1N: 230,
        voltageL2N: 231,
        voltageL3N: 232,
        voltageL1L2: 400,
        voltageL1L3: 401,
        voltageL2L3: 402,
        ledMode: 1,
        localRSSI: -60,
        dynamicChargerCurrent: 16,
        dynamicCircuitCurrentP1: 16,
        dynamicCircuitCurrentP2: 0,
        dynamicCircuitCurrentP3: 0,
      },
      values: {},
    };

    expect(mapBluetoothPoll(result)).to.include({
      "status.chargerOpMode": 3,
      "status.reasonForNoCurrent": 0,
      "status.totalPower": 7.4,
      "status.lifetimeEnergy": 1200,
      "status.energyPerHour": 4.1,
      "status.inCurrentT2": 0,
      "status.inCurrentT3": 16,
      "status.inVoltageT2T3": 230,
      "status.inVoltageT3T4": 400,
      "status.voltage": 230,
      "status.ledMode": 1,
      "info.bluetoothRSSI": -60,
      "config.isEnabled": true,
      "config.lockCablePermanently": true,
      "config.wiFiSSID": "Home Wi-Fi",
      "config.dynamicChargerCurrent": 16,
      "config.dynamicCircuitCurrentP1": 16,
    });
    expect(mapBluetoothPoll(result)).not.to.have.property("status.wiFiRSSI");
    expect(mapBluetoothPoll(result)).not.to.have.property("status.cableLocked");
    expect(mapBluetoothPoll(result)).not.to.have.property("status.isOnline");
  });

  it("skips invalid booleans and absent values without fabricating updates", () => {
    const result: BluetoothPollResult = {
      config: { isEnabled: 2, cableLocked: 2 },
      state: { chargerOpMode: Number.NaN, localRSSI: Number.NaN },
      values: {},
    };
    expect(mapBluetoothPoll(result)).to.deep.equal({});
  });
});
