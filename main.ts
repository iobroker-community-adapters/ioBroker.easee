"use strict";

import { Adapter } from "@iobroker/adapter-core";
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
import type {
  BluetoothClientOptions,
  BluetoothDeviceConfig,
  BluetoothStatusEvent,
} from "./lib/bluetooth-client.ts";
import type { BluetoothCommand } from "./lib/bluetooth-protocol.ts";
import { createNobleBluetoothScanner } from "./lib/noble-bluetooth-transport.ts";
import { mapBluetoothPoll } from "./lib/bluetooth-mapping.ts";
import {
  getConnectionMode,
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

interface Charger {
  id: string;
  name: string;
}

interface Site {
  id: string;
  currencyId?: string;
  costPerKWh?: number;
  costPerKwhExcludeVat?: number;
  vat?: number;
  circuits?: Array<{ id: string; chargers?: Charger[] | null }>;
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
const sessionRequestInterval = 7 * 60 * 1000;
const defaultSessionPollInterval = 60;
const maxTimeoutMilliseconds = 2_147_483_647;
axios.defaults.timeout = apiRequestTimeout;
const safeObjectIdSegment = /^[A-Za-z0-9_-]+$/;
const adapterIntervals: Record<string, Timer | undefined> = {}; //halten von allen Intervallen
let accessToken = "";
let refreshToken = "";
let expireTime = Date.now();
let polltime = 30;
let logtype = false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRetryableError(error: unknown): error is RetryableError {
  return (
    error instanceof Error && (error as RetryableError).retryDeferred === true
  );
}

class Easee extends Adapter {
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
  bluetoothChargers: BluetoothChargerConfig[] = [];
  bluetoothConnections = new Map<string, boolean>();
  bluetoothConnectionErrors = new Map<string, string>();
  bluetoothConnectionGenerations = new Map<string, number>();
  bluetoothPauseRestore = new Map<string, BluetoothPauseRestore>();
  bluetoothCircuitWrites = new Map<string, PendingBluetoothCircuitWrite>();
  bluetoothCircuitWriteSequence = 0;
  bluetoothDisconnectWaiters = new Map<
    string,
    Set<(disconnected: boolean) => void>
  >();
  bluetoothReconnectTimer: Timer | null = null;
  bluetoothPollTimer: Timer | null = null;
  bluetoothPollInFlight = false;
  bluetoothReconnectInFlight = false;
  bluetoothReconnectDelay = 10000;
  bluetoothStartupComplete = false;

  constructor(options: AdapterOptions = { name: "easee" }) {
    super({
      ...options,
      name: "easee",
    } as never);
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
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
        accessTokenFactory: () => accessToken,
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
          `SignalR connection closed: ${errorMessage(error || "unknown reason")}`,
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
        `SignalR start failed; REST polling remains active: ${errorMessage(error)}`,
      );
      this.scheduleSignalRReconnect();
    }
  }

  handleSignalRProductUpdate(data: SignalRProductUpdate): void {
    const stateName = objEnum.getNameByEnum(data.id);
    if (!stateName) {
      this.log.debug(`New SignalR-ID, possible new Value: ${data.id}`);
      this.log.debug(JSON.stringify(data));
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
            `SignalR observation ${data.id} for ${data.mid} had invalid boolean value ${JSON.stringify(data.value)}`,
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
            `SignalR observation ${data.id} for ${data.mid} had invalid number ${JSON.stringify(data.value)}`,
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
            `SignalR observation ${data.id} for ${data.mid} had invalid integer ${JSON.stringify(data.value)}`,
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
      `SignalR observation ${data.id} for ${stateId}: raw=${JSON.stringify(data.value)}, converted=${JSON.stringify(value)}, timestamp=${data.timestamp ?? "missing"}`,
    );
    this.writeObservedState(
      stateId,
      value,
      Number.isFinite(timestamp) ? timestamp : undefined,
      "SignalR",
    ).catch((error) =>
      this.log.warn(`SignalR state update failed: ${errorMessage(error)}`),
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
          `SignalR subscription failed for charger ${chargerId}: ${errorMessage(error)}`,
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
    this.clearTimeout(adapterIntervals.signalRReconnect);
    adapterIntervals.signalRReconnect = this.setTimeout(() => {
      this.startSignal().catch((error) =>
        this.log.warn(`SignalR reconnect failed: ${errorMessage(error)}`),
      );
    }, 30000);
  }

  /**
   * Starten den Adapter
   */
  async onReady(): Promise<void> {
    //initial Status melden
    await this.setStateAsync("info.connection", false, true);

    this.connectionMode = getConnectionMode(this.config.connectionMode);
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

    const configuredPollInterval = Number(this.config.polltime);
    polltime = 30;
    if (
      !Number.isFinite(configuredPollInterval) ||
      configuredPollInterval < 10 ||
      configuredPollInterval > 86_400
    ) {
      this.log.warn(
        "Poll interval must be between 10 and 86400 seconds; using 30",
      );
    } else {
      polltime = configuredPollInterval;
    }
    logtype = this.config.logtype;
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
        //Erstes Objekt erstellen
        await this.setObjectNotExistsAsync("lastUpdate", {
          type: "state",
          common: {
            name: "lastUpdate",
            type: "string",
            role: "indicator",
            read: true,
            write: false,
          },
          native: {},
        });

        //reset all to start
        this.chargerIds = [];

        if (this.config.signalR) {
          this.log.info("Starting SignalR");
          this.startSignal().catch((error) =>
            this.log.warn(`SignalR start failed: ${errorMessage(error)}`),
          );
        }
        // Start polling without delaying SignalR on a slow API response.
        await this.readAllStates();
      }
    }
  }

  async startBluetooth(): Promise<void> {
    try {
      this.bluetoothChargers = parseBluetoothChargerSettings(this.config);
    } catch (error) {
      this.log.error(
        `Invalid Bluetooth charger configuration: ${errorMessage(error)}`,
      );
      return;
    }

    const devices: BluetoothDeviceConfig[] = [];
    for (const config of this.bluetoothChargers) {
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

    try {
      const scanner = await createNobleBluetoothScanner();
      const options: BluetoothClientOptions = {
        onStatus: (event) => this.handleBluetoothStatus(event),
      };
      this.bluetoothClient = new BluetoothClient(devices, scanner, options);
      const configuredInterval = Number(this.config.polltime);
      if (Number.isFinite(configuredInterval) && configuredInterval > 0) {
        polltime = configuredInterval;
      }
      try {
        await this.bluetoothClient.start();
      } catch (error) {
        this.log.error(
          `Could not start Bluetooth client: ${errorMessage(error)}`,
        );
      } finally {
        this.bluetoothStartupComplete = true;
      }
      this.scheduleBluetoothPoll(0);
      this.scheduleBluetoothReconnect();
    } catch (error) {
      this.log.error(
        `Could not initialize Bluetooth transport: ${errorMessage(error)}`,
      );
      for (const charger of this.bluetoothChargers) {
        this.bluetoothConnectionErrors.set(
          charger.serialNumber,
          errorMessage(error),
        );
        await this.setStateAsync(
          `${charger.serialNumber}.info.bluetoothError`,
          errorMessage(error),
          true,
        );
      }
    }
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

  handleBluetoothStatus(event: BluetoothStatusEvent): void {
    const connected = event.status === "connected";
    this.bluetoothConnections.set(event.serial, connected);
    if (event.error) {
      this.bluetoothConnectionErrors.set(event.serial, event.error.message);
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
  }

  scheduleBluetoothReconnect(): void {
    if (
      this.unloading ||
      !this.bluetoothStartupComplete ||
      !this.bluetoothClient ||
      this.bluetoothReconnectTimer ||
      this.bluetoothReconnectInFlight ||
      [...this.bluetoothConnections.values()].every(Boolean)
    ) {
      return;
    }

    const delay = this.bluetoothReconnectDelay;
    this.bluetoothReconnectDelay = Math.min(delay * 2, 300000);
    this.bluetoothReconnectTimer = this.setTimeout(() => {
      this.bluetoothReconnectTimer = null;
      const client = this.bluetoothClient;
      if (!client || this.unloading) {
        return;
      }
      this.bluetoothReconnectInFlight = true;
      client
        .reconnect()
        .catch((error) => {
          this.log.warn(
            `Bluetooth reconnection failed: ${errorMessage(error)}`,
          );
        })
        .finally(() => {
          this.bluetoothReconnectInFlight = false;
          if (
            [...this.bluetoothConnections.values()].every(Boolean) &&
            this.bluetoothConnections.size > 0
          ) {
            this.bluetoothReconnectDelay = 10000;
          } else {
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
    if (this.unloading || !this.bluetoothClient || this.bluetoothPollInFlight) {
      return;
    }
    this.bluetoothPollInFlight = true;
    const client = this.bluetoothClient;
    try {
      for (const charger of this.bluetoothChargers) {
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
      if (!this.unloading) {
        this.scheduleBluetoothPoll(polltime * 1000);
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
        if (value !== 1 && value !== 2 && value !== 3) {
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
    try {
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
    this.clearTimeout(adapterIntervals.readAllStates);
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
    this.clearTimeout(adapterIntervals.signalRReconnect);
    for (const retry of this.pendingSiteConfigRetries.values()) {
      this.clearTimeout(retry.timer);
    }
    this.pendingSiteConfigRetries.clear();
    const signalRShutdown = Promise.resolve(
      this.signalRConnection?.stop(),
    ).catch((error) =>
      this.log.warn(`Error stopping SignalR: ${errorMessage(error)}`),
    );
    const pendingSessionShutdown = Promise.resolve(sessionShutdown).catch(
      (error) =>
        this.log.warn(`Error stopping session polling: ${errorMessage(error)}`),
    );
    const bluetoothShutdown = Promise.resolve(
      this.bluetoothClient?.stop(),
    ).catch((error) =>
      this.log.warn(`Error stopping Bluetooth client: ${errorMessage(error)}`),
    );
    Promise.all([signalRShutdown, pendingSessionShutdown, bluetoothShutdown])
      .then(() => this.setStateAsync("info.connection", false, true))
      .catch((error) =>
        this.log.error(`Error during unload: ${errorMessage(error)}`),
      )
      .finally(() => {
        this.signalRConnection = null;
        this.bluetoothClient = null;
        this.bluetoothStartupComplete = false;
        this.log.info("Adapter easee cleaned up everything...");
        callback();
      });
  }

  async requestWithBackoff<T>(
    key: string,
    requestFn: () => Promise<T>,
  ): Promise<T> {
    let retryState = this.apiRetryState.get(key);
    if (!retryState) {
      retryState = { delay: 30000, retryAt: 0, inFlight: null };
      this.apiRetryState.set(key, retryState);
    }
    if (retryState.inFlight) {
      return (await retryState.inFlight) as T;
    }
    if (retryState.retryAt > Date.now()) {
      const error: RetryableError = new Error(`Retry deferred for ${key}`);
      error.retryDeferred = true;
      throw error;
    }

    retryState.inFlight = (async () => {
      try {
        const response = await requestFn();
        this.apiRetryState.delete(key);
        return response;
      } catch (error) {
        if (this.unloading) {
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
    update: (site: Site) => Promise<void>,
    sequence: number | undefined,
    requireCircuit = true,
  ): Promise<void> {
    if (this.unloading) {
      return;
    }

    try {
      const site = await this.getChargerSite(chargerId);
      if (!site || (requireCircuit && !site.circuits?.[0])) {
        this.log.warn(`Unable to update ${description}: site data missing`);
        return;
      }
      if (requireCircuit) {
        const circuitKey = `${site.id}:${site.circuits![0].id}`;
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
      await update(site);
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
        (siteRetry?.retryAt || Date.now()) - Date.now(),
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
        if (!site?.circuits?.[0]) {
          this.log.warn(
            "Unable to update Dynamic circuit current: site data missing",
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

        const circuitId = site.circuits[0].id;
        const circuitKey = `${site.id}:${circuitId}`;
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
                  site.id,
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
          (siteRetry?.retryAt || Date.now()) - Date.now(),
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

    if (expireTime <= Date.now()) {
      //Token ist expired!
      if (logtype) {
        this.log.info("Token has expired - refresh");
      }
      await this.refreshToken();
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
          this.log.warn("Ignoring charger with an invalid Cloud id");
          continue;
        }
        const normalizedId = item.id.toLowerCase();
        const knownId = knownChargerIds.get(normalizedId);
        if (knownId && knownId !== item.id) {
          this.log.warn(
            `Ignoring charger id with conflicting casing: ${item.id}`,
          );
          continue;
        }
        if (seenChargerIds.has(normalizedId)) {
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
      for (const charger of chargers) {
        if (this.unloading) {
          return;
        }
        //Prüfen ob wir das Object kennen
        if (!this.chargerIds.includes(charger.id)) {
          //setzen als erstes alle Objekte
          await this.setAllStatusObjects(charger);
          await this.setAllConfigObjects(charger);

          //merken uns den charger
          this.chargerIds.push(charger.id);
        }
        await this.subscribeChargerToSignalR(charger.id);
        if (this.unloading) {
          return;
        }

        this.log.debug("Charger found");
        this.log.debug(JSON.stringify(charger));
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
          if (isRetryableError(error)) {
            continue;
          }
          this.log.error(errorMessage(error));
        }
      }
    } else if (tmpAllChargers !== undefined) {
      this.log.warn("Ignoring invalid charger list returned by Easee Cloud");
    } else {
      this.log.warn("No charger list was returned; the adapter will retry");
    }

    if (this.unloading) {
      return;
    }

    //Melden das Update
    await this.setStateAsync(
      "lastUpdate",
      new Date().toLocaleTimeString(),
      true,
    );
    if (!this.unloading) {
      adapterIntervals.readAllStates = this.setTimeout(
        this.readAllStates.bind(this),
        polltime * 1000,
      );
    }
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
      this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
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
            //Load site for Charger
            this.updateSiteConfigWithRetry(
              tmpControl[2],
              id,
              "Circuit current update",
              async (site) => {
                this.log.debug(`Update circuitMaxCurrent to: ${state.val}`);
                this.log.debug("Get infos from site:");
                this.log.debug(JSON.stringify(site));

                await this.changeMaxCircuitConfig(
                  site.id,
                  site.circuits![0].id,
                  state.val,
                );
                this.log.debug("Changes sent to API");
              },
              ++this.circuitMaxCurrentSequence,
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
            currentState.pendingValues[phase] = Number(state.val);
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
            const value = Number(state.val);
            if (
              !Number.isFinite(value) ||
              value < 0 ||
              (tmpControl[4] == "vat" && value >= 100)
            ) {
              this.log.error(`Invalid charging price value: ${state.val}`);
              return;
            }
            this.updateSiteConfigWithRetry(
              tmpControl[2],
              id,
              "Charging price update",
              async (site) => {
                const netPrice =
                  tmpControl[4] == "costPerKwhExcludeVat"
                    ? value
                    : Number(site.costPerKwhExcludeVat);
                const vat = tmpControl[4] == "vat" ? value : Number(site.vat);
                await this.changeChargingPrice(
                  tmpControl[2],
                  site,
                  netPrice,
                  vat,
                );
              },
              undefined,
              false,
            ).catch((error) =>
              this.log.error(
                `Charging price update failed: ${errorMessage(error)}`,
              ),
            );
          } else {
            this.log.debug(`update config to API: ${id}`);
            if (tmpControl[4] == "isEnabled") {
              void this.changeConfig(tmpControl[2], "enabled", state.val);
            } else {
              void this.changeConfig(tmpControl[2], tmpControl[4], state.val);
            }
            this.log.debug("Changes sent to API");
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
      `${source} observation for ${stateId} accepted: ${JSON.stringify(value)} (timestamp=${version.timestamp ?? "missing"})`,
    );
    const previousWrite = this.observedStateWrites.get(stateId);
    const write = (previousWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await this.setStateAsync(stateId, value, true);
        this.log.debug(
          `${source} observation value written to ${stateId}: ${JSON.stringify(value)}`,
        );
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
    await this.setStateAsync(`${charger.id}.config.isEnabled`, {
      val: charger_config.isEnabled,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.phaseMode`, {
      val: charger_config.phaseMode,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.ledStripBrightness`, {
      val: charger_config.ledStripBrightness,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.smartButtonEnabled`, {
      val: charger_config.smartButtonEnabled,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.wiFiSSID`, {
      val: charger_config.wiFiSSID,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.maxChargerCurrent`, {
      val: charger_config.maxChargerCurrent,
      ack: true,
    });

    if (charger_site) {
      if (typeof charger_site.costPerKWh === "number") {
        await this.setStateAsync(`${charger.id}.config.costPerKWh`, {
          val: charger_site.costPerKWh,
          ack: true,
        });
      }
      if (typeof charger_site.costPerKwhExcludeVat === "number") {
        await this.setStateAsync(`${charger.id}.config.costPerKwhExcludeVat`, {
          val: charger_site.costPerKwhExcludeVat,
          ack: true,
        });
      }
      if (typeof charger_site.vat === "number") {
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

    //Values for sites
    await this.setStateAsync(`${charger.id}.config.circuitMaxCurrentP1`, {
      val: charger_config.circuitMaxCurrentP1,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.circuitMaxCurrentP2`, {
      val: charger_config.circuitMaxCurrentP2,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.circuitMaxCurrentP3`, {
      val: charger_config.circuitMaxCurrentP3,
      ack: true,
    });
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

      this.log.info("Easee Api Login successful");

      accessToken = response.data.accessToken;
      refreshToken = response.data.refreshToken;
      expireTime =
        Date.now() +
        Math.max(
          Number(response.data.expiresIn) - tokenRefreshMarginSeconds,
          0,
        ) *
          1000;
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
  async refreshToken(): Promise<void> {
    return await axios
      .post(
        `${apiUrl}/api/accounts/refresh_token`,
        {
          accessToken: accessToken,
          refreshToken: refreshToken,
        },
        { timeout: apiRequestTimeout },
      )
      .then(async (response) => {
        if (logtype) {
          this.log.info("RefreshToken successful");
        }
        accessToken = response.data.accessToken;
        refreshToken = response.data.refreshToken;
        expireTime =
          Date.now() +
          Math.max(
            Number(response.data.expiresIn) - tokenRefreshMarginSeconds,
            0,
          ) *
            1000;
        await this.setStateAsync("info.connection", true, true);
        this.log.debug("Easee access token refreshed");
      })
      .catch(async (error) => {
        this.log.error("RefreshToken error");
        this.log.error(errorMessage(error));
        await this.setStateAsync("info.connection", false, true);
      });
  }

  //Lese alle Charger aus
  async getAllCharger(): Promise<Charger[] | undefined> {
    return await axios
      .get<Charger[]>(`${apiUrl}/api/chargers`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: apiRequestTimeout,
      })
      .then((response) => {
        this.log.debug("Chargers retrieved");
        this.log.debug(JSON.stringify(response.data));
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
    const site = await this.getChargerSite(chargerId);
    const circuits = (site.circuits ?? []).filter(
      (circuit) =>
        Array.isArray(circuit.chargers) &&
        circuit.chargers.some((charger) => charger.id === chargerId),
    );
    if (site.id == null || circuits.length !== 1 || circuits[0].id == null) {
      throw new Error("Could not uniquely identify the charger circuit");
    }
    const circuit = circuits[0];
    const ids = circuit.chargers!.map((charger) => charger.id);
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
          headers: { Authorization: `Bearer ${accessToken}` },
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
      const charger = await readCharger(id);
      chargers.push(id === chargerId ? { ...charger, name } : charger);
    }
    await axios.put(
      `${apiUrl}/api/sites/${encodeURIComponent(String(site.id))}/circuits/${encodeURIComponent(String(circuit.id))}/chargers`,
      chargers,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: apiRequestTimeout,
      },
    );
    const updated = await readCharger(chargerId);
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
            headers: { Authorization: `Bearer ${accessToken}` },
            params: { ids: CHARGER_STATE_OBSERVATION_IDS.join(",") },
            timeout: apiRequestTimeout,
          },
        ),
    );
    this.log.debug(`Charger observations read for id: ${charger_id}`);
    this.log.debug(JSON.stringify(response.data));
    const result = observationsToChargerStateWithTimestamps(response.data);
    this.log.debug(
      `Charger observations mapped for ${charger_id}: ${JSON.stringify(result.state)}`,
    );
    return result;
  }

  async getChargerConfig(charger_id: string): Promise<ChargerConfig> {
    const response = await this.requestWithBackoff(
      `charger config ${charger_id}`,
      () =>
        axios.get(
          `${apiUrl}/api/chargers/${encodeURIComponent(charger_id)}/config`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: apiRequestTimeout,
          },
        ),
    );
    this.log.debug(`Charger config retrieved for id: ${charger_id}`);
    this.log.debug(JSON.stringify(response.data));
    return response.data;
  }

  async getChargerSite(charger_id: string): Promise<Site> {
    const response = await this.requestWithBackoff(
      `charger site ${charger_id}`,
      () =>
        axios.get(
          `${apiUrl}/api/chargers/${encodeURIComponent(charger_id)}/site`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: apiRequestTimeout,
          },
        ),
    );
    this.log.debug(`Charger site retrieved for id: ${charger_id}`);
    this.log.debug(JSON.stringify(response.data));
    return response.data;
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
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: apiRequestTimeout,
            signal,
          },
        ),
    );
    this.log.debug(`Charger session retrieved for id: ${charger_id}`);
    this.log.debug(JSON.stringify(response.data));
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
              headers: { Authorization: `Bearer ${accessToken}` },
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
              headers: { Authorization: `Bearer ${accessToken}` },
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
    await axios.post(
      `${apiUrl}/api/sites/${encodeURIComponent(String(site.id))}/price`,
      {
        currencyId,
        costPerKWh: grossPrice,
        vat,
        costPerKwhExcludeVat: netPrice,
      },
      { headers: { Authorization: `Bearer ${accessToken}` } },
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

  async startCharging(id: string): Promise<void> {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${encodeURIComponent(id)}/commands/start_charging`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Start charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Start charging error");
        this.log.error(errorMessage(error));
        throw error;
      });
  }

  async stopCharging(id: string): Promise<void> {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${encodeURIComponent(id)}/commands/stop_charging`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Stop charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Stop charging error");
        this.log.error(errorMessage(error));
        throw error;
      });
  }

  async pauseCharging(id: string): Promise<void> {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${encodeURIComponent(id)}/commands/pause_charging`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Pause charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Pause charging error");
        this.log.error(errorMessage(error));
        throw error;
      });
  }

  async resumeCharging(id: string): Promise<void> {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${encodeURIComponent(id)}/commands/resume_charging`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Resume charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Resume charging error");
        this.log.error(errorMessage(error));
        throw error;
      });
  }

  async rebootCharging(id: string): Promise<void> {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${encodeURIComponent(id)}/commands/reboot`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Reboot charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Reboot charging error");
        this.log.error(errorMessage(error));
        throw error;
      });
  }

  async changeConfig(
    id: string,
    configvalue: string,
    value: ioBroker.StateValue,
  ): Promise<void> {
    this.log.debug(
      JSON.stringify({
        [configvalue]: value,
      }),
    );
    return await axios
      .post(
        `${apiUrl}/api/chargers/${encodeURIComponent(id)}/settings`,
        {
          [configvalue]: value,
        },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.debug(
          `Config update successful for charger ${id} (${configvalue})`,
        );
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Config update error");
        this.log.error(errorMessage(error));
      });
  }

  //circuitMaxCurrentPX
  async changeMaxCircuitConfig(
    site_id: string,
    circuit_id: string,
    value: ioBroker.StateValue,
  ): Promise<void> {
    return await axios
      .post(
        `${apiUrl}/api/sites/${encodeURIComponent(site_id)}/circuits/${encodeURIComponent(circuit_id)}/settings`,
        {
          maxCircuitCurrentP1: value,
          maxCircuitCurrentP2: value,
          maxCircuitCurrentP3: value,
        },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("CircuitMax update successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("CircuitMax update error");
        this.log.error(errorMessage(error));
      });
  }

  //dynamicCircuitCurrentPX
  async changeCircuitConfig(
    site_id: string,
    circuit_id: string,
    currentValues: ChargerValueSet,
  ): Promise<void> {
    //Der Wert darf nur für 3 Fach Werte aktualisiert werden
    await axios
      .post(
        `${apiUrl}/api/sites/${encodeURIComponent(site_id)}/circuits/${encodeURIComponent(circuit_id)}/settings`,
        {
          dynamicCircuitCurrentP1: currentValues.p1,
          dynamicCircuitCurrentP2: currentValues.p2,
          dynamicCircuitCurrentP3: currentValues.p3,
        },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: apiRequestTimeout,
        },
      )
      .then((response) => {
        this.log.info("Circuit update successful");
        this.log.debug(JSON.stringify(response.data));
        return response;
      })
      .catch((error) => {
        this.log.error("Circuit update error");
        this.log.error(errorMessage(error));
      });
  }

  /***********************************************************************
   * Funktionen zum erstellen der Objekte der Reading
   ***********************************************************************/

  async setAllStatusObjects(charger: Charger): Promise<void> {
    //Legen die Steuerungsbutton für jeden Charger an
    await this.setObjectNotExistsAsync(`${charger.id}.control.start`, {
      type: "state",
      common: {
        name: "Start charging",
        type: "boolean",
        role: "button.start",
        read: false,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.start`);

    await this.setObjectNotExistsAsync(`${charger.id}.control.stop`, {
      type: "state",
      common: {
        name: "Stop charging",
        type: "boolean",
        role: "button.stop",
        read: false,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.stop`);

    await this.setObjectNotExistsAsync(`${charger.id}.control.pause`, {
      type: "state",
      common: {
        name: "Pause charging",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.pause`);

    await this.setObjectNotExistsAsync(`${charger.id}.control.resume`, {
      type: "state",
      common: {
        name: "Resume charging",
        type: "boolean",
        role: "button.resume",
        read: false,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.resume`);

    await this.setObjectNotExistsAsync(`${charger.id}.control.reboot`, {
      type: "state",
      common: {
        name: "Reboot Charger",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.reboot`);

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
      common: { role: "text", write: true },
    });
    this.subscribeStates(`${charger.id}.name`);

    //"cableLocked": true,
    await this.setObjectNotExistsAsync(`${charger.id}.status.cableLocked`, {
      type: "state",
      common: {
        name: "Cable lock state",
        type: "boolean",
        role: "sensor.lock",
        read: true,
        write: false,
      },
      native: {},
    });

    //"chargerOpMode": 1,
    await this.setObjectNotExistsAsync(`${charger.id}.status.chargerOpMode`, {
      type: "state",
      common: {
        name: "Charger operation mode according to charger mode table",
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
      native: {},
    });

    const authTokenId = `${charger.id}.status.authToken`;
    const authTokenName =
      "Authorization token used for the last completed charging session";
    await this.setObjectNotExistsAsync(authTokenId, {
      type: "state",
      common: {
        name: authTokenName,
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.extendObjectAsync(authTokenId, {
      common: { name: authTokenName },
    });
    await this.setStateAsync(authTokenId, "", true);
    await this.setObjectNotExistsAsync(`${charger.id}.status.authTokenName`, {
      type: "state",
      common: {
        name: "Owner name of the charging session authorization token",
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.setStateAsync(`${charger.id}.status.authTokenName`, "", true);

    //"totalPower": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.totalPower`, {
      type: "state",
      common: {
        name: "Total power [kW]",
        type: "number",
        role: "value.power",
        read: true,
        write: false,
        unit: "kW",
      },
      native: {},
    });

    //"wiFiRSSI": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.wiFiRSSI`, {
      type: "state",
      common: {
        name: "WiFi signal strength [dBm]",
        type: "number",
        role: "value",
        read: true,
        write: false,
        unit: "dBm",
      },
      native: {},
    });

    //"chargerFirmware": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.chargerFirmware`, {
      type: "state",
      common: {
        name: "Modem firmware version",
        type: "number",
        role: "info.firmware",
        read: true,
        write: false,
      },
      native: {},
    });

    //"reasonForNoCurrent": 0,
    await this.setObjectNotExistsAsync(
      `${charger.id}.status.reasonForNoCurrent`,
      {
        type: "state",
        common: {
          name: "Reason for not offering current to the car",
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
        native: {},
      },
    );

    //"voltage": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.voltage`, {
      type: "state",
      common: {
        name: "voltage",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });

    //"outputCurrent": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.outputCurrent`, {
      type: "state",
      common: {
        name: "Active output phase(s) to EV according to output phase type table.",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inCurrentT2": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inCurrentT2`, {
      type: "state",
      common: {
        name: "Current RMS for input T2 [Amperes]",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inCurrentT3": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inCurrentT3`, {
      type: "state",
      common: {
        name: "Current RMS for input T3 [Amperes]",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inCurrentT4": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inCurrentT4`, {
      type: "state",
      common: {
        name: "Current RMS for input T4 [Amperes]",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inCurrentT5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inCurrentT5`, {
      type: "state",
      common: {
        name: "Current RMS for input T5 [Amperes]",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inVoltageT1T2": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT1T2`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T1 and T2 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT1T3": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT1T3`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T1 and T3 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT1T4": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT1T4`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T1 and T4 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT1T5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT1T5`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T1 and T5 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT2T3": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT2T3`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T2 and T3 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT2T4": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT2T4`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T2 and T4 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT2T5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT2T5`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T2 and T5 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT3T4": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT3T4`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T3 and T4 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT3T5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT3T5`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T3 and T5 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT4T5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT4T5`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T4 and T5 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });

    //"isOnline": true,
    await this.setObjectNotExistsAsync(`${charger.id}.status.isOnline`, {
      type: "state",
      common: {
        name: "isOnline",
        type: "boolean",
        role: "indicator.reachable",
        read: true,
        write: false,
      },
      native: {},
    });

    //"wiFiAPEnabled": true,
    await this.setObjectNotExistsAsync(`${charger.id}.status.wiFiAPEnabled`, {
      type: "state",
      common: {
        name: "True if WiFi Access Point is enabled, otherwise false",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
      },
      native: {},
    });

    //"ledMode": true,
    await this.setObjectNotExistsAsync(`${charger.id}.status.ledMode`, {
      type: "state",
      common: {
        name: "Charger LED mode",
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
      native: {},
    });

    //"lifetimeEnergy": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.lifetimeEnergy`, {
      type: "state",
      common: {
        name: "Accumulated energy in the lifetime of the charger [kWh]",
        type: "number",
        role: "value.energy.consumed",
        read: true,
        write: false,
        unit: "kWh",
      },
      native: {},
    });

    //"energyPerHour": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.energyPerHour`, {
      type: "state",
      common: {
        name: "Accumulated energy per hour [kWh]",
        type: "number",
        role: "value.energy.consumed",
        read: true,
        write: false,
        unit: "kWh",
      },
      native: {},
    });

    // Ab hier nur Objekte die über SignalR kommen
    //TempMax
    await this.setObjectNotExistsAsync(`${charger.id}.status.TempMax`, {
      type: "state",
      common: {
        name: "SignaleR only: Maximum temperature for all sensors [Celsius]",
        type: "number",
        role: "value.temperature.max",
        read: true,
        write: false,
      },
      native: {},
    });
  }

  /*************** Session Reading ****************/
  async setNewSessionToCharger(
    charger: Pick<Charger, "id">,
    charger_session: ChargerSession[],
  ): Promise<void> {
    this.log.debug(JSON.stringify(charger_session));
    for (const session of charger_session) {
      if (
        !Number.isInteger(session.year) ||
        session.year < 0 ||
        session.year > 9999 ||
        !Number.isInteger(session.month) ||
        session.month < 1 ||
        session.month > 12 ||
        !Number.isFinite(session.totalEnergyUsage) ||
        !Number.isFinite(session.totalCost)
      ) {
        this.log.warn(
          `Ignoring a session with invalid date or totals for charger ${charger.id}`,
        );
        continue;
      }
      //für jeden Monat errechnen wir das?
      await this.setObjectNotExistsAsync(
        `${charger.id}.session.${session.year}.${
          session.month
        }.totalEnergyUsage`,
        {
          type: "state",
          common: {
            name: "totalEnergyUsage",
            type: "number",
            role: "value",
            read: true,
            write: false,
          },
          native: {},
        },
      );
      await this.setStateAsync(
        `${charger.id}.session.${session.year}.${
          session.month
        }.totalEnergyUsage`,
        session.totalEnergyUsage,
        true,
      );

      await this.setObjectNotExistsAsync(
        `${charger.id}.session.${session.year}.${session.month}.totalCost`,
        {
          type: "state",
          common: {
            name: "totalCost",
            type: "number",
            role: "value",
            read: true,
            write: false,
          },
          native: {},
        },
      );
      await this.setStateAsync(
        `${charger.id}.session.${session.year}.${session.month}.totalCost`,
        session.totalCost,
        true,
      );

      await this.setObjectNotExistsAsync(
        `${charger.id}.session.${session.year}.total_year`,
        {
          type: "state",
          common: {
            name: "total_year",
            type: "number",
            role: "value",
            read: true,
            write: false,
          },
          native: {},
        },
      );
    }

    let tmpYear = 1970;
    let tmpYearCount = 0;
    for (const session of charger_session) {
      //Jahreszähler umhängen
      this.log.debug("set session year data");
      if (tmpYear != session.year) {
        //neues Jahr setzen alles zurück
        await this.setStateAsync(
          `${charger.id}.session.${session.year}.total_year`,
          session.totalEnergyUsage,
          true,
        );
        tmpYearCount = session.totalEnergyUsage;
        tmpYear = session.year;
      } else {
        tmpYearCount = tmpYearCount + session.totalEnergyUsage;
        await this.setStateAsync(
          `${charger.id}.session.${session.year}.total_year`,
          tmpYearCount,
          true,
        );
      }
    }
  }

  /*************** Config Reading ****************/
  async setAllConfigObjects(charger: Charger): Promise<void> {
    await this.setObjectNotExistsAsync(`${charger.id}.config.costPerKWh`, {
      type: "state",
      common: {
        name: "Charging price including VAT per kWh",
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
      native: {},
    });

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.costPerKwhExcludeVat`,
      {
        type: "state",
        common: {
          name: "Charging price excluding VAT per kWh",
          type: "number",
          role: "state",
          read: true,
          write: true,
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.costPerKwhExcludeVat`);

    await this.setObjectNotExistsAsync(`${charger.id}.config.vat`, {
      type: "state",
      common: {
        name: "Value added tax for charging price",
        type: "number",
        role: "state",
        read: true,
        write: true,
        unit: "%",
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.config.vat`);

    //isEnabled
    await this.setObjectNotExistsAsync(`${charger.id}.config.isEnabled`, {
      type: "state",
      common: {
        name: "Set true to enable charger, false disables charger",
        type: "boolean",
        role: "switch.enable",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.config.isEnabled`);

    //phaseMode
    await this.setObjectNotExistsAsync(`${charger.id}.config.phaseMode`, {
      type: "state",
      common: {
        name: "Phase mode on this charger. 1-Locked to 1-Phase, 2-Auto, 3-Locked to 3-phase(only Home)",
        type: "number",
        role: "level",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.config.phaseMode`);

    //maxChargerCurrent
    await this.setObjectNotExistsAsync(
      `${charger.id}.config.maxChargerCurrent`,
      {
        type: "state",
        common: {
          name: "Max current this charger is allowed to offer to car (A)",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.maxChargerCurrent`);

    //dynamicChargerCurrent
    await this.setObjectNotExistsAsync(
      `${charger.id}.config.dynamicChargerCurrent`,
      {
        type: "state",
        common: {
          name: "Dynamic max current this charger is allowed to offer to car (A)",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.dynamicChargerCurrent`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.dynamicCircuitCurrentP1`,
      {
        type: "state",
        common: {
          name: "Dynamically set circuit maximum current for phase 1 [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.dynamicCircuitCurrentP1`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.dynamicCircuitCurrentP2`,
      {
        type: "state",
        common: {
          name: "Dynamically set circuit maximum current for phase 2 [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.dynamicCircuitCurrentP2`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.dynamicCircuitCurrentP3`,
      {
        type: "state",
        common: {
          name: "Dynamically set circuit maximum current for phase 3 [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.dynamicCircuitCurrentP3`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.circuitMaxCurrentP1`,
      {
        type: "state",
        common: {
          name: "Set circuit maximum current [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.circuitMaxCurrentP1`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.circuitMaxCurrentP2`,
      {
        type: "state",
        common: {
          name: "Set circuit maximum current [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.circuitMaxCurrentP2`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.circuitMaxCurrentP3`,
      {
        type: "state",
        common: {
          name: "Set circuit maximum current [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.circuitMaxCurrentP3`);

    //ledStripBrightness
    await this.setObjectNotExistsAsync(
      `${charger.id}.config.ledStripBrightness`,
      {
        type: "state",
        common: {
          name: "LED strip brightness, 0-100%",
          type: "number",
          role: "level.brightness",
          read: true,
          write: true,
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.ledStripBrightness`);

    const lockCablePermanentlyId = `${charger.id}.config.lockCablePermanently`;
    await this.setObjectNotExistsAsync(lockCablePermanentlyId, {
      type: "state",
      common: {
        name: "Lock cable permanently setting",
        type: "boolean",
        role: "switch",
        read: true,
        write: true,
      },
      native: {},
    });
    await this.extendObjectAsync(lockCablePermanentlyId, {
      common: { read: true, write: true },
    });
    this.subscribeStates(lockCablePermanentlyId);

    //"smartCharging": true,
    await this.setObjectNotExistsAsync(`${charger.id}.config.smartCharging`, {
      type: "state",
      common: {
        name: "Smart charging state enabled by capacitive touch button",
        type: "boolean",
        role: "switch.enable",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.config.smartCharging`);

    //smartButtonEnabled
    await this.setObjectNotExistsAsync(
      `${charger.id}.config.smartButtonEnabled`,
      {
        type: "state",
        common: {
          name: "Smart Button Enabled/Disabled",
          type: "boolean",
          role: "switch.enable",
          read: true,
          write: true,
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.smartButtonEnabled`);

    //wiFiSSID
    await this.setObjectNotExistsAsync(`${charger.id}.config.wiFiSSID`, {
      type: "state",
      common: {
        name: "WiFi SSID name",
        type: "string",
        role: "text",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.config.wiFiSSID`);
  }
}

const createAdapter = Object.assign(
  (options: AdapterOptions = { name: "easee" }) => new Easee(options),
  { Easee },
);

if (require.main === module) {
  new Easee();
}

export = createAdapter;
