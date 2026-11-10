"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import { applyNobleHciMtuWorkaround } from "../src/lib/noble-hci-mtu-workaround.ts";

type FakeCommand = {
  buffer: Buffer;
  callback: ((response: Buffer) => void) | null;
  writeCallback: (() => void) | null;
};
type FakeListener = (...args: unknown[]) => void;

class FakeGatt {
  readonly requestedMtus: number[] = [];
  readonly requests: Buffer[] = [];
  readonly emitted: unknown[][] = [];
  readonly response: Buffer;
  readonly _address = "charger";
  readonly _characteristics: Record<
    string,
    Record<string, { valueHandle: number }>
  > = { service: { characteristic: { valueHandle: 0x1234 } } };
  readonly _commandQueue: FakeCommand[] = [];
  readonly listeners = new Map<string, FakeListener[]>();
  _currentCommand: FakeCommand | null = null;
  _desired_mtu = 256;
  _mtu = 23;
  lastWriteResponse: Buffer | undefined;

  constructor(peerMtu: number) {
    this.response = Buffer.alloc(3);
    this.response[0] = 0x03;
    this.response.writeUInt16LE(peerMtu, 1);
  }

  _queueCommand(
    request: Buffer,
    callback: ((response: Buffer) => void) | null = null,
    writeCallback: (() => void) | null = null,
  ): void {
    this._commandQueue.push({ buffer: request, callback, writeCallback });
    this.startNextCommand();
  }

  private startNextCommand(): void {
    while (this._currentCommand === null && this._commandQueue.length > 0) {
      this._currentCommand = this._commandQueue.shift() ?? null;
      if (!this._currentCommand) {
        return;
      }
      this.writeAtt(this._currentCommand.buffer);
      if (this._currentCommand.callback) {
        return;
      }
      this._currentCommand.writeCallback?.();
      this._currentCommand = null;
    }
  }

  onAclStreamData(cid: number, data: Buffer): void {
    if (cid !== 0x0004 || this._currentCommand === null) {
      return;
    }
    this._currentCommand.callback?.(data);
    this._currentCommand = null;
    this.startNextCommand();
  }

  writeAtt(request: Buffer): void {
    this.requests.push(Buffer.from(request));
  }

  mtuRequest(requestedMtu: number): Buffer {
    this.requestedMtus.push(requestedMtu);
    const request = Buffer.alloc(3);
    request[0] = 0x02;
    request.writeUInt16LE(requestedMtu, 1);
    return request;
  }

  executeWriteRequest(_handle: number, cancelPreparedWrites: boolean): Buffer {
    return Buffer.from([0x18, cancelPreparedWrites ? 0 : 1]);
  }

  writeRequest(handle: number, data: Buffer, withoutResponse: boolean): Buffer {
    const request = Buffer.alloc(3 + data.length);
    request[0] = withoutResponse ? 0x52 : 0x12;
    request.writeUInt16LE(handle, 1);
    data.copy(request, 3);
    return request;
  }

  longWrite(
    serviceUuid: string,
    characteristicUuid: string,
    data: Buffer,
    withoutResponse: boolean,
  ): void {
    const handle =
      this._characteristics[serviceUuid]?.[characteristicUuid]?.valueHandle;
    if (handle === undefined) {
      throw new Error("Characteristic not found");
    }
    const limit = this._mtu - 5;
    for (let offset = 0; offset < data.length; offset += limit) {
      const chunk = data.slice(offset, offset + limit);
      const request = Buffer.alloc(5 + chunk.length);
      request[0] = 0x16;
      request.writeUInt16LE(handle, 1);
      request.writeUInt16LE(offset, 3);
      chunk.copy(request, 5);
      this._queueCommand(request, (response) => {
        if (response[0] !== 0x17) {
          return;
        }
      });
    }
    this._queueCommand(this.executeWriteRequest(handle, false), (response) => {
      if (response[0] === 0x19 && !withoutResponse) {
        this.emit("write", this._address, serviceUuid, characteristicUuid);
      }
    });
  }

