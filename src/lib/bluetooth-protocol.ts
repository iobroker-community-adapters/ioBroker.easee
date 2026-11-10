import { createCipheriv, createHash, randomBytes } from "node:crypto";

export const BLUETOOTH_SERVICE_UUID = "be312306-9797-2ebc-c947-08eff95544bc";
export const BLUETOOTH_MANUFACTURER_ID = 3118;

export const BLUETOOTH_CHARACTERISTICS = {
  hello: "2f7b83db-ae66-d0be-ae45-78ecf4509b3d",
  command: "f4ef9f9e-540e-0497-1449-84fe940045be",
  config: "7d0b575a-5f58-cf9c-c442-2cacd56e4102",
  state: "992166b7-8cb3-fba7-9f4b-166fb352c50d",
} as const;

export type BluetoothChannel = keyof typeof BLUETOOTH_CHARACTERISTICS;
export type BluetoothValue = number | string | Buffer;

export interface BluetoothFrame {
  readonly type: "config" | "state";
  readonly fields: ReadonlyMap<number, BluetoothValue>;
  readonly named: Readonly<Record<string, BluetoothValue>>;
}

export class BluetoothProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BluetoothProtocolError";
  }
}

export class BluetoothAuthenticationError extends BluetoothProtocolError {
  constructor() {
    super("BLE authentication failed; check the configured PIN");
    this.name = "BluetoothAuthenticationError";
  }
}

export class BluetoothCommandRefusedError extends BluetoothProtocolError {
  readonly commandId: number;

  constructor(commandId: number) {
    super(`The charger refused BLE command ${commandId}`);
    this.name = "BluetoothCommandRefusedError";
    this.commandId = commandId;
  }
}

interface FieldDefinition {
  readonly id: number;
  readonly name: string;
  readonly unit?: string;
  readonly zeroWhenAbsent?: boolean;
}

export const CONFIG_FIELDS: readonly FieldDefinition[] = [
  { id: 1, name: "isEnabled", zeroWhenAbsent: true },
  { id: 2, name: "maxChargerCurrent", unit: "A", zeroWhenAbsent: true },
  { id: 3, name: "fallbackCircuitCurrentP1", unit: "A" },
  { id: 4, name: "fallbackCircuitCurrentP2", unit: "A" },
  { id: 5, name: "fallbackCircuitCurrentP3", unit: "A" },
  { id: 7, name: "phaseMode" },
  { id: 8, name: "circuitMaxCurrentP1", unit: "A" },
  { id: 9, name: "circuitMaxCurrentP2", unit: "A" },
  { id: 10, name: "circuitMaxCurrentP3", unit: "A" },
  { id: 11, name: "wifiSSID" },
  { id: 12, name: "enableIdleCurrent", zeroWhenAbsent: true },
  { id: 13, name: "ledStripBrightness", unit: "%" },
  { id: 14, name: "authorizationRequired", zeroWhenAbsent: true },
  { id: 18, name: "cableLocked", zeroWhenAbsent: true },
  { id: 19, name: "chargerFirmware" },
  { id: 20, name: "btEnableMode" },
];

export const STATE_FIELDS: readonly FieldDefinition[] = [
  { id: 2, name: "cableRating", unit: "A" },
  { id: 3, name: "lifetimeEnergy", unit: "kWh", zeroWhenAbsent: true },
  { id: 5, name: "reasonForNoCurrent", zeroWhenAbsent: true },
  { id: 11, name: "dynamicChargerCurrent", unit: "A", zeroWhenAbsent: true },
  { id: 12, name: "chargerOpMode" },
  { id: 14, name: "dynamicCircuitCurrentP1", unit: "A" },
  { id: 15, name: "dynamicCircuitCurrentP2", unit: "A" },
  { id: 16, name: "dynamicCircuitCurrentP3", unit: "A" },
  { id: 18, name: "totalPower", unit: "kW", zeroWhenAbsent: true },
  { id: 19, name: "sessionEnergy", unit: "kWh", zeroWhenAbsent: true },
  { id: 20, name: "energyPerHour", unit: "kWh", zeroWhenAbsent: true },
  { id: 22, name: "localRSSI", unit: "dBm" },
  { id: 25, name: "currentN", unit: "A", zeroWhenAbsent: true },
  { id: 26, name: "currentL1", unit: "A", zeroWhenAbsent: true },
  { id: 27, name: "currentL2", unit: "A", zeroWhenAbsent: true },
  { id: 28, name: "currentL3", unit: "A", zeroWhenAbsent: true },
  { id: 33, name: "voltageL1N", unit: "V" },
  { id: 34, name: "voltageL2N", unit: "V" },
  { id: 35, name: "voltageL3N", unit: "V" },
  { id: 36, name: "voltageL1L2", unit: "V" },
  { id: 37, name: "voltageL1L3", unit: "V" },
  { id: 38, name: "voltageL2L3", unit: "V" },
  { id: 43, name: "equalizerLimitL1", unit: "A" },
  { id: 44, name: "equalizerLimitL2", unit: "A" },
  { id: 45, name: "equalizerLimitL3", unit: "A" },
  { id: 46, name: "ledMode", zeroWhenAbsent: true },
];

