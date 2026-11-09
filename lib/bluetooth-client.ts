import {
  BLUETOOTH_SERVICE_UUID,
  BluetoothHandshake,
  BluetoothProtocolError,
  assertBluetoothCommandAccepted,
  createBluetoothReadRequest,
  encodeBluetoothCommand,
  encryptBluetoothRequest,
  parseBluetoothCommandReply,
  parseBluetoothFrame,
} from "./bluetooth-protocol.ts";
import type {
  BluetoothChannel,
  BluetoothCommand,
  BluetoothFrame,
  BluetoothValue,
} from "./bluetooth-protocol.ts";
import {
  bluetoothDiagnosticNow,
  logBluetoothDiagnostic,
} from "./bluetooth-diagnostics.ts";
import type { BluetoothDiagnosticLogger } from "./bluetooth-diagnostics.ts";
import type {
  BluetoothCandidate,
  BluetoothLink,
  BluetoothScanner,
} from "./bluetooth-transport.ts";

export interface BluetoothDeviceConfig {
  readonly serial: string;
  readonly pin: string;
  readonly name: string;
}

export type BluetoothConnectionStatus =
  "scanning" | "connecting" | "connected" | "disconnected" | "stopped";

export interface BluetoothStatusEvent {
  readonly serial: string;
  readonly name: string;
  readonly status: BluetoothConnectionStatus;
  readonly error?: Error;
}

export interface BluetoothClientCallbacks {
  readonly onStatus?: (event: BluetoothStatusEvent) => void;
  readonly onDisconnect?: (
    device: Pick<BluetoothDeviceConfig, "serial" | "name">,
  ) => void;
}

export interface BluetoothClientOptions extends BluetoothClientCallbacks {
  readonly discoveryTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly setupTimeoutMs?: number;
  readonly maxCandidatesPerDevice?: number;
  /** Receives identifier-free BLE phase logs through the adapter debug logger. */
  readonly diagnosticLogger?: BluetoothDiagnosticLogger;
}

export interface BluetoothPollResult {
  readonly config: Readonly<Record<string, BluetoothValue>>;
  readonly state: Readonly<Record<string, BluetoothValue>>;
  readonly values: Readonly<Record<string, BluetoothValue>>;
}

interface PendingNotification {
  readonly channel: BluetoothChannel;
  readonly resolve: (data: Buffer) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface DeviceConnection {
  readonly config: BluetoothDeviceConfig;
  readonly candidateId: string;
  readonly pairingAllowed: boolean;
  readonly link: BluetoothLink;
  readonly connectedAt: number;
  key: Buffer;
  connected: boolean;
  closed: boolean;
  pending?: PendingNotification;
  pairAttempted: boolean;
  operationTail: Promise<void>;
}

const CHANNELS: readonly BluetoothChannel[] = [
  "hello",
  "command",
  "config",
  "state",
];

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error("BLE operation failed");
}

function isAuthenticationWriteError(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return typeof value === "string" && isAuthenticationErrorText(value);
  }
  const error = value as Record<string, unknown>;
  return isAuthenticationErrorText(
    [error.message, error.name, error.type, error.code, error.text]
      .filter((part) => typeof part === "string" || typeof part === "number")
      .join(" "),
  );
}

function isAuthenticationErrorText(text: string): boolean {
  return /insufficient[\s_-]*auth(?:entication)?|authentication(?:\s+(?:required|failed))?|not[\s_.-]*paired|not[\s_.-]*authorized|(?:att|gatt)(?:\s+error)?[^\n]{0,32}0x0?5\b/i.test(
    text,
  );
}

export class BluetoothClient {
  private readonly devices: readonly BluetoothDeviceConfig[];
  private readonly scanner: BluetoothScanner;
  private readonly discoveryTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly setupTimeoutMs: number;
  private readonly maxCandidatesPerDevice: number;
  private readonly callbacks: BluetoothClientCallbacks;
  private readonly diagnosticLogger?: BluetoothDiagnosticLogger;
  private readonly connections = new Map<string, DeviceConnection>();
  private readonly connecting = new Set<DeviceConnection>();
  private started = false;
  private stopping = false;
  private startTask?: Promise<void>;
  private reconnectTask?: Promise<void>;
  private stopTask?: Promise<void>;

