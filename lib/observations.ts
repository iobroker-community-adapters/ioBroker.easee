"use strict";

export const CHARGER_STATE_OBSERVATION_IDS = [
  46, 48, 68, 80, 96, 102, 103, 109, 111, 112, 113, 114, 120, 122, 124, 132,
  182, 183, 184, 185, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 250,
];

const STATE_FIELDS_BY_OBSERVATION_ID: Record<
  number,
  keyof ChargerObservationState
> = {
  46: "ledMode",
  48: "dynamicChargerCurrent",
  68: "wiFiAPEnabled",
  80: "chargerFirmware",
  96: "reasonForNoCurrent",
  102: "smartCharging",
  103: "cableLocked",
  109: "chargerOpMode",
  111: "dynamicCircuitCurrentP1",
  112: "dynamicCircuitCurrentP2",
  113: "dynamicCircuitCurrentP3",
  114: "outputCurrent",
  120: "totalPower",
  122: "energyPerHour",
  124: "lifetimeEnergy",
  132: "wiFiRSSI",
  182: "inCurrentT2",
  183: "inCurrentT3",
  184: "inCurrentT4",
  185: "inCurrentT5",
  190: "inVoltageT1T2",
  191: "inVoltageT1T3",
  192: "inVoltageT1T4",
  193: "inVoltageT1T5",
  194: "inVoltageT2T3",
  195: "inVoltageT2T4",
  196: "inVoltageT2T5",
  197: "inVoltageT3T4",
  198: "inVoltageT3T5",
  199: "inVoltageT4T5",
};

const SUPPLY_VOLTAGE_FIELDS = [
  "inVoltageT2T3",
  "inVoltageT1T3",
  "inVoltageT1T4",
  "inVoltageT1T5",
  "inVoltageT2T4",
  "inVoltageT2T5",
];

/** Easee observation returned by the API. */
export interface ChargerObservation {
  id: number;
  value: unknown;
}

/** Observation collection returned by the API. */
export interface ChargerObservationResponse {
  observations?: ChargerObservation[];
}

/** Charger state values produced from observations. */
export interface ChargerObservationState {
  [field: string]: ioBroker.StateValue | undefined;
  ledMode: ioBroker.StateValue;
  dynamicChargerCurrent: ioBroker.StateValue;
  wiFiAPEnabled: ioBroker.StateValue;
  chargerFirmware: ioBroker.StateValue;
  reasonForNoCurrent: ioBroker.StateValue;
  smartCharging: ioBroker.StateValue;
  cableLocked: ioBroker.StateValue;
  chargerOpMode: ioBroker.StateValue;
  dynamicCircuitCurrentP1: ioBroker.StateValue;
  dynamicCircuitCurrentP2: ioBroker.StateValue;
  dynamicCircuitCurrentP3: ioBroker.StateValue;
  outputCurrent: ioBroker.StateValue;
  totalPower: ioBroker.StateValue;
  energyPerHour: ioBroker.StateValue;
  lifetimeEnergy: ioBroker.StateValue;
  wiFiRSSI: ioBroker.StateValue;
  inCurrentT2: ioBroker.StateValue;
  inCurrentT3: ioBroker.StateValue;
  inCurrentT4: ioBroker.StateValue;
  inCurrentT5: ioBroker.StateValue;
  inVoltageT1T2: ioBroker.StateValue;
  inVoltageT1T3: ioBroker.StateValue;
  inVoltageT1T4: ioBroker.StateValue;
  inVoltageT1T5: ioBroker.StateValue;
  inVoltageT2T3: ioBroker.StateValue;
  inVoltageT2T4: ioBroker.StateValue;
  inVoltageT2T5: ioBroker.StateValue;
  inVoltageT3T4: ioBroker.StateValue;
  inVoltageT3T5: ioBroker.StateValue;
  inVoltageT4T5: ioBroker.StateValue;
  isOnline?: boolean;
  voltage: number | null;
}

/**
 * Converts Easee API observations to the existing charger state fields.
 *
 * @param responseData
 */
export function observationsToChargerState(
  responseData: ChargerObservationResponse | null | undefined,
): ChargerObservationState {
  const observations = Array.isArray(responseData?.observations)
    ? responseData.observations
    : [];
  const chargerState: Record<string, ioBroker.StateValue | undefined> =
    Object.fromEntries(
      Object.values(STATE_FIELDS_BY_OBSERVATION_ID).map((field) => [
        field,
        null,
      ]),
    );

  for (const observation of observations) {
    const field = STATE_FIELDS_BY_OBSERVATION_ID[observation.id];
    if (field !== undefined && isStateValue(observation.value)) {
      chargerState[field] = observation.value;
    }
  }

  const cloudObservation = observations.find(
    (observation) => observation.id === 250,
  );
  if (cloudObservation) {
    if (isStateValue(cloudObservation.value)) {
      chargerState.isOnline = Boolean(cloudObservation.value);
    }
  }
  chargerState.voltage = null;
  for (const field of SUPPLY_VOLTAGE_FIELDS) {
    const value = chargerState[field];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 100 &&
      value <= 300
    ) {
      chargerState.voltage = value;
      break;
    }
  }

  return chargerState as ChargerObservationState;
}

function isStateValue(value: unknown): value is ioBroker.StateValue {
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
}