export const BLUETOOTH_FIELD_UNITS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      [...CONFIG_FIELDS, ...STATE_FIELDS]
        .filter(
          (
            field,
          ): field is FieldDefinition & {
            unit: string;
          } => !!field.unit,
        )
        .map((field) => [field.name, field.unit]),
    ),
  );

const CONFIG_BY_ID = new Map(CONFIG_FIELDS.map((field) => [field.id, field]));
const STATE_BY_ID = new Map(STATE_FIELDS.map((field) => [field.id, field]));

function readVarint(
  data: Buffer,
  offset: number,
): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let index = offset;
  for (let count = 0; count < 10; count++) {
    if (index >= data.length) {
      throw new BluetoothProtocolError("Truncated protobuf varint");
    }
    const byte = data[index++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: index };
    }
    shift += 7n;
  }
  throw new BluetoothProtocolError("Protobuf varint is too long");
}

function decodeWireFields(data: Buffer): Map<number, BluetoothValue> {
  const fields = new Map<number, BluetoothValue>();
  let offset = 0;
  while (offset < data.length) {
    const key = readVarint(data, offset);
    offset = key.next;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    if (fieldNumber === 0) {
      throw new BluetoothProtocolError("Invalid protobuf field number 0");
    }

    switch (wireType) {
      case 0: {
        const decoded = readVarint(data, offset);
        offset = decoded.next;
        const signed =
          decoded.value >= 1n << 63n
            ? decoded.value - (1n << 64n)
            : decoded.value;
        fields.set(fieldNumber, Number(signed));
        break;
      }
      case 1:
        if (offset + 8 > data.length) {
          throw new BluetoothProtocolError("Truncated protobuf fixed64");
        }
        fields.set(fieldNumber, data.readDoubleLE(offset));
        offset += 8;
        break;
      case 2: {
        const length = readVarint(data, offset);
        offset = length.next;
        if (length.value > BigInt(data.length - offset)) {
          throw new BluetoothProtocolError("Truncated protobuf byte field");
        }
        const end = offset + Number(length.value);
        const bytes = data.subarray(offset, end);
        offset = end;
        const text = bytes.toString("utf8");
        fields.set(
          fieldNumber,
          Buffer.from(text, "utf8").equals(bytes) &&
            [...text].every(
              (char) =>
                char === "\n" || char === "\t" || char.charCodeAt(0) >= 32,
            )
            ? text
            : bytes,
        );
        break;
      }
      case 5:
        if (offset + 4 > data.length) {
          throw new BluetoothProtocolError("Truncated protobuf fixed32");
        }
        fields.set(fieldNumber, data.readFloatLE(offset));
        offset += 4;
        break;
      default:
        throw new BluetoothProtocolError(
          `Unsupported protobuf wire type ${wireType}`,
        );
    }
  }
  return fields;
}

export function parseBluetoothFrame(
  data: Buffer,
  expected?: "config" | "state",
): BluetoothFrame {
  if (data.length < 6) {
    throw new BluetoothProtocolError(
      "BLE frame is shorter than its 6-byte header",
    );
  }
  if (data[0] !== 0) {
    throw new BluetoothProtocolError("Unexpected BLE frame header");
  }
  const typeId = data[1];
  const type =
    typeId === 0x40 ? "config" : typeId === 0x41 ? "state" : undefined;
  if (!type || (expected && type !== expected)) {
    throw new BluetoothProtocolError(
      "Unexpected or unsupported BLE frame type",
    );
  }
  const declaredLength = data.readUInt16BE(4);
  if (declaredLength !== data.length) {
    throw new BluetoothProtocolError(
      declaredLength > data.length
        ? "Incomplete BLE frame"
        : "BLE frame length mismatch",
    );
  }

  const fields = decodeWireFields(data.subarray(6));
  const definitions = type === "config" ? CONFIG_BY_ID : STATE_BY_ID;
  const named: Record<string, BluetoothValue> = {};
  for (const [id, value] of fields) {
    const definition = definitions.get(id);
    if (definition) {
      named[definition.name] = value;
    }
  }
  for (const definition of type === "config" ? CONFIG_FIELDS : STATE_FIELDS) {
    if (definition.zeroWhenAbsent && !(definition.name in named)) {
      named[definition.name] = 0;
    }
  }
  return { type, fields, named };
}

