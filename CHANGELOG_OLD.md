# Older changes
## 3.1.0 (2026-11-01)
- (Voodoo2man) Corrected cable-lock status reporting and improved the reliability of charger status updates.
- (Voodoo2man) Added a readable and adjustable permanent cable-lock setting, kept separate from the actual cable-lock status.
- (Voodoo2man) Improved recovery of live charger updates after connection interruptions while retaining regular status updates when live updates are disabled.

## 3.0.0 (2026-10-23)
- (Voodoo2man) Raised the minimum Node.js version to 22.19.0.

## 2.0.0 (2026-10-18)
- (Voodoo2man) Improved charger status updates and recovery after connection interruptions, with contributions from @Michaelnorge, @Codibris, and @m1chel87 and earlier compatibility work by @NCIceWolf.
- (Voodoo2man) Improved circuit-current controls and added configurable session updates across chargers.
- (Voodoo2man) Added configurable charging costs, including VAT.

## 2.0.0-alpha.1 (2026-10-17)
- (mcm1957) Adapter has been migrated into the iobroker-community-adapter-organisation
- (iobroker-bot) Adapter requires node.js >= 22 now.
- (copilot) Adapter requires js-controller >= 7.2.2 now
- (copilot) Adapter requires admin >= 7.7.22 now

## 1.0.10 (2023-07-27)
* (Newan) fix version number

## 1.0.9 (2023-07-27)
* (walburgf)  changed API URL from api.easee.cloud to api.easee.com
* (walburgf)  created addition parameter in admin config to reduce/steer logging information for user
* (walburgf)  modified internationalization to use jsonConfig.json. this needs at least ioBroker.admin version 5
* (walburgf)  added dependency to admin >=v5.1.28

## 1.0.8 (2023-07-02)
* (Newan)  small fixes

## 1.0.7
* (Newan) Changed login URL

## 1.0.6
* (Newan) Changed that smart charging is editable

## 1.0.5
* (marwin79) More Features supported and convert values to expected datatypes

## 1.0.4
* (Newan) dynamicCircuitCurrentPX writeable (set all Phases in 500ms) to limit ampere

## 1.0.3
* (Newan) Adapter crash fixed an other bugfixes

## 1.0.1
* (Newan) Add circuitMaxCurrentPX to limit current ampere

## 1.0.0
* (Newan) Stable Version with SignalR
