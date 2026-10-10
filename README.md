# dP Relay

> **Universal Cellular SMS Gateway & Transactional Relay Platform**  
> Send OTP and Bulk SMS globally using your own Android phone as a cellular gateway — or leverage dedicated, operator-managed gateways in Bangladesh.

---

## 🌟 What is dP Relay?

**dP Relay** is a developer-first SMS infrastructure platform designed to eliminate predatory telecom SMS markups, complex carrier aggregators, and vendor lock-in. It turns standard Android devices into high-performance, programmable SMS gateways that connect directly to modern cloud APIs.

The platform operates across two distinct modes:

### 1. 🌍 Global BYOD (Bring Your Own Device) — *Available Worldwide*
* **Send SMS through your own mobile number and local cellular plan**, anywhere on the globe.
* Install the lightweight **dP Relay Gateway Android app** on an Android smartphone with an active SIM card.
* Connect the device to your dP Relay app credentials via API.
* Dispatch transactional OTPs and batch marketing messages directly through your device's cellular network at the cost of your local carrier plan.

### 2. 🇧🇩 Dedicated Operator Relay — *Bangladesh*
* **Turnkey SMS relay without maintaining physical hardware.**
* For businesses, startups, and developers in Bangladesh who do not wish to manage physical Android devices, the dP Relay operator provides dedicated, pre-configured Bangladeshi carrier gateways.
* Purchase OTP and Bulk SMS credit bundles with automated local mobile financial service reconciliation (**bKash** automated transaction ingest).
* Send high-deliverability SMS across Grameenphone, Robi, Banglalink, and Teletalk networks.

---

## 🚀 Key Features

* **⚡ Transactional OTP Engine**: Complete OTP issuance, delivery, and constant-time verification lifecycle with automated rate limiting, phone number normalization (E.164), and webhook callback dispatch.
* **📢 High-Throughput Bulk Campaigns**: Dynamic message templating (`{{name}}`, `{{custom_field}}`), contact group management, automated recipient batching, configurable burst rates, and live delivery status tracking.
* **📱 Native Android Cellular Gateway**: Robust background service that maintains an encrypted control channel with the relay server, dispatches cellular SMS via Android `TelephonyManager`, captures native carrier delivery reports, and syncs statuses back in real-time.
* **🖥️ Modern Web Dashboard (`web-v5`)**: Complete responsive interface for app provisioning, API key management, webhook configuration, campaign monitoring, contact group management, credit purchasing, and ledger audits.
* **🛡️ Operator Command Center**: Administrative suite for monitoring fleet health, gateway heartbeats, staleness watchdog alarms, automatic quarantine for unresponsive devices, package configuration, and payment verification.
* **💳 Automated Payment Reconciliation (`payment-reader`)**: Android reader app that parses incoming bKash transaction alerts and automatically verifies & awards credit purchases in real-time without human intervention.
* **💰 Zero-Cost Production Footprint**: Fastify + Better-SQLite3 backend hosted on Render, static marketing pages on Cloudflare Pages CDN, achieving high throughput with $0.00/month infrastructure cost.

---

## 🏗️ System Architecture

```
                      ┌──────────────────────────────────────┐
                      │    Marketing & Documentation         │
                      │  https://dprelay.digital-papyrus.com │
                      │       (Cloudflare Pages CDN)         │
                      └──────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────┐                 ┌────────────────────────────────┐
│      Client / Dashboard        │                 │        Third-Party Apps        │
│ app.dprelay.digital-papyrus.com│                 │     E-Commerce / Medical /     │
│        (Render Static)         │                 │         Custom Backend         │
└────────────────────────────────┘                 └────────────────────────────────┘
                │                                                  │
                │              REST API / Webhooks                 │
                └─────────────────────────┬────────────────────────┘
                                          ▼
                      ┌──────────────────────────────────────┐
                      │          dP Relay Core API           │
                      │  https://api.dprelay.digital-papyrus │
                      │      (Fastify + Better-SQLite3)      │
                      └──────────────────────────────────────┘
                                          │
                        WebSocket / Encrypted HTTPS Queue
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
   ┌─────────────────────────────────┐         ┌─────────────────────────────────┐
   │     Global BYOD Gateways        │         │   Operator Gateways (BD Fleet)  │
   │  Your Android Phone + SIM Card  │         │   Dedicated dP Relay Pool Sims  │
   │   (authenticator-app / Gateway) │         │   (Auto-reconciled with bKash)  │
   └─────────────────────────────────┘         └─────────────────────────────────┘
                    │                                           │
                    ▼                                           ▼
            Local Mobile Carrier                        Bangladeshi Telcos
           (Any Carrier Worldwide)                 (GP, Robi, Banglalink, Teletalk)
```