export interface BluetoothCommandResult {
  readonly id?: number;
  readonly code?: number;
  readonly [key: string]: unknown;
}

export type BluetoothCommand =
  | {
      readonly type: "reboot";
    }
  | {
      readonly type: "setEnabled";
      readonly enabled: boolean;
    }
  | {
      readonly type: "setMaxChargerCurrent";
      readonly amperes: number;
    }
  | {
      readonly type: "setDynamicChargerCurrent";
      readonly amperes: number;
    }
  | {
      readonly type: "pauseCharging";
    }
  | {
      readonly type: "resumeCharging";
      readonly amperes: number;
    }
  | {
      readonly type: "setMaxCircuitCurrent";
      readonly amperes: number | readonly [number, number, number];
    }
  | {
      readonly type: "setDynamicCircuitCurrent";
      readonly amperes: number | readonly [number, number, number];
    }
  | {
      readonly type: "setCableLocked";
      readonly locked: boolean;
    }
  | {
      readonly type: "setLocalAuthorization";
      readonly required: boolean;
    }
  | {
      readonly type: "setIdleCurrent";
      readonly enabled: boolean;
    }
  | {
      readonly type: "setPhaseMode";
      readonly mode: 1 | 2 | 3;
    }
  | {
      readonly type: "setLedBrightness";
      readonly percent: number;
    };

interface EncodedCommand {
  readonly id: number;
  readonly payload: Buffer;
}

function assertAmperes(value: number, allowZero = true): void {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 40) {
    throw new RangeError(
      `Current must be an integer between ${allowZero ? 0 : 1} and 40 A`,
    );
  }
}

function commandPayload(
  id: number,
  values?: readonly (string | number | boolean)[],
): Buffer {
  if (!values) {
    return Buffer.from(JSON.stringify({ Id: id }));
  }
  return Buffer.from(
    JSON.stringify({
      Id: id,
      Arguments: values.map((value, index) => ({
        Id: index + 1,
        Value: typeof value === "boolean" ? String(value) : String(value),
      })),
    }),
  );
}

export function encodeBluetoothCommand(
  command: BluetoothCommand,
): EncodedCommand {
  switch (command.type) {
    case "reboot":
      return { id: 1, payload: commandPayload(1) };
    case "setEnabled":
      return { id: 29, payload: commandPayload(29, [command.enabled]) };
    case "setMaxChargerCurrent":
      assertAmperes(command.amperes);
      return { id: 47, payload: commandPayload(47, [command.amperes]) };
    case "setDynamicChargerCurrent":
      assertAmperes(command.amperes);
      return { id: 48, payload: commandPayload(48, [command.amperes]) };
    case "pauseCharging":
      return { id: 48, payload: commandPayload(48, [0]) };
    case "resumeCharging":
      assertAmperes(command.amperes, false);
      return { id: 48, payload: commandPayload(48, [command.amperes]) };
    case "setMaxCircuitCurrent":
    case "setDynamicCircuitCurrent": {
      const id = command.type === "setMaxCircuitCurrent" ? 24 : 22;
      const values =
        typeof command.amperes === "number"
          ? [command.amperes]
          : [...command.amperes];
      if (values.length !== 1 && values.length !== 3) {
        throw new RangeError(
          "Provide one common current or one current for each of three phases",
        );
      }
      values.forEach((value) => assertAmperes(value));
      return { id, payload: commandPayload(id, values) };
    }
    case "setCableLocked":
      return { id: 30, payload: commandPayload(30, [command.locked]) };
    case "setLocalAuthorization":
      return { id: 33, payload: commandPayload(33, [command.required]) };
    case "setIdleCurrent":
      return { id: 34, payload: commandPayload(34, [command.enabled]) };
    case "setPhaseMode":
      if (![1, 2, 3].includes(command.mode)) {
        throw new RangeError("Phase mode must be 1, 2 or 3");
      }
      return { id: 38, payload: commandPayload(38, [command.mode]) };
    case "setLedBrightness":
      if (
        !Number.isInteger(command.percent) ||
        command.percent < 0 ||
        command.percent > 100
      ) {
        throw new RangeError(
          "LED brightness must be an integer between 0 and 100 percent",
        );
      }
      return { id: 40, payload: commandPayload(40, [command.percent]) };
  }
}