  write(
    serviceUuid: string,
    characteristicUuid: string,
    data: Buffer,
    withoutResponse: boolean,
  ): void {
    const handle =
      this._characteristics[serviceUuid]?.[characteristicUuid]?.valueHandle;
    if (handle === undefined) {
      throw new Error("Characteristic not found");
    }
    if (withoutResponse) {
      this._queueCommand(this.writeRequest(handle, data, true), null);
    } else if (data.length + 3 > this._mtu) {
      this.longWrite(serviceUuid, characteristicUuid, data, withoutResponse);
    } else {
      this._queueCommand(this.writeRequest(handle, data, false), (response) => {
        this.lastWriteResponse = response;
        if (response[0] === 0x13) {
          this.emit("write", this._address, serviceUuid, characteristicUuid);
        }
      });
    }
  }

  exchangeMtu(): void {}

  on(event: string, listener: FakeListener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string, ...args: unknown[]): boolean {
    this.emitted.push([event, ...args]);
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
    return true;
  }
}

class FakeHciBindings {
  readonly emitted: unknown[][] = [];
  readonly listeners = new Map<string, FakeListener[]>();

  addressToId(address: string): string {
    return address === "charger" ? "peripheral-id" : address;
  }

  onWrite(
    address: string,
    serviceUuid: string,
    characteristicUuid: string,
    error?: unknown,
  ): void {
    if (error === undefined) {
      this.emit(
        "write",
        this.addressToId(address),
        serviceUuid,
        characteristicUuid,
      );
    } else {
      this.emit(
        "write",
        this.addressToId(address),
        serviceUuid,
        characteristicUuid,
        error,
      );
    }
  }

  on(event: string, listener: FakeListener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string, ...args: unknown[]): boolean {
    this.emitted.push([event, ...args]);
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
    return true;
  }
}

function patchHciPrototypes(): void {
  applyNobleHciMtuWorkaround(
    "hci",
    FakeGatt.prototype,
    FakeHciBindings.prototype,
  );
}

function attError(requestOpcode: number, errorCode: number): Buffer {
  const response = Buffer.alloc(5);
  response[0] = 0x01;
  response[1] = requestOpcode;
  response.writeUInt16LE(0x1234, 2);
  response[4] = errorCode;
  return response;
}

