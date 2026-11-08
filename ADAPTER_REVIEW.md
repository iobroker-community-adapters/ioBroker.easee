# ioBroker Adapter Review Report

**Review date:** 2026-11-08
**Adapter version:** 3.2.0
**Reviewed branch and base commit:** `feature/bluetooth-connectivity`, `07deaa4`
**Review scope:** Full adapter review of runtime behavior, Cloud and Bluetooth transports, state objects and writes, configuration/Admin UI, translations, documentation, tests, dependencies, and packaging.
**Checklist:** `review-adapter-for-io-broker`, V3.5
**Review method:** Repository source and test inspection, current ioBroker references, dependency audits, and local automated checks.

## Status of Previous Review Findings

No earlier adapter-review findings were supplied for comparison. This is a full review of the current checkout.

## Full Re-Review Results (Checklist V3.5)

### PASS items

- Cloud remains the default transport, and Bluetooth is selected explicitly; no automatic Cloud fallback is introduced.
- Bluetooth configuration uses individual per-charger fields. PIN values are protected in Admin configuration, and the Bluetooth code does not log PINs.
- Cloud and Bluetooth command paths are kept separate. Unsupported Bluetooth writes are rejected rather than reported as successful.
- Existing state IDs are retained for supported Bluetooth mappings. Reviewed writable states include the phase-3 current limit, and polling maps phase-2 current to the phase-2 state.
- State acknowledgement handling avoids redispatching acknowledged updates. Cloud command buttons acknowledge only after a successful request; failed requests and invalid button values are not acknowledged as successful.
- Writable state roles and metadata were checked against the current ioBroker role guidance.
- External charger IDs, duplicate IDs, and session calendar values are validated before they are used to create dynamic objects.
- Polling and retry delays are bounded, and Cloud HTTP requests have a finite timeout.
- Regression and BLE tests cover protocol/data mapping, authentication and command failures, timeouts, reconnection, multiple devices, unsupported functions, and the default Cloud mode.
- `npm test` passed: 138 JavaScript tests and 61 package tests.
- `npm run check` passed.
- `npm run lint` completed with 0 errors and 141 warnings.
- `git diff --check` passed.
- `npm audit --omit=dev` reported 0 vulnerabilities. The patched production lockfile versions are `follow-redirects` 1.16.2 and `node-forge` 1.4.3.
- `npm pack --dry-run` included the runtime entry point, Admin configuration, and Bluetooth guide in a 33-file package.
- The adapter icon hash differs from the official adapter-creator template icon.

### ACTIONABLE FINDINGS

No open actionable findings remain. The review found and fixed these issues in the working tree:

- The phase-3 current-limit state was not subscribed for writes, making its Bluetooth command unreachable; the state is now subscribed.
- Phase-2 polling previously wrote the phase-3 value; it now writes the correct phase-2 value.
- Acknowledged state changes could be dispatched again as commands, and Cloud buttons could be acknowledged despite a failed request; both behaviors are corrected.
- Several state roles were invalid or mismatched to their values and write semantics; the roles and button metadata were corrected.
- Malformed or duplicate external IDs and invalid session calendar values could produce invalid dynamic objects; validation now rejects them.
- Unbounded polling, retry, and HTTP timing could leave the adapter with unsafe or excessively long waits; delays and request timeouts are bounded.
- Two production transitive dependencies were updated to patched versions in `package-lock.json`.

### OBSERVATIONS

- ioBroker's static `common.connectionType` metadata supports only one connection type. It remains `cloud` to reflect the backward-compatible default even though runtime configuration also offers Bluetooth.
- The full `npm audit` reports 18 development-dependency findings (17 moderate, 1 low). Remediation would require broader development-tool upgrades; no forced major upgrades were applied. The production-only audit is clean.
- Lint completes without errors but reports 141 warnings; this review did not establish whether all warnings predate the current changes.
- No applicable GitHub Actions run was available for this branch during the review. CI is therefore not claimed as passed.
- No real charger or Bluetooth hardware was available. BLE operation, range, firmware compatibility, Linux/Docker access, and other operating systems were not hardware-tested; compatibility claims remain limited to the documented expectations and automated tests.
- No object dump was supplied. Dynamic object paths and validation were reviewed in source and tests, but a controller-generated object-tree snapshot was not independently inspected.
- Review fixes and this report are local working-tree changes; they have not been committed or pushed.