export function parseBluetoothCommandReply(
  data: Buffer,
): BluetoothCommandResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch {
    throw new BluetoothProtocolError("Invalid JSON in BLE command response");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BluetoothProtocolError("BLE command response is not an object");
  }
  return parsed as BluetoothCommandResult;
}

export function assertBluetoothCommandAccepted(
  reply: BluetoothCommandResult,
  expectedCommandId: number,
): void {
  if (reply.id !== undefined && reply.id !== expectedCommandId) {
    throw new BluetoothProtocolError(
      "BLE command response does not match the request",
    );
  }
  if (reply.code !== 1) {
    throw new BluetoothCommandRefusedError(expectedCommandId);
  }
}

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const G: Point = {
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};
type Point = { readonly x: bigint; readonly y: bigint };
type Jacobian = { readonly x: bigint; readonly y: bigint; readonly z: bigint };

function mod(value: bigint, modulus = P): bigint {
  const reduced = value % modulus;
  return reduced < 0n ? reduced + modulus : reduced;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = mod(base, modulus);
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) {
      result = (result * value) % modulus;
    }
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

function inverse(value: bigint): bigint {
  if (value === 0n) {
    throw new BluetoothAuthenticationError();
  }
  return modPow(value, P - 2n, P);
}

function toAffine(point: Jacobian): Point | null {
  if (point.z === 0n) {
    return null;
  }
  const zInv = inverse(point.z);
  const z2 = mod(zInv * zInv);
  return { x: mod(point.x * z2), y: mod(point.y * z2 * zInv) };
}

function addMixed(point: Jacobian, other: Point): Jacobian {
  if (point.z === 0n) {
    return { x: other.x, y: other.y, z: 1n };
  }
  const z2 = mod(point.z * point.z);
  const u2 = mod(other.x * z2);
  const s2 = mod(other.y * point.z * z2);
  const h = mod(u2 - point.x);
  const r0 = mod(s2 - point.y);
  if (h === 0n) {
    if (r0 === 0n) {
      return doublePoint(point);
    }
    return { x: 0n, y: 1n, z: 0n };
  }
  const hh = mod(h * h);
  const i = mod(4n * hh);
  const j = mod(h * i);
  const r = mod(2n * r0);
  const v = mod(point.x * i);
  const x = mod(r * r - j - 2n * v);
  const y = mod(r * (v - x) - 2n * point.y * j);
  const z = mod((point.z + h) * (point.z + h) - z2 - hh);
  return { x, y, z };
}

function doublePoint(point: Jacobian): Jacobian {
  if (point.z === 0n || point.y === 0n) {
    return { x: 0n, y: 1n, z: 0n };
  }
  const delta = mod(point.z * point.z);
  const gamma = mod(point.y * point.y);
  const beta = mod(point.x * gamma);
  const alpha = mod(3n * (point.x - delta) * (point.x + delta));
  const x = mod(alpha * alpha - 8n * beta);
  const z = mod((point.y + point.z) * (point.y + point.z) - gamma - delta);
  const y = mod(alpha * (4n * beta - x) - 8n * gamma * gamma);
  return { x, y, z };
}

function multiply(scalar: bigint, point: Point): Point | null {
  const value = mod(scalar, N);
  let result: Jacobian = { x: 0n, y: 1n, z: 0n };
  for (const bit of value.toString(2)) {
    result = doublePoint(result);
    if (bit === "1") {
      result = addMixed(result, point);
    }
  }
  return toAffine(result);
}

function addPoints(left: Point | null, right: Point | null): Point | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (left.x === right.x && mod(left.y + right.y) === 0n) {
    return null;
  }
  const slope =
    left.x === right.x
      ? mod((3n * left.x * left.x + A) * inverse(2n * left.y))
      : mod((right.y - left.y) * inverse(right.x - left.x));
  const x = mod(slope * slope - left.x - right.x);
  return { x, y: mod(slope * (left.x - x) - left.y) };
}

function scaleAndAdd(
  a: bigint,
  left: Point,
  b: bigint,
  right: Point,
): Point | null {
  return addPoints(multiply(a, left), multiply(b, right));
}