describe("Noble Raw HCI compatibility patch", () => {
  it("requests MTU 333 and writes a 330-byte value in one normal ATT Write Request", () => {
    patchHciPrototypes();

    const largerPeer = new FakeGatt(517);
    largerPeer.exchangeMtu();
    largerPeer.onAclStreamData(0x0004, largerPeer.response);
    expect(largerPeer.requestedMtus).to.deep.equal([333]);
    expect([...largerPeer.requests[0]]).to.deep.equal([0x02, 0x4d, 0x01]);
    expect(largerPeer._desired_mtu).to.equal(333);
    expect(largerPeer._mtu).to.equal(333);
    expect(largerPeer._mtu - 3).to.equal(330);
    expect(largerPeer.emitted).to.deep.equal([["mtu", "charger", 333]]);

    const hello = Buffer.alloc(330, 0x5a);
    largerPeer.write("service", "characteristic", hello, false);
    expect(largerPeer.requests[1]?.[0]).to.equal(0x12);
    expect(largerPeer.requests[1]?.length).to.equal(333);
    expect(largerPeer.requests[1]?.subarray(3).equals(hello)).to.equal(true);
  });

  it("uses the peer MTU when it is smaller than 333", () => {
    patchHciPrototypes();

    const smallerPeer = new FakeGatt(256);
    smallerPeer.exchangeMtu();
    smallerPeer.onAclStreamData(0x0004, smallerPeer.response);
    expect(smallerPeer.requestedMtus).to.deep.equal([333]);
    expect(smallerPeer._mtu).to.equal(256);
  });

  it("rejects a long write on a non-authentication ATT error and cancels its queue", async () => {
    patchHciPrototypes();

    const gatt = new FakeGatt(23);
    const bindings = new FakeHciBindings();
    gatt.on("write", (address, serviceUuid, characteristicUuid, error) => {
      bindings.onWrite(
        address as string,
        serviceUuid as string,
        characteristicUuid as string,
        error,
      );
    });
    const writeResult = new Promise<unknown>((resolve) => {
      bindings.on("write", (_id, _serviceUuid, _characteristicUuid, error) => {
        resolve(error);
      });
    });
    const observedResult = writeResult.then((error) => error);

    gatt.longWrite("service", "characteristic", Buffer.alloc(330), false);
    const queuedCommands = [gatt._currentCommand, ...gatt._commandQueue];
    const prepareCommands = queuedCommands.filter(
      (command) => command?.buffer[0] === 0x16,
    );
    expect(prepareCommands).to.have.length(19);
    expect(prepareCommands[0]?.buffer.length).to.equal(23);
    expect(prepareCommands[18]?.buffer.length).to.equal(11);
    expect(queuedCommands.at(-1)?.buffer).to.deep.equal(
      Buffer.from([0x18, 0x01]),
    );

    const firstPrepareResponse = Buffer.from(gatt._currentCommand!.buffer);
    firstPrepareResponse[0] = 0x17;
    gatt.onAclStreamData(0x0004, firstPrepareResponse);
    expect(gatt.requests).to.have.length(2);

    gatt.onAclStreamData(0x0004, attError(0x16, 0x09));
    const error = await observedResult;
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain(
      "ATT error 0x09 during long write",
    );
    expect(bindings.emitted[0]?.[1]).to.equal("peripheral-id");
    expect(gatt._commandQueue).to.have.length(0);
    expect(gatt._currentCommand?.buffer).to.deep.equal(
      Buffer.from([0x18, 0x00]),
    );
    expect(gatt.requests.map((request) => request[0])).to.deep.equal([
      0x16, 0x16, 0x18,
    ]);
    expect(gatt.requests[2]?.[1]).to.equal(0x00);

    gatt.onAclStreamData(0x0004, Buffer.from([0x19]));
    expect(gatt.requests.map((request) => request[0])).to.deep.equal([
      0x16, 0x16, 0x18,
    ]);
    expect(gatt._currentCommand).to.equal(null);
  });

  it("leaves ordinary Write Request error handling unchanged", () => {
    patchHciPrototypes();

    const gatt = new FakeGatt(23);
    const errorResponse = attError(0x12, 0x03);
    const emittedWrites: unknown[][] = [];
    gatt.on("write", (...args) => emittedWrites.push(args));
    gatt.write("service", "characteristic", Buffer.from([0x42]), false);
    gatt.onAclStreamData(0x0004, errorResponse);

    expect(gatt.lastWriteResponse).to.equal(errorResponse);
    expect(emittedWrites).to.deep.equal([]);
  });

  it("is idempotent and rejects an unsupported HCI GATT prototype clearly", () => {
    patchHciPrototypes();
    const patchedMethods = [
      FakeGatt.prototype.exchangeMtu,
      FakeGatt.prototype.longWrite,
      FakeGatt.prototype.onAclStreamData,
      FakeHciBindings.prototype.onWrite,
    ];
    patchHciPrototypes();
    expect([
      FakeGatt.prototype.exchangeMtu,
      FakeGatt.prototype.longWrite,
      FakeGatt.prototype.onAclStreamData,
      FakeHciBindings.prototype.onWrite,
    ]).to.deep.equal(patchedMethods);

    expect(() =>
      applyNobleHciMtuWorkaround("hci", {}, FakeHciBindings.prototype),
    ).to.throw(
      "Raw HCI ATT MTU workaround is incompatible with @stoprocent/noble",
    );
  });

  it("does nothing for bindings other than Raw HCI", () => {
    const unsupportedPrototype = {};
    expect(() =>
      applyNobleHciMtuWorkaround("dbus", unsupportedPrototype, {}),
    ).not.to.throw();
    expect(Reflect.ownKeys(unsupportedPrototype)).to.deep.equal([]);
  });
});
