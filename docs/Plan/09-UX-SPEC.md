<!--
AI: These are global UX rules that apply to every screen and interaction in the project. No exceptions.
Read first: 08-UI-SPEC.md (for screen-specific behavior), 07-USER-FLOWS.md (for flow-specific behavior)
You must: Apply every rule here to every component you build. These are not suggestions.
You must not: Show a destructive action without a confirmation dialog. Lose user input on error. Skip loading states.
Human reviews this: YES — UX rules must be agreed before building UI.
-->

# UX Spec
**Project:** Authenticator

## Non-negotiable rules
- Never lose user input on error. Always preserve form state when an operation fails.
- Every async action must show a loading state. The UI must not appear frozen.
- Destructive actions always require a confirmation dialog before executing.
- No placeholder copy (`…`, `TODO`, `[to be defined]`) in any committed UI.

## Loading states
| Pattern | When to use | Implementation |
|---------|-------------|----------------|
| Button spinner | Verify button pressed | Replace button label with spinner, disable button, show "Sending verification..." |
| Polling indicator | Waiting for verification | Show "Waiting for verification..." with animated dots, display countdown timer (30s) |
| Skeleton | App initial load | Pulse animation on status text |

## Feedback & notifications
| Event | Mechanism | Duration | Dismissable | Position |
|-------|-----------|----------|-------------|----------|
| Phone verified | Toast — green: "✅ Phone verified: {sender}" | 4s auto-dismiss | yes | Bottom |
| Verification failed | Inline below button: "❌ {error}" | Until dismissed | yes | Below verify button |
| SMS send failed | Toast — orange: "SMS failed. Please retry." | Persistent | yes | Bottom |
| Network error | Toast — red: "Network error. Please try again." | Persistent | yes | Bottom |
| Rate limited | Toast — red: "Too many requests. Please wait." | 4s auto-dismiss | yes | Bottom |

## Confirmation dialogs

### SMS send failure dialog
```
Title: "SMS Send Failed"
Body: "We couldn't send the verification SMS. Please check your SMS settings and retry."
Actions:
  [Cancel] (left, neutral)
  [Retry SMS] (right, primary-styled)
```

### Authenticator app — Battery optimization
```
Title: "⚠️ Battery Optimization"
Body: "This app MUST run 24/7 to receive SMS.\n\nPlease tap 'Allow' on the next screen to prevent Android from killing this app.\n\nThis phone will stay plugged in, so battery drain is not a concern."
Actions:
  [Open Settings] (right, primary-styled)
```

### Authenticator app — Auto-start (Chinese ROMs)
```
Title: "Enable Auto-Start"
Body: "On some phones (Xiaomi, Oppo, Vivo, Huawei), you need to manually enable 'Auto-Start' for this app.\n\nOn the next screen, find 'Phone Authenticator' and enable it."
Actions:
  [Skip] (left, neutral)
  [Open App Settings] (right, primary-styled)
```

## Forms (Client App)
- Validate phone number on blur: non-empty, starts with `+`, minimum 10 digits
- Disable verify button while request is in flight
- On verify success: show success state, clear form after 3 seconds
- On verify failure: retain phone number input, show error below button

## Navigation
- Single-screen authenticator app — no navigation
- Client app: verification is inline (no separate page)

## Empty states
### Authenticator app (main screen)
```
Heading: "✅ Phone Authenticator"
Body: "RUNNING 24/7"
Subtext: "Do NOT close this app. This phone only listens for SMS."
CTA: [⚙️ Enable Auto-Start (for Xiaomi/Oppo/Vivo)] — only if applicable
```

## Breakpoints
| Name | Width | Notes |
|------|-------|-------|
| Mobile (authenticator) | Any | Single column, centered text, minimal UI |
| Mobile (client) | < 768px | Full-width verify form, stacked layout |
| Tablet/Desktop (client) | > 768px | Centered card layout, max-width 480px |
