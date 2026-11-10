"use strict";

import { Adapter, I18n } from "@iobroker/adapter-core";
import { isDeepStrictEqual } from "node:util";
import {
  EaseeBluetoothDeviceManagement,
  getAdminDirectory,
  getStoredBluetoothConfigurationError,
} from "./lib/bluetooth-device-management.ts";
import axios from "axios";
import * as signalR from "@microsoft/signalr";
import * as objEnum from "./lib/enum.ts";
import AxiosSignalRHttpClient from "./lib/signalr-http-client.ts";
import {
  CHARGER_STATE_OBSERVATION_IDS,
  normalizeBooleanObservation,
  observationsToChargerStateWithTimestamps,
} from "./lib/observations.ts";
import { BluetoothClient } from "./lib/bluetooth-client.ts";
import { BLUETOOTH_SERVICE_UUID } from "./lib/bluetooth-protocol.ts";
import {
  bluetoothOnlyChargerStateSuffixes,
  chargerStateDefinitions,
  cloudOnlyChargerStateSuffixes,
  supportsConnectionMode,
} from "./lib/charger-state-definitions.ts";
import { deriveBluetoothSearchReadiness } from "./lib/bluetooth-readiness.ts";
import type {
  BluetoothAdapterState,
  BluetoothAdapterStatusProvider,
  BluetoothCandidate,
  BluetoothScanner,
} from "./lib/bluetooth-transport.ts";
import type {
  BluetoothClientOptions,
  BluetoothDeviceConfig,
  BluetoothStatusEvent,
} from "./lib/bluetooth-client.ts";
import type { BluetoothCommand } from "./lib/bluetooth-protocol.ts";
import { createNobleBluetoothScanner } from "./lib/noble-bluetooth-transport.ts";
import { mapBluetoothPoll } from "./lib/bluetooth-mapping.ts";
import {
  BluetoothConfigurationError,
  getConnectionMode,
  parseBluetoothChargers,
  parseBluetoothChargerSettings,
} from "./lib/connection-mode.ts";
import type {
  BluetoothChargerConfig,
  ConnectionMode,
} from "./lib/connection-mode.ts";
import type {
  ChargerObservationResult,
  ChargerObservationState,
} from "./lib/observations.ts";

type Timer = ioBroker.Timeout | undefined;
type Phase = "p1" | "p2" | "p3";
type AdapterOptions = ioBroker.AdapterOptions;
const encryptedBluetoothPinPrefix = "easee:v1:";
const cloudOnlyInstanceStateIds = new Set([
  "lastUpdate",
  "info.sessionPollLastRequest",
]);
const bluetoothOnlyInstanceStateIds = new Set([
  "info.bluetoothAdapterState",
  "info.bluetoothAdapterStateDisplay",
  "info.bluetoothSearchReadiness",
  "info.bluetoothSearchReadinessDisplay",
  "info.bluetoothScanResults",
  "info.bluetoothScanResultsDisplay",
]);
const bluetoothUnsupportedSessionStateSuffix =
  /^session\.(?:\d{1,4}\.total_year|\d{1,4}\.\d{1,2}\.(?:totalEnergyUsage|totalCost))$/;

interface Charger {
  id: string;
  name: string;
}

interface SiteCharger {
  id: string;
}

interface SiteCircuit {
  id?: string;
  chargers?: SiteCharger[] | null;
}

interface Site {
  id?: string;
  currencyId?: string;
  costPerKWh?: number;
  costPerKwhExcludeVat?: number;
  vat?: number;
  circuits?: SiteCircuit[] | null;
}

interface ChargerConfig {
  [key: string]: ioBroker.StateValue;
  isEnabled: ioBroker.StateValue;
  phaseMode: ioBroker.StateValue;
  ledStripBrightness: ioBroker.StateValue;
  smartButtonEnabled: ioBroker.StateValue;
  wiFiSSID: ioBroker.StateValue;
  maxChargerCurrent: ioBroker.StateValue;
  circuitMaxCurrentP1: ioBroker.StateValue;
  circuitMaxCurrentP2: ioBroker.StateValue;
  circuitMaxCurrentP3: ioBroker.StateValue;
}

interface ChargerSession {
  year: number;
  month: number;
  totalEnergyUsage: number;
  totalCost: number;
}

interface ChargingSessionDetails {
  carConnected?: string | null;
  isComplete: boolean;
  authToken?: string | null;
}

interface ChargingSessionStart {
  timestamp: number;
  reliable: boolean;
}

interface RetryState {
  delay: number;
  retryAt: number;
  inFlight: Promise<unknown> | null;
}

interface RetryableError extends Error {
  retryDeferred?: boolean;
  retryAt?: number;
}

interface DynamicChargerState {
  pendingValues: Partial<Record<Phase, number>>;
  pendingSequences: Partial<Record<Phase, number>>;
  latestSequences: Record<Phase, number>;
  timer: Timer | null;
  retryTimer: Timer | null;
  retryResolve: (() => void) | null;
  queue: Promise<void>;
}

interface DynamicCircuitState {
  values: Record<Phase, number>;
  phaseSequences: Record<Phase, number>;
  timer: Timer | null;
  queue: Promise<void>;
}

interface PendingRetry {
  timer: Timer;
}

interface PendingBluetoothCircuitWrite {
  values: Partial<Record<Phase, number>>;
  stateIds: Partial<Record<Phase, string>>;
  sequence: number;
  timer: Timer;
}

interface BluetoothPauseRestore {
  amperes: number;
  generation: number;
}

interface ChargerValueSet {
  p1: number;
  p2: number;
  p3: number;
}

interface SignalRProductUpdate {
  id: number;
  mid: string;
  dataType: number;
  timestamp?: string;
  value: string | number | boolean;
}

interface ObservationVersion {
  timestamp?: number;
  source: "REST" | "SignalR";
}

//Eigene Variablen
const apiUrl = "https://api.easee.com";
const apiRequestTimeout = 30000;
const cloudChargerCommands = {
  startCharging: { endpoint: "start_charging", label: "Start charging" },
  stopCharging: { endpoint: "stop_charging", label: "Stop charging" },
  pauseCharging: { endpoint: "pause_charging", label: "Pause charging" },
  resumeCharging: { endpoint: "resume_charging", label: "Resume charging" },
  rebootCharging: { endpoint: "reboot", label: "Reboot charging" },
} as const;
type CloudChargerCommand = keyof typeof cloudChargerCommands;
const sessionRequestInterval = 7 * 60 * 1000;
const defaultSessionPollInterval = 60;
const maxTimeoutMilliseconds = 2_147_483_647;
const bluetoothManualScanTimeoutMs = 30000;
const safeObjectIdSegment = /^[A-Za-z0-9_-]+$/;
const tokenRefreshMarginSeconds = 60;

function getRateLimitDelay(error: unknown): number {
  const errorRecord = isRecord(error) ? error : undefined;
  const responseRecord =
    errorRecord && isRecord(errorRecord.response)
      ? errorRecord.response
      : undefined;
  const responseHeaders =
    axios.isAxiosError(error) && error.response
      ? error.response.headers
      : responseRecord?.headers;
  const headers =
    typeof responseHeaders === "object" && responseHeaders !== null
      ? (responseHeaders as Record<string, unknown>)
      : undefined;
  const header = (name: string): string | undefined => {
    if (!headers) {
      return undefined;
    }
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (typeof value === "string") {
      return value;
    }
    return Array.isArray(value) && typeof value[0] === "string"
      ? value[0]
      : undefined;
  };
  const retryAfter = header("retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(maxTimeoutMilliseconds, Math.max(0, seconds * 1000));
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(
        maxTimeoutMilliseconds,
        Math.max(0, retryAt - Date.now()),
      );
    }
  }

  const remaining = Number(
    header("ratelimit-remaining") ?? header("x-ratelimit-remaining"),
  );
  if (remaining === 0) {
    const reset = Number(header("ratelimit-reset"));
    if (Number.isFinite(reset)) {
      return Math.min(maxTimeoutMilliseconds, Math.max(0, reset * 1000));
    }
    const legacyReset = Number(header("x-ratelimit-reset"));
    if (Number.isFinite(legacyReset)) {
      const resetAt = legacyReset > 1e12 ? legacyReset : legacyReset * 1000;
      return Math.min(
        maxTimeoutMilliseconds,
        Math.max(0, resetAt - Date.now()),
      );
    }
  }

  return (responseRecord?.status ??
    (axios.isAxiosError(error) ? error.response?.status : undefined)) === 429
    ? sessionRequestInterval
    : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface AuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function parseAuthTokenResponse(value: unknown): AuthTokenResponse {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    !value.accessToken.trim() ||
    typeof value.refreshToken !== "string" ||
    !value.refreshToken.trim()
  ) {
    throw new Error("Invalid authentication response");
  }
  const expiresIn = Number(value.expiresIn);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Invalid authentication token expiry");
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresIn,
  };
}

function normalizeSiteId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id || undefined;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

function sanitizeSite(value: unknown): Site | undefined {
  if (!isRecord(value) || Array.isArray(value)) {
    return undefined;
  }

  const site: Site = {};
  const id = normalizeSiteId(value.id);
  if (id !== undefined) {
    site.id = id;
  }
  if (typeof value.currencyId === "string" && value.currencyId.trim()) {
    site.currencyId = value.currencyId.trim();
  }
  for (const field of ["costPerKWh", "costPerKwhExcludeVat", "vat"] as const) {
    const fieldValue = value[field];
    if (
      typeof fieldValue === "number" &&
      Number.isFinite(fieldValue) &&
      fieldValue >= 0 &&
      (field !== "vat" || fieldValue < 100)
    ) {
      site[field] = fieldValue;
    }
  }
  if (value.circuits === null) {
    site.circuits = null;
  } else if (Array.isArray(value.circuits)) {
    site.circuits = value.circuits.map((value): SiteCircuit => {
      if (!isRecord(value) || Array.isArray(value)) {
        return {};
      }
      const circuit: SiteCircuit = {};
      const circuitId = normalizeSiteId(value.id);
      if (circuitId !== undefined) {
        circuit.id = circuitId;
      }
      if (value.chargers === null) {
        circuit.chargers = null;
      } else if (Array.isArray(value.chargers)) {
        const chargers = value.chargers.flatMap((value): SiteCharger[] => {
          if (!isRecord(value) || Array.isArray(value)) {
            return [];
          }
          const chargerId = normalizeSiteId(value.id);
          return chargerId === undefined ? [] : [{ id: chargerId }];
        });
        if (chargers.length === value.chargers.length) {
          circuit.chargers = chargers;
        }
      }
      return circuit;
    });
  }
  return site;
}

function getUniqueChargerCircuit(
  site: Site,
  chargerId: string,
): SiteCircuit | undefined {
  const circuits = site.circuits;
  if (
    !Array.isArray(circuits) ||
    circuits.some(
      (circuit) =>
        !circuit.id ||
        !Array.isArray(circuit.chargers) ||
        circuit.chargers.some((charger) => !charger.id),
    )
  ) {
    return undefined;
  }
  const matchingCircuits = circuits.filter(
    (circuit) =>
      Array.isArray(circuit.chargers) &&
      circuit.chargers.some((charger) => charger.id === chargerId),
  );
  return matchingCircuits.length === 1 ? matchingCircuits[0] : undefined;
}

const validPhaseModes = [1, 2, 3] as const;
type PhaseMode = (typeof validPhaseModes)[number];

function isValidPhaseMode(value: unknown): value is PhaseMode {
  return (
    typeof value === "number" &&
    validPhaseModes.some((phaseMode) => phaseMode === value)
  );
}

function isValidCloudConfigValue(
  setting: string,
  value: ioBroker.StateValue,
): boolean {
  switch (setting) {
    case "isEnabled":
    case "smartCharging":
    case "smartButtonEnabled":
      return typeof value === "boolean";
    case "phaseMode":
      return isValidPhaseMode(value);
    case "maxChargerCurrent":
    case "dynamicChargerCurrent":
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "ledStripBrightness":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 100
      );
    case "wiFiSSID":
      return typeof value === "string";
    default:
      return false;
  }
}

function parseBluetoothChargersAllowEmpty(
  value: unknown,
): BluetoothChargerConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("Bluetooth charger configuration must be a list");
  }
  return value.length === 0 ? [] : parseBluetoothChargers(value);
}

function isRetryableError(error: unknown): error is RetryableError {
  return (
    error instanceof Error && (error as RetryableError).retryDeferred === true
  );
}

function isTransientApiError(error: unknown): boolean {
  const isAxiosError = axios.isAxiosError(error);
  const response = isAxiosError
    ? error.response
    : isRecord(error) && isRecord(error.response)
      ? error.response
      : undefined;
  if (!isAxiosError && !response) {
    return false;
  }
  const status =
    response && isRecord(response) && typeof response.status === "number"
      ? response.status
      : undefined;
  return (
    (isAxiosError && status === undefined) ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  );
}

class Easee extends Adapter {
  private accessToken = "";
  private refreshTokenValue = "";
  private expireTime = Date.now();
  private polltime = 30;
  private logtype = false;
  private signalRReconnectTimer: Timer = undefined;
  private readAllStatesTimer: Timer = undefined;
  signalRConnection: signalR.HubConnection | null = null;
  signalRSubscribedChargers = new Set<string>();
  observationVersions = new Map<string, ObservationVersion>();
  observedStateWrites = new Map<string, Promise<unknown>>();
  lastChargerOpModes = new Map<string, number>();
  chargerSessionStarts = new Map<string, ChargingSessionStart>();
  chargerSessionGenerations = new Map<string, number>();
  chargerSessionAuthTokenResolved = new Set<string>();
  pendingSessionAuthTokenLookups = new Map<string, Promise<void>>();
  chargerIds: string[] = [];
  chargerNameQueue: Promise<void> = Promise.resolve();
  chargerNameVersions = new Map<string, number>();
  chargerNamePending = new Map<string, number>();
  signalRSubscriptionPromises = new Map<string, Promise<void>>();
  unloading = false;
  apiRetryState = new Map<string, RetryState>();
  pendingSiteConfigRetries = new Map<string, PendingRetry>();
  dynamicCircuitCurrentByCharger = new Map<string, DynamicChargerState>();
  dynamicCircuitCurrentByCircuit = new Map<string, DynamicCircuitState>();
  dynamicCircuitCurrentSequence = 0;
  circuitMaxCurrentByCircuit = new Map<string, number>();
  circuitMaxCurrentSequence = 0;
  sessionChargers: string[] = [];
  sessionCursor = 0;
  sessionPollTimer: Timer | null = null;
  sessionInFlight: Promise<void> | null = null;
  sessionAbortController: AbortController | null = null;
  sessionLastRequestAt: number | null = null;
  sessionRetryAt = 0;
  sessionPollMode: "auto" | "manual" = "auto";
  sessionManualInterval = defaultSessionPollInterval;
  connectionMode: ConnectionMode = "cloud";
  bluetoothClient: BluetoothClient | null = null;
  bluetoothScanner: (BluetoothScanner & BluetoothAdapterStatusProvider) | null =
    null;
  bluetoothAdapterStateUnsubscribe: (() => void) | null = null;
  bluetoothAdapterStateWrite: Promise<void> = Promise.resolve();
  bluetoothSearchReadinessWrite: Promise<void> = Promise.resolve();
  private lastBluetoothAdapterState: BluetoothAdapterState | null = null;
  configuredBluetoothChargers: BluetoothChargerConfig[] = [];
  bluetoothManualScanInFlight = false;
  bluetoothManualScanTask: Promise<readonly BluetoothCandidate[]> | null = null;
  bluetoothManualScanGeneration = 0;
  bluetoothConnections = new Map<string, boolean>();
  bluetoothConnectionErrors = new Map<string, string>();
  bluetoothConnectingLogged = new Set<string>();
  bluetoothConnectionGenerations = new Map<string, number>();
  bluetoothPauseRestore = new Map<string, BluetoothPauseRestore>();
  bluetoothCircuitWrites = new Map<string, PendingBluetoothCircuitWrite>();
  bluetoothCircuitWritesInFlight = 0;
  bluetoothCircuitWriteSequence = 0;
  bluetoothDisconnectWaiters = new Map<
    string,
    Set<(disconnected: boolean) => void>
  >();
  bluetoothReconnectTimer: Timer | null = null;
  bluetoothPollTimer: Timer | null = null;
  bluetoothPollInFlight = false;
  bluetoothWritesInFlight = 0;
  bluetoothReconnectInFlight = false;
  bluetoothReconnectDelay = 10000;
  bluetoothStartupComplete = false;
  bluetoothDeviceManagement!: EaseeBluetoothDeviceManagement;
  bluetoothConfigMutation: Promise<void> = Promise.resolve();
  i18nInitialized = false;

  constructor(options: AdapterOptions = { name: "easee" }) {
    super({
      ...options,
      name: "easee",
    } as never);
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.bluetoothDeviceManagement = new EaseeBluetoothDeviceManagement(this);
  }

  getConfiguredBluetoothChargers(
    configuration: Record<string, unknown> = this.config,
  ): BluetoothChargerConfig[] {
    let chargers: BluetoothChargerConfig[];
    try {
      chargers = parseBluetoothChargerSettings(configuration);
    } catch (error) {
      throw getStoredBluetoothConfigurationError(error);
    }

    return chargers.map((charger, index) => {
      if (!charger.pin.startsWith(encryptedBluetoothPinPrefix)) {
        return charger;
      }
      let pin: string;
      try {
        pin = this.decrypt(
          charger.pin.slice(encryptedBluetoothPinPrefix.length),
        );
      } catch {
        throw new BluetoothConfigurationError(
          `Stored Bluetooth charger entry ${index + 1} field pin could not be decrypted.`,
          `Der PIN in Eintrag ${index + 1}, Feld pin, der gespeicherten Bluetooth-Konfiguration konnte nicht entschlüsselt werden.`,
          "stored",
          {
            type: "message",
            key: "Stored Bluetooth charger entry %s field pin could not be decrypted.",
            parameters: [index + 1],
          },
        );
      }
      if (typeof pin !== "string" || !pin.trim()) {
        throw new BluetoothConfigurationError(
          `Stored Bluetooth charger entry ${index + 1} field pin did not decrypt to a non-empty string.`,
          `Der PIN in Eintrag ${index + 1}, Feld pin, der gespeicherten Bluetooth-Konfiguration wurde nicht als nichtleere Zeichenkette entschlüsselt.`,
          "stored",
          {
            type: "message",
            key: "Stored Bluetooth charger entry %s field pin did not decrypt to a non-empty string.",
            parameters: [index + 1],
          },
        );
      }
      return { ...charger, pin: pin.trim() };
    });
  }

