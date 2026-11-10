const ATT_CID = 0x0004;
const ATT_OP_ERROR = 0x01;
const ATT_OP_MTU_RESP = 0x03;
const ATT_OP_PREPARE_WRITE_REQ = 0x16;
const ATT_OP_PREPARE_WRITE_RESP = 0x17;
const ATT_OP_EXECUTE_WRITE_REQ = 0x18;
const ATT_ECODE_AUTHENTICATION = 0x05;
const ATT_ECODE_AUTHORIZATION = 0x08;
const ATT_ECODE_INSUFF_ENC = 0x0f;
const REQUESTED_ATT_MTU = 333;
const PATCHED = Symbol.for("iobroker.easee.noble-hci-mtu-workaround");

type NobleHciQueuedCommand = {
  buffer: Buffer;
  callback: ((response: Buffer) => void) | null;
  writeCallback: (() => void) | null;
};

type LongWriteContext = {
  serviceUuid: string;
  characteristicUuid: string;
  handle: number;
  successfulPrepareWrites: number;
  failed: boolean;
};

type NobleHciGattInstance = {
  readonly _address: string;
  _desired_mtu: number;
  _mtu: number;
  _commandQueue: NobleHciQueuedCommand[];
  _currentCommand: NobleHciQueuedCommand | null;
  _characteristics: Record<string, Record<string, { valueHandle: number }>>;
  _queueCommand: (
    request: Buffer,
    callback?: ((response: Buffer) => void) | null,
    writeCallback?: (() => void) | null,
  ) => void;
  executeWriteRequest: (
    handle: number,
    cancelPreparedWrites: boolean,
  ) => Buffer;
  mtuRequest: (requestedMtu: number) => Buffer;
  writeAtt: (request: Buffer) => void;
  onAclStreamData: (cid: number, data: Buffer) => void;
  emit: (event: string, ...args: unknown[]) => unknown;
};

type NobleHciBindingsInstance = {
  addressToId: (address: string) => string;
  emit: (event: string, ...args: unknown[]) => unknown;
};

type PatchRecord = {
  bindingPrototype: object;
  exchangeMtu: unknown;
  longWrite: unknown;
  onAclStreamData: unknown;
  onWrite: unknown;
};

function startQueuedCommands(gatt: NobleHciGattInstance): void {
  while (gatt._commandQueue.length > 0) {
    gatt._currentCommand = gatt._commandQueue.shift() ?? null;
    if (!gatt._currentCommand) {
      return;
    }

    gatt.writeAtt(gatt._currentCommand.buffer);
    if (gatt._currentCommand.callback) {
      break;
    }
    if (gatt._currentCommand.writeCallback) {
      gatt._currentCommand.writeCallback();
    }
    gatt._currentCommand = null;
  }
}

/**
 * Applies Raw-HCI-only ATT MTU and long-write compatibility fixes to Noble's private prototypes.
 *
 * @param binding Selected Noble binding.
 * @param gattPrototype Noble HCI GATT prototype loaded from its private module.
 * @param bindingsPrototype Noble HCI bindings prototype loaded from its private module.
 */
