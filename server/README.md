# dP Relay v5 Server

Fastify + TypeScript + SQLite (WAL). See `docs/httpsms vs dprelay/Modification 6/PLAN.md` for the architecture and `SETUP-R2.md` for backup provisioning.

## Run

```bash
cp .env.example .env   # adjust locally
npm ci
npm run dev            # tsx watch, http://localhost:3000/health
```

## Test / Build / Start

```bash
npm test        # vitest (uses temp DBs, no env needed)
npm run build   # tsc → dist/
npm start       # node dist/index.js
```

## Render deployment (free web service)

- **Root Directory:** `server`
- **Build Command:** `npm ci && npm run build`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`
- Node version pinned by `.node-version` (20)

## Durability (R1–R2 constraints from the plan)

Render's free disk is ephemeral. Until the Litestream entrypoint ships, this service may lose data on restart — do not point real traffic at it before `litestream.yml.example` is wired into the start command.