  async addBluetoothCharger(value: unknown): Promise<void> {
    const newCharger = parseBluetoothChargers([value])[0];
    await this.mutateBluetoothChargers((chargers) => [...chargers, newCharger]);
  }

  async editBluetoothCharger(
    serialNumber: string,
    value: unknown,
  ): Promise<void> {
    await this.mutateBluetoothChargers((chargers) => {
      const index = chargers.findIndex(
        (charger) => charger.serialNumber === serialNumber,
      );
      if (index < 0 || !isRecord(value)) {
        throw new Error("Bluetooth charger is not configured");
      }
      const pin =
        typeof value.pin === "string" && value.pin.trim()
          ? value.pin
          : chargers[index].pin;
      const updated = parseBluetoothChargers([
        {
          serialNumber: value.serialNumber,
          pin,
          name: value.name,
        },
      ])[0];
      const next = [...chargers];
      next[index] = updated;
      return next;
    });
  }

  async removeBluetoothCharger(serialNumber: string): Promise<void> {
    await this.mutateBluetoothChargers((chargers) => {
      const remaining = chargers.filter(
        (charger) => charger.serialNumber !== serialNumber,
      );
      if (remaining.length === chargers.length) {
        throw new Error("Bluetooth charger is not configured");
      }
      return remaining;
    });
  }

  async resetBluetoothChargerConfiguration(): Promise<void> {
    const mutation = this.bluetoothConfigMutation.then(async () => {
      const persisted = await this.getBluetoothInstanceObject();
      const native = { bluetoothChargerList: [] };
      await this.updateBluetoothNativeConfiguration(native, native, persisted);
      this.config.bluetoothChargerList = [];
      this.configuredBluetoothChargers = [];
    });
    this.bluetoothConfigMutation = mutation.catch(() => undefined);
    return mutation;
  }

  private async getBluetoothInstanceObject(): Promise<
    Record<string, unknown> & { native: Record<string, unknown> }
  > {
    const id = `system.adapter.${this.namespace}`;
    const object = await this.getForeignObjectAsync(id);
    if (!isRecord(object) || !isRecord(object.native)) {
      throw new Error(
        "Could not read persisted Bluetooth adapter configuration",
      );
    }
    return object;
  }

  private async updateBluetoothNativeConfiguration(
    native: Record<string, unknown>,
    expected: Record<string, unknown>,
    source?: Record<string, unknown> & { native: Record<string, unknown> },
  ): Promise<void> {
    const id = `system.adapter.${this.namespace}`;
    const current = await this.getBluetoothInstanceObject();
    if (
      source &&
      !isDeepStrictEqual(
        source.native.bluetoothChargerList,
        current.native.bluetoothChargerList,
      )
    ) {
      Object.assign(this.config, {
        bluetoothChargerList: current.native.bluetoothChargerList,
      });
      throw new Error(
        "Persisted Bluetooth configuration changed while saving; retry the operation",
      );
    }
    const replacement = {
      ...current,
      native: { ...current.native, ...native },
    };
    await this.setForeignObjectAsync(
      id,
      replacement as ioBroker.SettableObject,
    );

    const saved = await this.getBluetoothInstanceObject();
    if (
      !Object.entries(expected).every(([key, value]) =>
        isDeepStrictEqual(saved.native[key], value),
      )
    ) {
      throw new Error(
        "Persisted Bluetooth configuration did not match the saved values",
      );
    }
    Object.assign(this.config, {
      bluetoothChargerList: saved.native.bluetoothChargerList,
    });
  }

  private encryptBluetoothChargerConfiguration(
    chargers: BluetoothChargerConfig[],
  ): BluetoothChargerConfig[] {
    return chargers.map((charger) => {
      const encryptedPin = this.encrypt(charger.pin);
      if (typeof encryptedPin !== "string" || !encryptedPin.trim()) {
        throw new Error("Could not encrypt Bluetooth charger PIN");
      }
      return {
        ...charger,
        pin: `${encryptedBluetoothPinPrefix}${encryptedPin}`,
      };
    });
  }

  private mutateBluetoothChargers(
    update: (chargers: BluetoothChargerConfig[]) => BluetoothChargerConfig[],
  ): Promise<void> {
    const mutation = this.bluetoothConfigMutation.then(async () => {
      const persisted = await this.getBluetoothInstanceObject();
      const currentChargers = this.getConfiguredBluetoothChargers(
        persisted.native,
      );
      const chargers = parseBluetoothChargersAllowEmpty(
        update(currentChargers),
      );
      const canonical = {
        bluetoothChargerList:
          this.encryptBluetoothChargerConfiguration(chargers),
      };
      await this.updateBluetoothNativeConfiguration(
        canonical,
        canonical,
        persisted,
      );
    });
    this.bluetoothConfigMutation = mutation.catch(() => undefined);
    return mutation;
  }

  /**
   * SignalR
   */
  async startSignal(): Promise<void> {
    if (this.unloading || this.signalRConnection !== null) {
      return;
    }
    const connection = new signalR.HubConnectionBuilder()
      .withUrl("https://streams.easee.com/hubs/products", {
        accessTokenFactory: () => this.accessToken,
        httpClient: new AxiosSignalRHttpClient(),
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets,
      })
      .withAutomaticReconnect()
      .build();
    this.signalRConnection = connection;

    connection.on("ProductUpdate", (data: SignalRProductUpdate) => {
      this.handleSignalRProductUpdate(data);
    });

    connection.onreconnected(() => {
      this.resubscribeSignalRChargers(connection);
    });

    connection.onclose((error) => {
      if (this.signalRConnection === connection) {
        this.signalRConnection = null;
      }
      if (!this.unloading) {
        this.log.warn(
          `SignalR connection closed (${errorType(error || "unknown reason")}).`,
        );
        this.scheduleSignalRReconnect();
      }
    });

    try {
      await connection.start();
      this.signalRSubscribedChargers.clear();
      for (const charger_id of this.chargerIds) {
        await this.subscribeChargerToSignalR(charger_id);
      }
    } catch (error) {
      if (this.signalRConnection === connection) {
        this.signalRConnection = null;
      }
      this.log.warn(
        `SignalR start failed (${errorType(error)}); REST polling remains active.`,
      );
      this.scheduleSignalRReconnect();
    }
  }

