# Local Bluetooth connection

Bluetooth mode connects the adapter directly to configured Easee chargers. It
does not log in to Easee Cloud, fall back to Cloud, or fetch charger/site
inventories. Add and remove chargers in the ioBroker Device Manager using each
charger's serial number and Bluetooth PIN. The optional name is a local
ioBroker label; it does not rename the charger. PINs are encrypted in the
protected native configuration.

The Bluetooth protocol is unofficial and reverse-engineered. This adapter uses
the field and command descriptions in
[parrel/easee-ble](https://github.com/parrel/easee-ble/tree/bec7b061fc8199cd150dbb8bbce5ed5112145ede)
and the device behavior documented by
[ha-easee-ble](https://github.com/parrel/ha-easee-ble/tree/9973cec92660ecd791a9809eb06361bd5b535f1b).
Neither project is affiliated with Easee. Firmware changes may break the
protocol. Easee's firmware prerequisites below do not prove compatibility of
this adapter. A user reported a successful connection on macOS. On one
Raspberry Pi setup, Linux's default BlueZ D-Bus binding timed out waiting for
the BLE HELLO notification, while a subsequent Raw-HCI run completed both HELLO
rounds and authenticated config/state reads. This confirms that setup only; it
does not establish compatibility across charger firmware, controllers, or host
stacks.

## Setup

1. Select **Bluetooth (local)** as the connection mode.
2. Open the **ioBroker Device Manager** and add a charger. Enter its serial
   number and Bluetooth PIN; the local name is optional and does not rename the
   charger. The PIN is the charger PIN, not the Easee account password. The
   serial number can be found on the charger and in the Easee app. PINs are
   encrypted and protected in the adapter configuration. Use the manager to
   edit or remove configured chargers. Do not include a PIN in logs or support
   diagnostics. Restart the adapter after changing the managed charger list;
   this applies additions, edits, and removals to the live Bluetooth client.
3. Make the charger discoverable. Easee documents a long press of at least five
   seconds to open a ten-minute Bluetooth window; Bluetooth can also be set to
   always-on in the Easee app. The charger may stop advertising between windows.
4. Keep the adapter within Bluetooth range and leave the connection available.
   The charger allows only one Bluetooth connection at a time. A connection
   failure can mean that another phone, app, or adapter is using that slot; it
   is not proof of that cause.

Existing installations with the former numbered Bluetooth fields or JSON
charger setting continue to be read until those entries are edited in the
Device Manager. When saving a charger through the manager, its PIN is stored
encrypted in the new configuration format; existing entries remain usable
without re-entering their PINs.

A valid empty charger list is reported separately from an invalid stored
configuration. Configuration errors identify the affected setting, entry, or
field without logging PINs, encrypted PINs, keys, or complete configuration
objects. The Device Manager displays a warning card for an invalid stored
configuration. If an existing invalid entry prevents adding or editing a
charger, correct or remove that entry in the adapter instance configuration
before retrying; the manager does not silently replace invalid data with an
empty list.

The Easee support article documents Bluetooth access for three-phase chargers
with firmware 316 or newer and Easee One with firmware 60 or newer. These are
Easee's published prerequisites, not a hardware test of this adapter.
See [Easee: Using Bluetooth](https://support.easee.com/hc/en-gb/articles/19270172294161-Using-Bluetooth),
[Easee: Bluetooth in the Installer App](https://support.easee.com/hc/en-gb/articles/19160690698513-Bluetooth-in-the-Installer-App)
and [Easee: find or recover the PIN](https://support.easee.com/hc/en-gb/articles/4856383404177-Easee-charger-PIN-code-find-or-recover-the-PIN).

On Linux with the BlueZ D-Bus binding, if a GATT write reports an
authentication/insufficient-authentication error, the adapter requests
`org.bluez.Device1.Pair()` once for that connection and retries the affected
write once. Pairing is not requested proactively, is not attempted for other
write errors, and is not available on other Noble bindings. The automatic
pairing request and write retry are allowed only when that candidate's
advertised local name exactly matches its configured charger serial. A local
name is only a discovery hint, not cryptographic identity; the authenticated
J-PAKE exchange and serial reads remain necessary to verify the charger. The
BlueZ pairing operation is bounded to 30 seconds; failures and timeouts are
reported as connection errors. The configured Easee PIN is used by the Easee
protocol and is not sent to BlueZ as a Bluetooth pairing passkey. The host's
BlueZ system bus access and pairing policy must permit the request;
pairing-agent or security-policy requirements need to be handled on the host.

Home Assistant's `easee-ble` library has a workaround for chargers whose GATT
characteristics lack a usable Client Characteristic Configuration Descriptor
(CCCD). On macOS, when Noble/CoreBluetooth reports ATT `Attribute Not Found`
while enabling notifications, this adapter retains the callback and accepts
later characteristic values even if Noble does not mark them as notifications.
This is a best-effort CoreBluetooth path; if the OS does not deliver those
values, authentication still times out.

On Linux, the default BlueZ D-Bus binding cannot use that CCCD-less path. In
Bluetooth settings, select **Raw HCI** to use Noble's raw-HCI binding; this
selection overrides `NOBLE_BINDINGS`. With **Automatic** selected, the adapter
uses the platform default and honors `NOBLE_BINDINGS`. When raw HCI is selected,
the adapter checks the characteristic descriptors and, if the CCCD is absent,
leaves a passive listener for unsolicited ATT notifications instead of trying
to enable or later disable notifications. This relies on the charger sending
those notifications anyway and was confirmed on the successful Raspberry Pi
Raw-HCI run; other host and charger configurations remain unverified. Raw-HCI characteristic
discovery also retries once after a 250 ms quiet window if the first result is
missing one or more expected characteristics; complete first results proceed
without a delay, while other bindings retain immediate failure. A second
incomplete result still fails the connection. Raw HCI requests ATT MTU 333 and
negotiates the effective MTU as `min(333, peer MTU)`. The 330-byte HELLO plus
its 3-byte ATT header fits one normal GATT Write Request when the peer supports
MTU 333 or higher; a lower peer MTU still takes Noble's long-write path. In
that fallback, non-security ATT Error Responses are forwarded to the write
callback immediately, queued long-write commands are cleared, and an Execute
Write cancel is sent if earlier Prepare Writes succeeded. The updated Raw-HCI package completed both HELLO rounds and authenticated
config/state reads on the Raspberry Pi. Earlier traces showed `Prepare Queue
Full (0x09)` for both 251-byte and 18-byte Prepare Writes; the successful run
confirms connectivity on that setup. Compatibility with other chargers and
hosts remains unverified. Raw HCI bypasses
BlueZ, requires `CAP_NET_RAW`, and may conflict with BlueZ or another scanner;
the default `dbus` binding remains unable to subscribe this way. Home Assistant recommends
a Bluetooth proxy for some Linux setups, but this adapter does not currently
support a Home Assistant/ESPHome Bluetooth proxy.

## Adapter status and manual search

In Bluetooth mode, the settings page reports Noble's current local adapter
state (`poweredOn`, `poweredOff`, `unauthorized`, `unsupported`, `unknown`, or
`resetting`) and a separate Bluetooth search readiness message in
`info.bluetoothSearchReadiness`. Readiness distinguishes transport startup,
initial charger connection, active scan/poll/write/reconnect, pending or active
dynamic-current updates, local adapter unavailability, and when a manual search
can start. `Ready to search` means
the local adapter reports `poweredOn`, the BLE transport is initialized, and no
tracked operation currently blocks the scan; it does not establish that any
charger is nearby, advertising, authenticated, or connected. Access restrictions
can also prevent scanning even when a controller state is reported. Info logs
record local adapter-state transitions, configured charger count (not PINs),
connection stages, and manual scan start and duration. Scan failures are logged
as warnings. The manual diagnostic scan asks Noble for all advertisements and
then locally accepts those advertising the Easee service UUID or manufacturer
ID 3118, matching Home Assistant's advertised-device signature. It reports only
whether the company identifier matches; raw manufacturer data is never logged
or shown. For a scan with no matches, logs and `info.bluetoothScanResults`
include the number of advertisements Noble reported and up to 20 distinct
observed name/connectability/service-UUID/manufacturer-signature combinations;
unnamed devices, absent service UUIDs, and a nonmatching manufacturer ID are
reported explicitly. This can help distinguish no advertisements delivered to
Noble from devices whose advertisements do not contain the Easee signature or
are not currently connectable. The diagnostic summary is bounded and contains
no peripheral addresses. Matching results additionally show Noble's peripheral
identifier and reported connectability, when available. Connection-error text
redacts configured PINs and serials and common BLE address formats before
logging or storing the Bluetooth error-state value. Noble's Linux D-Bus
binding currently assumes advertisements are connectable, so the adapter
reports connectability as unknown for that backend rather than treating
Noble's value as hardware evidence.
Scans blocked by an initial connection attempt, poll, write, pending or active
Dynamic circuit current update, reconnection, or other search are reported at
info level with the individual busy flags, and the blocking operation is
written to `info.bluetoothScanResults`. An established idle charger connection
alone does not block a diagnostic advertisement scan.

Use **Search for Easee BLE devices** to run one unfiltered advertisement scan
for up to 30 seconds. Newly observed name/connectability/service-UUID and
manufacturer-signature combinations appear in `info.bluetoothScanResults` while
the scan runs. At completion, advertisements containing the Easee service UUID
or manufacturer ID 3118 are listed as matches with Noble's observed peripheral
identifier and connectability; that identifier is not asserted to be the
charger's serial number. Other advertisements remain diagnostic observations
and are not classified as Easee matches. Search results are informational and
are never added to configuration. Add a charger explicitly through the
aioBroker Device Manager, where its serial number and PIN are entered and
protected.

For automatic connection discovery, the adapter also considers a peripheral
whose broadcast local name exactly matches a configured charger's serial
number, even if the advertisement omits the Easee service UUID. Candidates
known to be non-connectable are reported and skipped; candidates whose
connectability is unknown (including the default Linux D-Bus backend) are still
attempted. The name is only a discovery hint: connection setup still requires the expected
Easee GATT service and characteristics before authentication and use. A
matching name alone does not prove the device's identity or availability.

A scan can return no matches when a charger is off, outside Bluetooth range,
not currently advertising, or otherwise unavailable; no match does not prove
that Bluetooth is disabled at the charger. If the **Raw HCI** binding is
selected in settings, or selected through `NOBLE_BINDINGS` while using
**Automatic**, it may conflict with BlueZ or another scanner such as
`bluetoothctl`; do not run a second scan at the same time. Searches are refused
as busy during an initial connection attempt, poll, or reconnection, or while a
Bluetooth write or Dynamic circuit current update is pending or active.
Scheduled polling/reconnection is held while the bounded scan runs, and writes
arriving during a search are rejected for retry rather than sent concurrently. A
simultaneous second search is rejected as busy, not queued. Stopping the adapter
cancels the scan and closes its Bluetooth resources. The Cloud mode never opens
the BLE scanner. A user reported seeing charger advertisements on macOS and
later confirmed a successful connection with this version; the updated
manufacturer-signature classification has not been independently checked on
hardware.

## Collecting Bluetooth connection diagnostics

For a Linux connection failure, collect the adapter's debug log and a host
Bluetooth trace for the same single attempt. Enable debug logging for this
adapter, restart it, and retain the startup line that identifies the selected
Noble binding. Adapter debug logs include stage transitions and elapsed times
for discovery, link connection, GATT discovery, notification setup, HELLO
writes and responses, authenticated reads, pairing, and disconnect. GATT
characteristic records include each expected channel's UUID and supported
notify/indicate/write properties; data and write records include UUID, channel,
byte count, notification flags, write mode, and connection state. Error records
classify common HCI failures such as `Unknown Connection Identifier` without
logging raw error messages. These diagnostics intentionally never include BLE
addresses, serials, credentials, or payload bytes. Start `btmon`
before the attempt so the trace includes the connection setup and the final
disconnect, not only the last pairing event:

```sh
sudo btmon -i hci0 | tee /tmp/easee-btmon.txt
```

Use the HCI controller selected on the host instead of `hci0` if necessary. For
the BlueZ D-Bus binding, also capture BlueZ's service log in a separate
terminal:

```sh
sudo journalctl -u bluetooth -f -o short-precise
```

On success, stop after the adapter reports the authenticated connection. On
failure, wait for the adapter's disconnect/error and the matching final
controller disconnect event in `btmon`. Do not run `bluetoothctl scan` or another
scanner during a Raw HCI attempt. The adapter's own logs cannot show raw SMP
pairing packets or BlueZ agent decisions; `btmon` and, for D-Bus, the BlueZ
service log are needed to evaluate those host-level events. Before sharing a
trace, redact BLE addresses and charger serials, and never include charger PINs,
account credentials, or keys. Preserve timestamps, protocol event names, and
status codes.

## Platform requirements

The adapter uses [`@stoprocent/noble`](https://github.com/stoprocent/noble)
2.8.0, an MIT-licensed Node.js BLE central with N-API native bindings and a
declared Node.js requirement of 14 or newer. The upstream documents macOS,
Linux, Windows, and Docker, but their setup differs by operating system. This
repository's dependency installation succeeded on Node 22.23.2 on macOS; this
is not a BLE hardware test, nor does it verify Node 22.19 on every platform.

In Bluetooth mode, the settings page provides **Automatic** (default),
**BlueZ D-Bus**, and **Raw HCI** choices. On Linux, Automatic selects BlueZ
D-Bus unless `NOBLE_BINDINGS` supplies a supported override; on other platforms
it uses Noble's platform default unless overridden. An explicit settings choice
takes precedence over `NOBLE_BINDINGS`. The adapter logs the selected Noble
binding at startup. BlueZ D-Bus uses the host BlueZ service and is intended to
coexist with other Bluetooth clients. The `dbus-next` runtime dependency is
included.

Raw HCI requires a powered Bluetooth LE controller and `CAP_NET_RAW` for the
Node.js process, and may conflict with BlueZ or another scanner. Noble's HCI
setup guide describes granting this capability to the Node.js binary; note that
this affects every process using that binary. Prefer a service-scoped capability
where the host service manager supports it, and verify permissions for the
actual adapter user. The D-Bus binding requires the system BlueZ service and
access to the system bus. A Raspberry Pi test with the default D-Bus binding reached the BLE HELLO
exchange but timed out waiting for its notification. After switching to Raw HCI
and applying the MTU 333 update, a later test completed HELLO and authenticated
config/state reads. This validates Raw HCI only on that setup.

On macOS, the native binding requires the platform's native build tools and
Bluetooth permission for the process running ioBroker. A user reported a
successful macOS connection with this version; this does not establish
compatibility with other macOS setups or charger models. On Windows, Noble
documents native Windows support; native build requirements and Bluetooth
permissions still apply, but Windows has not been hardware-tested with this
adapter.

For Docker on Linux, the default D-Bus binding needs access to the host system
bus and BlueZ service (often through `/run/dbus/system_bus_socket`); exposing
that socket grants access to host D-Bus interfaces and must be scoped carefully.
If `NOBLE_BINDINGS=hci` is selected instead, Noble documents `--network=host`, a
visible host controller, and `CAP_NET_RAW` (for example,
Docker's `--cap-add=NET_RAW`). These settings are not sufficient on every host
or Docker configuration and have not been tested with ioBroker images here.
The optional HCI user-channel mode has additional `CAP_NET_ADMIN` requirements
and is not assumed. Do not grant `--privileged`; there is no one-size-fits-all
Docker recipe verified by this project.

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
