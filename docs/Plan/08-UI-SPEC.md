<!--
AI: This is the source of truth for every screen's layout and interactive states. Implement exactly as specified.
Read first: 01-PRD.md (which screens exist), 09-UX-SPEC.md (global UX rules), 07-USER-FLOWS.md (how screens connect)
You must: Implement every state listed (loading, empty, error, success). Apply responsive rules at every breakpoint.
You must not: Render a screen that has no empty state or error state defined. Use color alone to convey meaning.
Human reviews this: YES — agree on UI spec before building components.
-->

# UI Spec
**Project:** Authenticator

---

## Screen: Authenticator Main (Dedicated Phone)
Route: Launch activity | Auth required: no (runs as service)

### Layout
```
[Centered content — vertical LinearLayout, padding 24dp]
  [Status text]: "✅ Phone Authenticator\nRUNNING 24/7"
  [Sub text]: "Do NOT close this app.\nThis phone only listens for SMS."
  [Auto-start button]: "⚙️ Enable Auto-Start\n(for Xiaomi/Oppo/Vivo)"
```

### Components

#### Status text
| Property | Value |
|----------|-------|
| Text | `✅ Phone Authenticator\nRUNNING 24/7` (updated dynamically) |
| Style | `textSize: 24sp`, `textStyle: bold`, `gravity: center` |

#### Sub text
| Property | Value |
|----------|-------|
| Text | `Do NOT close this app.\nThis phone only listens for SMS.` |
| Style | `textSize: 16sp`, `paddingTop: 20dp` |

#### Auto-start button
| Property | Value |
|----------|-------|
| Label | `⚙️ Enable Auto-Start\n(for Xiaomi/Oppo/Vivo)` |
| On click | Show AlertDialog → open `ACTION_APPLICATION_DETAILS_SETTINGS` |
| Disabled when | Never |
| Variant | Secondary |

### States
| State | Trigger | Behavior |
|-------|---------|----------|
| Loading | App first launch | Status text: "✅ Phone Authenticator\nSTARTING..." |
| Running | Service started successfully | Status text: "✅ Phone Authenticator\nRUNNING 24/7" |
| Error | Firebase auth failure | No visual change — retry happens silently |

### Responsive behavior
| Breakpoint | Behavior |
|------------|----------|
| All sizes | Single column, centered, minimal UI — this is a dedicated phone app |

---

## Screen: Client Verification (Ecommerce/Medical App)
Route: Inline component (not a full screen) | Auth required: no (public verification)

### Layout
```
[Verification card — max-width 480dp, centered, padding 24dp]
  [Title]: "Verify your phone number"
  [Phone input]: Hint "Enter phone number (e.g. +88017xxxxxxxx)"
  [Status text]: "" (shows verification state)
  [Verify button]: "Send Verification SMS"
```

### Components

#### Phone input
| Property | Value |
|----------|-------|
| Hint | `Enter phone number (e.g. +88017xxxxxxxx)` |
| Input type | `phone` |
| Validate on blur | Required, starts with `+`, ≥ 10 digits |

#### Verify button
| Property | Value |
|----------|-------|
| Label | `Send Verification SMS` |
| On click | Call `PhoneAuthHelper.verifyPhone()` |
| Disabled when | Phone input invalid, or request in flight |
| Variant | Primary |

#### Status text
| Property | Value |
|----------|-------|
| Default | `""` (empty) |
| Sending | `"Sending verification..."` |
| Polling | `"Waiting for verification... {countdown}s remaining"` |
| Success | `"✅ Phone verified: {sender}"` |
| Error | `"❌ {error message}"` |

### States
| State | Trigger | Behavior |
|-------|---------|----------|
| Idle | Screen loads | Show form, button enabled |
| Sending | Button pressed, SMS being sent | Button disabled with spinner, status: "Sending verification..." |
| Polling | SMS sent, waiting for CF response | Status: "Waiting for verification...", countdown timer, button disabled |
| Success | CF returns `verified: true` | Status: "✅ Phone verified: {sender}", button re-enabled |
| Error (rate limit) | CF returns 429 | Status: "❌ Too many requests. Please wait.", button re-enabled |
| Error (timeout) | 30s polling timeout | Status: "❌ Verification timed out. Please try again.", button re-enabled |
| Error (SMS failed) | sendSms returns false | Show retry guidance and allow the user to resend |

### Responsive behavior
| Breakpoint | Behavior |
|------------|----------|
| < 768px (Mobile) | Full-width form, stacked layout |
| > 768px (Tablet/Desktop) | Centered card, max-width 480dp |