  handleSignalRProductUpdate(data: SignalRProductUpdate): void {
    const stateName = objEnum.getNameByEnum(data.id);
    if (!stateName) {
      this.log.debug(
        `Unknown SignalR observation (id=${data.id}, dataType=${data.dataType}, valueType=${typeof data.value}).`,
      );
      return;
    }
    if (typeof data.mid !== "string" || !data.mid) {
      return;
    }
    if (!safeObjectIdSegment.test(data.mid)) {
      this.log.warn(
        `Ignoring SignalR update with invalid charger id: ${data.mid}`,
      );
      return;
    }

    let value: ioBroker.StateValue = data.value;
    switch (data.dataType) {
      case 2: {
        const normalized = normalizeBooleanObservation(value);
        if (normalized === undefined) {
          this.log.debug(
            `SignalR observation ${data.id} had an invalid boolean value (type=${typeof data.value}).`,
          );
          return;
        }
        value = normalized;
        break;
      }
      case 3: {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          this.log.debug(
            `SignalR observation ${data.id} had an invalid number (type=${typeof data.value}).`,
          );
          return;
        }
        value = number;
        break;
      }
      case 4: {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          this.log.debug(
            `SignalR observation ${data.id} had an invalid integer (type=${typeof data.value}).`,
          );
          return;
        }
        value = Math.trunc(number);
        break;
      }
    }

    const stateId = `${data.mid}${stateName}`;
    const timestamp = Date.parse(data.timestamp ?? "");
    this.log.debug(
      `SignalR observation ${data.id} updated (${typeof value}) at ${data.timestamp ?? "unknown time"}.`,
    );
    this.writeObservedState(
      stateId,
      value,
      Number.isFinite(timestamp) ? timestamp : undefined,
      "SignalR",
    ).catch((error) =>
      this.log.warn(`SignalR state update failed (${errorType(error)}).`),
    );
  }

  resubscribeSignalRChargers(connection: signalR.HubConnection): void {
    if (this.signalRConnection !== connection || this.unloading) {
      return;
    }
    this.signalRSubscribedChargers.clear();
    for (const chargerId of this.chargerIds) {
      void this.subscribeChargerToSignalR(chargerId);
    }
  }

  async subscribeChargerToSignalR(chargerId: string): Promise<void> {
    const connection = this.signalRConnection;
    if (
      this.unloading ||
      !connection ||
      connection.state !== signalR.HubConnectionState.Connected ||
      this.signalRSubscribedChargers.has(chargerId)
    ) {
      return;
    }
    const existingSubscription =
      this.signalRSubscriptionPromises.get(chargerId);
    if (existingSubscription) {
      return existingSubscription;
    }

    const subscription = connection
      .send("SubscribeWithCurrentState", chargerId, true)
      .then(() => {
        if (this.signalRConnection === connection && !this.unloading) {
          this.signalRSubscribedChargers.add(chargerId);
          this.log.info(`Charger registered in SignalR: ${chargerId}`);
        }
      })
      .catch((error) => {
        this.log.warn(
          `SignalR subscription failed for charger ${chargerId} (${errorType(error)}).`,
        );
      })
      .finally(() => {
        if (this.signalRSubscriptionPromises.get(chargerId) === subscription) {
          this.signalRSubscriptionPromises.delete(chargerId);
        }
      });
    this.signalRSubscriptionPromises.set(chargerId, subscription);
    return subscription;
  }

  scheduleSignalRReconnect(): void {
    if (this.unloading) {
      return;
    }
    this.clearTimeout(this.signalRReconnectTimer);
    this.signalRReconnectTimer = this.setTimeout(() => {
      this.signalRReconnectTimer = undefined;
      this.startSignal().catch((error) =>
        this.log.warn(`SignalR reconnect failed (${errorType(error)}).`),
      );
    }, 30000);
  }

  configurePollInterval(): void {
    const configuredInterval = Number(this.config.polltime);
    if (
      Number.isFinite(configuredInterval) &&
      configuredInterval >= 10 &&
      configuredInterval <= 86_400
    ) {
      this.polltime = configuredInterval;
      return;
    }
    this.polltime = 30;
    this.log.warn(
      "Poll interval must be between 10 and 86400 seconds; using 30",
    );
  }

  getCloudPollDelay(): number {
    const retryAt = this.apiRetryState.get("charger list")?.retryAt ?? 0;
    return Math.max(this.polltime * 1000, retryAt - Date.now());
  }

  scheduleCloudPoll(): void {
    if (this.unloading) {
      return;
    }
    this.clearTimeout(this.readAllStatesTimer);
    this.readAllStatesTimer = this.setTimeout(() => {
      this.readAllStatesTimer = undefined;
      void this.runCloudPoll();
    }, this.getCloudPollDelay());
  }

  async runCloudPoll(): Promise<void> {
    try {
      await this.readAllStates();
    } catch (error) {
      if (!this.unloading) {
        this.log.error(`State polling failed: ${errorMessage(error)}`);
        this.scheduleCloudPoll();
      }
    }
  }

  /**
   * Starten den Adapter
   */
  private async ensureLastUpdateObject(): Promise<void> {
    await this.setObjectNotExistsAsync("lastUpdate", {
      type: "state",
      common: {
        name: "lastUpdate",
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.extendObjectAsync("lastUpdate", {
      common: { type: "string", role: "text" },
    });
  }

  private async initializeI18n(): Promise<void> {
    if (this.i18nInitialized) {
      return;
    }
    try {
      await I18n.init(getAdminDirectory(), this);
    } catch (error) {
      this.log.warn(
        `Could not determine the language for Bluetooth status text; using English: ${errorMessage(error)}`,
      );
      await I18n.init(getAdminDirectory(), "en");
    }
    this.i18nInitialized = true;
  }

  async onReady(): Promise<void> {
    //initial Status melden
    await this.setStateAsync("info.connection", false, true);
    await this.initializeI18n();

    this.connectionMode = getConnectionMode(this.config.connectionMode);
    await this.reconcileModeSpecificObjects();
    this.logtype = this.config.logtype === true;
    if (this.connectionMode === "bluetooth") {
      await this.startBluetooth();
      return;
    }

    this.configureSessionPolling();
    await this.setObjectNotExistsAsync("info.sessionPollLastRequest", {
      type: "state",
      common: {
        name: "Last session request",
        type: "number",
        role: "value.time",
        unit: "ms",
        read: true,
        write: false,
      },
      native: {},
    });
    const lastSessionRequest = await this.getStateAsync(
      "info.sessionPollLastRequest",
    );
    if (
      typeof lastSessionRequest?.val === "number" &&
      Number.isFinite(lastSessionRequest.val)
    ) {
      this.sessionLastRequestAt = lastSessionRequest.val;
    }

    this.configurePollInterval();
    // Testen ob der Login funktioniert
    if (this.config.username == "" || this.config.username == "+49") {
      this.log.error("No username set");
    } else if (this.config.client_secret == "") {
      this.log.error("No password set");
    } else {
      this.log.debug("Api login started");
      const login = await this.login(
        this.config.username,
        this.config.client_secret,
      );
      if (login) {
        await this.ensureLastUpdateObject();

        //reset all to start
        this.chargerIds = [];

        if (this.config.signalR) {
          this.log.info("Starting SignalR");
          this.startSignal().catch((error) =>
            this.log.warn(`SignalR start failed (${errorType(error)}).`),
          );
        }
        // Start polling without delaying SignalR on a slow API response.
        await this.runCloudPoll();
      }
    }
  }

  async startBluetooth(): Promise<void> {
    await this.initializeI18n();
    this.lastBluetoothAdapterState = null;
    this.bluetoothStartupComplete = false;
    await this.setObjectNotExistsAsync("info.bluetoothAdapterState", {
      type: "state",
      common: {
        name: "Local Bluetooth adapter state",
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.setStateAsync("info.bluetoothAdapterState", "unknown", true);
    for (const [id, name] of [
      [
        "info.bluetoothAdapterStateDisplay",
        "Bluetooth adapter status for settings",
      ],
      [
        "info.bluetoothSearchReadinessDisplay",
        "Bluetooth search status for settings",
      ],
      [
        "info.bluetoothScanResultsDisplay",
        "Bluetooth search results for settings",
      ],
    ] as const) {
      await this.setObjectNotExistsAsync(id, {
        type: "state",
        common: {
          name,
          type: "string",
          role: "text",
          read: true,
          write: false,
        },
        native: {},
      });
    }
    await this.setStateAsync(
      "info.bluetoothAdapterStateDisplay",
      I18n.t("Bluetooth status is not available yet."),
      true,
    );
    await this.setStateAsync(
      "info.bluetoothSearchReadinessDisplay",
      I18n.t("Bluetooth is starting."),
      true,
    );
    await this.setObjectNotExistsAsync("info.bluetoothSearchReadiness", {
      type: "state",
      common: {
        name: "Bluetooth search readiness",
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.setStateAsync(
      "info.bluetoothSearchReadiness",
      "Initializing local Bluetooth transport.",
      true,
    );
    await this.setStateAsync(
      "info.bluetoothSearchReadinessDisplay",
      I18n.t("Bluetooth is starting."),
      true,
    );
    await this.setObjectNotExistsAsync("info.bluetoothScanResults", {
      type: "state",
      common: {
        name: "Manual Bluetooth search results",
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.writeBluetoothScanResults(
      "No search has been run yet.",
      I18n.t("No search has been run yet."),
    );

    let configurationError: BluetoothConfigurationError | null = null;
    try {
      this.configuredBluetoothChargers = this.getConfiguredBluetoothChargers();
    } catch (error) {
      configurationError = getStoredBluetoothConfigurationError(error);
      this.log.error(
        `Invalid Bluetooth charger configuration: ${configurationError.message}`,
      );
      this.configuredBluetoothChargers = [];
    }

    if (configurationError) {
      this.log.info(
        "Initializing Bluetooth transport for manual searches because the stored charger configuration is invalid.",
      );
    } else {
      this.log.info(
        `Initializing Bluetooth transport for ${this.configuredBluetoothChargers.length} configured charger(s).`,
      );
    }
    const devices: BluetoothDeviceConfig[] = [];
    for (const config of this.configuredBluetoothChargers) {
      const charger: Charger = {
        id: config.serialNumber,
        name: config.name,
      };
      devices.push({
        serial: config.serialNumber,
        pin: config.pin,
        name: config.name,
      });
      this.bluetoothConnections.set(charger.id, false);
      this.chargerIds.push(charger.id);
      await this.setAllStatusObjects(charger);
      await this.setAllConfigObjects(charger);
      await this.setBluetoothInfoObjects(charger);
      await this.setStateAsync(`${charger.id}.name`, charger.name, true);
    }
    if (this.configuredBluetoothChargers.length > 0) {
      await this.reconcileModeSpecificObjects(
        this.configuredBluetoothChargers.map((charger) => charger.serialNumber),
      );
    }

    try {
      const diagnosticLogger = {
        debug: (message: string) => this.log.debug(message),
      };
      const scanner = await createNobleBluetoothScanner(
        undefined,
        this.config.bluetoothBinding,
        diagnosticLogger,
      );
      if (this.unloading) {
        await scanner
          .close()
          .catch((error) =>
            this.log.warn(
              `Error closing late Bluetooth scanner: ${errorMessage(error)}`,
            ),
          );
        return;
      }
      this.log.debug(`Using Noble Bluetooth binding: ${scanner.getBinding()}.`);
      this.bluetoothScanner = scanner;
      this.bluetoothAdapterStateUnsubscribe = scanner.onAdapterStateChange(
        (state) => this.updateBluetoothAdapterState(state),
      );
      this.updateBluetoothAdapterState(scanner.getAdapterState());
      await this.bluetoothAdapterStateWrite;
      if (this.unloading) {
        return;
      }
      if (this.configuredBluetoothChargers.length === 0) {
        this.bluetoothStartupComplete = true;
        if (configurationError) {
          this.log.info(
            "Bluetooth is ready for manual searches; the stored charger configuration is invalid (see the error above).",
          );
        } else {
          this.log.info(
            "Bluetooth is ready for manual searches; no chargers are configured",
          );
        }
        await this.updateBluetoothSearchReadiness();
        return;
      }

      const options: BluetoothClientOptions = {
        diagnosticLogger,
        onStatus: (event) => this.handleBluetoothStatus(event),
      };
      this.bluetoothClient = new BluetoothClient(devices, scanner, options);
      this.configurePollInterval();
      try {
        await this.bluetoothClient.start();
      } catch (error) {
        this.log.error(
          `Could not start Bluetooth client: ${this.sanitizeBluetoothDiagnostic(errorMessage(error))}`,
        );
      } finally {
        this.bluetoothStartupComplete = true;
        await this.updateBluetoothSearchReadiness();
      }
      this.scheduleBluetoothPoll(0);
      this.scheduleBluetoothReconnect();
    } catch (error) {
      this.bluetoothStartupComplete = true;
      const detail = this.sanitizeBluetoothDiagnostic(errorMessage(error));
      this.log.error(`Could not initialize Bluetooth transport: ${detail}`);
      await this.writeBluetoothScanResults(
        `Bluetooth transport initialization failed: ${detail}`,
        I18n.t(
          "Bluetooth search failed. Check that Bluetooth is on and that ioBroker is allowed to use it. See the adapter log for details.",
        ),
      );
      for (const charger of this.configuredBluetoothChargers) {
        this.bluetoothConnectionErrors.set(charger.serialNumber, detail);
        await this.setStateAsync(
          `${charger.serialNumber}.info.bluetoothError`,
          detail,
          true,
        );
      }
      await this.updateBluetoothSearchReadiness();
    }
  }

  updateBluetoothAdapterState(state: BluetoothAdapterState): void {
    this.bluetoothAdapterStateWrite = this.bluetoothAdapterStateWrite
      .then(async () => {
        if (this.unloading || this.connectionMode !== "bluetooth") {
          return;
        }
        if (this.lastBluetoothAdapterState !== state) {
          const previous = this.lastBluetoothAdapterState;
          this.lastBluetoothAdapterState = state;
          this.log.debug(
            previous
              ? `Local Bluetooth adapter state changed from ${previous} to ${state}.`
              : `Local Bluetooth adapter state: ${state}.`,
          );
        }
        await this.setStateAsync("info.bluetoothAdapterState", state, true);
        await this.setStateAsync(
          "info.bluetoothAdapterStateDisplay",
          this.getBluetoothAdapterStateDisplay(state),
          true,
        );
        await this.updateBluetoothSearchReadiness();
      })
      .catch((error) => {
        this.log.warn(
          `Could not update local Bluetooth adapter state: ${errorMessage(error)}`,
        );
      });
  }

  private getBluetoothAdapterStateDisplay(
    state: BluetoothAdapterState,
  ): string {
    switch (state) {
      case "poweredOn":
        return I18n.t("The local Bluetooth adapter is ready.");
      case "poweredOff":
        return I18n.t("Bluetooth is turned off.");
      case "unauthorized":
        return I18n.t("Bluetooth access is not allowed.");
      case "unsupported":
        return I18n.t("Bluetooth is not supported on this device.");
      default:
        return I18n.t("Bluetooth status is unknown.");
    }
  }

  private getBluetoothSearchReadiness(): ReturnType<
    typeof deriveBluetoothSearchReadiness
  > {
    return deriveBluetoothSearchReadiness({
      unloading: this.unloading,
      bluetoothMode: this.connectionMode === "bluetooth",
      scannerAvailable: this.bluetoothScanner !== null,
      startupComplete: this.bluetoothStartupComplete,
      adapterState: this.lastBluetoothAdapterState,
      scanInFlight: this.bluetoothManualScanInFlight,
      pollInFlight: this.bluetoothPollInFlight,
      activeWrites: this.bluetoothWritesInFlight,
      pendingCircuitWrites: this.bluetoothCircuitWrites.size,
      activeCircuitWrites: this.bluetoothCircuitWritesInFlight,
      reconnectInFlight: this.bluetoothReconnectInFlight,
    });
  }

  private async writeBluetoothScanResults(
    rawResults: string,
    displayResults: string,
  ): Promise<void> {
    await this.setStateAsync("info.bluetoothScanResults", rawResults, true);
    await this.setStateAsync(
      "info.bluetoothScanResultsDisplay",
      displayResults,
      true,
    );
  }

  updateBluetoothSearchReadiness(): Promise<void> {
    if (this.connectionMode !== "bluetooth") {
      return this.bluetoothSearchReadinessWrite ?? Promise.resolve();
    }
    this.bluetoothSearchReadinessWrite = (
      this.bluetoothSearchReadinessWrite ?? Promise.resolve()
    )
      .then(async () => {
        const readiness = this.getBluetoothSearchReadiness();
        await this.setStateAsync(
          "info.bluetoothSearchReadiness",
          readiness.rawMessage,
          true,
        );
        await this.setStateAsync(
          "info.bluetoothSearchReadinessDisplay",
          I18n.t(readiness.displayMessageKey),
          true,
        );
      })
      .catch((error) => {
        this.log.warn(
          `Could not update Bluetooth search readiness: ${errorMessage(error)}`,
        );
      });
    return this.bluetoothSearchReadinessWrite;
  }

  refreshBluetoothAdapterState(): BluetoothAdapterState | null {
    if (this.connectionMode !== "bluetooth" || !this.bluetoothScanner) {
      return null;
    }
    return this.bluetoothScanner.getAdapterState();
  }

  onMessage(message: ioBroker.Message): void {
    if (!message?.callback) {
      return;
    }
    if (message.command === "bluetoothScan") {
      void this.runBluetoothManualScan()
        .then((result) =>
          this.sendTo(message.from, message.command, result, message.callback),
        )
        .catch((error) => {
          this.log.error(
            `Manual Bluetooth search failed: ${errorMessage(error)}`,
          );
          this.sendTo(
            message.from,
            message.command,
            { error: "failed" },
            message.callback,
          );
        });
    }
  }

  async runBluetoothManualScan(): Promise<{ result?: string; error?: string }> {
    if (this.connectionMode !== "bluetooth" || this.unloading) {
      return { error: "unavailable" };
    }
    let readiness = this.getBluetoothSearchReadiness();
    const scanner = this.bluetoothScanner;
    if (!scanner) {
      this.log.warn(
        "Manual Bluetooth search not started: local BLE transport is not initialized",
      );
      await this.updateBluetoothSearchReadiness();
      return { error: "notReady" };
    }
    if (!readiness.busyReason) {
      let adapterState: BluetoothAdapterState | null;
      try {
        adapterState = this.refreshBluetoothAdapterState();
      } catch (error) {
        const detail = this.sanitizeBluetoothDiagnostic(errorMessage(error))
          .replace(/[\r\n\t]+/g, " ")
          .slice(0, 200);
        await this.writeBluetoothScanResults(
          `Could not read local Bluetooth adapter state: ${detail}`,
          I18n.t(
            "Bluetooth search failed. Check that Bluetooth is on and that ioBroker is allowed to use it. See the adapter log for details.",
          ),
        );
        await this.setStateAsync(
          "info.bluetoothSearchReadiness",
          `Not ready: could not read the local Bluetooth adapter state (${detail}).`,
          true,
        );
        await this.setStateAsync(
          "info.bluetoothSearchReadinessDisplay",
          I18n.t(
            "Bluetooth search failed. Check that Bluetooth is on and that ioBroker is allowed to use it. See the adapter log for details.",
          ),
          true,
        );
        this.log.warn(`Manual Bluetooth search not started: ${detail}`);
        return { error: "failed" };
      }
      if (this.unloading || this.connectionMode !== "bluetooth") {
        return { error: "unavailable" };
      }
      if (adapterState) {
        this.updateBluetoothAdapterState(adapterState);
        await this.bluetoothAdapterStateWrite;
        readiness = this.getBluetoothSearchReadiness();
      }
    }
    if (readiness.busyReason) {
      const message = `Search not started: ${readiness.busyReason}. Try again when it completes.`;
      this.log.info(
        `Manual Bluetooth search not started: ${readiness.busyReason} (${readiness.diagnostics}).`,
      );
      await this.writeBluetoothScanResults(
        message,
        I18n.t("Bluetooth is busy. Please try again in a moment."),
      );
      await this.updateBluetoothSearchReadiness();
      return { error: "busy" };
    }
    if (!readiness.canScan) {
      if (readiness.reason === "adapterUnavailable") {
        const adapterState = this.lastBluetoothAdapterState ?? "unknown";
        await this.writeBluetoothScanResults(
          `Search not started: local Bluetooth adapter state is ${adapterState}.`,
          I18n.t("The local Bluetooth adapter is not ready."),
        );
        this.log.warn(
          `Manual Bluetooth search not started: local adapter state is ${adapterState}`,
        );
        await this.updateBluetoothSearchReadiness();
        return { error: "notReady" };
      }
      await this.updateBluetoothSearchReadiness();
      return { error: "notReady" };
    }

    this.bluetoothManualScanInFlight = true;
    await this.updateBluetoothSearchReadiness();
    const generation = ++this.bluetoothManualScanGeneration;
    if (this.unloading || generation !== this.bluetoothManualScanGeneration) {
      this.bluetoothManualScanInFlight = false;
      return { error: "unavailable" };
    }

    if (this.bluetoothPollTimer) {
      this.clearTimeout(this.bluetoothPollTimer);
      this.bluetoothPollTimer = null;
    }
    if (this.bluetoothReconnectTimer) {
      this.clearTimeout(this.bluetoothReconnectTimer);
      this.bluetoothReconnectTimer = null;
    }

    let scanStartedAt: number | undefined;
    let observedAdvertisementCount = 0;
    const observedAdvertisements = new Set<string>();
    let liveResultsWrite = Promise.resolve();
    let scanFinished = false;
    const isCurrentScan = (): boolean =>
      !this.unloading &&
      this.connectionMode === "bluetooth" &&
      generation === this.bluetoothManualScanGeneration;
    const queueLiveResults = (): void => {
      const observations = [...observedAdvertisements];
      liveResultsWrite = liveResultsWrite
        .then(async () => {
          if (!scanFinished && isCurrentScan()) {
            await this.writeBluetoothScanResults(
              `Searching for Easee BLE advertisements (up to ${bluetoothManualScanTimeoutMs / 1000} seconds)...\nAdvertisement names/connectability/service UUIDs/manufacturer matches observed so far:\n${observations.join("\n")}`,
              I18n.t(
                "Searching for nearby Easee chargers. Please wait up to %s seconds.",
                bluetoothManualScanTimeoutMs / 1000,
              ),
            );
          }
        })
        .catch((error: unknown) => {
          const detail = this.sanitizeBluetoothDiagnostic(errorMessage(error));
          this.log.warn(
            `Could not update live Bluetooth search results: ${detail}`,
          );
        });
    };
    try {
      await this.writeBluetoothScanResults(
        `Searching for Easee BLE advertisements (up to ${bluetoothManualScanTimeoutMs / 1000} seconds)...`,
        I18n.t(
          "Searching for nearby Easee chargers. Please wait up to %s seconds.",
          bluetoothManualScanTimeoutMs / 1000,
        ),
      );
      if (
        this.unloading ||
        this.connectionMode !== "bluetooth" ||
        generation !== this.bluetoothManualScanGeneration
      ) {
        return { error: "unavailable" };
      }
      this.log.info(
        `Starting manual Bluetooth search for the Easee service UUID ${BLUETOOTH_SERVICE_UUID} or manufacturer ID 3118 with an unfiltered advertisement scan; local adapter state is ${this.lastBluetoothAdapterState ?? "unknown"}.`,
      );
      scanStartedAt = Date.now();
      const scanTask = scanner.discover(
        BLUETOOTH_SERVICE_UUID,
        bluetoothManualScanTimeoutMs,
        {
          scanWithoutServiceFilter: true,
          onAdvertisement: (report) => {
            observedAdvertisementCount++;
            const name = report.name
              ? this.sanitizeBluetoothScanResult(report.name.trim()).slice(
                  0,
                  80,
                )
              : "Name not broadcast";
            const serviceUuids = report.serviceUuids
              .slice(0, 10)
              .map((serviceUuid) =>
                this.sanitizeBluetoothScanResult(
                  serviceUuid.toLowerCase(),
                ).slice(0, 40),
              );
            const connectability =
              report.connectable === undefined
                ? "connectability unknown"
                : report.connectable
                  ? "connectable"
                  : "not connectable";
            const manufacturerMatch = report.easeeManufacturerMatch
              ? "match"
              : "no match";
            const observation = `${name} [${connectability}; service UUIDs: ${serviceUuids.join(", ") || "none"}; manufacturer ID 3118: ${manufacturerMatch}]`;
            if (
              observedAdvertisements.size < 20 &&
              !observedAdvertisements.has(observation)
            ) {
              observedAdvertisements.add(observation);
              queueLiveResults();
            }
          },
        },
      );
      this.bluetoothManualScanTask = scanTask;
      const candidates = await scanTask;
      await liveResultsWrite;
      scanFinished = true;
      if (isCurrentScan()) {
        const observations = [...observedAdvertisements];
        this.log.info(
          `Manual Bluetooth search completed in ${Date.now() - (scanStartedAt ?? Date.now())} ms: ${candidates.length} advertisement(s) matched the Easee service UUID or manufacturer ID 3118.`,
        );
        this.log.info(
          `Unfiltered BLE diagnostics observed ${observedAdvertisementCount} advertisement(s); name/connectability/service UUID/manufacturer signature observations: ${observations.map((observation) => this.sanitizeBluetoothDiagnostic(observation)).join("; ") || "none"}.`,
        );
        await this.writeBluetoothScanResults(
          this.formatBluetoothScanResults(candidates, {
            observedAdvertisementCount,
            observations,
          }),
          this.formatBluetoothScanResultsDisplay(candidates, {
            observedAdvertisementCount,
          }),
        );
      }
      return { result: "completed" };
    } catch (error) {
      scanFinished = true;
      await liveResultsWrite;
      const detail = this.sanitizeBluetoothDiagnostic(errorMessage(error));
      const currentSearch = isCurrentScan();
      if (currentSearch) {
        await this.writeBluetoothScanResults(
          `Search failed: ${detail}. Check local Bluetooth access; a charger may also be out of range or busy.`,
          I18n.t(
            "Bluetooth search failed. Check that Bluetooth is on and that ioBroker is allowed to use it. See the adapter log for details.",
          ),
        );
        const elapsed =
          scanStartedAt === undefined
            ? "before scanning"
            : `after ${Date.now() - scanStartedAt} ms`;
        this.log.warn(`Manual Bluetooth search failed ${elapsed}: ${detail}`);
      }
      return { error: currentSearch ? "failed" : "unavailable" };
    } finally {
      scanFinished = true;
      await liveResultsWrite;
      if (generation === this.bluetoothManualScanGeneration) {
        this.bluetoothManualScanInFlight = false;
        this.bluetoothManualScanTask = null;
        if (!this.unloading && this.connectionMode === "bluetooth") {
          this.bluetoothReconnectDelay = 10000;
          this.scheduleBluetoothPoll(0);
          this.scheduleBluetoothReconnect();
        }
        await this.updateBluetoothSearchReadiness();
      }
    }
  }

  formatBluetoothScanResults(
    candidates: readonly BluetoothCandidate[],
    diagnostics?: {
      readonly observedAdvertisementCount: number;
      readonly observations: readonly string[];
    },
  ): string {
    const diagnosticSummary = diagnostics
      ? `\nNoble observed ${diagnostics.observedAdvertisementCount} BLE advertisement(s) without a service UUID filter. Name/connectability/service UUID/manufacturer signature observations: ${diagnostics.observations.join("; ") || "none"}.`
      : "";
    if (candidates.length === 0) {
      return `No matching advertisements were found during this scan. This does not establish whether a charger is available.${diagnosticSummary}`;
    }
    const displayLimit = 100;
    const results = candidates.slice(0, displayLimit).map((candidate) => {
      const id = this.sanitizeBluetoothScanResult(candidate.id).slice(0, 80);
      const name = candidate.name
        ? this.sanitizeBluetoothScanResult(candidate.name.trim()).slice(0, 80)
        : "";
      const connectability =
        candidate.connectable === undefined
          ? "connectability unknown"
          : candidate.connectable
            ? "connectable"
            : "not connectable";
      return `- ${name || "Name not broadcast"} [${connectability}] (observed BLE identifier: ${id})`;
    });
    const omitted =
      candidates.length - results.length > 0
        ? `\n${candidates.length - results.length} additional result(s) omitted.`
        : "";
    return `Found ${candidates.length} matching advertisement(s):\n${results.join("\n")}${omitted}${diagnosticSummary}`;
  }

  formatBluetoothScanResultsDisplay(
    candidates: readonly BluetoothCandidate[],
    diagnostics?: { readonly observedAdvertisementCount: number },
  ): string {
    if (candidates.length === 0) {
      return diagnostics && diagnostics.observedAdvertisementCount > 0
        ? I18n.t(
            "Bluetooth devices were detected, but no Easee charger was recognized. The charger may be out of range or not ready for Bluetooth.",
          )
        : I18n.t(
            "No Easee charger was detected. It may be out of range or not ready for Bluetooth.",
          );
    }
    const summary =
      candidates.length === 1
        ? I18n.t("Found one possible Easee charger.")
        : I18n.t("Found %s possible Easee chargers.", candidates.length);
    const names = candidates.slice(0, 10).map((candidate) => {
      const name = candidate.name
        ? this.sanitizeBluetoothScanResult(candidate.name.trim()).slice(0, 80)
        : I18n.t("Device name not available.");
      return `- ${name}`;
    });
    const omitted =
      candidates.length > names.length
        ? `\n${I18n.t("And %s more.", candidates.length - names.length)}`
        : "";
    return `${summary}\n${names.join("\n")}${omitted}`;
  }

  async setBluetoothInfoObjects(charger: Charger): Promise<void> {
    await this.setObjectNotExistsAsync(
      `${charger.id}.info.bluetoothConnection`,
      {
        type: "state",
        common: {
          name: "Bluetooth connection",
          type: "boolean",
          role: "indicator.reachable",
          read: true,
          write: false,
          def: false,
        },
        native: {},
      },
    );
    await this.setObjectNotExistsAsync(`${charger.id}.info.bluetoothError`, {
      type: "state",
      common: {
        name: "Bluetooth connection error",
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.setObjectNotExistsAsync(`${charger.id}.info.bluetoothRSSI`, {
      type: "state",
      common: {
        name: "Bluetooth signal strength",
        type: "number",
        role: "value",
        unit: "dBm",
        read: true,
        write: false,
      },
      native: {},
    });
    await Promise.all([
      this.setStateAsync(`${charger.id}.info.bluetoothConnection`, false, true),
      this.setStateAsync(`${charger.id}.info.bluetoothError`, "", true),
    ]);
  }

  private sanitizeBluetoothDiagnostic(value: string): string {
    let sanitized = value.replace(/[\r\n\t]+/g, " ");
    for (const charger of this.configuredBluetoothChargers) {
      if (charger.serialNumber) {
        sanitized = sanitized.split(charger.serialNumber).join("[redacted]");
      }
      if (charger.pin) {
        sanitized = sanitized.split(charger.pin).join("[redacted]");
      }
    }
    return sanitized
      .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, "[redacted]")
      .replace(/\bdev_(?:[0-9a-f]{2}_){5}[0-9a-f]{2}\b/gi, "dev_[redacted]")
      .slice(0, 200);
  }

  private sanitizeBluetoothScanResult(value: string): string {
    let sanitized = value.replace(/[\r\n\t]+/g, " ");
    for (const charger of this.configuredBluetoothChargers) {
      if (charger.pin) {
        sanitized = sanitized.split(charger.pin).join("[redacted]");
      }
    }
    return sanitized
      .replace(/\bPIN(?:\s*[:=]\s*|\s+)[^\s;,]+/gi, "PIN [redacted]")
      .slice(0, 200);
  }

  handleBluetoothStatus(event: BluetoothStatusEvent): void {
    const detail = event.error
      ? this.sanitizeBluetoothDiagnostic(event.error.message)
      : undefined;
    const statusMessage = `Bluetooth connection state: ${event.status}`;
    const connected = event.status === "connected";
    if (connected) {
      this.bluetoothConnectingLogged.delete(event.serial);
      this.log.info(statusMessage);
    } else if (event.retryExhausted) {
      this.bluetoothConnectingLogged.delete(event.serial);
      this.log.error(
        `Bluetooth connection failed after ${event.maxAttempts ?? event.attempt ?? 3} attempts for ${event.name}: ${detail ?? "No connection could be established."}`,
      );
    } else if (detail !== undefined) {
      this.log.debug(`${statusMessage}: ${detail}`);
    } else if (event.status === "scanning" || event.status === "connecting") {
      if (this.bluetoothConnectingLogged.has(event.serial)) {
        this.log.debug(statusMessage);
      } else {
        this.bluetoothConnectingLogged.add(event.serial);
        this.log.info("Bluetooth connection state: connecting");
      }
    } else {
      this.log.debug(statusMessage);
    }

    this.bluetoothConnections.set(event.serial, connected);
    if (detail !== undefined) {
      this.bluetoothConnectionErrors.set(event.serial, detail);
    } else if (connected) {
      this.bluetoothConnectionErrors.delete(event.serial);
      this.bluetoothPauseRestore.delete(event.serial);
      this.bluetoothConnectionGenerations.set(
        event.serial,
        (this.bluetoothConnectionGenerations.get(event.serial) ?? 0) + 1,
      );
    } else if (
      event.status === "disconnected" &&
      !this.bluetoothConnectionErrors.has(event.serial)
    ) {
      this.bluetoothConnectionErrors.set(
        event.serial,
        "Not connected; check range, charger discoverability, PIN, and whether another Bluetooth client may be connected.",
      );
    }
    if (event.status === "disconnected") {
      for (const resolve of [
        ...(this.bluetoothDisconnectWaiters.get(event.serial) ?? []),
      ]) {
        resolve(true);
      }
    }

    const error = this.bluetoothConnectionErrors.get(event.serial) ?? "";
    Promise.all([
      this.setStateAsync(
        `${event.serial}.info.bluetoothConnection`,
        connected,
        true,
      ),
      this.setStateAsync(`${event.serial}.info.bluetoothError`, error, true),
      this.setStateAsync(
        "info.connection",
        [...this.bluetoothConnections.values()].some(Boolean),
        true,
      ),
    ]).catch((writeError) => {
      this.log.error(
        `Could not update Bluetooth connection status for ${event.serial}: ${errorMessage(writeError)}`,
      );
    });

    if (connected) {
      this.scheduleBluetoothPoll(0);
    } else if (event.status === "disconnected") {
      this.cancelBluetoothCircuitWrites(event.serial);
      if (this.bluetoothStartupComplete) {
        this.scheduleBluetoothReconnect();
      }
    }
    void this.updateBluetoothSearchReadiness();
  }

  scheduleBluetoothReconnect(): void {
    if (
      this.unloading ||
      !this.bluetoothStartupComplete ||
      !this.bluetoothClient ||
      this.bluetoothReconnectTimer ||
      this.bluetoothReconnectInFlight ||
      this.bluetoothManualScanInFlight ||
      !this.bluetoothClient.hasReconnectAttemptsRemaining() ||
      [...this.bluetoothConnections.values()].every(Boolean)
    ) {
      return;
    }

    const delay = this.bluetoothReconnectDelay;
    this.bluetoothReconnectTimer = this.setTimeout(() => {
      this.bluetoothReconnectTimer = null;
      const client = this.bluetoothClient;
      if (!client || this.unloading) {
        return;
      }
      if (
        this.bluetoothManualScanInFlight ||
        !client.hasReconnectAttemptsRemaining()
      ) {
        return;
      }
      this.bluetoothReconnectInFlight = true;
      void this.updateBluetoothSearchReadiness();
      client
        .reconnect()
        .catch((error) => {
          this.log.warn(
            `Bluetooth reconnection failed: ${errorMessage(error)}`,
          );
        })
        .finally(() => {
          this.bluetoothReconnectInFlight = false;
          void this.updateBluetoothSearchReadiness();
          if (
            [...this.bluetoothConnections.values()].every(Boolean) &&
            this.bluetoothConnections.size > 0
          ) {
            this.bluetoothReconnectDelay = 10000;
          } else if (client.hasReconnectAttemptsRemaining()) {
            this.bluetoothReconnectDelay = Math.min(delay * 2, 300000);
            this.scheduleBluetoothReconnect();
          }
        });
    }, delay);
  }

  scheduleBluetoothPoll(delay: number): void {
    if (this.unloading || !this.bluetoothClient) {
      return;
    }
    if (this.bluetoothPollTimer) {
      this.clearTimeout(this.bluetoothPollTimer);
    }
    this.bluetoothPollTimer = this.setTimeout(() => {
      this.bluetoothPollTimer = null;
      void this.pollBluetoothChargers();
    }, delay);
  }

  async pollBluetoothChargers(): Promise<void> {
    if (
      this.unloading ||
      !this.bluetoothClient ||
      this.bluetoothPollInFlight ||
      this.bluetoothManualScanInFlight
    ) {
      return;
    }
    this.bluetoothPollInFlight = true;
    await this.updateBluetoothSearchReadiness();
    const client = this.bluetoothClient;
    try {
      for (const charger of this.configuredBluetoothChargers) {
        if (
          this.unloading ||
          !this.bluetoothConnections.get(charger.serialNumber)
        ) {
          continue;
        }
        try {
          const result = await client.poll(charger.serialNumber);
          await this.applyBluetoothPoll(charger.serialNumber, result);
        } catch (error) {
          this.log.warn(
            `Bluetooth polling failed for ${charger.serialNumber}: ${errorMessage(error)}`,
          );
        }
      }
    } finally {
      this.bluetoothPollInFlight = false;
      await this.updateBluetoothSearchReadiness();
      if (!this.unloading) {
        this.scheduleBluetoothPoll(this.polltime * 1000);
      }
    }
  }

  async applyBluetoothPoll(
    serial: string,
    result: Awaited<ReturnType<BluetoothClient["poll"]>>,
  ): Promise<void> {
    const mapped = mapBluetoothPoll(result);
    for (const [stateId, value] of Object.entries(mapped)) {
      if (this.unloading) {
        return;
      }
      await this.setStateAsync(`${serial}.${stateId}`, value, true);
    }
  }

  async readBluetoothPoll(
    serial: string,
  ): Promise<Awaited<ReturnType<BluetoothClient["poll"]>>> {
    const client = this.bluetoothClient;
    if (!client || !this.bluetoothConnections.get(serial)) {
      throw new Error(`Bluetooth charger ${serial} is not connected`);
    }
    const result = await client.poll(serial);
    await this.applyBluetoothPoll(serial, result);
    return result;
  }

  async handleBluetoothStateChange(
    id: string,
    state: ioBroker.State,
  ): Promise<void> {
    if (this.unloading) {
      return;
    }
    const parts = id.split(".");
    const serial = parts[2];
    if (!serial || !this.bluetoothConnections.has(serial)) {
      this.log.error(`Bluetooth write rejected for unknown charger: ${id}`);
      return;
    }

    if (this.bluetoothManualScanInFlight) {
      await this.reportBluetoothWriteFailure(
        serial,
        id,
        new Error("A Bluetooth search is in progress; retry the write later"),
      );
      return;
    }

    this.bluetoothWritesInFlight += 1;
    await this.updateBluetoothSearchReadiness();
    try {
      if (parts[3] === "control") {
        await this.handleBluetoothControlWrite(id, serial, parts[4], state);
        return;
      }
      if (parts[3] === "config") {
        await this.handleBluetoothConfigWrite(id, serial, parts[4], state);
        return;
      }
      throw new Error("This datapoint is not writable in Bluetooth mode");
    } catch (error) {
      await this.reportBluetoothWriteFailure(serial, id, error);
    } finally {
      this.bluetoothWritesInFlight -= 1;
      await this.updateBluetoothSearchReadiness();
    }
  }

  async handleBluetoothConfigWrite(
    id: string,
    serial: string,
    key: string | undefined,
    state: ioBroker.State,
  ): Promise<void> {
    const value = state.val;
    switch (key) {
      case "isEnabled":
        if (typeof value !== "boolean") {
          throw new Error("Charger enabled value must be boolean");
        }
        await this.executeVerifiedBluetoothCommand(
          serial,
          id,
          value,
          { type: "setEnabled", enabled: value },
          (result) => result.config.isEnabled === (value ? 1 : 0),
        );
        return;
      case "maxChargerCurrent": {
        const amperes = this.requireBluetoothAmperes(value);
        await this.executeVerifiedBluetoothCommand(
          serial,
          id,
          value,
          { type: "setMaxChargerCurrent", amperes },
          (result) => result.config.maxChargerCurrent === amperes,
        );
        return;
      }
      case "dynamicChargerCurrent": {
        const amperes = this.requireBluetoothAmperes(value);
        await this.executeVerifiedBluetoothCommand(
          serial,
          id,
          value,
          { type: "setDynamicChargerCurrent", amperes },
          (result) => result.state.dynamicChargerCurrent === amperes,
        );
        if (amperes > 0) {
          this.bluetoothPauseRestore.delete(serial);
        }
        return;
      }
      case "phaseMode":
        if (!isValidPhaseMode(value)) {
          throw new Error("Phase mode must be 1, 2 or 3");
        }
        await this.executeVerifiedBluetoothCommand(
          serial,
          id,
          value,
          { type: "setPhaseMode", mode: value },
          (result) => result.config.phaseMode === value,
        );
        return;
      case "ledStripBrightness":
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 100
        ) {
          throw new Error("LED brightness must be an integer from 0 to 100");
        }
        await this.executeVerifiedBluetoothCommand(
          serial,
          id,
          value,
          { type: "setLedBrightness", percent: value },
          (result) => result.config.ledStripBrightness === value,
        );
        return;
      case "lockCablePermanently":
        if (typeof value !== "boolean") {
          throw new Error("Permanent cable lock value must be boolean");
        }
        await this.executeVerifiedBluetoothCommand(
          serial,
          id,
          value,
          { type: "setCableLocked", locked: value },
          (result) => result.config.cableLocked === (value ? 1 : 0),
        );
        return;
      case "circuitMaxCurrentP1":
      case "circuitMaxCurrentP2":
      case "circuitMaxCurrentP3":
        await this.writeBluetoothCircuitMaximum(
          id,
          serial,
          key.slice(-2).toLowerCase() as Phase,
          value,
        );
        return;
      case "dynamicCircuitCurrentP1":
      case "dynamicCircuitCurrentP2":
      case "dynamicCircuitCurrentP3":
        this.queueBluetoothDynamicCircuitWrite(
          id,
          serial,
          key.slice(-2).toLowerCase() as Phase,
          value,
        );
        return;
      default:
        throw new Error(
          `The config datapoint ${key ?? "(unknown)"} is not supported in Bluetooth mode`,
        );
    }
  }

  async handleBluetoothControlWrite(
    id: string,
    serial: string,
    key: string | undefined,
    state: ioBroker.State,
  ): Promise<void> {
    if (state.val !== true) {
      throw new Error("Control buttons can only be triggered with true");
    }
    const client = this.bluetoothClient;
    if (!client || !this.bluetoothConnections.get(serial)) {
      throw new Error(`Bluetooth charger ${serial} is not connected`);
    }

    switch (key) {
      case "pause": {
        const generation = this.bluetoothConnectionGenerations.get(serial) ?? 0;
        const current = await this.readBluetoothPoll(serial);
        this.assertBluetoothConnectionGeneration(serial, generation);
        const amperes = current.state.dynamicChargerCurrent;
        if (
          typeof amperes !== "number" ||
          !Number.isInteger(amperes) ||
          amperes <= 0 ||
          amperes > 40
        ) {
          throw new Error(
            "Pause is unavailable because no positive current limit is known",
          );
        }
        await this.executeVerifiedBluetoothCommand(
          serial,
          id,
          state.val,
          { type: "pauseCharging" },
          (result) => result.state.dynamicChargerCurrent === 0,
          undefined,
          generation,
        );
        this.bluetoothPauseRestore.set(serial, { amperes, generation });
        return;
      }
      case "resume": {
        const restore = this.bluetoothPauseRestore.get(serial);
        if (
          !restore ||
          restore.generation !==
            (this.bluetoothConnectionGenerations.get(serial) ?? 0)
        ) {
          throw new Error(
            "Resume is unavailable without a current limit saved by this connection",
          );
        }
        const generation = this.bluetoothConnectionGenerations.get(serial) ?? 0;
        const current = await this.readBluetoothPoll(serial);
        this.assertBluetoothConnectionGeneration(serial, generation);
        if (current.state.dynamicChargerCurrent !== 0) {
          throw new Error(
            "Resume was rejected because the charger is no longer paused",
          );
        }
        await this.executeVerifiedBluetoothCommand(
          serial,
          id,
          state.val,
          { type: "resumeCharging", amperes: restore.amperes },
          (result) => result.state.dynamicChargerCurrent === restore.amperes,
          undefined,
          generation,
        );
        this.bluetoothPauseRestore.delete(serial);
        return;
      }
      case "reboot":
        await client.command(serial, { type: "reboot" });
        if (!(await this.waitForBluetoothDisconnect(serial, 15000))) {
          throw new Error(
            "The charger did not disconnect after the reboot request; execution is unconfirmed",
          );
        }
        await this.setStateAsync(id, { val: state.val, ack: true });
        return;
      case "start":
      case "stop":
        throw new Error(
          `The ${key} command is Cloud-only; charger enablement is not equivalent to a charging session command`,
        );
      default:
        throw new Error(
          `The control command ${key ?? "(unknown)"} is not supported in Bluetooth mode`,
        );
    }
  }

  async writeBluetoothCircuitMaximum(
    id: string,
    serial: string,
    phase: Phase,
    value: ioBroker.StateValue,
  ): Promise<void> {
    const amperes = this.requireBluetoothAmperes(value);
    const generation = this.bluetoothConnectionGenerations.get(serial) ?? 0;
    const current = await this.readBluetoothPoll(serial);
    this.assertBluetoothConnectionGeneration(serial, generation);
    const limits = [
      current.config.circuitMaxCurrentP1,
      current.config.circuitMaxCurrentP2,
      current.config.circuitMaxCurrentP3,
    ];
    if (
      limits.some(
        (limit) =>
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 0 ||
          limit > 40,
      )
    ) {
      throw new Error(
        "Current phase limits are unavailable; refusing to guess other phases",
      );
    }
    const next = limits as [number, number, number];
    const index = phase === "p1" ? 0 : phase === "p2" ? 1 : 2;
    next[index] = amperes;
    await this.executeVerifiedBluetoothCommand(
      serial,
      id,
      value,
      { type: "setMaxCircuitCurrent", amperes: next },
      (result) =>
        result.config.circuitMaxCurrentP1 === next[0] &&
        result.config.circuitMaxCurrentP2 === next[1] &&
        result.config.circuitMaxCurrentP3 === next[2],
      undefined,
      generation,
    );
  }

  queueBluetoothDynamicCircuitWrite(
    id: string,
    serial: string,
    phase: Phase,
    value: ioBroker.StateValue,
  ): void {
    const amperes = this.requireBluetoothAmperes(value);
    const sequence = ++this.bluetoothCircuitWriteSequence;
    let pending = this.bluetoothCircuitWrites.get(serial);
    if (!pending) {
      pending = {
        values: {},
        stateIds: {},
        sequence,
        timer: undefined,
      };
      this.bluetoothCircuitWrites.set(serial, pending);
    } else if (pending.timer) {
      this.clearTimeout(pending.timer);
      pending.sequence = sequence;
    }
    pending.values[phase] = amperes;
    pending.stateIds[phase] = id;
    pending.timer = this.setTimeout(() => {
      this.bluetoothCircuitWrites.delete(serial);
      void this.flushBluetoothDynamicCircuitWrite(serial, pending);
    }, 500);
  }

  async flushBluetoothDynamicCircuitWrite(
    serial: string,
    pending: PendingBluetoothCircuitWrite,
  ): Promise<void> {
    this.bluetoothCircuitWritesInFlight += 1;
    try {
      await this.updateBluetoothSearchReadiness();
      if (this.unloading || !this.bluetoothConnections.get(serial)) {
        throw new Error(
          "Pending dynamic circuit current update was discarded after disconnect",
        );
      }
      const generation = this.bluetoothConnectionGenerations.get(serial) ?? 0;
      const current = await this.readBluetoothPoll(serial);
      this.assertBluetoothConnectionGeneration(serial, generation);
      const newerPending = this.bluetoothCircuitWrites.get(serial);
      if (newerPending && newerPending.sequence > pending.sequence) {
        this.log.info(
          `Discarded superseded Dynamic circuit current update for ${serial}`,
        );
        return;
      }
      const values = [
        pending.values.p1 ?? current.state.dynamicCircuitCurrentP1,
        pending.values.p2 ?? current.state.dynamicCircuitCurrentP2,
        pending.values.p3 ?? current.state.dynamicCircuitCurrentP3,
      ];
      if (
        values.some(
          (value) =>
            typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < 0 ||
            value > 40,
        )
      ) {
        throw new Error(
          "Current phase limits are unavailable; refusing to guess other phases",
        );
      }
      const currents = values as [number, number, number];
      const latestPending = this.bluetoothCircuitWrites.get(serial);
      if (latestPending && latestPending.sequence > pending.sequence) {
        this.log.info(
          `Discarded superseded Dynamic circuit current update for ${serial}`,
        );
        return;
      }
      await this.executeVerifiedBluetoothCommand(
        serial,
        pending.stateIds.p1 ??
          pending.stateIds.p2 ??
          pending.stateIds.p3 ??
          `${serial}.config.dynamicCircuitCurrentP1`,
        pending.values.p1 ?? currents[0],
        { type: "setDynamicCircuitCurrent", amperes: currents },
        (result) =>
          result.state.dynamicCircuitCurrentP1 === currents[0] &&
          result.state.dynamicCircuitCurrentP2 === currents[1] &&
          result.state.dynamicCircuitCurrentP3 === currents[2],
        pending,
        generation,
      );
    } catch (error) {
      await this.reportBluetoothWriteFailure(
        serial,
        pending.stateIds.p1 ??
          pending.stateIds.p2 ??
          pending.stateIds.p3 ??
          `${serial}.config.dynamicCircuitCurrentP1`,
        error,
      );
    } finally {
      this.bluetoothCircuitWritesInFlight -= 1;
      await this.updateBluetoothSearchReadiness();
    }
  }

  cancelBluetoothCircuitWrites(serial: string, reportLoss = true): void {
    const pending = this.bluetoothCircuitWrites.get(serial);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      this.clearTimeout(pending.timer);
    }
    this.bluetoothCircuitWrites.delete(serial);
    if (reportLoss) {
      this.log.warn(
        `Discarded pending dynamic circuit current update for ${serial} after connection loss`,
      );
    }
  }

  async executeVerifiedBluetoothCommand(
    serial: string,
    stateId: string,
    requestedValue: ioBroker.StateValue,
    command: BluetoothCommand,
    verify: (result: Awaited<ReturnType<BluetoothClient["poll"]>>) => boolean,
    pending?: PendingBluetoothCircuitWrite,
    expectedGeneration = this.bluetoothConnectionGenerations.get(serial) ?? 0,
  ): Promise<void> {
    const client = this.bluetoothClient;
    this.assertBluetoothConnectionGeneration(serial, expectedGeneration);
    if (!client) {
      throw new Error(`Bluetooth charger ${serial} is not connected`);
    }
    await client.command(serial, command);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await client.poll(serial);
      this.assertBluetoothConnectionGeneration(serial, expectedGeneration);
      await this.applyBluetoothPoll(serial, result);
      if (verify(result)) {
        if (pending) {
          for (const phase of ["p1", "p2", "p3"] as const) {
            const phaseStateId = pending.stateIds[phase];
            const phaseValue = pending.values[phase];
            if (phaseStateId && phaseValue !== undefined) {
              await this.setStateAsync(phaseStateId, {
                val: phaseValue,
                ack: true,
              });
            }
          }
        } else {
          await this.setStateAsync(stateId, {
            val: requestedValue,
            ack: true,
          });
        }
        return;
      }
      if (attempt < 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
      }
    }
    throw new Error(
      "The charger did not confirm the requested Bluetooth setting",
    );
  }

  assertBluetoothConnectionGeneration(
    serial: string,
    expectedGeneration: number,
  ): void {
    if (
      this.unloading ||
      !this.bluetoothConnections.get(serial) ||
      (this.bluetoothConnectionGenerations.get(serial) ?? 0) !==
        expectedGeneration
    ) {
      throw new Error(
        `Bluetooth connection for ${serial} changed; refusing to send or confirm a stale command`,
      );
    }
  }

  async waitForBluetoothDisconnect(
    serial: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!this.bluetoothConnections.get(serial)) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      let timer: Timer = undefined;
      const waiters =
        this.bluetoothDisconnectWaiters.get(serial) ??
        new Set<(disconnected: boolean) => void>();
      const finish = (disconnected: boolean): void => {
        if (timer) {
          this.clearTimeout(timer);
        }
        waiters.delete(finish);
        if (waiters.size) {
          this.bluetoothDisconnectWaiters.set(serial, waiters);
        } else {
          this.bluetoothDisconnectWaiters.delete(serial);
        }
        resolve(disconnected);
      };
      waiters.add(finish);
      this.bluetoothDisconnectWaiters.set(serial, waiters);
      timer = this.setTimeout(() => finish(false), timeoutMs);
    });
  }

  requireBluetoothAmperes(value: ioBroker.StateValue): number {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 40
    ) {
      throw new Error("Current must be an integer between 0 and 40 A");
    }
    return value;
  }

  async reportBluetoothWriteFailure(
    serial: string,
    id: string,
    error: unknown,
  ): Promise<void> {
    const message = errorMessage(error);
    this.log.error(`Bluetooth write failed for ${id}: ${message}`);
    if (this.unloading) {
      return;
    }
    this.bluetoothConnectionErrors.set(serial, message);
    try {
      await this.setStateAsync(`${serial}.info.bluetoothError`, message, true);
    } catch (writeError) {
      this.log.error(
        `Could not report Bluetooth write error for ${serial}: ${errorMessage(writeError)}`,
      );
    }
  }

  async executeCloudControlWrite(
    id: string,
    chargerId: string,
    command: "start" | "stop" | "pause" | "resume" | "reboot",
    value: ioBroker.StateValue,
  ): Promise<void> {
    if (this.unloading) {
      return;
    }
    if (value !== true) {
      this.log.error(`Invalid control value for ${id}: expected true`);
      return;
    }

    try {
      switch (command) {
        case "start":
          this.log.info(`Starting charging for charger ${chargerId}`);
          await this.startCharging(chargerId);
          break;
        case "stop":
          this.log.info(`Stopping charging for charger ${chargerId}`);
          await this.stopCharging(chargerId);
          break;
        case "pause":
          this.log.info(`Pausing charging for charger ${chargerId}`);
          await this.pauseCharging(chargerId);
          break;
        case "resume":
          this.log.info(`Resuming charging for charger ${chargerId}`);
          await this.resumeCharging(chargerId);
          break;
        case "reboot":
          this.log.info(`Rebooting charger ${chargerId}`);
          await this.rebootCharging(chargerId);
          break;
      }
      await this.setStateAsync(id, { val: true, ack: true });
    } catch (error) {
      this.log.error(
        `Cloud ${command} command failed for charger ${chargerId}: ${errorMessage(error)}`,
      );
    }
  }

  configureSessionPolling(): void {
    this.sessionPollMode =
      this.config.sessionPollMode === "manual" ? "manual" : "auto";
    const configuredInterval = Number(this.config.sessionPollInterval);
    const maxSessionPollInterval = Math.floor(maxTimeoutMilliseconds / 60_000);
    this.sessionManualInterval = Number.isFinite(configuredInterval)
      ? Math.min(maxSessionPollInterval, Math.max(7, configuredInterval))
      : defaultSessionPollInterval;
    if (
      this.sessionPollMode === "manual" &&
      this.sessionManualInterval !== configuredInterval
    ) {
      this.log.warn(
        `Manual session interval must be between 7 and ${maxSessionPollInterval} minutes; using a safe interval`,
      );
    }
  }

  // Clear all Timeouts and inform users
  onUnload(callback: () => void): void {
    this.unloading = true;
    const bluetoothReadinessShutdown = this.updateBluetoothSearchReadiness();
    this.bluetoothAdapterStateUnsubscribe?.();
    this.bluetoothAdapterStateUnsubscribe = null;
    this.bluetoothManualScanGeneration += 1;
    this.bluetoothManualScanInFlight = false;
    this.bluetoothManualScanTask = null;
    this.clearTimeout(this.readAllStatesTimer);
    this.readAllStatesTimer = undefined;
    if (this.bluetoothReconnectTimer) {
      this.clearTimeout(this.bluetoothReconnectTimer);
    }
    this.bluetoothReconnectTimer = null;
    if (this.bluetoothPollTimer) {
      this.clearTimeout(this.bluetoothPollTimer);
    }
    this.bluetoothPollTimer = null;
    for (const serial of this.bluetoothCircuitWrites?.keys() ?? []) {
      this.cancelBluetoothCircuitWrites(serial, false);
    }
    for (const waiters of this.bluetoothDisconnectWaiters?.values() ?? []) {
      for (const resolve of [...waiters]) {
        resolve(false);
      }
    }
    this.bluetoothPauseRestore?.clear();
    if (this.sessionPollTimer) {
      this.clearTimeout(this.sessionPollTimer);
    }
    this.sessionPollTimer = null;
    this.sessionAbortController?.abort();
    const sessionShutdown = this.sessionInFlight;
    for (const chargerState of this.dynamicCircuitCurrentByCharger.values()) {
      if (chargerState.timer) {
        this.clearTimeout(chargerState.timer);
      }
      if (chargerState.retryTimer) {
        this.clearTimeout(chargerState.retryTimer);
      }
      chargerState.retryResolve?.();
    }
    this.dynamicCircuitCurrentByCharger.clear();
    for (const circuitState of this.dynamicCircuitCurrentByCircuit.values()) {
      if (circuitState.timer) {
        this.clearTimeout(circuitState.timer);
      }
    }
    this.dynamicCircuitCurrentByCircuit.clear();
    this.clearTimeout(this.signalRReconnectTimer);
    this.signalRReconnectTimer = undefined;
    for (const retry of this.pendingSiteConfigRetries.values()) {
      this.clearTimeout(retry.timer);
    }
    this.pendingSiteConfigRetries.clear();
    const signalRShutdown = Promise.resolve(
      this.signalRConnection?.stop(),
    ).catch((error) =>
      this.log.warn(`Error stopping SignalR (${errorType(error)}).`),
    );
    const pendingSessionShutdown = Promise.resolve(sessionShutdown).catch(
      (error) =>
        this.log.warn(`Error stopping session polling: ${errorMessage(error)}`),
    );
    const bluetoothShutdown = Promise.resolve(
      this.bluetoothClient
        ? this.bluetoothClient.stop()
        : this.bluetoothScanner?.close(),
    ).catch((error) =>
      this.log.warn(`Error stopping Bluetooth client: ${errorMessage(error)}`),
    );
    const bluetoothStatusShutdown = Promise.resolve(
      this.bluetoothAdapterStateWrite,
    ).catch((error) =>
      this.log.warn(
        `Error stopping Bluetooth status updates: ${errorMessage(error)}`,
      ),
    );
    Promise.all([
      signalRShutdown,
      pendingSessionShutdown,
      bluetoothShutdown,
      bluetoothStatusShutdown,
      bluetoothReadinessShutdown,
    ])
      .then(() => this.setStateAsync("info.connection", false, true))
      .catch((error) =>
        this.log.error(`Error during unload: ${errorMessage(error)}`),
      )
      .finally(() => {
        this.signalRConnection = null;
        this.bluetoothClient = null;
        this.bluetoothScanner = null;
        this.bluetoothStartupComplete = false;
        this.log.info("Adapter easee cleaned up everything...");
        callback();
      });
  }

  async requestWithBackoff<T>(
    key: string,
    requestFn: () => Promise<T>,
    coalesceInFlight = true,
  ): Promise<T> {
    if (this.unloading) {
      throw new Error("Adapter is stopping");
    }
    let retryState = this.apiRetryState.get(key);
    if (!retryState) {
      retryState = { delay: 30000, retryAt: 0, inFlight: null };
      this.apiRetryState.set(key, retryState);
    }
    if (retryState.inFlight) {
      if (coalesceInFlight) {
        return (await retryState.inFlight) as T;
      }
      try {
        await retryState.inFlight;
      } catch {
        // Continue with this write after the prior request settles.
      }
      return this.requestWithBackoff(key, requestFn, false);
    }
    if (retryState.retryAt > Date.now()) {
      const error: RetryableError = new Error(`Retry deferred for ${key}`);
      error.retryDeferred = true;
      error.retryAt = retryState.retryAt;
      throw error;
    }

    retryState.inFlight = (async () => {
      try {
        const response = await requestFn();
        this.apiRetryState.delete(key);
        return response;
      } catch (error) {
        if (this.unloading || !isTransientApiError(error)) {
          throw error;
        }
        const delay = Math.max(retryState.delay, getRateLimitDelay(error));
        retryState.retryAt = Date.now() + delay;
        if (key.startsWith("charger session ")) {
          this.sessionRetryAt = Math.max(
            this.sessionRetryAt,
            retryState.retryAt,
          );
        }
        retryState.delay = Math.min(Math.max(delay * 2, 30000), 300000);
        this.log.warn(
          `Easee API request failed for ${key}; retrying after ${Math.ceil(delay / 1000)} seconds: ${errorMessage(error)}`,
        );
        const retryError: RetryableError = new Error(errorMessage(error));
        retryError.retryDeferred = true;
        retryError.retryAt = retryState.retryAt;
        throw retryError;
      } finally {
        retryState.inFlight = null;
      }
    })();
    return (await retryState.inFlight) as T;
  }

  async updateSiteConfigWithRetry(
    chargerId: string,
    stateId: string,
    description: string,
    update: (site: Site, circuit: SiteCircuit | undefined) => Promise<void>,
    sequence: number | undefined,
    requireCircuit = true,
    sequenceKey?: string,
  ): Promise<void> {
    if (this.unloading) {
      return;
    }

    try {
      const site = await this.getChargerSite(chargerId);
      if (this.unloading) {
        return;
      }
      const circuit = site
        ? getUniqueChargerCircuit(site, chargerId)
        : undefined;
      if (!site?.id) {
        this.log.warn(
          `Unable to update ${description}: site data missing for charger ${chargerId}`,
        );
        return;
      }
      if (requireCircuit && !circuit?.id) {
        this.log.warn(
          `Unable to update ${description}: unique charger circuit data missing for charger ${chargerId}`,
        );
        return;
      }
      if (requireCircuit) {
        const circuitKey = `${site.id}:${circuit!.id}:${sequenceKey ?? ""}`;
        const latestSequence =
          this.circuitMaxCurrentByCircuit.get(circuitKey) || 0;
        if (sequence !== undefined && sequence < latestSequence) {
          this.log.info(
            `Discarded superseded ${description} for ${circuitKey}`,
          );
          return;
        }
        if (sequence !== undefined) {
          this.circuitMaxCurrentByCircuit.set(circuitKey, sequence);
        }
      }
      await update(site, circuit);
    } catch (error) {
      if (!isRetryableError(error) || this.unloading) {
        this.log.error(`${description} error: ${errorMessage(error)}`);
        return;
      }

      const retryKey = `${chargerId}:${stateId}`;
      const existingRetry = this.pendingSiteConfigRetries.get(retryKey);
      if (existingRetry) {
        this.clearTimeout(existingRetry.timer);
      }

      const siteRetry = this.apiRetryState.get(`charger site ${chargerId}`);
      const delay = Math.max(
        0,
        (error.retryAt ?? siteRetry?.retryAt ?? Date.now()) - Date.now(),
      );
      const timer = this.setTimeout(() => {
        this.pendingSiteConfigRetries.delete(retryKey);
        this.updateSiteConfigWithRetry(
          chargerId,
          stateId,
          description,
          update,
          sequence,
          requireCircuit,
          sequenceKey,
        ).catch((error) =>
          this.log.error(
            `${description} retry failed for ${chargerId}: ${errorMessage(error)}`,
          ),
        );
      }, delay);
      this.pendingSiteConfigRetries.set(retryKey, { timer });
      this.log.info(
        `${description} queued for retry in ${Math.ceil(delay / 1000)} seconds`,
      );
    }
  }

  async updateDynamicCircuitWithRetry(
    chargerId: string,
    chargerState: DynamicChargerState,
    changedValues: Partial<Record<Phase, number>>,
    phaseSequences: Partial<Record<Phase, number>>,
  ): Promise<void> {
    while (!this.unloading) {
      if (
        (Object.entries(phaseSequences) as [Phase, number][]).some(
          ([phase, sequence]) =>
            chargerState.latestSequences[phase] !== sequence,
        )
      ) {
        this.log.info(
          `Discarded superseded Dynamic circuit current update for ${chargerId}`,
        );
        return;
      }
      try {
        const site = await this.getChargerSite(chargerId);
        if (this.unloading) {
          return;
        }
        const circuit = site
          ? getUniqueChargerCircuit(site, chargerId)
          : undefined;
        if (!site?.id || !circuit?.id) {
          this.log.warn(
            "Unable to update Dynamic circuit current: site or unique charger circuit data missing",
          );
          return;
        }

        if (
          (Object.entries(phaseSequences) as [Phase, number][]).some(
            ([phase, sequence]) =>
              chargerState.latestSequences[phase] !== sequence,
          )
        ) {
          this.log.info(
            `Discarded superseded Dynamic circuit current update for ${chargerId}`,
          );
          return;
        }

        const siteId = site.id;
        const circuitId = circuit.id;
        const circuitKey = `${siteId}:${circuitId}`;
        let circuitState = this.dynamicCircuitCurrentByCircuit.get(circuitKey);
        if (!circuitState) {
          circuitState = {
            values: { p1: 0, p2: 0, p3: 0 },
            phaseSequences: { p1: 0, p2: 0, p3: 0 },
            timer: null,
            queue: Promise.resolve(),
          };
          this.dynamicCircuitCurrentByCircuit.set(circuitKey, circuitState);
        }
        let updated = false;
        for (const [phase, value] of Object.entries(changedValues) as [
          Phase,
          number,
        ][]) {
          const sequence = phaseSequences[phase];
          if (sequence === undefined) {
            continue;
          }
          if (sequence >= circuitState.phaseSequences[phase]) {
            circuitState.values[phase] = value;
            circuitState.phaseSequences[phase] = sequence;
            updated = true;
          }
        }
        if (!updated) {
          this.log.info(
            `Discarded superseded Dynamic circuit current update for ${circuitKey}`,
          );
          return;
        }
        if (circuitState.timer === null) {
          circuitState.timer = this.setTimeout(() => {
            circuitState.timer = null;
            const currentValues = { ...circuitState.values };
            circuitState.values = { p1: 0, p2: 0, p3: 0 };
            circuitState.queue = circuitState.queue
              .catch((error) => {
                this.log.error(
                  `Previous circuit current update failed: ${errorMessage(error)}`,
                );
              })
              .then(() => {
                if (this.unloading) {
                  return;
                }
                return this.changeCircuitConfig(
                  siteId,
                  circuitId,
                  currentValues,
                );
              });
          }, 500);
        }
        return;
      } catch (error) {
        if (!isRetryableError(error) || this.unloading) {
          this.log.error(
            `Dynamic circuit current update error: ${errorMessage(error)}`,
          );
          return;
        }

        const siteRetry = this.apiRetryState.get(`charger site ${chargerId}`);
        const delay = Math.max(
          0,
          (error.retryAt ?? siteRetry?.retryAt ?? Date.now()) - Date.now(),
        );
        await new Promise<void>((resolve) => {
          chargerState.retryResolve = resolve;
          chargerState.retryTimer = this.setTimeout(resolve, delay);
        });
        chargerState.retryResolve = null;
        chargerState.retryTimer = null;
      }
    }
  }

  /*****************************************************************************************/
  async readAllStates(): Promise<void> {
    if (this.unloading) {
      return;
    }

    if (this.expireTime <= Date.now()) {
      //Token ist expired!
      if (this.logtype) {
        this.log.info("Token has expired - refresh");
      }
      if (!(await this.refreshToken())) {
        if (!this.unloading) {
          this.scheduleCloudPoll();
        }
        return;
      }
    }
    if (this.unloading) {
      return;
    }
    this.log.debug("read new states from the API");

    //Lesen alle Charger aus
    const nameVersions = new Map(this.chargerNameVersions);
    const tmpAllChargers = await this.getAllCharger();
    if (this.unloading) {
      return;
    }
    await this.setStateAsync(
      "info.connection",
      tmpAllChargers !== undefined,
      true,
    );
    let pollSucceeded = Array.isArray(tmpAllChargers);
    if (Array.isArray(tmpAllChargers)) {
      const chargers: Charger[] = [];
      const seenChargerIds = new Set<string>();
      const knownChargerIds = new Map(
        this.chargerIds.map((id) => [id.toLowerCase(), id]),
      );
      for (const item of tmpAllChargers) {
        if (
          !isRecord(item) ||
          typeof item.id !== "string" ||
          !safeObjectIdSegment.test(item.id)
        ) {
          pollSucceeded = false;
          this.log.warn("Ignoring charger with an invalid Cloud id");
          continue;
        }
        const normalizedId = item.id.toLowerCase();
        const knownId = knownChargerIds.get(normalizedId);
        if (knownId && knownId !== item.id) {
          pollSucceeded = false;
          this.log.warn(
            `Ignoring charger id with conflicting casing: ${item.id}`,
          );
          continue;
        }
        if (seenChargerIds.has(normalizedId)) {
          pollSucceeded = false;
          this.log.warn(`Ignoring duplicate charger id: ${item.id}`);
          continue;
        }
        seenChargerIds.add(normalizedId);
        chargers.push({
          id: item.id,
          name:
            typeof item.name === "string" && item.name.trim()
              ? item.name
              : item.id,
        });
      }

      if (chargers.length > 0 || tmpAllChargers.length === 0) {
        this.updateSessionChargers(chargers);
      } else {
        this.log.warn(
          "No valid chargers were returned; retaining the previous session polling list",
        );
      }
      if (tmpAllChargers.length === 0) {
        this.log.info("No chargers are configured in the Easee Cloud account");
      }
      const initializedChargerIds: string[] = [];
      for (const charger of chargers) {
        if (this.unloading) {
          return;
        }
        //Prüfen ob wir das Object kennen
        if (!this.chargerIds.includes(charger.id)) {
          //setzen als erstes alle Objekte
          await this.setAllStatusObjects(charger);
          await this.setAllConfigObjects(charger);
          initializedChargerIds.push(charger.id);

          //merken uns den charger
          this.chargerIds.push(charger.id);
        }
        await this.subscribeChargerToSignalR(charger.id);
        if (this.unloading) {
          return;
        }

        this.log.debug("Charger found");
        try {
          //Lesen den Status aus
          const tmpChargerState = await this.getChargerState(charger.id);
          if (this.unloading) {
            return;
          }
          //Lesen die config
          const tmpChargerConfig = await this.getChargerConfig(charger.id);
          if (this.unloading) {
            return;
          }
          // Read the charging price configured for the site
          const tmpChargerSite = await this.getChargerSite(charger.id);
          if (this.unloading) {
            return;
          }

          //Setzen die Daten der Charger
          await this.setNewStatusToCharger(
            charger,
            tmpChargerState.state,
            tmpChargerState.timestamps,
            nameVersions.get(charger.id) ?? 0,
          );

          //Setzen die Config zum Charger
          await this.setConfigStatus(charger, tmpChargerConfig, tmpChargerSite);
        } catch (error) {
          pollSucceeded = false;
          if (isRetryableError(error)) {
            continue;
          }
          this.log.error(errorMessage(error));
        }
      }
      if (initializedChargerIds.length > 0) {
        await this.reconcileModeSpecificObjects(initializedChargerIds);
      }
    } else if (tmpAllChargers !== undefined) {
      this.log.warn("Ignoring invalid charger list returned by Easee Cloud");
    } else {
      this.log.warn("No charger list was returned; the adapter will retry");
    }

    if (this.unloading) {
      return;
    }

    if (pollSucceeded) {
      await this.setStateAsync(
        "lastUpdate",
        new Date().toLocaleTimeString(),
        true,
      );
    }
    this.scheduleCloudPoll();
  }

  updateSessionChargers(chargers: Charger[]): void {
    const nextCharger = this.sessionChargers[this.sessionCursor];
    const previousChargers = this.sessionChargers;
    this.sessionChargers = [...new Set(chargers.map((charger) => charger.id))];
    const changed =
      previousChargers.length !== this.sessionChargers.length ||
      previousChargers.some(
        (chargerId, index) => chargerId !== this.sessionChargers[index],
      );
    this.sessionCursor = nextCharger
      ? Math.max(this.sessionChargers.indexOf(nextCharger), 0)
      : this.sessionCursor % Math.max(this.sessionChargers.length, 1);

    this.updateSessionPollInfo().catch((error) => {
      this.log.warn(
        `Could not update session polling information: ${errorMessage(error)}`,
      );
    });

    if (!this.sessionChargers.length) {
      if (this.sessionPollTimer) {
        this.clearTimeout(this.sessionPollTimer);
      }
      this.sessionPollTimer = null;
      return;
    }
    if (!this.sessionInFlight && (this.sessionPollTimer === null || changed)) {
      const nextSlotDelay =
        this.sessionLastRequestAt === null
          ? 0
          : Math.max(
              0,
              (this.sessionLastRequestAt ?? 0) +
                this.getSessionRequestInterval() -
                Date.now(),
            );
      this.scheduleSessionPoll(nextSlotDelay);
    }
  }

  async updateSessionPollInfo(): Promise<void> {
    const chargerCount = this.sessionChargers.length;
    if (!chargerCount) {
      return;
    }
    const recommendedInterval = chargerCount * 7;
    const effectiveInterval =
      this.sessionPollMode === "manual"
        ? Math.max(recommendedInterval, this.sessionManualInterval)
        : recommendedInterval;
    await Promise.all([
      this.setStateAsync("info.sessionPollChargerCount", chargerCount, true),
      this.setStateAsync(
        "info.sessionPollRecommendedInterval",
        recommendedInterval,
        true,
      ),
      this.setStateAsync(
        "info.sessionPollEffectiveInterval",
        effectiveInterval,
        true,
      ),
    ]);
  }

  getSessionRequestInterval(): number {
    const chargerCount = this.sessionChargers.length;
    if (!chargerCount) {
      return sessionRequestInterval;
    }
    const effectiveInterval =
      this.sessionPollMode === "manual"
        ? Math.max(chargerCount * 7, this.sessionManualInterval)
        : chargerCount * 7;
    return Math.max(
      sessionRequestInterval,
      (effectiveInterval * 60000) / chargerCount,
    );
  }

  scheduleSessionPoll(delay: number): void {
    if (
      this.unloading ||
      !this.sessionChargers.length ||
      this.sessionInFlight
    ) {
      return;
    }
    if (this.sessionPollTimer) {
      this.clearTimeout(this.sessionPollTimer);
    }
    const safeDelay = Number.isFinite(delay)
      ? Math.min(maxTimeoutMilliseconds, Math.max(0, delay))
      : maxTimeoutMilliseconds;
    this.sessionPollTimer = this.setTimeout(() => {
      this.sessionPollTimer = null;
      this.pollNextSession().catch((error) => {
        this.log.warn(`Session polling failed: ${errorMessage(error)}`);
      });
    }, safeDelay);
  }

  async pollNextSession(): Promise<void> {
    if (
      this.unloading ||
      this.sessionInFlight ||
      !this.sessionChargers.length
    ) {
      return;
    }

    const minRequestDelay =
      this.sessionLastRequestAt === null
        ? 0
        : Math.max(
            0,
            this.sessionLastRequestAt +
              this.getSessionRequestInterval() -
              Date.now(),
          );
    if (minRequestDelay > 0) {
      this.scheduleSessionPoll(minRequestDelay);
      return;
    }

    const sharedRetryDelay = this.sessionRetryAt - Date.now();
    if (sharedRetryDelay > 0) {
      this.scheduleSessionPoll(Math.max(minRequestDelay, sharedRetryDelay));
      return;
    }

    let selectedIndex = -1;
    let earliestRetryAt = Infinity;
    for (let offset = 0; offset < this.sessionChargers.length; offset++) {
      const index = (this.sessionCursor + offset) % this.sessionChargers.length;
      const chargerId = this.sessionChargers[index];
      const retryAt =
        this.apiRetryState.get(`charger session ${chargerId}`)?.retryAt || 0;
      if (retryAt <= Date.now()) {
        selectedIndex = index;
        break;
      }
      earliestRetryAt = Math.min(earliestRetryAt, retryAt);
    }

    if (selectedIndex < 0) {
      this.scheduleSessionPoll(
        Math.max(minRequestDelay, earliestRetryAt - Date.now()),
      );
      return;
    }

    const chargerId = this.sessionChargers[selectedIndex];
    this.sessionCursor = (selectedIndex + 1) % this.sessionChargers.length;
    this.sessionLastRequestAt = Date.now();
    this.setStateAsync(
      "info.sessionPollLastRequest",
      this.sessionLastRequestAt,
      true,
    ).catch((error) => {
      this.log.warn(
        `Could not persist session request time: ${errorMessage(error)}`,
      );
    });
    const controller = new AbortController();
    this.sessionAbortController = controller;
    const request = (async () => {
      try {
        const sessions = await this.getChargerSession(
          chargerId,
          controller.signal,
        );
        if (!this.unloading && this.sessionChargers.includes(chargerId)) {
          await this.setNewSessionToCharger({ id: chargerId }, sessions);
        }
      } catch (error) {
        if (!this.unloading) {
          this.log.warn(
            `Session request failed for charger ${chargerId}: ${errorMessage(error)}`,
          );
        }
      } finally {
        this.sessionInFlight = null;
        this.sessionAbortController = null;
        const delay = Math.max(
          0,
          (this.sessionLastRequestAt ?? 0) +
            this.getSessionRequestInterval() -
            Date.now(),
        );
        this.scheduleSessionPoll(delay);
      }
    })();
    this.sessionInFlight = request;
    await request;
  }

  //Is called if a subscribed state changes
  onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (state) {
      // The state was changed
      this.log.debug(`state ${id} changed (ack = ${state.ack})`);
      if (state.ack) {
        return;
      }
      if (this.connectionMode === "bluetooth") {
        void this.handleBluetoothStateChange(id, state);
        return;
      }
      const tmpControl = id.split(".");
      if (tmpControl.length === 4 && tmpControl[3] === "name") {
        if (!state.ack) {
          this.queueChargerNameChange(tmpControl[2], state.val);
        }
        return;
      }
      if (tmpControl[3] == "config") {
        // change config, wenn ack = false
        if (!state.ack) {
          if (
            tmpControl[4] == "circuitMaxCurrentP1" ||
            tmpControl[4] == "circuitMaxCurrentP2" ||
            tmpControl[4] == "circuitMaxCurrentP3"
          ) {
            const phase = tmpControl[4].endsWith("P1")
              ? "p1"
              : tmpControl[4].endsWith("P2")
                ? "p2"
                : "p3";
            if (
              typeof state.val !== "number" ||
              !Number.isFinite(state.val) ||
              state.val < 0
            ) {
              this.log.error(
                `Invalid circuit current for ${id}: expected a finite non-negative number`,
              );
              return;
            }
            this.updateSiteConfigWithRetry(
              tmpControl[2],
              id,
              "Circuit current update",
              async (site, circuit) => {
                if (!site.id || !circuit?.id) {
                  throw new Error("Could not identify the charger circuit");
                }
                await this.changeMaxCircuitConfig(
                  site.id,
                  circuit.id,
                  phase,
                  state.val as number,
                );
              },
              ++this.circuitMaxCurrentSequence,
              true,
              phase,
            ).catch((error) =>
              this.log.error(
                `Circuit current update failed: ${errorMessage(error)}`,
              ),
            );
          } else if (
            tmpControl[4] == "dynamicCircuitCurrentP1" ||
            tmpControl[4] == "dynamicCircuitCurrentP2" ||
            tmpControl[4] == "dynamicCircuitCurrentP3"
          ) {
            const chargerId = tmpControl[2];
            let currentState =
              this.dynamicCircuitCurrentByCharger.get(chargerId);
            if (!currentState) {
              currentState = {
                pendingValues: {},
                pendingSequences: {},
                latestSequences: { p1: 0, p2: 0, p3: 0 },
                timer: null,
                retryTimer: null,
                retryResolve: null,
                queue: Promise.resolve(),
              };
              this.dynamicCircuitCurrentByCharger.set(chargerId, currentState);
            }
            let phase: Phase | undefined;
            switch (tmpControl[4]) {
              case "dynamicCircuitCurrentP1":
                phase = "p1";
                break;
              case "dynamicCircuitCurrentP2":
                phase = "p2";
                break;
              case "dynamicCircuitCurrentP3":
                phase = "p3";
                break;
            }
            if (!phase) {
              return;
            }
            if (
              typeof state.val !== "number" ||
              !Number.isFinite(state.val) ||
              state.val < 0
            ) {
              this.log.error(
                `Invalid dynamic circuit current for ${id}: expected a finite non-negative number`,
              );
              return;
            }
            currentState.pendingValues[phase] = state.val;
            currentState.pendingSequences[phase] = ++this
              .dynamicCircuitCurrentSequence;
            currentState.latestSequences[phase] =
              currentState.pendingSequences[phase] ?? 0;
            if (currentState.timer) {
              this.clearTimeout(currentState.timer);
            }
            currentState.timer = this.setTimeout(() => {
              currentState.timer = null;
              const changedValues = { ...currentState.pendingValues };
              const phaseSequences = { ...currentState.pendingSequences };
              currentState.pendingValues = {};
              currentState.pendingSequences = {};
              currentState.queue = currentState.queue
                .catch((error) => {
                  this.log.error(
                    `Previous dynamic current update failed: ${errorMessage(error)}`,
                  );
                })
                .then(() => {
                  if (this.unloading) {
                    return;
                  }
                  return this.updateDynamicCircuitWithRetry(
                    chargerId,
                    currentState,
                    changedValues,
                    phaseSequences,
                  );
                });
            }, 500);
          } else if (tmpControl[4] === "lockCablePermanently") {
            if (typeof state.val !== "boolean") {
              this.log.error(
                `Invalid permanent cable lock value: ${state.val}`,
              );
              return;
            }
            void this.changeConfig(
              tmpControl[2],
              "lockCablePermanently",
              state.val,
            );
          } else if (
            tmpControl[4] == "costPerKwhExcludeVat" ||
            tmpControl[4] == "vat"
          ) {
            const value = state.val;
            if (
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < 0 ||
              (tmpControl[4] == "vat" && value >= 100)
            ) {
              this.log.error(`Invalid charging price value: ${state.val}`);
              return;
            }
            const chargerId = tmpControl[2];
            const changedField = tmpControl[4];
            this.updateSiteConfigWithRetry(
              chargerId,
              `${chargerId}.config.chargingPrice`,
              "Charging price update",
              async (site) => {
                const [netPriceState, vatState] = await Promise.all([
                  this.getStateAsync(
                    `${chargerId}.config.costPerKwhExcludeVat`,
                  ),
                  this.getStateAsync(`${chargerId}.config.vat`),
                ]);
                const pendingNetPrice =
                  netPriceState &&
                  !netPriceState.ack &&
                  typeof netPriceState.val === "number" &&
                  Number.isFinite(netPriceState.val) &&
                  netPriceState.val >= 0
                    ? netPriceState.val
                    : Number(site.costPerKwhExcludeVat);
                const pendingVat =
                  vatState &&
                  !vatState.ack &&
                  typeof vatState.val === "number" &&
                  Number.isFinite(vatState.val) &&
                  vatState.val >= 0 &&
                  vatState.val < 100
                    ? vatState.val
                    : Number(site.vat);
                const netPrice =
                  changedField === "costPerKwhExcludeVat"
                    ? value
                    : pendingNetPrice;
                const vat = changedField === "vat" ? value : pendingVat;
                await this.changeChargingPrice(chargerId, site, netPrice, vat);
              },
              undefined,
              false,
            ).catch((error) =>
              this.log.error(
                `Charging price update failed: ${errorMessage(error)}`,
              ),
            );
          } else {
            const setting = tmpControl[4];
            if (!isValidCloudConfigValue(setting, state.val)) {
              this.log.error(`Invalid Cloud configuration value for ${id}`);
              return;
            }
            const apiSetting = setting === "isEnabled" ? "enabled" : setting;
            this.log.debug(
              `Updating Cloud setting ${apiSetting} for ${tmpControl[2]}`,
            );
            void this.changeConfig(tmpControl[2], apiSetting, state.val);
          }
        }
      } else {
        // control charger
        switch (tmpControl[4]) {
          case "start":
            void this.executeCloudControlWrite(
              id,
              tmpControl[2],
              "start",
              state.val,
            );
            break;
          case "stop":
            void this.executeCloudControlWrite(
              id,
              tmpControl[2],
              "stop",
              state.val,
            );
            break;
          case "pause":
            void this.executeCloudControlWrite(
              id,
              tmpControl[2],
              "pause",
              state.val,
            );
            break;
          case "resume":
            void this.executeCloudControlWrite(
              id,
              tmpControl[2],
              "resume",
              state.val,
            );
            break;
          case "reboot":
            void this.executeCloudControlWrite(
              id,
              tmpControl[2],
              "reboot",
              state.val,
            );
            break;
          default:
            this.log.error(`No command for Control found for: ${id}`);
        }
      }
    } else {
      // The state was deleted
      this.log.info(`state ${id} deleted`);
    }
  }

  /***********************************************************************
   * Funktionen für Status der Reading um den Code aufgeräumter zu machen
   ***********************************************************************/

  //Setzen alle Status für Charger
  async setNewStatusToCharger(
    charger: Charger,
    charger_states: ChargerObservationState,
    timestamps: Partial<Record<string, number>> = {},
    nameVersion = this.chargerNameVersions.get(charger.id) ?? 0,
  ): Promise<void> {
    if (
      !this.chargerNamePending.has(charger.id) &&
      nameVersion === (this.chargerNameVersions.get(charger.id) ?? 0)
    ) {
      await this.setStateAsync(`${charger.id}.name`, charger.name, true);
    }
    const statusFields: (keyof ChargerObservationState)[] = [
      "cableLocked",
      "chargerOpMode",
      "totalPower",
      "wiFiRSSI",
      "chargerFirmware",
      "reasonForNoCurrent",
      "voltage",
      "outputCurrent",
      "isOnline",
      "wiFiAPEnabled",
      "ledMode",
      "lifetimeEnergy",
      "energyPerHour",
      "inCurrentT2",
      "inCurrentT3",
      "inCurrentT4",
      "inCurrentT5",
      "inVoltageT1T2",
      "inVoltageT1T3",
      "inVoltageT1T4",
      "inVoltageT1T5",
      "inVoltageT2T3",
      "inVoltageT2T4",
      "inVoltageT2T5",
      "inVoltageT3T4",
      "inVoltageT3T5",
      "inVoltageT4T5",
    ];
    for (const field of statusFields) {
      await this.setObservedState(
        `${charger.id}.status.${field}`,
        charger_states[field],
        timestamps[field],
        "REST",
      );
    }

    for (const field of [
      "lockCablePermanently",
      "dynamicChargerCurrent",
      "dynamicCircuitCurrentP1",
      "dynamicCircuitCurrentP2",
      "dynamicCircuitCurrentP3",
      "smartCharging",
    ] as const) {
      await this.setObservedState(
        `${charger.id}.config.${field}`,
        charger_states[field],
        timestamps[field],
        "REST",
      );
    }
  }

  async setObservedState(
    stateId: string,
    value: ioBroker.StateValue | undefined,
    timestamp: number | undefined,
    source: ObservationVersion["source"],
  ): Promise<void> {
    await this.writeObservedState(stateId, value, timestamp, source);
  }

  async writeObservedState(
    stateId: string,
    value: ioBroker.StateValue | undefined,
    timestamp: number | undefined,
    source: ObservationVersion["source"],
  ): Promise<void> {
    if (value === undefined || value === null) {
      this.log.debug(`${source} observation for ${stateId} was empty; skipped`);
      return;
    }

    const previousVersion = this.observationVersions.get(stateId);
    const version: ObservationVersion = {
      timestamp:
        timestamp !== undefined && Number.isFinite(timestamp)
          ? timestamp
          : undefined,
      source,
    };
    if (previousVersion) {
      const stale =
        version.timestamp !== undefined &&
        previousVersion.timestamp !== undefined
          ? version.timestamp < previousVersion.timestamp
          : source === "REST" || previousVersion.timestamp !== undefined;
      if (stale) {
        this.log.debug(
          `${source} observation for ${stateId} was stale or incomparable; skipped (timestamp=${version.timestamp ?? "missing"}, previous=${previousVersion.timestamp ?? "missing"} from ${previousVersion.source})`,
        );
        return;
      }
    }

    this.observationVersions.set(stateId, version);
    let chargingStartCharger:
      { chargerId: string; generation: number } | undefined;
    let completedSessionLookup:
      | { chargerId: string; sessionStartAt?: number; generation: number }
      | undefined;
    const chargerOpModeSuffix = ".status.chargerOpMode";
    if (
      stateId.endsWith(chargerOpModeSuffix) &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      const chargerId = stateId
        .slice(0, -chargerOpModeSuffix.length)
        .split(".")
        .pop();
      if (chargerId) {
        const previousOpMode = this.lastChargerOpModes.get(chargerId);
        if (value === 2 || value === 6 || value === 7) {
          if (previousOpMode === 1) {
            this.chargerSessionStarts.set(chargerId, {
              timestamp: version.timestamp ?? Date.now(),
              reliable: true,
            });
          }
        }
        if (value === 3 && previousOpMode !== 3) {
          if (!this.chargerSessionStarts.has(chargerId)) {
            this.chargerSessionStarts.set(chargerId, {
              timestamp: version.timestamp ?? Date.now(),
              reliable: previousOpMode === 1,
            });
          }
          const generation =
            (this.chargerSessionGenerations.get(chargerId) ?? 0) + 1;
          this.chargerSessionGenerations.set(chargerId, generation);
          this.chargerSessionAuthTokenResolved.delete(chargerId);
          chargingStartCharger = { chargerId, generation };
        }
        if (
          (value === 4 && previousOpMode === 3) ||
          (value === 1 && (previousOpMode === 3 || previousOpMode === 4))
        ) {
          if (!this.chargerSessionAuthTokenResolved.has(chargerId)) {
            const sessionStart = this.chargerSessionStarts.get(chargerId);
            completedSessionLookup = {
              chargerId,
              sessionStartAt: sessionStart?.reliable
                ? sessionStart.timestamp
                : undefined,
              generation: this.chargerSessionGenerations.get(chargerId) ?? 0,
            };
          }
        }
        if (value === 1) {
          this.chargerSessionStarts.delete(chargerId);
        }
        this.lastChargerOpModes.set(chargerId, value);
      }
    }
    this.log.debug(
      `${source} observation for ${stateId} accepted (timestamp=${version.timestamp ?? "missing"}).`,
    );
    const previousWrite = this.observedStateWrites.get(stateId);
    const write = (previousWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await this.setStateAsync(stateId, value, true);
        this.log.debug(`${source} observation written to ${stateId}.`);
        if (chargingStartCharger) {
          await this.writeSessionAuthTokenIfCurrent(
            chargingStartCharger.chargerId,
            "",
            chargingStartCharger.generation,
          );
          await this.writeSessionAuthTokenIfCurrent(
            chargingStartCharger.chargerId,
            "",
            chargingStartCharger.generation,
            "authTokenName",
          );
        }
      });
    this.observedStateWrites.set(stateId, write);
    try {
      await write;
      if (completedSessionLookup) {
        this.queueCompletedSessionAuthTokenLookup(completedSessionLookup);
      }
    } catch (error) {
      if (this.observationVersions.get(stateId) === version) {
        if (previousVersion) {
          this.observationVersions.set(stateId, previousVersion);
        } else {
          this.observationVersions.delete(stateId);
        }
      }
      throw error;
    } finally {
      if (this.observedStateWrites.get(stateId) === write) {
        this.observedStateWrites.delete(stateId);
      }
    }
  }

  //Setzen alle Status für Config
  async setConfigStatus(
    charger: Charger,
    charger_config: ChargerConfig,
    charger_site: Site | null | undefined,
  ): Promise<void> {
    const writeConfigValue = async (
      name: string,
      value: ioBroker.StateValue,
      isValid: (candidate: unknown) => boolean,
    ): Promise<void> => {
      if (!isValid(value)) {
        this.log.warn(
          `Ignoring invalid Cloud configuration value ${name} for ${charger.id}`,
        );
        return;
      }
      await this.setStateAsync(`${charger.id}.config.${name}`, {
        val: value,
        ack: true,
      });
    };
    const isNonNegativeNumber = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0;

    await writeConfigValue(
      "isEnabled",
      charger_config.isEnabled,
      (value) => typeof value === "boolean",
    );
    await writeConfigValue(
      "phaseMode",
      charger_config.phaseMode,
      isValidPhaseMode,
    );
    await writeConfigValue(
      "ledStripBrightness",
      charger_config.ledStripBrightness,
      (value) => isNonNegativeNumber(value) && value <= 100,
    );
    await writeConfigValue(
      "smartButtonEnabled",
      charger_config.smartButtonEnabled,
      (value) => typeof value === "boolean",
    );
    await writeConfigValue(
      "wiFiSSID",
      charger_config.wiFiSSID,
      (value) => typeof value === "string",
    );
    await writeConfigValue(
      "maxChargerCurrent",
      charger_config.maxChargerCurrent,
      isNonNegativeNumber,
    );

    if (charger_site) {
      if (isNonNegativeNumber(charger_site.costPerKWh)) {
        await this.setStateAsync(`${charger.id}.config.costPerKWh`, {
          val: charger_site.costPerKWh,
          ack: true,
        });
      }
      if (isNonNegativeNumber(charger_site.costPerKwhExcludeVat)) {
        await this.setStateAsync(`${charger.id}.config.costPerKwhExcludeVat`, {
          val: charger_site.costPerKwhExcludeVat,
          ack: true,
        });
      }
      if (
        typeof charger_site.vat === "number" &&
        Number.isFinite(charger_site.vat) &&
        charger_site.vat >= 0 &&
        charger_site.vat < 100
      ) {
        await this.setStateAsync(`${charger.id}.config.vat`, {
          val: charger_site.vat,
          ack: true,
        });
      }

      const currencyUnit =
        typeof charger_site.currencyId === "string" && charger_site.currencyId
          ? `${charger_site.currencyId}/kWh`
          : undefined;
      await this.extendObjectAsync(`${charger.id}.config.costPerKWh`, {
        common: { unit: currencyUnit, write: false },
      });
      await this.extendObjectAsync(
        `${charger.id}.config.costPerKwhExcludeVat`,
        { common: { unit: currencyUnit, write: true } },
      );
      await this.extendObjectAsync(`${charger.id}.config.vat`, {
        common: { unit: "%", write: true },
      });
    }

    await writeConfigValue(
      "circuitMaxCurrentP1",
      charger_config.circuitMaxCurrentP1,
      isNonNegativeNumber,
    );
    await writeConfigValue(
      "circuitMaxCurrentP2",
      charger_config.circuitMaxCurrentP2,
      isNonNegativeNumber,
    );
    await writeConfigValue(
      "circuitMaxCurrentP3",
      charger_config.circuitMaxCurrentP3,
      isNonNegativeNumber,
    );
  }

  /*************************************************************************
   * API CALLS
   * //Todo auslagern in eigene Datei ?
   **************************************************************************/

  //Get Token from API
  async login(username: string, password: string): Promise<boolean> {
    try {
      const response = await axios.post(
        `${apiUrl}/api/accounts/login`,
        {
          userName: username,
          password: password,
        },
        { timeout: apiRequestTimeout },
      );

      const tokens = parseAuthTokenResponse(response.data);
      this.log.info("Easee Api Login successful");

      this.accessToken = tokens.accessToken;
      this.refreshTokenValue = tokens.refreshToken;
      this.expireTime =
        Date.now() +
        Math.max(tokens.expiresIn - tokenRefreshMarginSeconds, 0) * 1000;
      this.log.debug("Easee access token received");
      await this.setStateAsync("info.connection", true, true);
      return true;
    } catch (error) {
      this.log.error("Api login error - check Username and password");
      this.log.error(errorMessage(error));
      await this.setStateAsync("info.connection", false, true);
      return false;
    }
  }

  //GET net Token from API
  async refreshToken(): Promise<boolean> {
    return await axios
      .post(
        `${apiUrl}/api/accounts/refresh_token`,
        {
          accessToken: this.accessToken,
          refreshToken: this.refreshTokenValue,
        },
        { timeout: apiRequestTimeout },
      )
      .then(async (response) => {
        if (this.logtype) {
          this.log.info("RefreshToken successful");
        }
        const tokens = parseAuthTokenResponse(response.data);
        this.accessToken = tokens.accessToken;
        this.refreshTokenValue = tokens.refreshToken;
        this.expireTime =
          Date.now() +
          Math.max(tokens.expiresIn - tokenRefreshMarginSeconds, 0) * 1000;
        await this.setStateAsync("info.connection", true, true);
        this.log.debug("Easee access token refreshed");
        return true;
      })
      .catch(async (error) => {
        this.log.error("RefreshToken error");
        this.log.error(errorMessage(error));
        await this.setStateAsync("info.connection", false, true);
        return false;
      });
  }

  //Lese alle Charger aus
  async getAllCharger(): Promise<Charger[] | undefined> {
    return await this.requestWithBackoff("charger list", () =>
      axios.get<Charger[]>(`${apiUrl}/api/chargers`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        timeout: apiRequestTimeout,
      }),
    )
      .then((response) => {
        this.log.debug("Chargers retrieved");
        return response.data;
      })
      .catch((error) => {
        this.log.error(errorMessage(error));
        return undefined;
      });
  }

  queueChargerNameChange(chargerId: string, value: ioBroker.StateValue): void {
    if (typeof value !== "string" || value.trim().length === 0) {
      this.log.error(
        `Invalid charger name for ${chargerId}: expected a non-empty string`,
      );
      return;
    }
    const version = (this.chargerNameVersions.get(chargerId) ?? 0) + 1;
    this.chargerNameVersions.set(chargerId, version);
    this.chargerNamePending.set(
      chargerId,
      (this.chargerNamePending.get(chargerId) ?? 0) + 1,
    );
    this.chargerNameQueue = this.chargerNameQueue.then(async () => {
      try {
        if (!this.unloading) {
          await this.changeChargerName(chargerId, value, version);
        }
      } catch (error) {
        this.log.error(
          `Charger name update failed for ${chargerId}: ${errorMessage(error)}`,
        );
      } finally {
        const remaining = (this.chargerNamePending.get(chargerId) ?? 1) - 1;
        if (remaining > 0) {
          this.chargerNamePending.set(chargerId, remaining);
        } else {
          this.chargerNamePending.delete(chargerId);
          this.chargerNameVersions.set(
            chargerId,
            (this.chargerNameVersions.get(chargerId) ?? 0) + 1,
          );
        }
      }
    });
  }

  async changeChargerName(
    chargerId: string,
    name: string,
    version: number,
  ): Promise<void> {
    if (this.unloading) {
      return;
    }
    const site = await this.getChargerSite(chargerId);
    if (this.unloading) {
      return;
    }
    if (!site?.id) {
      throw new Error(`No site data available for charger ${chargerId}`);
    }
    const circuit = getUniqueChargerCircuit(site, chargerId);
    if (!circuit?.id || !Array.isArray(circuit.chargers)) {
      throw new Error("Could not uniquely identify the charger circuit");
    }
    const ids = circuit.chargers.map((charger) => charger.id);
    if (
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    ) {
      throw new Error("Invalid charger list for circuit");
    }
    const readCharger = async (id: string): Promise<Charger> => {
      const response = await axios.get<Charger>(
        `${apiUrl}/api/chargers/${encodeURIComponent(id)}`,
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          timeout: apiRequestTimeout,
        },
      );
      if (!response.data || response.data.id !== id) {
        throw new Error(`Invalid charger details for ${id}`);
      }
      return response.data;
    };
    const chargers: Charger[] = [];
    for (const id of ids) {
      if (this.unloading) {
        return;
      }
      const charger = await readCharger(id);
      if (this.unloading) {
        return;
      }
      chargers.push(id === chargerId ? { ...charger, name } : charger);
    }
    if (this.unloading) {
      return;
    }
    await axios.put(
      `${apiUrl}/api/sites/${encodeURIComponent(String(site.id))}/circuits/${encodeURIComponent(String(circuit.id))}/chargers`,
      chargers,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        timeout: apiRequestTimeout,
      },
    );
    if (this.unloading) {
      return;
    }
    const updated = await readCharger(chargerId);
    if (this.unloading) {
      return;
    }
    if (updated.name !== name) {
      throw new Error("Easee did not confirm the requested charger name");
    }
    if (
      !this.unloading &&
      this.chargerNameVersions.get(chargerId) === version
    ) {
      await this.setStateAsync(`${chargerId}.name`, updated.name, true);
      this.log.info(`Charger name updated for ${chargerId}`);
    }
  }

  // Lese den Charger aus
  async getChargerState(charger_id: string): Promise<ChargerObservationResult> {
    const response = await this.requestWithBackoff(
      `charger observations ${charger_id}`,
      () =>
        axios.get(
          `${apiUrl}/state/${encodeURIComponent(charger_id)}/observations`,
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            params: { ids: CHARGER_STATE_OBSERVATION_IDS.join(",") },
            timeout: apiRequestTimeout,
          },
        ),
    );
    this.log.debug(`Charger observations read for id: ${charger_id}`);
    const result = observationsToChargerStateWithTimestamps(response.data);
    this.log.debug(`Charger observations mapped for id: ${charger_id}`);
    return result;
  }

  async getChargerConfig(charger_id: string): Promise<ChargerConfig> {
    const response = await this.requestWithBackoff(
      `charger config ${charger_id}`,
      () =>
        axios.get(
          `${apiUrl}/api/chargers/${encodeURIComponent(charger_id)}/config`,
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            timeout: apiRequestTimeout,
          },
        ),
    );
    this.log.debug(`Charger config retrieved for id: ${charger_id}`);
    return response.data;
  }

  async getChargerSite(charger_id: string): Promise<Site | undefined> {
    const response = await this.requestWithBackoff(
      `charger site ${charger_id}`,
      () =>
        axios.get(
          `${apiUrl}/api/chargers/${encodeURIComponent(charger_id)}/site`,
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            timeout: apiRequestTimeout,
          },
        ),
    );
    const site = sanitizeSite(response.data);
    if (site) {
      this.log.debug(`Charger site retrieved for id: ${charger_id}`);
    } else {
      this.log.debug(`No site object returned for charger ${charger_id}`);
    }
    return site;
  }

  async getChargerSession(
    charger_id: string,
    signal?: AbortSignal,
  ): Promise<ChargerSession[]> {
    const response = await this.requestWithBackoff(
      `charger session ${charger_id}`,
      () =>
        axios.get(
          `${apiUrl}/api/sessions/charger/${encodeURIComponent(charger_id)}/monthly`,
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            timeout: apiRequestTimeout,
            signal,
          },
        ),
    );
    this.log.debug(`Charger session retrieved for id: ${charger_id}`);
    return response.data;
  }

  async writeSessionAuthTokenIfCurrent(
    chargerId: string,
    authToken: string,
    generation: number,
    field: "authToken" | "authTokenName" = "authToken",
  ): Promise<void> {
    const stateId = `${chargerId}.status.${field}`;
    const previous = this.observedStateWrites.get(stateId);
    const write = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (
          this.unloading ||
          this.chargerSessionGenerations.get(chargerId) !== generation
        ) {
          return;
        }
        await this.setStateAsync(stateId, authToken, true);
      });
    this.observedStateWrites.set(stateId, write);
    try {
      await write;
    } finally {
      if (this.observedStateWrites.get(stateId) === write) {
        this.observedStateWrites.delete(stateId);
      }
    }
  }

  queueCompletedSessionAuthTokenLookup(lookup: {
    chargerId: string;
    sessionStartAt?: number;
    generation: number;
  }): void {
    const previous = this.pendingSessionAuthTokenLookups.get(lookup.chargerId);
    const runLookup = async (): Promise<void> => {
      if (
        this.unloading ||
        this.chargerSessionGenerations.get(lookup.chargerId) !==
          lookup.generation ||
        this.chargerSessionAuthTokenResolved.has(lookup.chargerId)
      ) {
        return;
      }
      await this.updateCurrentSessionAuthToken(
        lookup.chargerId,
        lookup.sessionStartAt,
        lookup.generation,
      );
    };
    const request = previous
      ? previous.catch(() => undefined).then(runLookup)
      : runLookup();
    this.pendingSessionAuthTokenLookups.set(lookup.chargerId, request);
  }

  async updateCurrentSessionAuthToken(
    chargerId: string,
    sessionStartAt: number | undefined,
    generation: number,
  ): Promise<void> {
    try {
      if (this.unloading) {
        return;
      }

      const to = new Date();
      const from = new Date(
        sessionStartAt !== undefined
          ? sessionStartAt - 5 * 60 * 1000
          : to.getTime() - 24 * 60 * 60 * 1000,
      );
      const response = await this.requestWithBackoff(
        `charger session auth ${chargerId}`,
        () =>
          axios.get<ChargingSessionDetails[]>(
            `${apiUrl}/api/sessions/charger/${encodeURIComponent(chargerId)}/sessions/${encodeURIComponent(from.toISOString())}/${encodeURIComponent(to.toISOString())}`,
            {
              headers: { Authorization: `Bearer ${this.accessToken}` },
              timeout: apiRequestTimeout,
            },
          ),
      );
      if (
        this.unloading ||
        this.chargerSessionGenerations.get(chargerId) !== generation ||
        !Array.isArray(response.data)
      ) {
        return;
      }

      const completedSession = response.data
        .filter(
          (session) =>
            session?.isComplete === true &&
            typeof session.authToken === "string" &&
            session.authToken.trim().length > 0,
        )
        .filter((session) => {
          if (sessionStartAt === undefined) {
            return true;
          }
          const carConnectedAt = Date.parse(session.carConnected ?? "");
          return (
            Number.isFinite(carConnectedAt) &&
            carConnectedAt >= sessionStartAt - 5 * 60 * 1000
          );
        })
        .sort(
          (first, second) =>
            Date.parse(second.carConnected ?? "") -
            Date.parse(first.carConnected ?? ""),
        )[0];
      if (!completedSession?.authToken) {
        this.log.debug(
          `No completed charging session authorization token returned for ${chargerId}`,
        );
        return;
      }

      if (this.chargerSessionGenerations.get(chargerId) !== generation) {
        return;
      }
      await this.writeSessionAuthTokenIfCurrent(
        chargerId,
        completedSession.authToken,
        generation,
      );
      if (this.chargerSessionGenerations.get(chargerId) !== generation) {
        return;
      }
      this.chargerSessionAuthTokenResolved.add(chargerId);
      this.log.debug(
        `Received an authorization token for the completed charging session of ${chargerId}`,
      );

      let name = "unknown";
      try {
        const keys = await this.requestWithBackoff("account easee keys", () =>
          axios.get<{ id?: string | null; owner?: string | null }[]>(
            `${apiUrl}/api/accounts/easeekeys`,
            {
              headers: { Authorization: `Bearer ${this.accessToken}` },
              timeout: apiRequestTimeout,
            },
          ),
        );
        if (Array.isArray(keys.data)) {
          const match = keys.data.find(
            (key) =>
              typeof key?.id === "string" &&
              key.id.trim().toUpperCase() ===
                completedSession.authToken!.trim().toUpperCase(),
          );
          if (typeof match?.owner === "string" && match.owner.trim()) {
            name = match.owner.trim();
          }
        }
      } catch {
        this.log.debug("Could not resolve authorization token name");
      }
      await this.writeSessionAuthTokenIfCurrent(
        chargerId,
        name,
        generation,
        "authTokenName",
      );
    } catch (error) {
      if (!this.unloading && !isRetryableError(error)) {
        this.log.warn(
          `Could not read the charging authorization token for ${chargerId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  async changeChargingPrice(
    charger_id: string,
    site: Site,
    netPrice: number,
    vat: number,
  ): Promise<void> {
    if (this.unloading) {
      return;
    }
    if (!site || site.id === undefined) {
      throw new Error(`No site data available for charger ${charger_id}`);
    }

    const currencyId =
      typeof site.currencyId === "string" ? site.currencyId : "";
    if (!currencyId) {
      throw new Error(`No currency available for site ${site.id}`);
    }

    if (
      !Number.isFinite(netPrice) ||
      netPrice < 0 ||
      !Number.isFinite(vat) ||
      vat < 0 ||
      vat >= 100
    ) {
      throw new Error("Invalid net charging price or VAT");
    }
    const grossPrice = netPrice * (1 + vat / 100);
    await this.requestWithBackoff(
      `charging price ${charger_id}`,
      () =>
        axios.post(
          `${apiUrl}/api/sites/${encodeURIComponent(String(site.id))}/price`,
          {
            currencyId,
            costPerKWh: grossPrice,
            vat,
            costPerKwhExcludeVat: netPrice,
          },
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            timeout: apiRequestTimeout,
          },
        ),
      false,
    );
    await this.setStateAsync(`${charger_id}.config.costPerKwhExcludeVat`, {
      val: netPrice,
      ack: true,
    });
    await this.setStateAsync(`${charger_id}.config.vat`, {
      val: vat,
      ack: true,
    });
    await this.setStateAsync(`${charger_id}.config.costPerKWh`, {
      val: grossPrice,
      ack: true,
    });
    this.log.info("Charging price update successful");
  }

  private async runCloudChargerCommand(
    id: string,
    command: CloudChargerCommand,
  ): Promise<void> {
    const details = cloudChargerCommands[command];
    try {
      await axios.post(
        `${apiUrl}/api/chargers/${encodeURIComponent(id)}/commands/${details.endpoint}`,
        {},
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          timeout: apiRequestTimeout,
        },
      );
      this.log.info(`${details.label} successful`);
    } catch (error) {
      this.log.error(`${details.label} error`);
      this.log.error(errorMessage(error));
      throw error;
    }
  }

  async startCharging(id: string): Promise<void> {
    return this.runCloudChargerCommand(id, "startCharging");
  }

  async stopCharging(id: string): Promise<void> {
    return this.runCloudChargerCommand(id, "stopCharging");
  }

  async pauseCharging(id: string): Promise<void> {
    return this.runCloudChargerCommand(id, "pauseCharging");
  }

  async resumeCharging(id: string): Promise<void> {
    return this.runCloudChargerCommand(id, "resumeCharging");
  }

  async rebootCharging(id: string): Promise<void> {
    return this.runCloudChargerCommand(id, "rebootCharging");
  }

  async changeConfig(
    id: string,
    configvalue: string,
    value: ioBroker.StateValue,
  ): Promise<void> {
    this.log.debug(`Updating Cloud setting ${configvalue} for charger ${id}`);
    return await axios
      .post(
        `${apiUrl}/api/chargers/${encodeURIComponent(id)}/settings`,
        {
          [configvalue]: value,
        },
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          timeout: apiRequestTimeout,
        },
      )
      .then(() => {
        this.log.debug(
          `Config update successful for charger ${id} (${configvalue})`,
        );
      })
      .catch((error) => {
        this.log.error("Config update error");
        this.log.error(errorMessage(error));
      });
  }

  async changeMaxCircuitConfig(
    site_id: string,
    circuit_id: string,
    phase: Phase,
    value: number,
  ): Promise<void> {
    const setting = `maxCircuitCurrent${phase.toUpperCase()}`;
    await this.requestWithBackoff(
      `circuit max current ${site_id}:${circuit_id}:${phase}`,
      () =>
        axios.post(
          `${apiUrl}/api/sites/${encodeURIComponent(site_id)}/circuits/${encodeURIComponent(circuit_id)}/settings`,
          { [setting]: value },
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            timeout: apiRequestTimeout,
          },
        ),
      false,
    );
    this.log.info(`Circuit max current update successful for ${phase}`);
  }

  async changeCircuitConfig(
    site_id: string,
    circuit_id: string,
    currentValues: ChargerValueSet,
  ): Promise<void> {
    await this.requestWithBackoff(
      `dynamic circuit current ${site_id}:${circuit_id}`,
      () =>
        axios.post(
          `${apiUrl}/api/sites/${encodeURIComponent(site_id)}/circuits/${encodeURIComponent(circuit_id)}/settings`,
          {
            dynamicCircuitCurrentP1: currentValues.p1,
            dynamicCircuitCurrentP2: currentValues.p2,
            dynamicCircuitCurrentP3: currentValues.p3,
          },
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            timeout: apiRequestTimeout,
          },
        ),
      false,
    );
    this.log.info("Circuit current update successful");
  }

  /***********************************************************************
   * Funktionen zum erstellen der Objekte der Reading
   ***********************************************************************/

  async reconcileModeSpecificObjects(
    chargerIds?: readonly string[],
  ): Promise<void> {
    const namespacePrefix = `${this.namespace}.`;
    const params = {
      startkey: namespacePrefix,
      endkey: `${namespacePrefix}\u9999`,
    };
    const [stateView, deviceView] = await Promise.all([
      this.getObjectViewAsync("system", "state", params),
      chargerIds
        ? Promise.resolve(null)
        : this.getObjectViewAsync("system", "device", params),
    ]);
    const managedChargerIds = new Set(
      chargerIds ??
        (deviceView?.rows ?? []).flatMap((row) => {
          const localId = row.id.startsWith(namespacePrefix)
            ? row.id.slice(namespacePrefix.length)
            : "";
          return row.value?.type === "device" &&
            row.value.common?.name === "Easee charger" &&
            safeObjectIdSegment.test(localId)
            ? [localId]
            : [];
        }),
    );
    const unsupportedChargerStates =
      this.connectionMode === "bluetooth"
        ? cloudOnlyChargerStateSuffixes
        : bluetoothOnlyChargerStateSuffixes;
    const unsupportedInstanceStates =
      this.connectionMode === "bluetooth"
        ? cloudOnlyInstanceStateIds
        : bluetoothOnlyInstanceStateIds;
    const removed: string[] = [];

    for (const row of stateView.rows) {
      if (row.value?.type !== "state" || !row.id.startsWith(namespacePrefix)) {
        continue;
      }
      const localId = row.id.slice(namespacePrefix.length);
      let unsupported = unsupportedInstanceStates.has(localId);
      const separator = localId.indexOf(".");
      if (!unsupported && separator > 0) {
        const chargerId = localId.slice(0, separator);
        if (managedChargerIds.has(chargerId)) {
          const suffix = localId.slice(separator + 1);
          unsupported = unsupportedChargerStates.has(suffix);
          if (
            !unsupported &&
            this.connectionMode === "bluetooth" &&
            bluetoothUnsupportedSessionStateSuffix.test(suffix)
          ) {
            unsupported = true;
          }
        }
      }
      if (unsupported) {
        await this.delObjectAsync(localId);
        removed.push(localId);
      }
    }

    if (removed.length > 0) {
      this.log.debug(
        `Removed ${removed.length} datapoint(s) unsupported in ${this.connectionMode} mode`,
      );
    }
  }

  async ensureChargerObjectStructure(
    charger: Pick<Charger, "id">,
  ): Promise<void> {
    await this.setObjectNotExistsAsync(charger.id, {
      type: "device",
      common: { name: "Easee charger" },
      native: {},
    });
    for (const [id, name] of [
      ["control", "Controls"],
      ["status", "Status"],
      ["config", "Configuration"],
      ["info", "Information"],
      ["session", "Charging sessions"],
    ]) {
      await this.setObjectNotExistsAsync(`${charger.id}.${id}`, {
        type: "channel",
        common: { name },
        native: {},
      });
    }
  }

  private async ensureRegisteredChargerStates(
    charger: Charger,
    category: "control" | "status" | "config",
  ): Promise<void> {
    for (const definition of chargerStateDefinitions) {
      if (
        definition.category !== category ||
        !supportsConnectionMode(definition.modes, this.connectionMode)
      ) {
        continue;
      }
      const stateId = `${charger.id}.${definition.suffix}`;
      const write = definition.writeModes
        ? supportsConnectionMode(definition.writeModes, this.connectionMode)
        : definition.write;
      const common = {
        name: definition.name,
        type: definition.type,
        role: definition.role,
        read: definition.read,
        write,
        ...(definition.unit !== undefined ? { unit: definition.unit } : {}),
        ...(definition.min !== undefined ? { min: definition.min } : {}),
        ...(definition.max !== undefined ? { max: definition.max } : {}),
      };
      await this.setObjectNotExistsAsync(stateId, {
        type: "state",
        common,
        native: {},
      });
      if (definition.updateExisting) {
        await this.extendObjectAsync(stateId, {
          common: {
            ...definition.updateExisting,
            ...(definition.writeModes ? { write } : {}),
          },
        });
      }
      if (definition.subscribe) {
        this.subscribeStates(stateId);
      }
    }
  }

  async setAllStatusObjects(charger: Charger): Promise<void> {
    await this.ensureChargerObjectStructure(charger);
    await this.ensureRegisteredChargerStates(charger, "control");

    //id
    await this.setObjectNotExistsAsync(`${charger.id}.id`, {
      type: "state",
      common: {
        name: "id",
        type: "string",
        role: "info.name",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.setStateAsync(`${charger.id}.id`, charger.id, true);

    //name
    await this.setObjectNotExistsAsync(`${charger.id}.name`, {
      type: "state",
      common: {
        name: "name",
        type: "string",
        role: "text",
        read: true,
        write: true,
      },
      native: {},
    });
    await this.extendObjectAsync(`${charger.id}.name`, {
      common: { role: "text", write: this.connectionMode !== "bluetooth" },
    });
    this.subscribeStates(`${charger.id}.name`);

    await this.ensureRegisteredChargerStates(charger, "status");
    if (this.connectionMode !== "bluetooth") {
      for (const suffix of ["status.authToken", "status.authTokenName"]) {
        const stateId = `${charger.id}.${suffix}`;
        const state = await this.getStateAsync(stateId);
        if (!state || state.val === null || state.val === undefined) {
          await this.setStateAsync(stateId, "", true);
        }
      }
    }
  }

  /*************** Session Reading ****************/
  async setNewSessionToCharger(
    charger: Pick<Charger, "id">,
    charger_session: unknown,
  ): Promise<void> {
    if (!Array.isArray(charger_session)) {
      this.log.warn(`Ignoring invalid session list for charger ${charger.id}`);
      return;
    }

    const sessionsByMonth = new Map<string, ChargerSession>();
    for (const candidate of charger_session) {
      if (
        !isRecord(candidate) ||
        !Number.isInteger(candidate.year) ||
        (candidate.year as number) < 0 ||
        (candidate.year as number) > 9999 ||
        !Number.isInteger(candidate.month) ||
        (candidate.month as number) < 1 ||
        (candidate.month as number) > 12 ||
        typeof candidate.totalEnergyUsage !== "number" ||
        !Number.isFinite(candidate.totalEnergyUsage) ||
        typeof candidate.totalCost !== "number" ||
        !Number.isFinite(candidate.totalCost)
      ) {
        this.log.warn(
          `Ignoring a session with invalid date or totals for charger ${charger.id}`,
        );
        continue;
      }
      const session: ChargerSession = {
        year: candidate.year as number,
        month: candidate.month as number,
        totalEnergyUsage: candidate.totalEnergyUsage,
        totalCost: candidate.totalCost,
      };
      sessionsByMonth.set(`${session.year}-${session.month}`, session);
    }

    const validSessions = [...sessionsByMonth.values()].sort(
      (first, second) => first.year - second.year || first.month - second.month,
    );
    if (validSessions.length === 0) {
      return;
    }
    await this.ensureChargerObjectStructure(charger);

    for (const session of validSessions) {
      const yearFolder = `${charger.id}.session.${session.year}`;
      const monthFolder = `${yearFolder}.${session.month}`;
      await this.setObjectNotExistsAsync(yearFolder, {
        type: "folder",
        common: { name: String(session.year) },
        native: {},
      });
      await this.setObjectNotExistsAsync(monthFolder, {
        type: "folder",
        common: { name: String(session.month) },
        native: {},
      });

      await this.setObjectNotExistsAsync(`${monthFolder}.totalEnergyUsage`, {
        type: "state",
        common: {
          name: "Total energy usage",
          type: "number",
          role: "value.energy.consumed",
          read: true,
          write: false,
          unit: "kWh",
        },
        native: {},
      });
      await this.setStateAsync(
        `${monthFolder}.totalEnergyUsage`,
        session.totalEnergyUsage,
        true,
      );
      await this.setObjectNotExistsAsync(`${monthFolder}.totalCost`, {
        type: "state",
        common: {
          name: "Total cost",
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
        native: {},
      });
      await this.setStateAsync(
        `${monthFolder}.totalCost`,
        session.totalCost,
        true,
      );
      await this.setObjectNotExistsAsync(`${yearFolder}.total_year`, {
        type: "state",
        common: {
          name: "Total yearly energy usage",
          type: "number",
          role: "value.energy.consumed",
          read: true,
          write: false,
          unit: "kWh",
        },
        native: {},
      });
    }

    let currentYear = -1;
    let yearlyEnergy = 0;
    for (const session of validSessions) {
      if (currentYear !== session.year) {
        currentYear = session.year;
        yearlyEnergy = 0;
      }
      yearlyEnergy += session.totalEnergyUsage;
      await this.setStateAsync(
        `${charger.id}.session.${session.year}.total_year`,
        yearlyEnergy,
        true,
      );
    }
  }

  /*************** Config Reading ****************/
  async setAllConfigObjects(charger: Charger): Promise<void> {
    await this.ensureRegisteredChargerStates(charger, "config");
  }
}

const createAdapter = Object.assign(
  (options: AdapterOptions = { name: "easee" }) => new Easee(options),
  { Easee, EaseeBluetoothDeviceManagement },
);

if (require.main === module) {
  new Easee();
}

export = createAdapter;