function fixed32(value: bigint): Buffer {
  const result = Buffer.alloc(32);
  let remaining = value;
  for (let index = 31; index >= 0; index--) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

function pointBytes(point: Point): Buffer {
  return Buffer.concat([Buffer.from([4]), fixed32(point.x), fixed32(point.y)]);
}

function readPoint(
  data: Buffer,
  offset: number,
): { point: Point; next: number } {
  if (offset >= data.length) {
    throw new BluetoothAuthenticationError();
  }
  const length = data[offset];
  const start = offset + 1;
  if (length !== 65 || data[start] !== 4 || start + length > data.length) {
    throw new BluetoothAuthenticationError();
  }
  const x = BigInt(`0x${data.subarray(start + 1, start + 33).toString("hex")}`);
  const y = BigInt(
    `0x${data.subarray(start + 33, start + 65).toString("hex")}`,
  );
  if (
    x >= P ||
    y >= P ||
    mod(
      y * y -
        (x * x * x +
          A * x +
          0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn),
    ) !== 0n
  ) {
    throw new BluetoothAuthenticationError();
  }
  return { point: { x, y }, next: start + length };
}

function minimalBytes(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, "hex");
}

function writeTlsPoint(point: Point): Buffer {
  const raw = pointBytes(point);
  return Buffer.concat([Buffer.from([raw.length]), raw]);
}

function readTlsPoint(
  data: Buffer,
  offset: number,
): { point: Point; next: number } {
  return readPoint(data, offset);
}

function zkpHash(
  base: Point,
  commitment: Point,
  publicPoint: Point,
  role: string,
): bigint {
  const identity = Buffer.from(role, "utf8");
  const parts = [base, commitment, publicPoint].map((point) => {
    const encoded = pointBytes(point);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encoded.length);
    return Buffer.concat([length, encoded]);
  });
  const identityLength = Buffer.alloc(4);
  identityLength.writeUInt32BE(identity.length);
  const digest = createHash("sha256")
    .update(Buffer.concat([...parts, identityLength, identity]))
    .digest();
  return BigInt(`0x${digest.toString("hex")}`) % N;
}

type RandomSource = (size: number) => Buffer;

function randomScalar(random: RandomSource): bigint {
  for (;;) {
    const candidate = BigInt(`0x${random(32).toString("hex")}`);
    if (candidate > 0n && candidate < N) {
      return candidate;
    }
  }
}

function proof(
  base: Point,
  secret: bigint,
  publicPoint: Point,
  role: string,
  random: RandomSource,
): Buffer {
  const nonce = randomScalar(random);
  const commitment = multiply(nonce, base)!;
  const challenge = zkpHash(base, commitment, publicPoint, role);
  const response = mod(nonce - secret * challenge, N);
  const responseBytes = minimalBytes(response);
  return Buffer.concat([
    writeTlsPoint(commitment),
    Buffer.from([responseBytes.length]),
    responseBytes,
  ]);
}

function readProof(
  base: Point,
  publicPoint: Point,
  role: string,
  data: Buffer,
  offset: number,
): number {
  const parsed = readTlsPoint(data, offset);
  offset = parsed.next;
  if (offset >= data.length) {
    throw new BluetoothAuthenticationError();
  }
  const length = data[offset++];
  if (length === 0 || offset + length > data.length) {
    throw new BluetoothAuthenticationError();
  }
  const response = BigInt(
    `0x${data.subarray(offset, offset + length).toString("hex")}`,
  );
  if (response >= N) {
    throw new BluetoothAuthenticationError();
  }
  const challenge = zkpHash(base, parsed.point, publicPoint, role);
  const verified = scaleAndAdd(challenge, publicPoint, response, base);
  if (!verified) {
    throw new BluetoothAuthenticationError();
  }
  if (verified.x !== parsed.point.x || verified.y !== parsed.point.y) {
    throw new BluetoothAuthenticationError();
  }
  return offset + length;
}

function writeKeyProof(
  base: Point,
  role: string,
  random: RandomSource,
): {
  readonly secret: bigint;
  readonly publicPoint: Point;
  readonly bytes: Buffer;
} {
  const secret = randomScalar(random);
  const publicPoint = multiply(secret, base)!;
  return {
    secret,
    publicPoint,
    bytes: Buffer.concat([
      writeTlsPoint(publicPoint),
      proof(base, secret, publicPoint, role, random),
    ]),
  };
}