export function applyNobleHciMtuWorkaround(
  binding: string,
  gattPrototype: unknown,
  bindingsPrototype?: unknown,
): void {
  if (binding !== "hci") {
    return;
  }

  if (
    !gattPrototype ||
    (typeof gattPrototype !== "object" && typeof gattPrototype !== "function")
  ) {
    throw new Error(
      "Raw HCI ATT MTU workaround is incompatible with @stoprocent/noble: the HCI GATT prototype is unavailable",
    );
  }
  if (
    !bindingsPrototype ||
    (typeof bindingsPrototype !== "object" &&
      typeof bindingsPrototype !== "function")
  ) {
    throw new Error(
      "Raw HCI ATT MTU workaround is incompatible with @stoprocent/noble: the HCI bindings prototype is unavailable",
    );
  }

  const prototype = gattPrototype as Record<PropertyKey, unknown>;
  const hciBindingsPrototype = bindingsPrototype as Record<
    PropertyKey,
    unknown
  >;
  const requiredGattMethods = [
    "exchangeMtu",
    "mtuRequest",
    "_queueCommand",
    "longWrite",
    "onAclStreamData",
    "executeWriteRequest",
    "writeAtt",
  ];
  const missingMethods = requiredGattMethods.filter(
    (method) => typeof prototype[method] !== "function",
  );
  if (typeof prototype.emit !== "function") {
    missingMethods.push("emit");
  }
  const requiredBindingsMethods = ["onWrite", "addressToId", "emit"];
  missingMethods.push(
    ...requiredBindingsMethods
      .filter((method) => typeof hciBindingsPrototype[method] !== "function")
      .map((method) => `bindings.${method}`),
  );
  if (missingMethods.length > 0) {
    throw new Error(
      `Raw HCI ATT MTU workaround is incompatible with @stoprocent/noble: missing or changed HCI methods: ${missingMethods.join(", ")}`,
    );
  }

  const previousPatch = prototype[PATCHED] as PatchRecord | undefined;
  if (previousPatch !== undefined) {
    if (
      prototype.exchangeMtu === previousPatch.exchangeMtu &&
      prototype.longWrite === previousPatch.longWrite &&
      prototype.onAclStreamData === previousPatch.onAclStreamData &&
      previousPatch.bindingPrototype === hciBindingsPrototype &&
      hciBindingsPrototype.onWrite === previousPatch.onWrite
    ) {
      return;
    }
    throw new Error(
      "Raw HCI ATT MTU workaround is incompatible with @stoprocent/noble: a patched HCI method has changed",
    );
  }

  const methodNames = [
    [prototype, "exchangeMtu"],
    [prototype, "longWrite"],
    [prototype, "onAclStreamData"],
    [hciBindingsPrototype, "onWrite"],
  ] as const;
  for (const [target, method] of methodNames) {
    const descriptor = Object.getOwnPropertyDescriptor(target, method);
    if (
      !descriptor ||
      typeof descriptor.value !== "function" ||
      (!descriptor.writable && !descriptor.configurable)
    ) {
      throw new Error(
        `Raw HCI ATT MTU workaround is incompatible with @stoprocent/noble: ${method} cannot be safely patched`,
      );
    }
  }
  if (!Object.isExtensible(prototype)) {
    throw new Error(
      "Raw HCI ATT MTU workaround is incompatible with @stoprocent/noble: HCI GATT prototype cannot be safely patched",
    );
  }

  const commandContexts = new WeakMap<Buffer, LongWriteContext>();
  const exchangeMtu = function (this: NobleHciGattInstance): void {
    this._desired_mtu = REQUESTED_ATT_MTU;
    this._queueCommand(this.mtuRequest(this._desired_mtu), (response) => {
      if (response[0] === ATT_OP_MTU_RESP) {
        const peerMtu = response.readUInt16LE(1);
        this._mtu = Math.min(REQUESTED_ATT_MTU, peerMtu);
      }

      this.emit("mtu", this._address, this._mtu);
    });
  };

  const originalLongWrite = prototype.longWrite as (
    this: NobleHciGattInstance,
    serviceUuid: string,
    characteristicUuid: string,
    data: Buffer,
    withoutResponse: boolean,
  ) => void;
  const longWrite = function (
    this: NobleHciGattInstance,
    serviceUuid: string,
    characteristicUuid: string,
    data: Buffer,
    withoutResponse: boolean,
  ): void {
    const context: LongWriteContext = {
      serviceUuid,
      characteristicUuid,
      handle:
        this._characteristics[serviceUuid][characteristicUuid].valueHandle,
      successfulPrepareWrites: 0,
      failed: false,
    };
    const originalQueueCommand = this._queueCommand;
    const ownQueueCommand = Object.getOwnPropertyDescriptor(
      this,
      "_queueCommand",
    );

    Object.defineProperty(this, "_queueCommand", {
      configurable: true,
      enumerable: ownQueueCommand?.enumerable ?? false,
      writable: true,
      value: function (
        this: NobleHciGattInstance,
        request: Buffer,
        callback?: ((response: Buffer) => void) | null,
        writeCallback?: (() => void) | null,
      ): void {
        let wrappedCallback = callback;
        if (
          request[0] === ATT_OP_PREPARE_WRITE_REQ ||
          request[0] === ATT_OP_EXECUTE_WRITE_REQ
        ) {
          commandContexts.set(request, context);
          if (request[0] === ATT_OP_PREPARE_WRITE_REQ && callback) {
            wrappedCallback = (response) => {
              if (response[0] === ATT_OP_PREPARE_WRITE_RESP) {
                context.successfulPrepareWrites++;
              }
              callback(response);
            };
          }
        }
        originalQueueCommand.call(
          this,
          request,
          wrappedCallback,
          writeCallback,
        );
      },
    });

    try {
      originalLongWrite.call(
        this,
        serviceUuid,
        characteristicUuid,
        data,
        withoutResponse,
      );
    } finally {
      if (ownQueueCommand) {
        Object.defineProperty(this, "_queueCommand", ownQueueCommand);
      } else {
        Reflect.deleteProperty(this, "_queueCommand");
      }
    }
  };

  const originalOnAclStreamData = prototype.onAclStreamData as (
    this: NobleHciGattInstance,
    cid: number,
    data: Buffer,
  ) => void;
  const onAclStreamData = function (
    this: NobleHciGattInstance,
    cid: number,
    data: Buffer,
  ): void {
    const currentCommand = this._currentCommand;
    const context = currentCommand
      ? commandContexts.get(currentCommand.buffer)
      : undefined;
    const errorCode = data.length >= 5 ? data[4] : undefined;
    const isSecurityError =
      errorCode === ATT_ECODE_AUTHENTICATION ||
      errorCode === ATT_ECODE_AUTHORIZATION ||
      errorCode === ATT_ECODE_INSUFF_ENC;

    if (
      cid === ATT_CID &&
      currentCommand &&
      context &&
      !context.failed &&
      data.length >= 5 &&
      data[0] === ATT_OP_ERROR &&
      !isSecurityError
    ) {
      context.failed = true;
      const requestOpcode = data[1];
      const handle = data.readUInt16LE(2);
      const error = Object.assign(
        new Error(
          `ATT error 0x${errorCode?.toString(16).padStart(2, "0")} during long write (request 0x${requestOpcode.toString(16).padStart(2, "0")}, handle 0x${handle.toString(16).padStart(4, "0")})`,
        ),
        { code: errorCode, handle, requestOpcode },
      );

      for (let index = this._commandQueue.length - 1; index >= 0; index--) {
        const queuedCommand = this._commandQueue[index];
        if (
          queuedCommand &&
          commandContexts.get(queuedCommand.buffer) === context
        ) {
          this._commandQueue.splice(index, 1);
        }
      }

      const failedOpcode = currentCommand.buffer[0];
      this._currentCommand = null;
      const shouldCancelPreparedWrites =
        context.successfulPrepareWrites > 0 ||
        failedOpcode === ATT_OP_EXECUTE_WRITE_REQ;
      const cancelRequest = shouldCancelPreparedWrites
        ? this.executeWriteRequest(context.handle, true)
        : undefined;
      if (cancelRequest) {
        this._currentCommand = {
          buffer: cancelRequest,
          callback: () => undefined,
          writeCallback: null,
        };
      }

      try {
        this.emit(
          "write",
          this._address,
          context.serviceUuid,
          context.characteristicUuid,
          error,
        );
      } finally {
        if (cancelRequest) {
          this.writeAtt(cancelRequest);
        } else {
          startQueuedCommands(this);
        }
      }
      return;
    }

    originalOnAclStreamData.call(this, cid, data);
  };

  const hciOnWrite = function (
    this: NobleHciBindingsInstance,
    address: string,
    serviceUuid: string,
    characteristicUuid: string,
    error?: unknown,
  ): void {
    const uuid = this.addressToId(address);
    if (error === undefined) {
      this.emit("write", uuid, serviceUuid, characteristicUuid);
    } else {
      this.emit("write", uuid, serviceUuid, characteristicUuid, error);
    }
  };

  Object.defineProperty(prototype, "exchangeMtu", {
    ...Object.getOwnPropertyDescriptor(prototype, "exchangeMtu"),
    value: exchangeMtu,
  });
  Object.defineProperty(prototype, "longWrite", {
    ...Object.getOwnPropertyDescriptor(prototype, "longWrite"),
    value: longWrite,
  });
  Object.defineProperty(prototype, "onAclStreamData", {
    ...Object.getOwnPropertyDescriptor(prototype, "onAclStreamData"),
    value: onAclStreamData,
  });
  Object.defineProperty(hciBindingsPrototype, "onWrite", {
    ...Object.getOwnPropertyDescriptor(hciBindingsPrototype, "onWrite"),
    value: hciOnWrite,
  });
  const patchRecord: PatchRecord = {
    bindingPrototype: hciBindingsPrototype,
    exchangeMtu,
    longWrite,
    onAclStreamData,
    onWrite: hciOnWrite,
  };
  Object.defineProperty(prototype, PATCHED, { value: patchRecord });
}