  constructor(
    devices: readonly BluetoothDeviceConfig[],
    scanner: BluetoothScanner,
    options: BluetoothClientOptions = {},
  ) {
    const serials = new Set<string>();
    for (const device of devices) {
      if (!device.serial.trim() || !device.pin || !device.name.trim()) {
        throw new RangeError("Every BLE device needs a serial, PIN and name");
      }
      if (serials.has(device.serial)) {
        throw new RangeError(`Duplicate BLE serial ${device.serial}`);
      }
      serials.add(device.serial);
    }
    this.devices = devices.map((device) => ({ ...device }));
    this.scanner = scanner;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 8000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.setupTimeoutMs = options.setupTimeoutMs ?? 15000;
    this.maxCandidatesPerDevice = options.maxCandidatesPerDevice ?? 8;
    this.diagnosticLogger = options.diagnosticLogger;
    this.callbacks = {
      onStatus: options.onStatus,
      onDisconnect: options.onDisconnect,
    };
    if (
      [
        this.discoveryTimeoutMs,
        this.requestTimeoutMs,
        this.setupTimeoutMs,
      ].some((timeout) => !Number.isFinite(timeout) || timeout <= 0) ||
      !Number.isInteger(this.maxCandidatesPerDevice) ||
      this.maxCandidatesPerDevice <= 0
    ) {
      throw new RangeError("BLE timeouts and candidate limit must be positive");
    }
  }

  start(): Promise<void> {
    if (this.stopTask) {
      return Promise.reject(
        new BluetoothProtocolError("Bluetooth client is stopping"),
      );
    }
    if (this.started) {
      return this.startTask ?? Promise.resolve();
    }
    this.started = true;
    this.stopping = false;
    this.startTask = this.connectConfiguredDevices();
    return this.startTask;
  }

  async stop(): Promise<void> {
    if (this.stopTask) {
      return this.stopTask;
    }
    this.stopping = true;
    this.started = false;
    const scannerClose = Promise.resolve()
      .then(() => this.scanner.close())
      .then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
    this.stopTask = (async () => {
      try {
        await this.startTask?.catch(() => undefined);
        await this.reconnectTask?.catch(() => undefined);
        const current = [...this.connections.values(), ...this.connecting];
        this.connections.clear();
        this.connecting.clear();
        await Promise.all(
          current.map((connection) => this.closeConnection(connection)),
        );
        const { error } = await scannerClose;
        if (error !== undefined) {
          throw errorFrom(error);
        }
      } finally {
        for (const device of this.devices) {
          this.emitStatus(device, "stopped");
        }
        this.startTask = undefined;
        this.stopTask = undefined;
      }
    })();
    return this.stopTask;
  }

  reconnect(): Promise<void> {
    if (!this.started || this.stopping) {
      return Promise.reject(
        new BluetoothProtocolError("Bluetooth client is not running"),
      );
    }
    if (this.reconnectTask) {
      return this.reconnectTask;
    }
    const task = this.connectConfiguredDevices().finally(() => {
      if (this.reconnectTask === task) {
        this.reconnectTask = undefined;
      }
    });
    this.reconnectTask = task;
    return task;
  }

  async poll(serial: string): Promise<BluetoothPollResult> {
    const connection = this.getConnection(serial);
    return this.enqueue(connection, async () => {
      const config = await this.requestFrame(connection, "config", 1);
      const state = await this.requestFrame(connection, "state", 2);
      return {
        config: config.named,
        state: state.named,
        values: { ...config.named, ...state.named },
      };
    });
  }

  async command(
    serial: string,
    command: BluetoothCommand,
  ): Promise<ReturnType<typeof parseBluetoothCommandReply>> {
    const connection = this.getConnection(serial);
    return this.enqueue(connection, async () => {
      const encoded = encodeBluetoothCommand(command);
      const encrypted = encryptBluetoothRequest(
        connection.key,
        encoded.payload,
      );
      const response = await this.exchange(connection, "command", encrypted);
      const reply = parseBluetoothCommandReply(response);
      assertBluetoothCommandAccepted(reply, encoded.id);
      return reply;
    });
  }

