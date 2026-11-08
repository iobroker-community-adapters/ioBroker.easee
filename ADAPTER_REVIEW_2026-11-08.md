# ioBroker Adapter Review — 2026-11-08

**Adapter:** `iobroker.easee` 3.2.0
**Branch / reviewed HEAD:** `feature/bluetooth-connectivity` / `461b968`
**Checklist:** `review-adapter-for-io-broker`, V3.5
**Scope:** Current worktree review of adapter runtime and object/state handling, Cloud polling and writes, Bluetooth Device Manager/search/client lifecycle, Admin configuration and translations, documentation, tests, dependencies, CI/build and package contents.
**Review timing:** The initial review covered the worktree at that point; subsequent BlueZ pairing changes and validation are recorded below.

## Findings fixed

| Severity | Area | Finding and impact | Fix and verification |
|---|---|---|---|
| High | `main.ts` | A malformed object argument in the charging-price configuration path made `main.ts` fail to parse, preventing tests and runtime loading. | Closed the object correctly. TypeScript check, build, unit tests and package tests pass. |
| Medium | `admin/i18n/zh-cn.json` | A stray fragment made the Chinese Admin translation invalid JSON and failed package validation. | Repaired the JSON and retained the new search strings. All 11 Admin locale files validate; package tests pass. |
| Medium | `lib/bluetooth-client.ts` | Stopping while discovery was active could wait for discovery to finish before closing the scanner, delaying cleanup until a timeout. | Begin scanner shutdown immediately and await the startup task and cleanup. Added a pending-discovery stop regression test. |
| Medium | `main.ts` | Coalescing Cloud writes that shared a retry key could return an earlier request's result to a later, different write instead of sending the newer value. | Keep coalescing for reads; serialize writes and send each requested value. Added regression coverage for distinct charging-price payloads. |
| Low | `main.ts` | Transient responses represented as ordinary `{ response: { status } }` objects were not retried, although rate-limit delay parsing already supported this shape. | Classify supported response-shaped errors as transient while retaining Axios network-error handling. Existing Retry-After tests pass. |
| Low | `main.ts` | A session payload containing no valid calendar entries could still create empty charger/session object structure. | Return before creating objects when no valid sessions remain. Added/retained coverage for invalid calendar values. |
| Low | `main.ts` | Existing session authorization-token states could be reset to empty while objects were recreated on startup. | Initialize the states only when they do not yet have values. Added a regression test that preserves existing token and owner values. |

## Review coverage and remaining observations

- **Cloud/runtime:** Polling continues after unexpected errors; `info.connection` reflects the charger-list request, while `lastUpdate` changes only after a complete poll. Circuit and price writes are serialized where needed. Existing state IDs and acknowledgement behavior were checked in source and tests.
- **Bluetooth:** Search remains bounded and is coordinated with connection, polling, writes and shutdown. Search results do not modify configuration; PINs are not included in search results or diagnostics. Manual search start/result counts are logged, and a blocked attempt records its specific blocking operation in `info.bluetoothScanResults`. On Linux BlueZ, an authentication-related GATT write error now requests pairing once and retries that write once; the pairing call is bounded to 30 seconds. No hardware was available, so BLE authentication, range, firmware and real charger commands were not hardware-tested.
- **Admin/configuration:** The Device Manager remains the explicit path for adding chargers; configured PINs use the adapter's encryption mechanism. Search results are informational and do not auto-add devices. Locale JSON passed package validation.
- **Dynamic objects:** Charger IDs and session calendar values are validated before object paths are created. No controller object dump was supplied, so a live object-tree comparison could not be performed.
- **Dependencies:** `npm audit --omit=dev` reported **0 production vulnerabilities**. Full `npm audit` reported **18 development-dependency findings** (17 moderate, 1 low); proposed remediation includes major tooling changes, so no forced upgrade was applied.
- **Lint:** `npm run lint` completed with **0 errors and 146 warnings**, primarily JSDoc warnings. The warnings were not broadly suppressed or changed as part of this review.
- **Compatibility:** Automated validation ran on the current macOS environment with Node.js 22.23.2. The integration harness started the adapter under its temporary js-controller 8 test environment. Other Node.js versions, operating systems, Docker configurations and Bluetooth hardware were not tested here.
- **Release/CI:** `npm pack --dry-run` included `build/main.js` and `docs/bluetooth.md` (45 files). No CI run can validate these uncommitted changes; no release or manual release-only Repository Checker was run.

## Verification

- `npm test` — passed: **202 JavaScript tests** and **61 package tests** (including the BlueZ pairing retry coverage).
- `npm run test:integration` — passed: **1 adapter startup test**.
- `npm run check` — passed.
- `npm run lint` — passed with 0 errors and 146 warnings.
- `npm run build` — passed as part of package testing.
- Built entry-point import with the ioBroker adapter-core module stubbed — passed.
- `npm pack --dry-run` — passed; package contains `build/main.js` and the Bluetooth guide.
- `npm audit --omit=dev` — passed with 0 vulnerabilities.
- `git diff --check` — passed.
