"use strict";

import type { BluetoothPollResult } from "./bluetooth-client.ts";

export type BluetoothStateValue = number | string | boolean;

const STATE_FIELDS: ReadonlyArray<
  readonly [string, keyof BluetoothPollResult["state"]]
> = [
  ["status.chargerOpMode", "chargerOpMode"],
  ["status.reasonForNoCurrent", "reasonForNoCurrent"],
  ["status.totalPower", "totalPower"],
  ["status.lifetimeEnergy", "lifetimeEnergy"],
  ["status.energyPerHour", "energyPerHour"],
  ["status.inCurrentT2", "currentN"],
  ["status.inCurrentT3", "currentL1"],
  ["status.inCurrentT4", "currentL2"],
  ["status.inCurrentT5", "currentL3"],
  ["status.inVoltageT2T3", "voltageL1N"],
  ["status.inVoltageT2T4", "voltageL2N"],
  ["status.inVoltageT2T5", "voltageL3N"],
  ["status.inVoltageT3T4", "voltageL1L2"],
  ["status.inVoltageT3T5", "voltageL1L3"],
  ["status.inVoltageT4T5", "voltageL2L3"],
  ["status.ledMode", "ledMode"],
  ["info.bluetoothRSSI", "localRSSI"],
];

const CONFIG_FIELDS: ReadonlyArray<
  readonly [string, keyof BluetoothPollResult["config"]]
> = [
  ["config.maxChargerCurrent", "maxChargerCurrent"],
  ["config.phaseMode", "phaseMode"],
  ["config.ledStripBrightness", "ledStripBrightness"],
  ["config.wiFiSSID", "wifiSSID"],
  ["config.circuitMaxCurrentP1", "circuitMaxCurrentP1"],
  ["config.circuitMaxCurrentP2", "circuitMaxCurrentP2"],
  ["config.circuitMaxCurrentP3", "circuitMaxCurrentP3"],
];

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBooleanNumber(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

export function mapBluetoothPoll(
  result: BluetoothPollResult,
): Readonly<Record<string, BluetoothStateValue>> {
  const mapped: Record<string, BluetoothStateValue> = {};

  for (const [stateId, field] of STATE_FIELDS) {
    const value = result.state[field];
    if (isNumber(value)) {
      mapped[stateId] = value;
    }
  }

  for (const [stateId, field] of CONFIG_FIELDS) {
    const value = result.config[field];
    if (isNumber(value) || typeof value === "string") {
      mapped[stateId] = value;
    }
  }

  const enabled = result.config.isEnabled;
  if (isBooleanNumber(enabled)) {
    mapped["config.isEnabled"] = enabled === 1;
  }

  const cableLocked = result.config.cableLocked;
  if (isBooleanNumber(cableLocked)) {
    mapped["config.lockCablePermanently"] = cableLocked === 1;
  }

  const lineNeutralVoltage = [
    result.state.voltageL1N,
    result.state.voltageL2N,
    result.state.voltageL3N,
  ].find(isNumber);
  if (lineNeutralVoltage !== undefined) {
    mapped["status.voltage"] = lineNeutralVoltage;
  }

  for (const field of [
    "dynamicCircuitCurrentP1",
    "dynamicCircuitCurrentP2",
    "dynamicCircuitCurrentP3",
  ] as const) {
    const value = result.state[field];
    if (isNumber(value)) {
      mapped[`config.${field}`] = value;
    }
  }

  const dynamicChargerCurrent = result.state.dynamicChargerCurrent;
  if (isNumber(dynamicChargerCurrent)) {
    mapped["config.dynamicChargerCurrent"] = dynamicChargerCurrent;
  }

  return mapped;
}
