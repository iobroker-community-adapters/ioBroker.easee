"use strict";

export {};

import { expect } from "chai";
import sinon from "sinon";
import Module from "node:module";
import type { Module as NodeModule } from "node:module";
import { afterEach, describe, it } from "mocha";
import type { DeviceInfo } from "@iobroker/dm-utils";

interface ModuleLoader {
  _load: (
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
  ) => unknown;
}

interface TestAction {
  id: string;
  handler?: (...args: unknown[]) => unknown;
}

interface TestInstanceInfo {
  apiVersion: string;
  actions?: TestAction[];
}

interface TestDeviceInfo {
  actions?: TestAction[];
}

interface TestStoredObject extends Record<string, unknown> {
  common: Record<string, unknown>;
  native: Record<string, unknown>;
}

type NodeExtend = (
  deep: boolean,
  target: Record<string, unknown>,
  source: Record<string, unknown>,
) => Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeExtend = require("node.extend") as NodeExtend;
const moduleLoader = Module as unknown as ModuleLoader;
const originalLoad = moduleLoader._load;
moduleLoader._load = function (
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean,
) {
  if (request === "@iobroker/adapter-core") {
    return { Adapter: class {}, I18n: { t: (message: string) => message } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const createAdapter = require("../src/main.ts");
moduleLoader._load = originalLoad;

const BluetoothDeviceManager = createAdapter.EaseeBluetoothDeviceManagement;

class TestDeviceManagement extends BluetoothDeviceManager {
  constructor(adapter: Record<string, unknown>) {
    super(adapter);
  }

  getInfo(): TestInstanceInfo {
    return this.getInstanceInfo() as TestInstanceInfo;
  }

  getDevices(): DeviceInfo<string>[] {
    const devices: DeviceInfo<string>[] = [];
    let totalDevices = 0;
    this.loadDevices({
      setTotalDevices: (count: number) => {
        totalDevices = count;
      },
      addDevice: (device: DeviceInfo<string>) => devices.push(device),
    });
    expect(totalDevices).to.equal(devices.length);
    return devices;
  }

  getDevice(deviceId: string): TestDeviceInfo {
    return this.getDeviceInfo(deviceId) as TestDeviceInfo;
  }

  debugLog(message: string): void {
    this.log.debug(message);
  }
}

function createHarness(initialConfig: Record<string, unknown> = {}): {
  adapter: ReturnType<typeof Object.create>;
  manager: TestDeviceManagement;
  storedObject: TestStoredObject;
} {
  const adapter = Object.create(createAdapter.Easee.prototype);
  adapter.on = sinon.stub();
  adapter.log = {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  };
  adapter.namespace = "easee.0";
  adapter.config = {
    bluetoothChargerList: [],
    ...initialConfig,
  };
  adapter.bluetoothConfigMutation = Promise.resolve();
  adapter.encrypt = sinon
    .stub()
    .callsFake(
      (pin: string) => `encrypted-${Buffer.from(pin).toString("hex")}`,
    );
  adapter.decrypt = sinon
    .stub()
    .callsFake((pin: string) =>
      Buffer.from(pin.replace(/^encrypted-/, ""), "hex").toString(),
    );
  const storedObject: TestStoredObject = {
    _id: "system.adapter.easee.0",
    type: "instance",
    common: {
      name: "easee",
      enabled: true,
      untouchedSetting: "keep common",
    },
    native: {
      ...adapter.config,
      untouchedSetting: "keep native",
    },
  };
  adapter.getForeignObjectAsync = sinon
    .stub()
    .callsFake(() => Promise.resolve(structuredClone(storedObject)));
  adapter.setForeignObjectAsync = sinon
    .stub()
    .callsFake((_id: string, object: TestStoredObject) => {
      for (const key of Object.keys(storedObject)) {
        delete storedObject[key];
      }
      Object.assign(storedObject, structuredClone(object));
      return Promise.resolve();
    });
  adapter.extendForeignObjectAsync = sinon
    .stub()
    .callsFake((_id: string, object: Record<string, unknown>) => {
      nodeExtend(true, storedObject, object);
      return Promise.resolve();
    });
  const manager = new TestDeviceManagement(adapter);
  return { adapter, manager, storedObject };
}

function actionById(actions: TestAction[], id: string): TestAction {
  const action = actions.find((candidate) => candidate.id === id);
  expect(action, `expected action ${id}`).to.exist;
  return action!;
}

describe("Bluetooth charger Device Manager", () => {
  afterEach(() => sinon.restore());

  it("uses the controller node.extend implementation that merges arrays by index", () => {
    const existing = {
      native: {
        bluetoothChargerList: [
          { serialNumber: "EMX123456" },
          { serialNumber: "EMX654321" },
        ],
      },
    };
    const shortened = nodeExtend(true, structuredClone(existing), {
      native: { bluetoothChargerList: [{ serialNumber: "EMX654321" }] },
    });
    const cleared = nodeExtend(true, structuredClone(existing), {
      native: { bluetoothChargerList: [] },
    });

    expect(
      (shortened.native as Record<string, unknown>).bluetoothChargerList,
    ).to.deep.equal([
      { serialNumber: "EMX654321" },
      { serialNumber: "EMX654321" },
    ]);
    expect(
      (cleared.native as Record<string, unknown>).bluetoothChargerList,
    ).to.deep.equal(existing.native.bluetoothChargerList);
  });

  it("registers Device Manager v3 actions and lists chargers without exposing PINs", () => {
    const { manager } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "Garage",
        },
      ],
    });
    const devices = manager.getDevices();
    expect(manager.getInfo().apiVersion).to.equal("v3");
    expect(manager.getInfo().actions?.map(({ id }) => id)).to.include(
      "addBluetoothCharger",
    );
    expect(devices).to.have.length(1);
    expect(JSON.stringify(devices)).not.to.include("4321");
    expect(JSON.stringify(devices)).to.include("EMX123456");
  });

  it("shows live power and Bluetooth signal in the card body without controls", () => {
    const { manager } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "Garage",
        },
      ],
    });

    const [device] = manager.getDevices();
    expect(device.name).to.equal("Garage");
    expect(device.status).to.deep.equal({
      connection: {
        stateId: "easee.0.EMX123456.info.bluetoothConnection",
        mapping: { true: "connected", false: "disconnected" },
      },
    });
    expect(device.customInfo).to.deep.equal({
      id: "EMX123456",
      schema: {
        type: "panel",
        items: {
          totalPower: {
            type: "state",
            oid: "easee.0.EMX123456.status.totalPower",
            foreign: true,
            control: "text",
            label: {
              en: "Charging power",
              de: "Ladeleistung",
              es: "Potencia de carga",
              fr: "Puissance de charge",
              it: "Potenza di ricarica",
              nl: "Laadvermogen",
              pl: "Moc ładowania",
              pt: "Potência de carregamento",
              ru: "Мощность зарядки",
              uk: "Потужність заряджання",
              "zh-cn": "充电功率",
            },
            unit: "kW",
          },
          bluetoothRSSI: {
            type: "state",
            oid: "easee.0.EMX123456.info.bluetoothRSSI",
            foreign: true,
            control: "text",
            label: {
              en: "Bluetooth signal strength",
              de: "Bluetooth-Signalstärke",
              es: "Intensidad de la señal Bluetooth",
              fr: "Intensité du signal Bluetooth",
              it: "Intensità del segnale Bluetooth",
              nl: "Bluetooth-signaalsterkte",
              pl: "Siła sygnału Bluetooth",
              pt: "Intensidade do sinal Bluetooth",
              ru: "Уровень сигнала Bluetooth",
              uk: "Рівень сигналу Bluetooth",
              "zh-cn": "蓝牙信号强度",
            },
            unit: "dBm",
          },
        },
      },
    });
    expect(device.controls).to.be.undefined;
  });

  it("adds a charger and encrypts its PIN in the canonical list", async () => {
    const { adapter, manager, storedObject } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-31323334",
          name: "Garage",
        },
      ],
    });
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "EMX654321",
        pin: "5678",
        name: "New charger",
      }),
      showMessage: sinon.stub().resolves(),
    };
    const addAction = actionById(
      manager.getInfo().actions!,
      "addBluetoothCharger",
    );

    expect(await addAction.handler!(context)).to.deep.equal({ refresh: true });
    expect(adapter.encrypt.calledWithExactly("5678")).to.equal(true);
    const expected = [
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "Garage",
      },
      {
        serialNumber: "EMX654321",
        pin: "easee:v1:encrypted-35363738",
        name: "New charger",
      },
    ];
    expect(storedObject.native.bluetoothChargerList).to.deep.equal(expected);
    expect(adapter.config.bluetoothChargerList).to.deep.equal(expected);
    expect(storedObject.native.untouchedSetting).to.equal("keep native");
    expect(storedObject.common.untouchedSetting).to.equal("keep common");
    expect(storedObject._id).to.equal("system.adapter.easee.0");
    expect(adapter.extendForeignObjectAsync.called).to.equal(false);
    expect(JSON.stringify(storedObject.native)).not.to.include("5678");
    expect(JSON.stringify(adapter.log)).not.to.include("5678");
  });

  it("allows adding the first charger to a new empty configuration", async () => {
    const { adapter, manager, storedObject } = createHarness();
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "EMX123456",
        pin: "1234",
        name: "",
      }),
      showMessage: sinon.stub().resolves(),
    };
    const add = actionById(manager.getInfo().actions!, "addBluetoothCharger");

    expect(await add.handler!(context)).to.deep.equal({ refresh: true });
    expect(storedObject.native.bluetoothChargerList).to.deep.equal([
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "EMX123456",
      },
    ]);
    expect(adapter.encrypt.calledWithExactly("1234")).to.equal(true);
  });

  it("shows a redacted field-specific warning for an undecryptable saved charger", () => {
    const { adapter, manager } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:stored-ciphertext-secret",
          name: "Garage",
        },
      ],
    });
    adapter.decrypt.throws(new Error("decrypt-error-secret"));

    const devices = manager.getDevices();
    expect(devices).to.have.length(1);
    expect(devices[0].name).to.deep.include({
      en: "Bluetooth configuration error: Stored Bluetooth charger entry 1 field pin could not be decrypted.",
      de: "Bluetooth-Konfigurationsfehler: Der PIN in Eintrag 1, Feld pin, der gespeicherten Bluetooth-Konfiguration konnte nicht entschlüsselt werden.",
    });
    const output = JSON.stringify({ devices, logs: adapter.log });
    expect(output).not.to.include("stored-ciphertext-secret");
    expect(output).not.to.include("decrypt-error-secret");
  });

  it("reports a stored configuration failure when it blocks the first add", async () => {
    const { adapter, manager } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:stored-ciphertext-secret",
          name: "Garage",
        },
      ],
    });
    adapter.decrypt.throws(new Error("decrypt-error-secret"));
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "EMX654321",
        pin: "new-submitted-pin",
        name: "New charger",
      }),
      showMessage: sinon.stub().resolves(),
    };
    const add = actionById(manager.getInfo().actions!, "addBluetoothCharger");

    expect(await add.handler!(context)).to.deep.equal({ refresh: false });
    const message = JSON.stringify(context.showMessage.firstCall.args[0]);
    expect(message).to.include(
      "existing stored Bluetooth configuration is invalid",
    );
    expect(message).to.include("entry 1 field pin");
    expect(message).not.to.include("new-submitted-pin");
    expect(message).not.to.include("stored-ciphertext-secret");
    expect(message).not.to.include("decrypt-error-secret");
    expect(adapter.setForeignObjectAsync.called).to.equal(false);
    expect(adapter.encrypt.called).to.equal(false);
    expect(adapter.log.error.called).to.equal(false);
    expect(adapter.log.warn.called).to.equal(false);
  });

  it("edits a charger while preserving its encrypted PIN when the field is blank", async () => {
    const { adapter, manager, storedObject } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "Old name",
        },
      ],
    });
    const device = manager.getDevice("EMX123456");
    const edit = actionById(device.actions!, "editBluetoothCharger");
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "EMX123456",
        pin: "",
        name: "Updated name",
      }),
      showMessage: sinon.stub().resolves(),
    };

    expect(await edit.handler!("EMX123456", context)).to.deep.equal({
      refresh: "instance",
    });
    expect(adapter.encrypt.calledWithExactly("4321")).to.equal(true);
    const expected = [
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-34333231",
        name: "Updated name",
      },
    ];
    expect(storedObject.native.bluetoothChargerList).to.deep.equal(expected);
    expect(adapter.config.bluetoothChargerList).to.deep.equal(expected);
  });

  it("removes the last charger and saves an empty canonical list", async () => {
    const { manager, adapter, storedObject } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "One",
        },
      ],
    });
    const remove = actionById(
      manager.getDevice("EMX123456").actions!,
      "removeBluetoothCharger",
    );

    expect(
      await remove.handler!("EMX123456", {
        showMessage: sinon.stub().resolves(),
      }),
    ).to.deep.equal({
      refresh: "instance",
    });
    expect(storedObject.native.bluetoothChargerList).to.deep.equal([]);
    expect(adapter.getConfiguredBluetoothChargers()).to.deep.equal([]);
  });

  it("persists removal of either charger from a two-item list", async () => {
    const chargers = [
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "First",
      },
      {
        serialNumber: "EMX654321",
        pin: "easee:v1:encrypted-35363738",
        name: "Last",
      },
    ];
    for (const [serialNumber, expected] of [
      ["EMX123456", [chargers[1]]],
      ["EMX654321", [chargers[0]]],
    ] as const) {
      const { adapter, storedObject } = createHarness({
        bluetoothChargerList: chargers,
      });

      await adapter.removeBluetoothCharger(serialNumber);

      expect(storedObject.native.bluetoothChargerList).to.deep.equal(expected);
      expect(adapter.config.bluetoothChargerList).to.deep.equal(expected);
      expect(adapter.extendForeignObjectAsync.called).to.equal(false);
    }
  });

  it("persists serial changes and the replacement encrypted PIN", async () => {
    const { adapter, storedObject } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "Old name",
        },
      ],
    });

    await adapter.editBluetoothCharger("EMX123456", {
      serialNumber: "EMX654321",
      pin: "9876",
      name: "New name",
    });

    const expected = [
      {
        serialNumber: "EMX654321",
        pin: "easee:v1:encrypted-39383736",
        name: "New name",
      },
    ];
    expect(storedObject.native.bluetoothChargerList).to.deep.equal(expected);
    expect(adapter.config.bluetoothChargerList).to.deep.equal(expected);
    expect(adapter.encrypt.calledWithExactly("9876")).to.equal(true);
  });

  it("clears every encrypted PIN entry on reset", async () => {
    const { adapter, storedObject } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-31323334",
          name: "Garage",
        },
        {
          serialNumber: "EMX654321",
          pin: "easee:v1:encrypted-35363738",
          name: "Driveway",
        },
      ],
    });

    await adapter.resetBluetoothChargerConfiguration();

    expect(storedObject.native.bluetoothChargerList).to.deep.equal([]);
    expect(adapter.config.bluetoothChargerList).to.deep.equal([]);
    expect(adapter.configuredBluetoothChargers).to.deep.equal([]);
    expect(JSON.stringify(storedObject.native)).not.to.include("1234");
    expect(JSON.stringify(storedObject.native)).not.to.include("5678");
  });

  it("loads canonical encrypted values again from the persisted instance", () => {
    const first = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-31323334",
          name: "Garage",
        },
      ],
    });
    const reloaded = createHarness(first.storedObject.native);

    expect(reloaded.adapter.getConfiguredBluetoothChargers()).to.deep.equal([
      { serialNumber: "EMX123456", pin: "1234", name: "Garage" },
    ]);
  });

  it("bases charger changes on the latest persisted object, not stale config", async () => {
    const { adapter, storedObject } = createHarness();
    storedObject.native.bluetoothChargerList = [
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "Persisted charger",
      },
    ];

    await adapter.addBluetoothCharger({
      serialNumber: "EMX654321",
      pin: "5678",
      name: "New charger",
    });

    const expected = [
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "Persisted charger",
      },
      {
        serialNumber: "EMX654321",
        pin: "easee:v1:encrypted-35363738",
        name: "New charger",
      },
    ];
    expect(storedObject.native.bluetoothChargerList).to.deep.equal(expected);
    expect(adapter.config.bluetoothChargerList).to.deep.equal(expected);
  });

  it("synchronizes only the verified Bluetooth list into runtime configuration", async () => {
    const { adapter, storedObject } = createHarness({
      client_secret: "runtime-decrypted-cloud-secret",
      runtimeOnlySetting: "keep runtime config",
    });
    adapter.config.client_secret = "runtime-decrypted-cloud-secret";
    storedObject.native.client_secret = "persisted-encrypted-cloud-secret";
    storedObject.native.persistedOnlySetting = "keep persisted native";

    await adapter.addBluetoothCharger({
      serialNumber: "EMX123456",
      pin: "1234",
      name: "New charger",
    });

    expect(adapter.config.client_secret).to.equal(
      "runtime-decrypted-cloud-secret",
    );
    expect(adapter.config.runtimeOnlySetting).to.equal("keep runtime config");
    expect(adapter.config).not.to.have.property("persistedOnlySetting");
    expect(storedObject.native.client_secret).to.equal(
      "persisted-encrypted-cloud-secret",
    );
    expect(storedObject.native.persistedOnlySetting).to.equal(
      "keep persisted native",
    );
    expect(JSON.stringify(adapter.log)).not.to.include("1234");
    expect(JSON.stringify(adapter.log)).not.to.include(
      "persisted-encrypted-cloud-secret",
    );
  });

  it("preserves non-Bluetooth fields changed before a configuration write", async () => {
    const { adapter, storedObject } = createHarness();
    const originalGet = adapter.getForeignObjectAsync;
    let readCount = 0;
    adapter.getForeignObjectAsync = sinon.stub().callsFake((id: string) => {
      readCount += 1;
      if (readCount === 2) {
        storedObject.common.untouchedSetting = "new common value";
        storedObject.native.untouchedSetting = "new native value";
      }
      return originalGet(id);
    });

    await adapter.addBluetoothCharger({
      serialNumber: "EMX123456",
      pin: "1234",
      name: "New charger",
    });

    expect(storedObject.common.untouchedSetting).to.equal("new common value");
    expect(storedObject.native.untouchedSetting).to.equal("new native value");
  });

  it("does not overwrite a concurrent persisted charger change", async () => {
    const { adapter, storedObject } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-31323334",
          name: "Original",
        },
      ],
    });
    const originalGet = adapter.getForeignObjectAsync;
    const externalList = [
      {
        serialNumber: "EMX654321",
        pin: "easee:v1:encrypted-35363738",
        name: "External change",
      },
    ];
    let readCount = 0;
    adapter.getForeignObjectAsync = sinon.stub().callsFake((id: string) => {
      readCount += 1;
      if (readCount === 2) {
        storedObject.native.bluetoothChargerList = externalList;
      }
      return originalGet(id);
    });

    const saveError = await adapter
      .addBluetoothCharger({
        serialNumber: "EMX789012",
        pin: "9876",
        name: "New charger",
      })
      .catch((error: unknown) => error);

    expect(saveError).to.be.instanceOf(Error);
    expect(storedObject.native.bluetoothChargerList).to.deep.equal(
      externalList,
    );
    expect(adapter.config.bluetoothChargerList).to.deep.equal(externalList);
    expect(adapter.setForeignObjectAsync.called).to.equal(false);
  });

  it("serializes concurrent charger additions against the latest persisted object", async () => {
    const { adapter, storedObject } = createHarness();

    await Promise.all([
      adapter.addBluetoothCharger({
        serialNumber: "EMX123456",
        pin: "1234",
        name: "First",
      }),
      adapter.addBluetoothCharger({
        serialNumber: "EMX654321",
        pin: "5678",
        name: "Second",
      }),
    ]);

    const expected = [
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "First",
      },
      {
        serialNumber: "EMX654321",
        pin: "easee:v1:encrypted-35363738",
        name: "Second",
      },
    ];
    expect(storedObject.native.bluetoothChargerList).to.deep.equal(expected);
    expect(adapter.config.bluetoothChargerList).to.deep.equal(expected);
    expect(adapter.setForeignObjectAsync.callCount).to.equal(2);
  });

  it("does not update memory when a successful write fails read-back verification", async () => {
    const { adapter, storedObject } = createHarness();
    const originalConfig = { ...adapter.config };
    adapter.setForeignObjectAsync.resolves();

    const saveError = await adapter
      .addBluetoothCharger({
        serialNumber: "EMX123456",
        pin: "1234",
        name: "Not saved",
      })
      .catch((error: unknown) => error);

    expect(saveError).to.be.instanceOf(Error);
    expect(storedObject.native.bluetoothChargerList).to.deep.equal([]);
    expect(adapter.config).to.deep.equal(originalConfig);
  });

  it("leaves persisted and in-memory values unchanged when a charger save rejects", async () => {
    const { adapter, storedObject } = createHarness();
    const originalConfig = { ...adapter.config };
    const originalNative = structuredClone(storedObject.native);
    adapter.setForeignObjectAsync.rejects(new Error("save failed"));

    const saveError = await adapter
      .addBluetoothCharger({
        serialNumber: "EMX123456",
        pin: "1234",
        name: "Not saved",
      })
      .catch((error: unknown) => error);

    expect(saveError).to.be.instanceOf(Error);
    expect(storedObject.native).to.deep.equal(originalNative);
    expect(adapter.config).to.deep.equal(originalConfig);
  });

  it("rejects invalid input without echoing or logging the submitted PIN", async () => {
    const { manager, adapter } = createHarness();
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "invalid serial",
        pin: "sensitive-pin",
        name: "Bad entry",
      }),
      showMessage: sinon.stub().resolves(),
    };
    const add = actionById(manager.getInfo().actions!, "addBluetoothCharger");

    expect(await add.handler!(context)).to.deep.equal({ refresh: false });
    expect(adapter.setForeignObjectAsync.called).to.equal(false);
    expect(
      JSON.stringify(context.showMessage.firstCall.args[0]),
    ).not.to.include("sensitive-pin");
    expect(adapter.log.error.called).to.equal(false);
    expect(adapter.log.warn.called).to.equal(false);
  });

  it("suppresses dm-utils debug messages that include submitted form data", () => {
    const { manager, adapter } = createHarness();

    manager.debugLog(
      'DeviceManagement received: {"command":"dm:deviceAction","message":{"pin":"sensitive-pin"}}',
    );

    expect(adapter.log.debug.called).to.equal(false);
  });

  it("rejects a forged device ID and unknown charger without changing configuration", async () => {
    const { manager, adapter } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "Garage",
        },
      ],
    });
    const remove = actionById(
      manager.getDevice("EMX123456").actions!,
      "removeBluetoothCharger",
    );

    expect(await remove.handler!("EMX654321", {})).to.deep.equal({
      refresh: "none",
    });
    expect(() => manager.getDevice("EMX654321")).to.throw(
      "Bluetooth charger is not configured",
    );
    expect(adapter.setForeignObjectAsync.called).to.equal(false);
  });
});
