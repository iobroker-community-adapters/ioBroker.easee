"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import { createDecipheriv } from "node:crypto";
import { BluetoothHandshake } from "../lib/bluetooth-protocol.ts";
import { BluetoothClient } from "../lib/bluetooth-client.ts";
import type {
  BluetoothCandidate,
  BluetoothDiscoveryOptions,
  BluetoothLink,
  BluetoothScanner,
} from "../lib/bluetooth-transport.ts";

async function expectRejectedWithMessage(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected rejection containing "${message}"`);
}

function frame(type: "config" | "state"): Buffer {
  const data = Buffer.alloc(6);
  data[0] = 0;
  data[1] = type === "config" ? 0x40 : 0x41;
  data.writeUInt16BE(data.length, 4);
  return data;
}

function decryptRequest(data: Buffer, key: Buffer): Record<string, unknown> {
  const record = Buffer.from(data.toString("ascii"), "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, record.subarray(0, 4), {
    authTagLength: 16,
  });
  decipher.setAuthTag(record.subarray(4, 20));
  return JSON.parse(
    Buffer.concat([
      decipher.update(record.subarray(20)),
      decipher.final(),
    ]).toString("utf8"),
  ) as Record<string, unknown>;
}

class FakeLink implements BluetoothLink {
  readonly writes: { channel: string; data: Buffer }[] = [];
  disconnectCount = 0;
  pairCalls = 0;
  pairFailure?: Error;
  pairDelayMs = 0;
  authenticationWriteFailures: Error[] = [];
  stateResponses = 0;
  suppressStateAfterInitial = false;
  deferCommands = false;
  commandReplyCode = 1;
  pair?: () => Promise<void>;
  private readonly subscribers = new Map<string, (data: Buffer) => void>();
  private disconnected?: () => void;
  private activeCommandCount = 0;
  private successfulHelloWrites = 0;
  private readonly serverHandshake: BluetoothHandshake;
  private clientRoundOne?: Buffer;
  private serverKey?: Buffer;
  maxActiveCommands = 0;

  constructor(
    serverPin: string,
    private readonly expectedSerial: string,
    supportsPairing = true,
  ) {
    this.serverHandshake = new BluetoothHandshake(serverPin, "server");
    if (supportsPairing) {
      this.pair = () => {
        this.pairCalls++;
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (this.pairFailure) {
              reject(this.pairFailure);
            } else {
              resolve();
            }
          }, this.pairDelayMs);
        });
      };
    }
  }

  subscribe(channel: string, listener: (data: Buffer) => void): Promise<void> {
    this.subscribers.set(channel, listener);
    return Promise.resolve();
  }

  write(channel: string, data: Buffer): Promise<void> {
    this.writes.push({ channel, data: Buffer.from(data) });
    const authenticationWriteFailure = this.authenticationWriteFailures.shift();
    if (authenticationWriteFailure) {
      return Promise.reject(authenticationWriteFailure);
    }
    if (channel === "hello") {
      const round = ++this.successfulHelloWrites;
      if (round === 1) {
        this.clientRoundOne = Buffer.from(data);
        queueMicrotask(() =>
          this.notify("hello", this.serverHandshake.createRoundOne()),
        );
      } else {
        if (!this.clientRoundOne) {
          throw new Error("Missing client round one");
        }
        const serverRoundTwo = this.serverHandshake.acceptRoundOne(
          this.clientRoundOne,
        );
        this.serverKey = this.serverHandshake.acceptRoundTwo(data);
        queueMicrotask(() => this.notify("hello", serverRoundTwo));
      }
      return Promise.resolve();
    }
    if (channel === "config") {
      this.replyToRead("config", data);
      return Promise.resolve();
    }
    if (channel === "state") {
      this.stateResponses++;
      if (this.suppressStateAfterInitial && this.stateResponses > 1) {
        return Promise.resolve();
      }
      this.replyToRead("state", data);
      return Promise.resolve();
    }
    if (channel === "command") {
      this.activeCommandCount++;
      this.maxActiveCommands = Math.max(
        this.maxActiveCommands,
        this.activeCommandCount,
      );
      if (this.deferCommands) {
        return Promise.resolve();
      }
      setTimeout(() => {
        this.activeCommandCount--;
        const request = this.serverKey && decryptRequest(data, this.serverKey);
        this.notify(
          "command",
          Buffer.from(
            JSON.stringify({
              id: request?.Id,
              code: this.commandReplyCode,
            }),
          ),
        );
      }, 10);
    }
    return Promise.resolve();
  }

  onDisconnect(listener: () => void): void {
    this.disconnected = listener;
  }

  disconnect(): Promise<void> {
    this.disconnectCount++;
    return Promise.resolve();
  }

  triggerDisconnect(): void {
    this.disconnected?.();
  }

  releaseCommand(): void {
    this.activeCommandCount--;
    this.notify("command", Buffer.from('{"id":29,"code":1}'));
  }

  deliverStaleState(): void {
    this.notify("state", frame("state"));
  }

  private notify(channel: string, data: Buffer): void {
    this.subscribers.get(channel)?.(data);
  }

  private replyToRead(channel: "config" | "state", data: Buffer): void {
    try {
      if (!this.serverKey) {
        return;
      }
      const request = decryptRequest(data, this.serverKey);
      if (request.sn !== this.expectedSerial) {
        return;
      }
      queueMicrotask(() => this.notify(channel, frame(channel)));
    } catch {
      // Wrong PINs produce a different session key; the charger ignores that record.
    }
  }
}

class FakeScanner implements BluetoothScanner {
  readonly link: FakeLink;
  closed = false;
  connects: string[] = [];
  connectFailure?: Error;
  discoveryCalls = 0;
  discoveryFailures = 0;
  readonly fallbackLocalNames: (string | undefined)[] = [];
  discoveryResults: readonly BluetoothCandidate[];

  constructor(serverPin = "1234", expectedSerial = "EMX12345") {
    this.link = new FakeLink(serverPin, expectedSerial);
    this.discoveryResults = [
      { id: "temporary-device-address", name: expectedSerial },
    ];
  }

  discover(
    _serviceUuid: string,
    _timeoutMs: number,
    options?: BluetoothDiscoveryOptions,
  ): Promise<readonly BluetoothCandidate[]> {
    this.discoveryCalls++;
    this.fallbackLocalNames.push(options?.fallbackLocalName);
    if (this.discoveryFailures > 0) {
      this.discoveryFailures--;
      return Promise.reject(new Error("simulated scan failure"));
    }
    return Promise.resolve(this.discoveryResults);
  }

  connect(candidate: BluetoothCandidate): Promise<BluetoothLink> {
    this.connects.push(candidate.id);
    return this.connectFailure
      ? Promise.reject(this.connectFailure)
      : Promise.resolve(this.link);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class PendingDiscoveryScanner implements BluetoothScanner {
  closed = false;
  resolveDiscovery?: (candidates: readonly BluetoothCandidate[]) => void;

  discover(): Promise<readonly BluetoothCandidate[]> {
    return new Promise((resolve) => {
      this.resolveDiscovery = resolve;
    });
  }

  connect(): Promise<BluetoothLink> {
    return Promise.reject(new Error("No device should be connected"));
  }

  close(): Promise<void> {
    this.closed = true;
    this.resolveDiscovery?.([]);
    return Promise.resolve();
  }
}

class MultiFakeScanner implements BluetoothScanner {
  readonly links = new Map<string, FakeLink>();
  closed = false;

  constructor(
    chargers: readonly {
      id: string;
      serial: string;
      pin: string;
    }[],
  ) {
    for (const charger of chargers) {
      this.links.set(charger.id, new FakeLink(charger.pin, charger.serial));
    }
  }

  discover(): Promise<readonly BluetoothCandidate[]> {
    return Promise.resolve(
      [...this.links.keys()].map((id) => ({ id, name: "Charger" })),
    );
  }

  connect(candidate: BluetoothCandidate): Promise<BluetoothLink> {
    const link = this.links.get(candidate.id);
    if (!link) {
      return Promise.reject(new Error("Unknown fake BLE device"));
    }
    return Promise.resolve(link);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function client(
  scanner: FakeScanner,
  pin = "1234",
  timeoutMs = 100,
  onDisconnect?: () => void,
): BluetoothClient {
  return new BluetoothClient(
    [{ serial: "EMX12345", pin, name: "Garage charger" }],
    scanner,
    {
      requestTimeoutMs: timeoutMs,
      discoveryTimeoutMs: 20,
      setupTimeoutMs: 100,
      onDisconnect,
    },
  );
}

describe("Bluetooth client boundary", () => {
  it("closes an active discovery scan immediately when stopping", async () => {
    const scanner = new PendingDiscoveryScanner();
    const instance = new BluetoothClient(
      [{ serial: "EMX12345", pin: "1234", name: "Garage charger" }],
      scanner,
      { discoveryTimeoutMs: 1000 },
    );
    const starting = instance.start();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stopping = instance.stop();
    await Promise.resolve();
    expect(scanner.closed).to.equal(true);
    await Promise.all([starting, stopping]);
  });

  it("uses the configured serial as the exact local-name fallback", async () => {
    const scanner = new FakeScanner();
    const instance = client(scanner);

    await instance.start();

    expect(scanner.fallbackLocalNames).to.deep.equal(["EMX12345"]);
    await instance.stop();
  });

  it("reports generic candidate connection failures such as GATT validation errors", async () => {
    const scanner = new FakeScanner();
    scanner.connectFailure = new Error(
      "Expected exactly one BLE service; found 0",
    );
    const statuses: Array<{ status: string; error?: Error }> = [];
    const instance = new BluetoothClient(
      [{ serial: "EMX12345", pin: "1234", name: "Garage charger" }],
      scanner,
      { onStatus: (event) => statuses.push(event) },
    );

    await instance.start();

    expect(
      statuses.find(
        (event) => event.status === "connecting" && event.error !== undefined,
      )?.error?.message,
    ).to.equal("Expected exactly one BLE service; found 0");
    expect(statuses.at(-1)?.status).to.equal("disconnected");
    await instance.stop();
  });

  it("reports when discovery found no advertisements for the Easee service", async () => {
    const scanner = new FakeScanner();
    scanner.discoveryResults = [];
    const statuses: Array<{
      status: string;
      error?: Error;
    }> = [];
    const instance = new BluetoothClient(
      [{ serial: "EMX12345", pin: "1234", name: "Garage charger" }],
      scanner,
      { onStatus: (event) => statuses.push(event) },
    );

    await instance.start();

    expect(statuses.at(-1)?.status).to.equal("disconnected");
    expect(statuses.at(-1)?.error?.message).to.equal(
      "No advertisements matching the Easee service UUID or configured charger name were found",
    );
    await instance.stop();
  });

  it("does not connect to matching advertisements reported as non-connectable", async () => {
    const scanner = new FakeScanner();
    scanner.discoveryResults = [
      { id: "non-connectable-device", name: "EMX12345", connectable: false },
    ];
    const statuses: Array<{ status: string; error?: Error }> = [];
    const instance = new BluetoothClient(
      [{ serial: "EMX12345", pin: "1234", name: "Garage charger" }],
      scanner,
      { onStatus: (event) => statuses.push(event) },
    );

    await instance.start();

    expect(scanner.connects).to.deep.equal([]);
    expect(statuses.at(-1)?.status).to.equal("disconnected");
    expect(statuses.at(-1)?.error?.message).to.equal(
      "Matching BLE advertisements were not connectable; open the charger's Bluetooth window and retry",
    );
    await instance.stop();
  });

  it("pairs once after an ATT authentication error and retries the write", async () => {
    const scanner = new FakeScanner();
    scanner.link.authenticationWriteFailures.push(
      new Error("ATT Insufficient Authentication (0x05)"),
    );
    scanner.link.pairDelayMs = 40;
    const instance = client(scanner, "1234", 20);

    await instance.start();

    expect(scanner.link.pairCalls).to.equal(1);
    expect(
      scanner.link.writes.filter((write) => write.channel === "hello"),
    ).to.have.length(3);
    expect(scanner.link.disconnectCount).to.equal(0);
    await instance.stop();
  });

  it("does not pair or retry unless the advertised name exactly matches the serial", async () => {
    const scanner = new FakeScanner();
    scanner.discoveryResults = [{ id: "wrong-name-device", name: "emx12345" }];
    scanner.link.authenticationWriteFailures.push(
      new Error("ATT Insufficient Authentication (0x05)"),
    );
    const instance = client(scanner);

    await instance.start();

    expect(scanner.connects).to.deep.equal(["wrong-name-device"]);
    expect(scanner.link.pairCalls).to.equal(0);
    expect(
      scanner.link.writes.filter((write) => write.channel === "hello"),
    ).to.have.length(1);
    await instance.stop();
  });

  it("recognizes BlueZ NotAuthorized D-Bus errors without a descriptive message", async () => {
    const scanner = new FakeScanner();
    const authenticationError = new Error("GATT operation failed");
    authenticationError.name = "org.bluez.Error.NotAuthorized";
    scanner.link.authenticationWriteFailures.push(authenticationError);
    const instance = client(scanner);

    await instance.start();

    expect(scanner.link.pairCalls).to.equal(1);
    expect(
      scanner.link.writes.filter((write) => write.channel === "hello"),
    ).to.have.length(3);
    await instance.stop();
  });

  it("caps pairing and write retry at one attempt per connection", async () => {
    const scanner = new FakeScanner();
    scanner.link.authenticationWriteFailures.push(
      new Error("ATT Insufficient Authentication (0x05)"),
      new Error("ATT Insufficient Authentication (0x05)"),
    );
    const instance = client(scanner);

    await instance.start();

    expect(scanner.link.pairCalls).to.equal(1);
    expect(
      scanner.link.writes.filter((write) => write.channel === "hello"),
    ).to.have.length(2);
    await instance.stop();
  });

  it("surfaces a BlueZ pairing failure without retrying the write", async () => {
    const scanner = new FakeScanner();
    scanner.link.authenticationWriteFailures.push(
      new Error("org.bluez.Error.NotAuthorized: Insufficient Authentication"),
    );
    scanner.link.pairFailure = new Error(
      "BlueZ pairing failed: org.bluez.Error.AuthenticationCanceled",
    );
    const statuses: Array<{ status: string; error?: Error }> = [];
    const instance = new BluetoothClient(
      [{ serial: "EMX12345", pin: "1234", name: "Garage charger" }],
      scanner,
      { onStatus: (event) => statuses.push(event) },
    );

    await instance.start();

    expect(scanner.link.pairCalls).to.equal(1);
    expect(
      scanner.link.writes.filter((write) => write.channel === "hello"),
    ).to.have.length(1);
    expect(
      statuses.find((event) => event.status === "connecting" && event.error)
        ?.error?.message,
    ).to.equal("BlueZ pairing failed: org.bluez.Error.AuthenticationCanceled");
    await instance.stop();
  });

  it("does not pair after a non-authentication write error", async () => {
    const scanner = new FakeScanner();
    scanner.link.authenticationWriteFailures.push(
      new Error("GATT write failed: Operation not permitted"),
    );
    const instance = client(scanner);

    await instance.start();

    expect(scanner.link.pairCalls).to.equal(0);
    expect(
      scanner.link.writes.filter((write) => write.channel === "hello"),
    ).to.have.length(1);
    await instance.stop();
  });

  it("does not pair or retry on a non-BlueZ link", async () => {
    const scanner = new FakeScanner();
    scanner.link.pair = undefined;
    scanner.link.authenticationWriteFailures.push(
      new Error("ATT Insufficient Authentication (0x05)"),
    );
    const instance = client(scanner);

    await instance.start();

    expect(scanner.link.pairCalls).to.equal(0);
    expect(
      scanner.link.writes.filter((write) => write.channel === "hello"),
    ).to.have.length(1);
    await instance.stop();
  });

  it("does not bind a discovery when a wrong PIN cannot authenticate reads", async () => {
    const scanner = new FakeScanner("1234");
    const statuses: string[] = [];
    const instance = new BluetoothClient(
      [{ serial: "EMX12345", pin: "wrong", name: "Garage charger" }],
      scanner,
      {
        discoveryTimeoutMs: 20,
        requestTimeoutMs: 50,
        onStatus: (event) => statuses.push(event.status),
      },
    );
    await instance.start();
    expect(statuses).to.include("disconnected");
    await expectRejectedWithMessage(
      instance.poll("EMX12345"),
      "No connected BLE charger",
    );
    expect(scanner.link.disconnectCount).to.equal(1);
    await instance.stop();
    expect(scanner.closed).to.equal(true);
  });

  it("does not cross-assign a validly authenticated charger with another serial", async () => {
    const scanner = new FakeScanner("1234", "EMXOTHER");
    const instance = client(scanner, "1234", 20);
    await instance.start();
    expect(scanner.link.disconnectCount).to.equal(1);
    await expectRejectedWithMessage(
      instance.poll("EMX12345"),
      "No connected BLE charger",
    );
    await instance.stop();
  });

  it("reconnects after a bounded scan failure", async () => {
    const scanner = new FakeScanner();
    scanner.discoveryFailures = 1;
    const statuses: string[] = [];
    const instance = new BluetoothClient(
      [{ serial: "EMX12345", pin: "1234", name: "Garage charger" }],
      scanner,
      {
        discoveryTimeoutMs: 20,
        requestTimeoutMs: 50,
        onStatus: (event) => statuses.push(event.status),
      },
    );
    await instance.start();
    await expectRejectedWithMessage(
      instance.poll("EMX12345"),
      "No connected BLE charger",
    );

    await instance.reconnect();

    expect(scanner.discoveryCalls).to.equal(2);
    expect(statuses).to.include("connected");
    await instance.poll("EMX12345");
    await instance.stop();
  });

  it("assigns multiple chargers to distinct authenticated peripherals", async () => {
    const scanner = new MultiFakeScanner([
      { id: "first-peripheral", serial: "EMX11111", pin: "1111" },
      { id: "second-peripheral", serial: "EMX22222", pin: "2222" },
    ]);
    const instance = new BluetoothClient(
      [
        { serial: "EMX11111", pin: "1111", name: "First charger" },
        { serial: "EMX22222", pin: "2222", name: "Second charger" },
      ],
      scanner,
      { discoveryTimeoutMs: 20, requestTimeoutMs: 50 },
    );
    await instance.start();

    await Promise.all([instance.poll("EMX11111"), instance.poll("EMX22222")]);
    expect(scanner.links.get("first-peripheral")?.disconnectCount).to.equal(0);
    expect(scanner.links.get("second-peripheral")?.disconnectCount).to.equal(0);
    await instance.stop();
    expect(scanner.links.get("first-peripheral")?.disconnectCount).to.equal(1);
    expect(scanner.links.get("second-peripheral")?.disconnectCount).to.equal(1);
  });

  it("bounds unanswered BLE operations and discards late notifications", async () => {
    const scanner = new FakeScanner();
    const instance = client(scanner, "1234", 20);
    await instance.start();
    scanner.link.suppressStateAfterInitial = true;
    await expectRejectedWithMessage(
      instance.poll("EMX12345"),
      "Timed out waiting for BLE state response",
    );
    const writesAtTimeout = scanner.link.writes.length;
    scanner.link.deliverStaleState();
    await expectRejectedWithMessage(
      instance.command("EMX12345", { type: "setEnabled", enabled: true }),
      "No connected BLE charger",
    );
    expect(scanner.link.writes.length).to.equal(writesAtTimeout);
    await instance.stop();
  });

  it("serializes commands for one charger and reports only accepted command replies", async () => {
    const scanner = new FakeScanner();
    const instance = client(scanner);
    await instance.start();
    const results = await Promise.all([
      instance.command("EMX12345", { type: "setEnabled", enabled: true }),
      instance.command("EMX12345", { type: "setEnabled", enabled: false }),
    ]);
    expect(results).to.have.length(2);
    expect(scanner.link.maxActiveCommands).to.equal(1);
    await instance.stop();
  });

  it("rejects a negative command acknowledgement", async () => {
    const scanner = new FakeScanner();
    const instance = client(scanner);
    await instance.start();
    scanner.link.commandReplyCode = 0;

    await expectRejectedWithMessage(
      instance.command("EMX12345", { type: "setEnabled", enabled: true }),
      "refused",
    );
    await instance.stop();
  });

  it("rejects queued operations after disconnect without replaying them", async () => {
    const scanner = new FakeScanner();
    let disconnects = 0;
    const instance = client(scanner, "1234", 200, () => disconnects++);
    await instance.start();
    scanner.link.deferCommands = true;
    const first = instance.command("EMX12345", {
      type: "setEnabled",
      enabled: true,
    });
    const second = instance.command("EMX12345", {
      type: "setEnabled",
      enabled: false,
    });
    const firstCheck = expectRejectedWithMessage(first, "disconnected");
    const secondCheck = expectRejectedWithMessage(second, "not connected");
    await new Promise((resolve) => setImmediate(resolve));
    scanner.link.triggerDisconnect();
    await Promise.all([firstCheck, secondCheck]);
    const commandWrites = scanner.link.writes.filter(
      (write) => write.channel === "command",
    );
    expect(commandWrites).to.have.length(1);
    expect(disconnects).to.equal(1);
    scanner.link.releaseCommand();
    await expectRejectedWithMessage(
      instance.poll("EMX12345"),
      "No connected BLE charger",
    );
    await instance.stop();
    expect(scanner.closed).to.equal(true);
  });

  it("closes every connection and the scanner on stop", async () => {
    const scanner = new FakeScanner();
    const instance = client(scanner);
    await instance.start();
    await instance.stop();
    expect(scanner.link.disconnectCount).to.equal(1);
    expect(scanner.closed).to.equal(true);
    await expectRejectedWithMessage(
      instance.command("EMX12345", { type: "reboot" }),
      "not running",
    );
  });
});
