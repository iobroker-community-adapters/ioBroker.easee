import {
  BLUETOOTH_SERVICE_UUID,
  BluetoothAuthenticationError,
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
  readonly timer: ReturnType<typeof setTimeout>;
}

interface DeviceConnection {
  readonly config: BluetoothDeviceConfig;
  readonly candidateId: string;
  readonly link: BluetoothLink;
  key: Buffer;
  connected: boolean;
  closed: boolean;
  pending?: PendingNotification;
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

export class BluetoothClient {
  private readonly devices: readonly BluetoothDeviceConfig[];
  private readonly scanner: BluetoothScanner;
  private readonly discoveryTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly setupTimeoutMs: number;
  private readonly maxCandidatesPerDevice: number;
  private readonly callbacks: BluetoothClientCallbacks;
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
        await this.scanner.close();
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
      let candidates: readonly BluetoothCandidate[];
      try {
        candidates = await this.withTimeout(
          this.scanner.discover(
            BLUETOOTH_SERVICE_UUID,
            this.discoveryTimeoutMs,
          ),
          this.discoveryTimeoutMs + 1000,
          "Timed out scanning for BLE chargers",
        );
      } catch (error) {
        this.emitStatus(config, "disconnected", errorFrom(error));
        continue;
      }

      let connected = false;
      const potentialCandidates = candidates
        .filter((candidate) => !claimedCandidateIds.has(candidate.id))
        .slice(0, this.maxCandidatesPerDevice);
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
          if (
            error instanceof BluetoothAuthenticationError ||
            error instanceof BluetoothProtocolError
          ) {
            this.emitStatus(config, "connecting", error);
          }
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
    } catch (error) {
      openingTimedOut = true;
      throw error;
    }
    const connection: DeviceConnection = {
      config,
      candidateId: candidate.id,
      link,
      key: Buffer.alloc(0),
      connected: true,
      closed: false,
      operationTail: Promise.resolve(),
    };
    this.connecting.add(connection);
    link.onDisconnect(() => this.handleDisconnect(connection));
    try {
      await Promise.all(
        CHANNELS.map((channel) =>
          this.withTimeout(
            link.subscribe(channel, (data) =>
              this.handleNotification(connection, channel, data),
            ),
            this.setupTimeoutMs,
            "Timed out setting up BLE notifications",
          ),
        ),
      );
      const handshake = new BluetoothHandshake(config.pin);
      const firstReply = await this.exchange(
        connection,
        "hello",
        handshake.createRoundOne(),
      );
      const secondRequest = handshake.acceptRoundOne(firstReply);
      const secondReply = await this.exchange(
        connection,
        "hello",
        secondRequest,
      );
      connection.key = handshake.acceptRoundTwo(secondReply);

      // The serial is included in both authenticated reads; only then is this discovery bound to it.
      await this.requestFrame(connection, "config", 1);
      await this.requestFrame(connection, "state", 2);
      this.connecting.delete(connection);
      return connection;
    } catch (error) {
      this.connecting.delete(connection);
      await this.closeConnection(connection);
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

  private exchange(
    connection: DeviceConnection,
    channel: BluetoothChannel,
    payload: Buffer,
  ): Promise<Buffer> {
    this.assertConnected(connection);
    const reply = this.waitForNotification(connection, channel);
    const write = Promise.resolve().then(() =>
      connection.link.write(channel, payload),
    );
    return Promise.all([write, reply])
      .then(([, data]) => data)
      .catch(async (error) => {
        this.rejectPending(connection, errorFrom(error));
        this.handleDisconnect(connection);
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
      const timer = setTimeout(() => {
        if (connection.pending?.timer === timer) {
          connection.pending = undefined;
          reject(
            new BluetoothProtocolError(
              `Timed out waiting for BLE ${channel} response`,
            ),
          );
        }
      }, this.requestTimeoutMs);
      connection.pending = { channel, resolve, reject, timer };
    });
  }

  private handleNotification(
    connection: DeviceConnection,
    channel: BluetoothChannel,
    data: Buffer,
  ): void {
    const pending = connection.pending;
    if (!connection.connected || !pending || pending.channel !== channel) {
      return;
    }
    connection.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(Buffer.from(data));
  }

  private handleDisconnect(connection: DeviceConnection): void {
    if (!connection.connected) {
      return;
    }
    connection.connected = false;
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
    clearTimeout(pending.timer);
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
    await Promise.resolve()
      .then(() => connection.link.disconnect())
      .catch(() => undefined);
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