---

## 📂 Repository Structure

| Directory | Description | Technology Stack |
|---|---|---|
| [`server/`](./server) | Core REST API, billing, OTP lifecycle, bulk scheduler, and WebSocket server | Node.js 20, Fastify, Better-SQLite3 |
| [`web-v5/`](./web-v5) | Client dashboard and Operator control panel | React 18, Vite 5, TypeScript |
| [`landing/`](./landing) | High-performance static marketing landing page, docs, and pricing | Vanilla HTML5, CSS3 (Cloudflare Pages) |
| [`authenticator-app/`](./authenticator-app) | Android Gateway background service for sending & receiving SMS | Kotlin 1.9, Android SDK 26–34 |
| [`payment-reader/`](./payment-reader) | Android payment listener app for automated bKash SMS reconciliation | Kotlin 1.9, Android WorkManager |
| [`client/`](./client) | Lightweight client SDK for easy integration into third-party apps | Kotlin / Multiplatform |
| [`docs/`](./docs) | Architecture Decision Records (ADRs), API specs, and schemas | Markdown, OpenAPI 3.0 |

---

## ⚡ Quick Start: Sending an SMS via API

### 1. Authenticate with your App Credentials
Every API request requires your `X-App-Id` and `X-App-Secret` headers obtained from your [dP Relay Dashboard](https://app.dprelay.digital-papyrus.com):

```bash
curl -X POST https://api.dprelay.digital-papyrus.com/api/v5/otp/send \
  -H "Content-Type: application/json" \
  -H "X-App-Id: your_app_id" \
  -H "X-App-Secret: your_app_secret" \
  -d '{
    "phoneNumber": "+8801700000000",
    "purpose": "login"
  }'
```

### 2. Verify an OTP Code
```bash
curl -X POST https://api.dprelay.digital-papyrus.com/api/v5/otp/verify \
  -H "Content-Type: application/json" \
  -H "X-App-Id: your_app_id" \
  -H "X-App-Secret: your_app_secret" \
  -d '{
    "phoneNumber": "+8801700000000",
    "code": "482910"
  }'
```

### 3. Send a Bulk Campaign
```bash
curl -X POST https://api.dprelay.digital-papyrus.com/api/v5/bulk/campaigns \
  -H "Content-Type: application/json" \
  -H "X-App-Id: your_app_id" \
  -H "X-App-Secret: your_app_secret" \
  -d '{
    "name": "Weekend Sale Announcement",
    "message": "Hello {{name}}! Enjoy 20% off with code FLASH20 today.",
    "recipients": [
      { "phone": "+8801700000000", "variables": { "name": "Rahim" } },
      { "phone": "+8801800000000", "variables": { "name": "Karim" } }
    ]
  }'
```

---

## 🔒 Security & Verification

* **Cryptographic Signing**: Webhook dispatch is signed with HMAC-SHA256 (`X-Signature-256`) to ensure message integrity.
* **Timing-Attack Resistance**: Constant-time comparison (`crypto.timingSafeEqual`) on all secrets, tokens, and verification codes.
* **Fail-Closed Builds**: Release APKs are built and signed exclusively using environment-driven keystore credentials; unsigned or debug builds are prevented in production.
* **Device Watchdog**: Server-side watchdog monitors gateway heartbeats every 60 seconds; inactive gateways are automatically quarantined to prevent dropped SMS queues.

---

## 📄 License & Ownership

Copyright © 2026 Digital Papyrus. All rights reserved.
