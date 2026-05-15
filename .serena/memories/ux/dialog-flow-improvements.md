# UX: One-Time Permission & Settings Dialogs

## Problem
`MainActivity` unconditionally shows the following dialogs on **every fresh start**, even if the user already configured everything:
- Battery optimization dialog (no skip, forces "Open Settings")
- Auto-start dialog (Xiaomi/MIUI specific)

This makes every restart (crash recovery, MIUI kill, reboot) require manual user interaction before the service can start.

## Required for Production
Each dialog must only be shown **once**, or only when the setting is actually missing:

1. **Battery optimization** — check `PowerManager.isIgnoringBatteryOptimizations(packageName)` before showing the dialog. Skip the dialog entirely if already exempted.
2. **Auto-start** — there is no reliable programmatic API to check auto-start status on MIUI. Best approach: store a flag in SharedPreferences (`autostart_prompted = true`) after the user dismisses the dialog once, and never show it again.
3. **SMS / Notification permissions** — Android's `ContextCompat.checkSelfPermission()` already handles this correctly (system won't re-prompt if already granted), but the app should call `checkSelfPermission` before calling `requestPermissions` and skip straight to `onPermissionsGranted()` if all are already granted.

## Files to Change
- `authenticator-app/app/src/main/java/com/digitalpapyrus/authenticator/MainActivity.kt`
  - `requestSmsPermissions()` — add pre-check with `checkSelfPermission`
  - `onPermissionsGranted()` / `showBatteryOptimizationDialog()` — add `isIgnoringBatteryOptimizations` guard
  - `onBatteryOptimizationComplete()` / `showAutoStartDialog()` — add SharedPreferences flag guard

## Priority
Low — not blocking current operation. Required before production deployment.
