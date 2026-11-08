# Local Bluetooth connection

Bluetooth mode connects the adapter directly to configured Easee chargers. It
does not log in to Easee Cloud, fall back to Cloud, or fetch charger/site
inventories. Configure each charger by its serial number and Bluetooth PIN in
the adapter settings. The optional name is a local ioBroker label; it does not
rename the charger. The PIN list is stored in an encrypted and protected native
configuration string.

The Bluetooth protocol is unofficial and reverse-engineered. This adapter uses
the field and command descriptions in
[parrel/easee-ble](https://github.com/parrel/easee-ble/tree/bec7b061fc8199cd150dbb8bbce5ed5112145ede)
and the device behavior documented by
[ha-easee-ble](https://github.com/parrel/ha-easee-ble/tree/9973cec92660ecd791a9809eb06361bd5b535f1b).
Neither project is affiliated with Easee. Firmware changes may break the
protocol. Easee's firmware prerequisites below do not prove compatibility of
this adapter. No physical charger test has been performed, so actual hardware
compatibility remains unknown.

## Setup

1. Select **Bluetooth (local)** as the connection mode.
2. Fill in one **Bluetooth charger** section per charger. Enter its serial
   number and Bluetooth PIN; the local name is optional and does not rename the
   charger. The PIN is the charger PIN, not the Easee account password. The
   serial number can be found on the charger and in the Easee app. The settings
   provide fields for up to ten chargers, and each PIN is stored as a protected,
   encrypted native string. Do not include the PIN in logs or support
   diagnostics.
3. Make the charger discoverable. Easee documents a long press of at least five
   seconds to open a ten-minute Bluetooth window; Bluetooth can also be set to
   always-on in the Easee app. The charger may stop advertising between windows.
4. Keep the adapter within Bluetooth range and leave the connection available.
   The charger allows only one Bluetooth connection at a time. A connection
   failure can mean that another phone, app, or adapter is using that slot; it
   is not proof of that cause.

The Easee support article documents Bluetooth access for three-phase chargers
with firmware 316 or newer and Easee One with firmware 60 or newer. These are
Easee's published prerequisites, not a hardware test of this adapter.
See [Easee: Using Bluetooth](https://support.easee.com/hc/en-gb/articles/19270172294161-Using-Bluetooth),
[Easee: Bluetooth in the Installer App](https://support.easee.com/hc/en-gb/articles/19160690698513-Bluetooth-in-the-Installer-App)
and [Easee: find or recover the PIN](https://support.easee.com/hc/en-gb/articles/4856383404177-Easee-charger-PIN-code-find-or-recover-the-PIN).

## Platform requirements

The adapter uses [`@stoprocent/noble`](https://github.com/stoprocent/noble)
2.8.0, an MIT-licensed Node.js BLE central with N-API native bindings and a
declared Node.js requirement of 14 or newer. The upstream documents macOS,
Linux, Windows, and Docker, but their setup differs by operating system. This
repository's dependency installation succeeded on Node 22.23.2 on macOS; this
is not a BLE hardware test, nor does it verify Node 22.19 on every platform.

On Linux, Noble's default binding uses raw HCI access. Noble documents Linux
kernel 3.6 or newer, `libbluetooth-dev`, a powered Bluetooth LE controller, and
`CAP_NET_RAW` for the Node.js process. Its upstream setup guide describes
granting this capability to the Node.js binary; note that this affects every
process using that binary. Prefer a service-scoped capability where the host
service manager supports it, and verify permissions for the actual adapter
user. Raw HCI accesses the controller directly and can conflict with BlueZ or
other Bluetooth clients. Noble also provides a separate BlueZ D-Bus binding,
which requires `dbus-next`; this adapter does not assume that binding is
configured.

On macOS, the native binding requires the platform's native build tools and
Bluetooth permission for the process running ioBroker. On Windows, Noble
documents native Windows support; native build requirements and Bluetooth
permissions still apply. Neither operating system has been hardware-tested
with this adapter.

For Docker on Linux, Noble documents `--network=host`. The default raw HCI
binding also needs the host controller to be visible in the container's
network namespace and `CAP_NET_RAW` (for example, Docker's `--cap-add=NET_RAW`).
These settings are not sufficient on every host or Docker configuration and
have not been tested with ioBroker images here. The optional HCI user-channel
mode has additional `CAP_NET_ADMIN` requirements and is not assumed. Do not
grant `--privileged` or expose a D-Bus socket unless the chosen binding
requires it; there is no one-size-fits-all Docker recipe verified by this
project.

## Existing datapoint mapping

Cloud mode remains the default. In Cloud mode, observations are read through
Easee's API, settings are read from charger/site API responses, and SignalR may
provide live updates. In Bluetooth mode, the adapter creates charger-relative
object IDs using the configured serial numbers, so it can be set up and
restored after a restart without Cloud discovery. These IDs match Cloud-created
IDs only if the Cloud charger ID is the same string as the configured serial
number; without Cloud discovery the adapter cannot determine or translate a
different Cloud ID. The local
connection does not provide the Cloud charger name, site membership, price,
session history, or authorization-token owner.

Only fields with matching meanings and units are mapped. The BLE reference
describes `chargerOpMode` as the car/cable state, not the charger enabled
setting; `reasonForNoCurrent` is the separate reason charging is blocked.

| Existing datapoint | Cloud source/meaning | BLE source and correspondence | Bluetooth limitation |
|---|---|---|---|
| `status.chargerOpMode` | Observation 109; charger operation mode | State `chargerOpMode`; same Easee mode values | Physical hardware not tested |
| `status.reasonForNoCurrent` | Observation 96; reason code | State `reasonForNoCurrent`; same reason-code field | Unknown codes remain unknown |
| `status.totalPower` | Observation 120; kW | State `totalPower`; kW | BLE omits protobuf defaults; the reference defines this field's omitted value as 0 |
| `status.lifetimeEnergy` | Observation 124; lifetime kWh | State `lifetimeEnergy`; kWh | No Cloud session history is available |
| `status.energyPerHour` | Observation 122; energy for the hour, kWh | State `energyPerHour`; kWh for the previous clock hour | BLE's value steps on the hour |
| `status.inCurrentT2` | Observation 182; current at terminal T2, A | State `currentN`; T2 is neutral | Physical terminal mapping follows the reverse-engineered reference |
| `status.inCurrentT3` / `T4` / `T5` | Observations 183–185; current at each terminal, A | States `currentL1` / `currentL2` / `currentL3`; T3/T4/T5 map to L1/L2/L3 | A phase's current may be zero when unused |
| `status.inVoltageT2T3` / `T2T4` / `T2T5` | Observations 194–196; terminal voltage, V | States `voltageL1N` / `voltageL2N` / `voltageL3N`; T2 is neutral, T3/T4/T5 are L1/L2/L3 | Existing line-neutral `status.voltage` is derived from these matching measurements |
| `status.inVoltageT3T4` / `T3T5` / `T4T5` | Observations 197–199; terminal voltage, V | States `voltageL1L2` / `voltageL1L3` / `voltageL2L3`; T3/T4/T5 map to L1/L2/L3 | Values preserve their V unit |
| `config.isEnabled` | Cloud charger setting | Config `isEnabled`; command 29 | Does not mean a charging session has started |
| `config.maxChargerCurrent` | Maximum charger current, A | Config `maxChargerCurrent`; command 47 | BLE command accepts whole amperes in 0–40 A |
| `config.dynamicChargerCurrent` | Temporary charger current, A | State `dynamicChargerCurrent`; command 48 | Whole amperes in 0–40 A; volatile setting |
| `config.phaseMode` | Requested phase mode (1/2/3) | Config `phaseMode`; command 38 | Change only takes effect after the charger is switched off and on |
| `config.circuitMaxCurrentP1`–`P3` | Cloud site circuit maximum current, A | Config fields of the same names; command 24 | BLE accepts whole amperes in 0–40 A |
| `config.dynamicCircuitCurrentP1`–`P3` | Cloud site's dynamic circuit-current limit, A | State fields of the same names; command 22 | BLE value is volatile and cleared by a reboot; phases must be sent together |
| `config.lockCablePermanently` | Observation 30; permanent cable-lock setting | Config `cableLocked`; command 30 | This setting is not the same as the live cable-lock status |
| `config.ledStripBrightness` | Charger LED brightness, percent | Config `ledStripBrightness`; command 40 | BLE range is 0–100 percent |
| `control.pause` | Cloud pause-charging command | Dynamic charger current 0 A using command 48 | This uses a temporary current limit, not the charger-enabled switch |
| `control.resume` | Cloud resume-charging command | Restore the positive current observed before the adapter paused | Rejected if no fresh, in-memory pre-pause current is available; it is not guessed or restored across reconnects |
| `control.reboot` | Cloud reboot command | BLE command 1 | The link is expected to drop during reboot |

`status.wiFiRSSI` is a Wi-Fi signal measurement in Cloud mode. BLE `localRSSI`
is the Bluetooth link's signal strength, so it is exposed separately and is
never written into `status.wiFiRSSI`. Similarly, BLE's configured
`cableLocked` is not used as the Cloud live cable-lock state.

The following existing values have no confirmed BLE equivalent and are not
refreshed in Bluetooth mode: `status.isOnline`, `status.outputCurrent`,
`status.wiFiRSSI`, the Cloud live `status.cableLocked`, session totals,
authorization-token states, Cloud/site prices, and any SignalR-only
temperature. `config.wiFiSSID` can be read locally, but changing it requires a
Wi-Fi passphrase that the existing datapoint does not provide. Smart charging,
smart-button settings, and renaming the charger are also not mapped. Existing
object IDs are retained; unsupported writes are reported instead of being sent
or acknowledged as successful.

Cloud-only start and stop commands are deliberately not translated to
`isEnabled`: enabling/disabling a charger is not the same as starting/stopping
a particular charging session. A command acknowledgement is checked for an
explicit charger refusal; receiving a reply alone does not mean the requested
setting was accepted.

## Reference libraries and attribution

`easee-ble` and `ha-easee-ble` are MIT-licensed, independent reverse-engineering
projects. Their field names, value meanings, command descriptions and protocol
UUIDs are used as factual references; this adapter does not depend on their
Python implementation. See their
[MIT licenses](https://github.com/parrel/easee-ble/blob/bec7b061fc8199cd150dbb8bbce5ed5112145ede/LICENSE)
and [Home Assistant integration](https://github.com/parrel/ha-easee-ble/tree/9973cec92660ecd791a9809eb06361bd5b535f1b).
