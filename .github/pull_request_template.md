## What and why

<!-- What does this change, and why? Link issues with "Fixes #123". -->

## Contracts

- [ ] No cross-package interface changed
- [ ] `docs/CONTRACTS.md` updated in this PR (explain below), and every side of the interface matches it

## How I tested

- [ ] `npm run build` and `npm test` pass at the repo root
- [ ] `npm run test:bundle -w flutter-intercept` passes
- [ ] New or changed behaviour is covered by tests
- [ ] Ran the integration suite (`npm run test:integration` in `packages/extension`), if the debug provider, entry generation or devices are affected
- [ ] Tried it on devices (list them: Android emulator/phone, iOS simulator, iPhone USB/Wi-Fi, macOS):

## Docs

- [ ] User-visible change documented in `packages/extension/README.md` and/or `packages/extension/CHANGELOG.md`
- [ ] Measured results recorded in `docs/spikes/*.md` (if applicable)

## Hygiene

- [ ] No signing team IDs, device UDIDs/serials, proxy tokens, CA keys, emails or private IPs in the diff (including fixtures, logs and `project.pbxproj`)
