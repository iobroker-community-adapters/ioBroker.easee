"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import { randomBytes } from "node:crypto";
import {
  BLUETOOTH_CHARACTERISTICS,
  BLUETOOTH_FIELD_UNITS,
  BLUETOOTH_MANUFACTURER_ID,
  BLUETOOTH_SERVICE_UUID,
  BluetoothCommandRefusedError,
  BluetoothHandshake,
  BluetoothProtocolError,
  assertBluetoothCommandAccepted,
  encodeBluetoothCommand,
  parseBluetoothCommandReply,
  parseBluetoothFrame,
} from "../src/lib/bluetooth-protocol.ts";

function varint(value: bigint): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7fn) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Buffer.from(bytes);
}

function fieldVarint(id: number, value: bigint): Buffer {
  return Buffer.concat([varint(BigInt(id << 3)), varint(value)]);
}

function fieldString(id: number, value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([
    varint(BigInt((id << 3) | 2)),
    varint(BigInt(bytes.length)),
    bytes,
  ]);
}

function frame(type: "config" | "state", payload: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header[0] = 0;
  header[1] = type === "config" ? 0x40 : 0x41;
  header.writeUInt16BE(header.length + payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("Easee BLE protocol", () => {
  it("defines only the supported service and channel UUIDs", () => {
    expect(BLUETOOTH_SERVICE_UUID).to.equal(
      "be312306-9797-2ebc-c947-08eff95544bc",
    );
    expect(BLUETOOTH_MANUFACTURER_ID).to.equal(3118);
    expect(BLUETOOTH_CHARACTERISTICS).to.deep.equal({
      hello: "2f7b83db-ae66-d0be-ae45-78ecf4509b3d",
      command: "f4ef9f9e-540e-0497-1449-84fe940045be",
      config: "7d0b575a-5f58-cf9c-c442-2cacd56e4102",
      state: "992166b7-8cb3-fba7-9f4b-166fb352c50d",
    });
  });

  it("maps confirmed config fields, units and zero-when-absent defaults", () => {
    const config = parseBluetoothFrame(
      frame(
        "config",
        Buffer.concat([
          fieldVarint(1, 1n),
          fieldVarint(2, 32n),
          fieldVarint(7, 2n),
          fieldString(11, "Garage Wi-Fi"),
          fieldString(19, "1.2"),
          fieldVarint(90, 99n),
        ]),
      ),
    );
    expect(config.named).to.include({
      isEnabled: 1,
      maxChargerCurrent: 32,
      phaseMode: 2,
      wifiSSID: "Garage Wi-Fi",
      chargerFirmware: "1.2",
      enableIdleCurrent: 0,
      authorizationRequired: 0,
      cableLocked: 0,
    });
    expect(config.named).not.to.have.property("field90");
    expect(config.named).not.to.have.property("wifiPassword");
    expect(BLUETOOTH_FIELD_UNITS.maxChargerCurrent).to.equal("A");
    expect(BLUETOOTH_FIELD_UNITS.ledStripBrightness).to.equal("%");
    expect(config.named).not.to.have.property("ocppEnabled");
  });

  it("decodes state units, signed RSSI and absent defaults without inventing fields", () => {
    const signedRssi = BigInt.asUintN(64, -61n);
    const currentFloat = Buffer.alloc(4);
    currentFloat.writeFloatLE(16.25);
    const payload = Buffer.concat([
      fieldVarint(3, 1250n),
      fieldVarint(22, signedRssi),
      fieldVarint(25, 0n),
      varint((26n << 3n) | 5n),
      currentFloat,
      fieldVarint(36, 231n),
      fieldVarint(70, 7n),
    ]);
    const state = parseBluetoothFrame(frame("state", payload));
    expect(state.named).to.include({
      lifetimeEnergy: 1250,
      localRSSI: -61,
      currentN: 0,
      currentL1: 16.25,
    });
    expect(state.named).to.have.property("currentL2", 0);
    expect(state.named).to.have.property("reasonForNoCurrent", 0);
    expect(state.named).not.to.have.property("wifiRSSI");
    expect(state.named).to.have.property("voltageL1L2", 231);
    expect(state.fields.get(36)).to.equal(231);
    expect(BLUETOOTH_FIELD_UNITS.totalPower).to.equal("kW");
    expect(BLUETOOTH_FIELD_UNITS.voltageL1N).to.equal("V");
  });

  it("rejects malformed, truncated and wrong-channel frames", () => {
    const valid = frame("state", fieldVarint(3, 1n));
    expect(() => parseBluetoothFrame(valid, "config")).to.throw(
      BluetoothProtocolError,
    );
    expect(() => parseBluetoothFrame(valid.subarray(0, 5))).to.throw(
      BluetoothProtocolError,
    );
    const badLength = Buffer.from(valid);
    badLength.writeUInt16BE(valid.length + 1, 4);
    expect(() => parseBluetoothFrame(badLength)).to.throw(
      "Incomplete BLE frame",
    );
    expect(() =>
      parseBluetoothFrame(frame("state", Buffer.from([0x08, 0x80]))),
    ).to.throw(BluetoothProtocolError);
  });

  it("serializes verified commands with protocol IDs and bounded values", () => {
    const max = encodeBluetoothCommand({
      type: "setMaxChargerCurrent",
      amperes: 40,
    });
    expect(max.id).to.equal(47);
    expect(JSON.parse(max.payload.toString())).to.deep.equal({
      Id: 47,
      Arguments: [{ Id: 1, Value: "40" }],
    });
    expect(encodeBluetoothCommand({ type: "pauseCharging" })).to.deep.equal({
      id: 48,
      payload: Buffer.from('{"Id":48,"Arguments":[{"Id":1,"Value":"0"}]}'),
    });
    expect(
      encodeBluetoothCommand({
        type: "setEnabled",
        enabled: false,
      }).payload.toString(),
    ).to.equal('{"Id":29,"Arguments":[{"Id":1,"Value":"false"}]}');
    const phases = encodeBluetoothCommand({
      type: "setDynamicCircuitCurrent",
      amperes: [16, 20, 32],
    });
    expect(phases.id).to.equal(22);
    expect(JSON.parse(phases.payload.toString()).Arguments).to.deep.equal([
      { Id: 1, Value: "16" },
      { Id: 2, Value: "20" },
      { Id: 3, Value: "32" },
    ]);
    expect(() =>
      encodeBluetoothCommand({ type: "resumeCharging", amperes: 0 }),
    ).to.throw(RangeError);
    expect(() =>
      encodeBluetoothCommand({ type: "setMaxChargerCurrent", amperes: 41 }),
    ).to.throw(RangeError);
    expect(() =>
      encodeBluetoothCommand({ type: "setLedBrightness", percent: 101 }),
    ).to.throw(RangeError);
  });

  it("requires a positive command acknowledgement, not just a reply", () => {
    expect(() =>
      assertBluetoothCommandAccepted({ id: 29, code: 1 }, 29),
    ).not.to.throw();
    expect(() =>
      assertBluetoothCommandAccepted({ id: 29, code: 0 }, 29),
    ).to.throw(BluetoothCommandRefusedError);
    expect(() =>
      assertBluetoothCommandAccepted({ id: 30, code: 1 }, 29),
    ).to.throw(BluetoothProtocolError);
    expect(
      parseBluetoothCommandReply(Buffer.from('{"id":47,"code":1}')),
    ).to.deep.equal({
      id: 47,
      code: 1,
    });
  });

  it("rejects invalid authentication exchange data without exposing the PIN", () => {
    const handshake = new BluetoothHandshake("1234");
    expect(handshake.createRoundOne().length).to.be.greaterThan(100);
    expect(() => handshake.acceptRoundOne(Buffer.from("invalid"))).to.throw(
      "BLE authentication failed; check the configured PIN",
    );
  });

  it("derives matching EC-JPAKE keys and separates sessions when PINs differ", () => {
    const clientHandshake = new BluetoothHandshake("1234");
    const serverHandshake = new BluetoothHandshake("1234", "server");
    const clientRoundOne = clientHandshake.createRoundOne();
    const serverRoundOne = serverHandshake.createRoundOne();
    const clientRoundTwo = clientHandshake.acceptRoundOne(serverRoundOne);
    const serverRoundTwo = serverHandshake.acceptRoundOne(clientRoundOne);
    const clientKey = clientHandshake.acceptRoundTwo(serverRoundTwo);
    const serverKey = serverHandshake.acceptRoundTwo(clientRoundTwo);
    expect(clientKey).to.deep.equal(serverKey);
    expect(clientKey).to.have.length(32);

    const wrongPinClient = new BluetoothHandshake("9999");
    const wrongPinServer = new BluetoothHandshake("1234", "server");
    const wrongClientRoundOne = wrongPinClient.createRoundOne();
    const wrongServerRoundOne = wrongPinServer.createRoundOne();
    const wrongClientRoundTwo =
      wrongPinClient.acceptRoundOne(wrongServerRoundOne);
    const wrongServerRoundTwo =
      wrongPinServer.acceptRoundOne(wrongClientRoundOne);
    expect(
      wrongPinClient.acceptRoundTwo(wrongServerRoundTwo),
    ).not.to.deep.equal(wrongPinServer.acceptRoundTwo(wrongClientRoundTwo));
  });

  it("matches the mbedTLS P-256 EC-JPAKE session-key vector", () => {
    const scalars = new Map([
      [
        0,
        Buffer.from(
          "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f21",
          "hex",
        ),
      ],
      [
        2,
        Buffer.from(
          "6162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f81",
          "hex",
        ),
      ],
    ]);
    let randomCall = 0;
    const deterministicRandom = (size: number): Buffer => {
      const scalar = scalars.get(randomCall);
      randomCall++;
      return scalar ?? randomBytes(size);
    };
    const handshake = new BluetoothHandshake(
      "threadjpaketest",
      "client",
      deterministicRandom,
    );
    handshake.createRoundOne();
    const serverRoundOne = Buffer.from(
      "41047ea6e3a4487037a9e0dbd79262b2cc273e779930fc18409ac5361c5fe669d702e147790aeb4ce7fd6575ab0f6c7fd1c335939aa863ba37ec91b7e32bb013bb2b410409f85b3d20ebd7885ce464c08d056d6428fe4dd9287aa365f131f4360ff386d846898bc4b41583c2a5197f65d78742746c12a5ec0a4ffe2f270a750a1d8fb51620934d74eb43e54df424fd96306c0117bf131afabf90a9d33d1198d905193735144104190a07700ffa4be6ae1d79ee0f06aeb544cd5addaabedf70f8623321332c54f355f0fbfec783ed359e5d0bf7377a0fc4ea7ace473c9c112b41ccd41ac56a56124104360a1cea33fce641156458e0a4eac219e96831e6aebc88b3f3752f93a0281d1bf1fb106051db9694a8d6e862a5ef1324a3d9e27894f1ee4f7c59199965a8dd4a2091847d2d22df3ee55faa2a3fb33fd2d1e055a07a7c61ecfb8d80ec00c2c9eb12",
      "hex",
    );
    const serverRoundTwo = Buffer.from(
      "03001741040fb22b1d5d1123e0ef9feb9d8a2e590a1f4d7ced2c2b06586e8f2a16d4eb2fda4328a20b07d8fd667654ca18c54e32a333a0845451e926ee8804fd7af0aaa7a641045516ea3e54a0d5d8b2ce786b38d383370029a5dbe4459c9dd601b408a24ae6465c8ac905b9eb03b5d3691c139ef83f1cd4200f6c9cd4ec392218a59ed243d3c820ff724a9a70b88cb86f20b434c6865aa1cd7906dd7c9bce3525f508276f26836c",
      "hex",
    );
    const clientRoundTwo = handshake.acceptRoundOne(serverRoundOne);
    expect(clientRoundTwo.length).to.be.greaterThan(100);
    const key = handshake.acceptRoundTwo(serverRoundTwo);
    expect(key.toString("hex")).to.equal(
      "f3d47f599844db92a569bbe7981e39d931fd743bf22e98f9b438f719d3c4f351",
    );
  });
});