function readKeyProof(
  base: Point,
  role: string,
  data: Buffer,
  offset: number,
): {
  readonly point: Point;
  readonly next: number;
} {
  const parsed = readTlsPoint(data, offset);
  return {
    point: parsed.point,
    next: readProof(base, parsed.point, role, data, parsed.next),
  };
}

interface HandshakeRound {
  readonly bytes: Buffer;
  readonly points: readonly [Point, Point];
  readonly secrets: readonly [bigint, bigint];
}

export class BluetoothHandshake {
  private readonly pin: bigint;
  private readonly role: "client" | "server";
  private readonly peerRole: "client" | "server";
  private readonly random: RandomSource;
  private roundOne?: HandshakeRound;
  private peerFirst?: Point;
  private peerSecond?: Point;

  constructor(
    pin: string,
    role: "client" | "server" = "client",
    random: RandomSource = randomBytes,
  ) {
    if (pin.length === 0) {
      throw new RangeError("BLE PIN must not be empty");
    }
    this.pin = BigInt(`0x${Buffer.from(pin, "utf8").toString("hex")}`);
    this.role = role;
    this.peerRole = role === "client" ? "server" : "client";
    this.random = random;
  }

  createRoundOne(): Buffer {
    const first = writeKeyProof(G, this.role, this.random);
    const second = writeKeyProof(G, this.role, this.random);
    this.roundOne = {
      bytes: Buffer.concat([first.bytes, second.bytes]),
      points: [first.publicPoint, second.publicPoint],
      secrets: [first.secret, second.secret],
    };
    return this.roundOne.bytes;
  }

  acceptRoundOne(data: Buffer): Buffer {
    if (!this.roundOne) {
      throw new BluetoothAuthenticationError();
    }
    const first = readKeyProof(G, this.peerRole, data, 0);
    const second = readKeyProof(G, this.peerRole, data, first.next);
    if (second.next !== data.length) {
      throw new BluetoothAuthenticationError();
    }
    this.peerFirst = first.point;
    this.peerSecond = second.point;
    const base = addPoints(
      addPoints(first.point, second.point),
      this.roundOne.points[0],
    );
    if (!base) {
      throw new BluetoothAuthenticationError();
    }
    const secret = mod(this.roundOne.secrets[1] * this.pin, N);
    const publicPoint = multiply(secret, base);
    if (!publicPoint) {
      throw new BluetoothAuthenticationError();
    }
    const serverParameters =
      this.role === "server" ? Buffer.from([3, 0, 23]) : Buffer.alloc(0);
    return Buffer.concat([
      serverParameters,
      writeTlsPoint(publicPoint),
      proof(base, secret, publicPoint, this.role, this.random),
    ]);
  }

  acceptRoundTwo(data: Buffer): Buffer {
    const first = this.roundOne;
    const peerFirst = this.peerFirst;
    const peerSecond = this.peerSecond;
    if (!first || !peerFirst || !peerSecond) {
      throw new BluetoothAuthenticationError();
    }
    let offset = 0;
    if (this.role === "client") {
      if (data.length < 3 || data[0] !== 3 || data.readUInt16BE(1) !== 23) {
        throw new BluetoothAuthenticationError();
      }
      offset = 3;
    }
    const base = addPoints(
      addPoints(first.points[0], first.points[1]),
      peerFirst,
    );
    if (!base) {
      throw new BluetoothAuthenticationError();
    }
    const peer = readKeyProof(base, this.peerRole, data, offset);
    if (peer.next !== data.length) {
      throw new BluetoothAuthenticationError();
    }
    const sharedScalar = mod(first.secrets[1] * this.pin, N);
    const inversePoint = multiply(-sharedScalar, peerSecond);
    const intermediate = addPoints(peer.point, inversePoint);
    const shared = intermediate
      ? multiply(first.secrets[1], intermediate)
      : null;
    if (!shared) {
      throw new BluetoothAuthenticationError();
    }
    return createHash("sha256").update(fixed32(shared.x)).digest();
  }
}

export function encryptBluetoothRequest(
  key: Buffer,
  plaintext: Buffer,
): Buffer {
  if (key.length !== 32) {
    throw new BluetoothProtocolError("Invalid BLE session key length");
  }
  const nonce = randomBytes(4);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(
    Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("hex"),
    "ascii",
  );
}

export function createBluetoothReadRequest(
  uid: number,
  serial: string,
): Buffer {
  return Buffer.from(JSON.stringify({ uid, sn: serial }));
}