  private async connectConfiguredDevices(): Promise<void> {
    const claimedCandidateIds = new Set(
      [...this.connections.values()].map(
        (connection) => connection.candidateId,
      ),
    );
    for (const config of this.devices) {
      if (this.stopping) {
        return;
      }
      if (this.connections.has(config.serial)) {
        continue;
      }
      this.emitStatus(config, "scanning");
      const discoveryStartedAt = bluetoothDiagnosticNow();
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "client.discovery",
        "started",
        {
          fields: { timeoutMs: this.discoveryTimeoutMs },
        },
      );
      let candidates: readonly BluetoothCandidate[];
      try {
        candidates = await this.withTimeout(
          this.scanner.discover(
            BLUETOOTH_SERVICE_UUID,
            this.discoveryTimeoutMs,
            { fallbackLocalName: config.serial },
          ),
          this.discoveryTimeoutMs + 1000,
          "Timed out scanning for BLE chargers",
        );
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "client.discovery",
          "completed",
          {
            durationMs: bluetoothDiagnosticNow() - discoveryStartedAt,
            fields: { candidates: candidates.length },
          },
        );
      } catch (error) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "client.discovery",
          "failed",
          {
            durationMs: bluetoothDiagnosticNow() - discoveryStartedAt,
            error,
          },
        );
        this.emitStatus(config, "disconnected", errorFrom(error));
        continue;
      }

      let connected = false;
      const unclaimedCandidates = candidates.filter(
        (candidate) => !claimedCandidateIds.has(candidate.id),
      );
      const potentialCandidates = unclaimedCandidates
        .filter((candidate) => candidate.connectable !== false)
        .slice(0, this.maxCandidatesPerDevice);
      if (potentialCandidates.length === 0) {
        const reason =
          candidates.length === 0
            ? "No advertisements matching the Easee service UUID or configured charger name were found"
            : unclaimedCandidates.length === 0
              ? "All matching BLE advertisements were already assigned to another configured charger"
              : "Matching BLE advertisements were not connectable; open the charger's Bluetooth window and retry";
        this.emitStatus(config, "disconnected", new Error(reason));
        continue;
      }
      for (const candidate of potentialCandidates) {
        if (this.stopping) {
          return;
        }
        this.emitStatus(config, "connecting");
        let connection: DeviceConnection | undefined;
        try {
          connection = await this.authenticateCandidate(config, candidate);
          if (this.stopping || !connection.connected) {
            await this.closeConnection(connection);
            return;
          }
          claimedCandidateIds.add(candidate.id);
          this.connections.set(config.serial, connection);
          this.emitStatus(config, "connected");
          connected = true;
          break;
        } catch (error) {
          if (connection) {
            this.connecting.delete(connection);
            await this.closeConnection(connection);
          }
          this.emitStatus(config, "connecting", errorFrom(error));
        }
      }
      if (!connected && !this.stopping) {
        this.emitStatus(config, "disconnected");
      }
    }
  }

  private async authenticateCandidate(
    config: BluetoothDeviceConfig,
    candidate: BluetoothCandidate,
  ): Promise<DeviceConnection> {
    const openingStartedAt = bluetoothDiagnosticNow();
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "client.link_open",
      "started",
    );
    const opening = this.scanner.connect(candidate);
    let openingTimedOut = false;
    void opening.then(
      (lateLink) => {
        if (openingTimedOut) {
          void lateLink.disconnect().catch(() => undefined);
        }
      },
      () => undefined,
    );
    let link: BluetoothLink;
    try {
      link = await this.withTimeout(
        opening,
        this.setupTimeoutMs,
        "Timed out connecting to BLE charger",
      );
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "client.link_open",
        "completed",
        { durationMs: bluetoothDiagnosticNow() - openingStartedAt },
      );
    } catch (error) {
      openingTimedOut = true;
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "client.link_open",
        "failed",
        {
          durationMs: bluetoothDiagnosticNow() - openingStartedAt,
          error,
        },
      );
      throw error;
    }
    const connection: DeviceConnection = {
      config,
      candidateId: candidate.id,
      pairingAllowed: candidate.name === config.serial,
      link,
      connectedAt: bluetoothDiagnosticNow(),
      key: Buffer.alloc(0),
      connected: true,
      closed: false,
      pairAttempted: false,
      operationTail: Promise.resolve(),
    };
    this.connecting.add(connection);
    link.onDisconnect(() => this.handleDisconnect(connection));
    try {
      await Promise.all(
        CHANNELS.map((channel) => {
          const setupStartedAt = bluetoothDiagnosticNow();
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "client.notification_setup",
            "started",
            { fields: { channel } },
          );
          return this.withTimeout(
            link.subscribe(channel, (data) =>
              this.handleNotification(connection, channel, data),
            ),
            this.setupTimeoutMs,
            "Timed out setting up BLE notifications",
          ).then(
            () =>
              logBluetoothDiagnostic(
                this.diagnosticLogger,
                "client.notification_setup",
                "completed",
                {
                  durationMs: bluetoothDiagnosticNow() - setupStartedAt,
                  fields: { channel },
                },
              ),
            (error: unknown) => {
              logBluetoothDiagnostic(
                this.diagnosticLogger,
                "client.notification_setup",
                "failed",
                {
                  durationMs: bluetoothDiagnosticNow() - setupStartedAt,
                  error,
                  fields: { channel },
                },
              );
              throw error;
            },
          );
        }),
      );
      const handshake = new BluetoothHandshake(config.pin);
      const firstReply = await this.runHelloRound(
        connection,
        handshake.createRoundOne(),
        1,
      );
      const secondRequest = handshake.acceptRoundOne(firstReply);
      const secondReply = await this.runHelloRound(
        connection,
        secondRequest,
        2,
      );
      connection.key = handshake.acceptRoundTwo(secondReply);

      const authenticatedReadsStartedAt = bluetoothDiagnosticNow();
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "client.authenticated_reads",
        "started",
      );
      try {
        // The serial is included in both authenticated reads; only then is this discovery bound to it.
        await this.requestFrame(connection, "config", 1);
        await this.requestFrame(connection, "state", 2);
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "client.authenticated_reads",
          "completed",
          {
            durationMs: bluetoothDiagnosticNow() - authenticatedReadsStartedAt,
          },
        );
      } catch (error) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "client.authenticated_reads",
          "failed",
          {
            durationMs: bluetoothDiagnosticNow() - authenticatedReadsStartedAt,
            error,
          },
        );
        throw error;
      }
      this.connecting.delete(connection);
      return connection;
    } catch (error) {
      this.connecting.delete(connection);
      await this.closeConnection(connection);
      throw error;
    }
  }

  private async runHelloRound(
    connection: DeviceConnection,
    payload: Buffer,
    round: 1 | 2,
  ): Promise<Buffer> {
    const startedAt = bluetoothDiagnosticNow();
    logBluetoothDiagnostic(this.diagnosticLogger, "hello.exchange", "started", {
      fields: { round },
    });
    try {
      const response = await this.exchange(connection, "hello", payload);
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "hello.exchange",
        "completed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          fields: { round },
        },
      );
      return response;
    } catch (error) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "hello.exchange",
        "failed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          error,
          fields: { round },
        },
      );
      throw error;
    }
  }

  private requestFrame(
    connection: DeviceConnection,
    channel: "config" | "state",
    uid: number,
  ): Promise<BluetoothFrame> {
    if (connection.key.length !== 32) {
      return Promise.reject(
        new BluetoothProtocolError("BLE authentication is incomplete"),
      );
    }
    const request = encryptBluetoothRequest(
      connection.key,
      createBluetoothReadRequest(uid, connection.config.serial),
    );
    return this.exchange(connection, channel, request).then((response) =>
      parseBluetoothFrame(response, channel),
    );
  }

  private async writeWithPairRetry(
    connection: DeviceConnection,
    channel: BluetoothChannel,
    payload: Buffer,
  ): Promise<void> {
    const write = async (attempt: number): Promise<void> => {
      const startedAt = bluetoothDiagnosticNow();
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        channel === "hello" ? "hello.write" : "client.write",
        "started",
        { fields: { attempt, channel, byteLength: payload.length } },
      );
      try {
        await connection.link.write(channel, payload);
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          channel === "hello" ? "hello.write" : "client.write",
          "completed",
          {
            durationMs: bluetoothDiagnosticNow() - startedAt,
            fields: { attempt, channel, byteLength: payload.length },
          },
        );
      } catch (error) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          channel === "hello" ? "hello.write" : "client.write",
          "failed",
          {
            durationMs: bluetoothDiagnosticNow() - startedAt,
            error,
            fields: { attempt, channel, byteLength: payload.length },
          },
        );
        throw error;
      }
    };

    try {
      await write(1);
    } catch (error) {
      const authenticationFailure = isAuthenticationWriteError(error);
      if (authenticationFailure) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "security.authenticated_write",
          "authentication_rejected",
          { error, fields: { channel } },
        );
      }
      const pair = connection.link.pair;
      if (
        connection.pairAttempted ||
        !connection.pairingAllowed ||
        !pair ||
        !authenticationFailure
      ) {
        if (authenticationFailure) {
          logBluetoothDiagnostic(
            this.diagnosticLogger,
            "security.pairing",
            "not_attempted",
            {
              error,
              fields: {
                attempted: connection.pairAttempted,
                allowed: connection.pairingAllowed,
                supported: Boolean(pair),
              },
            },
          );
        }
        throw error;
      }
      connection.pairAttempted = true;
      this.pauseNotificationTimeout(connection);
      const pairingStartedAt = bluetoothDiagnosticNow();
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "security.pairing",
        "started",
      );
      try {
        await pair.call(connection.link);
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "security.pairing",
          "completed",
          { durationMs: bluetoothDiagnosticNow() - pairingStartedAt },
        );
      } catch (pairingError) {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          "security.pairing",
          "failed",
          {
            durationMs: bluetoothDiagnosticNow() - pairingStartedAt,
            error: pairingError,
          },
        );
        throw pairingError;
      } finally {
        this.resumeNotificationTimeout(connection);
      }
      await write(2);
    }
  }

  private exchange(
    connection: DeviceConnection,
    channel: BluetoothChannel,
    payload: Buffer,
  ): Promise<Buffer> {
    this.assertConnected(connection);
    const reply = this.waitForNotification(connection, channel);
    const responseStartedAt = bluetoothDiagnosticNow();
    if (channel === "hello") {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "hello.response",
        "started",
      );
    }
    const trackedReply =
      channel === "hello"
        ? reply.then(
            (data) => {
              logBluetoothDiagnostic(
                this.diagnosticLogger,
                "hello.response",
                "completed",
                {
                  durationMs: bluetoothDiagnosticNow() - responseStartedAt,
                },
              );
              return data;
            },
            (error: unknown) => {
              logBluetoothDiagnostic(
                this.diagnosticLogger,
                "hello.response",
                "failed",
                {
                  durationMs: bluetoothDiagnosticNow() - responseStartedAt,
                  error,
                },
              );
              throw error;
            },
          )
        : reply;
    let writeOutcome: "pending" | "completed" | "failed" = "pending";
    const write = Promise.resolve()
      .then(() => this.writeWithPairRetry(connection, channel, payload))
      .then(
        () => {
          writeOutcome = "completed";
        },
        (error: unknown) => {
          writeOutcome = "failed";
          throw error;
        },
      );
    const exchangeStartedAt = bluetoothDiagnosticNow();
    return Promise.all([write, trackedReply])
      .then(([, data]) => data)
      .catch(async (error) => {
        logBluetoothDiagnostic(
          this.diagnosticLogger,
          channel === "hello" ? "hello.exchange" : "client.exchange",
          "failed",
          {
            durationMs: bluetoothDiagnosticNow() - exchangeStartedAt,
            error,
            fields: {
              channel,
              byteLength: payload.length,
              pendingChannel: connection.pending?.channel ?? channel,
              writeOutcome,
            },
          },
        );
        this.rejectPending(connection, errorFrom(error));
        this.handleDisconnect(connection, "exchange_failure");
        await this.closeConnection(connection);
        throw errorFrom(error);
      });
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BluetoothProtocolError(message)),
        timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  private waitForNotification(
    connection: DeviceConnection,
    channel: BluetoothChannel,
  ): Promise<Buffer> {
    if (connection.pending) {
      return Promise.reject(
        new BluetoothProtocolError("A BLE request is already in flight"),
      );
    }
    return new Promise((resolve, reject) => {
      const pending: PendingNotification = { channel, resolve, reject };
      connection.pending = pending;
      this.startNotificationTimeout(connection, pending);
    });
  }

  private startNotificationTimeout(
    connection: DeviceConnection,
    pending: PendingNotification,
  ): void {
    if (connection.pending !== pending || pending.timer) {
      return;
    }
    const timer = setTimeout(() => {
      if (connection.pending === pending && pending.timer === timer) {
        connection.pending = undefined;
        pending.timer = undefined;
        pending.reject(
          new BluetoothProtocolError(
            `Timed out waiting for BLE ${pending.channel} response`,
          ),
        );
      }
    }, this.requestTimeoutMs);
    pending.timer = timer;
  }

  private pauseNotificationTimeout(connection: DeviceConnection): void {
    const pending = connection.pending;
    if (!pending?.timer) {
      return;
    }
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }

  private resumeNotificationTimeout(connection: DeviceConnection): void {
    const pending = connection.pending;
    if (pending) {
      this.startNotificationTimeout(connection, pending);
    }
  }

  private handleNotification(
    connection: DeviceConnection,
    channel: BluetoothChannel,
    data: Buffer,
  ): void {
    const pending = connection.pending;
    const ignoreReason = !connection.connected
      ? "disconnected"
      : !pending
        ? "no_pending"
        : pending.channel !== channel
          ? "unexpected_channel"
          : undefined;
    if (!connection.connected || !pending || pending.channel !== channel) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "client.notification",
        "ignored",
        {
          fields: {
            channel,
            byteLength: data.length,
            accepted: false,
            ignoreReason,
            pendingChannel: pending?.channel ?? "none",
          },
        },
      );
      return;
    }
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "client.notification",
      "matched",
      {
        fields: {
          channel,
          byteLength: data.length,
          accepted: true,
          pendingChannel: pending.channel,
        },
      },
    );
    connection.pending = undefined;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    pending.resolve(Buffer.from(data));
  }

  private handleDisconnect(
    connection: DeviceConnection,
    source: "link_event" | "exchange_failure" = "link_event",
  ): void {
    if (!connection.connected) {
      return;
    }
    connection.connected = false;
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "client.disconnect",
      source === "link_event" ? "observed" : "invalidated",
      {
        durationMs: bluetoothDiagnosticNow() - connection.connectedAt,
        fields: { source },
      },
    );
    this.rejectPending(
      connection,
      new BluetoothProtocolError("BLE device disconnected"),
    );
    this.connecting.delete(connection);
    if (this.connections.get(connection.config.serial) === connection) {
      this.connections.delete(connection.config.serial);
      if (!this.stopping) {
        this.emitStatus(connection.config, "disconnected");
        try {
          this.callbacks.onDisconnect?.({
            serial: connection.config.serial,
            name: connection.config.name,
          });
        } catch {
          // A consumer callback must not escape into the BLE event emitter.
        }
      }
    }
  }

  private rejectPending(connection: DeviceConnection, error: Error): void {
    const pending = connection.pending;
    if (!pending) {
      return;
    }
    connection.pending = undefined;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    pending.reject(error);
  }

  private async closeConnection(connection: DeviceConnection): Promise<void> {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (connection.connected) {
      connection.connected = false;
      this.rejectPending(
        connection,
        new BluetoothProtocolError("BLE connection closed"),
      );
    }
    const startedAt = bluetoothDiagnosticNow();
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "client.disconnect",
      "started",
    );
    try {
      await Promise.resolve().then(() => connection.link.disconnect());
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "client.disconnect",
        "completed",
        { durationMs: bluetoothDiagnosticNow() - startedAt },
      );
    } catch (error) {
      logBluetoothDiagnostic(
        this.diagnosticLogger,
        "client.disconnect",
        "failed",
        {
          durationMs: bluetoothDiagnosticNow() - startedAt,
          error,
        },
      );
    }
  }

  private getConnection(serial: string): DeviceConnection {
    if (!this.started || this.stopping) {
      throw new BluetoothProtocolError("Bluetooth client is not running");
    }
    const connection = this.connections.get(serial);
    if (!connection || !connection.connected) {
      throw new BluetoothProtocolError(
        `No connected BLE charger for serial ${serial}`,
      );
    }
    return connection;
  }

  private enqueue<T>(
    connection: DeviceConnection,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = connection.operationTail.then(() => {
      this.assertConnected(connection);
      return operation();
    });
    connection.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertConnected(connection: DeviceConnection): void {
    if (!this.started || this.stopping || !connection.connected) {
      throw new BluetoothProtocolError("BLE device is not connected");
    }
  }

  private emitStatus(
    device: BluetoothDeviceConfig,
    status: BluetoothConnectionStatus,
    error?: Error,
  ): void {
    logBluetoothDiagnostic(
      this.diagnosticLogger,
      "client.state",
      status,
      error === undefined ? {} : { error },
    );
    try {
      this.callbacks.onStatus?.(
        error
          ? { serial: device.serial, name: device.name, status, error }
          : { serial: device.serial, name: device.name, status },
      );
    } catch {
      // Status consumers do not own BLE lifecycle control.
    }
  }
}
