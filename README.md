# SDE Assignment — Auto-Generated CRUD + RBAC Platform

A compact internal developer platform that lets admins define data models from a UI and **auto-generates full CRUD APIs + Admin UI + RBAC**.
This repo contains a production-minded backend (Node + TypeScript + Express + Prisma + PostgreSQL) and a frontend admin UI (React + Vite + TypeScript).
Extras included: model versioning, file-backed published models, audit logs, JWT auth with rotation, token refresh, hot reload, relations, owner enforcement, and seed data.

---

## Table of contents

1. [Quick status / summary](#quick-status--summary)
2. [Repository layout](#repository-layout)
3. [Prerequisites](#prerequisites)
4. [Environment (masked) — `.env.example`](#environment-masked---envexample)
5. [Backend — install & run](#backend---install--run)
6. [Database & Prisma (migrations & generate)](#database--prisma-migrations--generate)
7. [Seeding (system + models + records)](#seeding-system--models--records)
8. [Frontend — install & run](#frontend---install--run)
9. [How it works — architecture & design notes](#how-it-works---architecture--design-notes)
10. [Dynamic APIs & file-backed publishing](#dynamic-apis--file-backed-publishing)
11. [RBAC & ownership rules](#rbac--ownership-rules)
12. [System model mapping (record-id ↔ origin-id)](#system-model-mapping-record-id--origin-id)
13. [Audit logs, versioning & model files (`/models`)](#audit-logs-versioning--model-files-models)
14. [Hot reload / development ergonomics](#hot-reload--development-ergonomics)
15. [Troubleshooting & tips](#troubleshooting--tips)
16. [Testing & verification commands (recommended)](#testing--verification-commands-recommended)
17. [Final notes](#final-notes)

---

## Quick status / summary

* **Backend:** Node (TS) + Express, Prisma (Postgres), JWT (RS256), bcrypt, token rotation, audit logs, versioned models.
* **Frontend:** React + Vite + TypeScript. Admin UI auto-renders forms + lists based on published model JSON files.
* **Important features:** dynamic CRUD registration, file persistence for published models (`/models/*.json`), model versioning (ModelVersion table), RBAC at model & feature level, owner enforcement, hot reload during dev.
* **Caveat:** Backend is solid and production-minded; frontend is functional with minimal design — you may want to polish the UI/UX and edge-case form validation.

---

## Prerequisites

* Node 18+ / npm (or pnpm/yarn)
* PostgreSQL running locally (or a hosted instance)
* `openssl` (or another way) to generate RSA keypair for RS256 JWT (dev only)
* `npx` / `ts-node` for seed scripts (or run compiled code)

---

## Environment (masked) — `.env.example`

Create a `.env` in the `backend` root. **Replace values** in angle brackets with your own secrets.

```env
# Database
DATABASE_URL="postgresql://<DB_USER>:<DB_PASS>@<DB_HOST>:<DB_PORT>/<DB_NAME>"

# RSA key files (RS256)
JWT_PRIVATE_KEY_PATH=./keys/private.pem
JWT_PUBLIC_KEY_PATH=./keys/public.pem

# Token lifetimes (seconds)
ACCESS_TOKEN_TTL=<900>       # default 900 = 15 minutes
REFRESH_TOKEN_TTL=<2592000>  # default 30 days

# bcrypt rounds for hashing refresh tokens
HASH_ROUNDS=<12>

JWT_ISSUER=<internal-platform>
COOKIE_SECURE=<false>          # set true in production (requires https)
COOKIE_SAMESITE=<lax>

# Seed accounts (change in prod)
SEED_ADMIN_EMAIL=<admin@local.test>
SEED_ADMIN_PASSWORD=<AdminPass123!>
SEED_MANAGER_EMAIL=<manager@local.test>
SEED_MANAGER_PASSWORD=<ManagerPass123!>
SEED_VIEWER_EMAIL=<viewer@local.test>
SEED_VIEWER_PASSWORD=<ViewerPass123!>
```

> **Security note:** Do **not** commit your real `.env` or RSA private key to the repo. Keep keys in a secrets manager for production.

---

## Backend — install & run

From `/backend`:

1. Install

```bash
npm install
```

2. Generate Prisma client (if not generated automatically)

```bash
npx prisma generate
```

3. Run DB migrations (creates tables)

```bash
npx prisma migrate dev --name init
```

4. Seed system data (users, roles, models, model versions, records)
   You may have either of these scripts — run whichever exists in `/src/seed/`:

```bash
# common example commands:
npx ts-node src/seed/initialSeed.ts
# OR (if using the other filename)
npx ts-node src/seed/seed_system_and_models_fixed.ts
```

> Seed does:
>
> * create Roles (Admin/Manager/Viewer), Permissions, Users
> * create/publish ModelDefinition + ModelVersion snapshots for system and demo models
> * write published model JSON files to `/models/*.json`
> * create example records and audit logs

5. Start in development (with hot reload)
   Recommended: use `ts-node-dev` or `nodemon` in package.json dev script. Example:

```bash
npm run dev
# (internally: ts-node-dev --respawn --transpile-only src/index.ts)
```

If you use a compiled start:

```bash
npm run build
npm start
```

---

## Database & Prisma (migrations & generate)

1. Ensure `.env` `DATABASE_URL` points to Postgres.
2. Create initial migration:

```bash
npx prisma migrate dev --name init
```

3. Generate client:

```bash
npx prisma generate
```

Whenever you change Prisma schema:

* update `prisma/schema.prisma`
* run `npx prisma migrate dev --name <desc>` (or `prisma migrate deploy` in CI)
* run `npx prisma generate`

---

## Seeding (system + models + records)

Seed script prepares everything:

* Creates *system tables* (Role, User, Permission)
* Creates *ModelDefinition* and *ModelVersion* records for system models (User, Role) and demo domain models (Product, Employee, etc.)
* Mirrors system rows into `Record` table
* Writes published model JSON files to `/models/` (these files are the source of truth for admin UI + dynamic route registration)
* Adds sample records and audit logs

Run:

```bash
npx ts-node src/seed/initialSeed.ts
# or
npx ts-node src/seed/seed_system_and_models_fixed.ts
```

If seed fails:

* confirm Postgres connection `DATABASE_URL`
* confirm RSA keys exist (some seeds write audit or create users that might rely on config)

---

## Frontend — install & run

From `/frontend`:

```bash
npm install
npm run dev      # starts Vite dev server
# or
pnpm install && pnpm dev
```

Open: [http://localhost:5173](http://localhost:5173) (default Vite port)

**Note:** Frontend does not require an `.env` to start (but you may configure API base URL in a client config).

---

## How it works — architecture & design notes

* **ModelDefinition & ModelVersion**

  * `ModelDefinition` is a canonical model entry (name, json, version counter, published flag).
  * Each publish creates a **ModelVersion** snapshot (`json`, `versionNumber`). The system uses the **latest ModelVersion** for runtime behavior.
  * `resolvePublishedModel(routeName)` enforces that `modelDefinition.published == true` and picks the most recent `ModelVersion` (by versionNumber). (If you want stricter behavior require ModelVersion to have `published:true` as well — small tweak recommended.)

* **Dynamic CRUD**

  * On model publish the server writes `/models/<ModelName>.json` and dynamically registers route handlers:

    * `POST /api/<model>`
    * `GET /api/<model>`
    * `GET /api/<model>/:id`
    * `PUT /api/<model>/:id`
    * `DELETE /api/<model>/:id`
  * CRUD handlers use Prisma `Record` table for dynamic models and system tables (`user`, `role`) for system models with careful dual-write and transactional mirroring.

* **RBAC**

  * Role → Feature permissions stored in `RolePermission`.
  * Model-level permissions stored in `ModelRolePermission` for `MODEL.CREATE`, `MODEL.READ`, etc.
  * Middleware validates claims from JWT (RS256) and enforces both feature-level checks and model-level checks. Ownership checks enforced when ownerField present.

* **JWT + Token rotation**

  * RS256 keys stored via env paths; access token TTL and refresh TTL in env.
  * Refresh tokens hashed in DB with rotation/replacement pointers (`RefreshToken` model).

* **Audit log**

  * Immutable `AuditLog` entries for important operations (model publish, record create/update/delete, system user creation, token rotation events).

---

## Dynamic APIs & file-backed publishing

* When an admin clicks **Publish**:

  1. Server writes `ModelDefinition` (published=true) into DB and creates `ModelVersion` snapshot.
  2. Server writes `/models/<modelName>.json` (includes modelId, version, fields, ownerField, rbac mapping).
  3. Server registers/refreshes dynamic CRUD routes for that model (runtime registration).
  4. Admin UI reads `/models` to render forms and tables.

* Files under `/models` are **source-of-truth** for Admin UI and quick recovery. Keep them checked into a separate repo or an object store for production persistence if you require strict auditability.

---

## RBAC & ownership rules (practical)

* Admin role → `ALL` permissions by default (seeded).
* Managers → create/read/update (as seeded).
* Viewer → read only.
* For owner-sensitive operations (update/delete), middleware enforces:

  * User with `MODEL.UPDATE` or `MODEL.DELETE` for that model can proceed.
  * If model defines `ownerField` then only record owner OR roles with elevated permission (Admin) can modify or delete.

---

## System model mapping (record-id ↔ origin-id)

Important nuance (already implemented in backend):

* System tables (`role`, `user`) use *origin UUIDs* (their real Prisma `id`).
* Model `Record` rows for system-models have data JSON that contains `id` which is the origin `id`. But the `Record` row itself has a different `id` (Record UUID).
* **Frontend may send a roleId as a *record id* (a role model record).** The backend maps that record id → origin role id (by reading `Record.data` → `._origin?.id` or `data.id`) and writes the proper system `roleId` into `user.roleId`.
* When returning records to client, backend maps system `roleId` → role model record id (if record exists) so client keeps using record ids uniformly.

This mapping guarantees the UI can treat relations always as record-level links but the system tables remain normalized.

---

## Audit logs, versioning & model files (`/models`)

* Every publish creates a `ModelVersion` snapshot and an entry in `AuditLog`.
* `/models/<ModelName>.json` contains:

  * `modelId`, `version`, `fields`, `ownerField`, `isSystem` flag, `timestamp`, and RBAC rules for roles.
* Keep `/models` as a human-readable artifact of what was published.

---

## Hot reload / development ergonomics

* Backend dev: use `ts-node-dev` or `nodemon` to hot-reload TypeScript API code.

  * Example `package.json` dev script:

    ```json
    "dev": "ts-node-dev --respawn --transpile-only src/index.ts"
    ```
* Frontend: Vite already hot-reloads.

---

## Troubleshooting & tips

### Common issues

* **Cannot log in**

  * Check `.env` keys (RSA key paths) and database connectivity.
  * Ensure seed created admin user (`SEED_ADMIN_*`) and that the seed script ran.
* **Seed fails**

  * Confirm `DATABASE_URL` and that DB is reachable.
  * Check for duplicate unique constraints — clear DB / re-run with `prisma migrate reset` (dev only).
* **Model endpoints 404 after publish**

  * Confirm `ModelDefinition.published` is `true` and ModelVersion exists.
  * Check `/models/<ModelName>.json` got written.
* **Role id mismatch / relation problems**

  * Remember frontend may send a *record id*. Backend attempts to map record→origin. If mapping fails, check the corresponding Role record JSON in `/models` and the `Record.data` for `id` or `_origin.id`.

### Debugging

* Search logs for `SYSTEM_USER_CREATE`, `SYSTEM_ROLE_CREATE`, `RECORD_CREATE` audit entries.
* Use Prisma Studio:

  ```bash
  npx prisma studio
  ```

---

## Testing & verification commands (recommended)

* Run Prisma Studio to inspect tables:

  ```bash
  npx prisma studio
  ```
* Verify published files exist:

  ```bash
  ls -la backend/models
  cat backend/models/User.json
  ```
* Test auth flow (example cURL):

  ```bash
  # login -> receive access + refresh token
  curl -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@local.test","password":"AdminPass123!"}'
  ```
* Test creating a dynamic record (replace token / model):

  ```bash
  curl -X POST http://localhost:3000/api/Product \
    -H "Authorization: Bearer <ACCESS_TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{"name":"My Product","price":12.5,"ownerId":"<admin-record-id>"}'
  ```

---

## Final notes (for reviewers / selection committee)

* **Backend maturity:** production-ready patterns (transactional dual-write for system models, token rotation, audit logs, version snapshots, file persistence).
* **Frontend status:** functional admin UI, automatic form generation from model JSON — **styling & UX are minimal** and can be improved quickly. Treat frontend as a working demo for the platform capabilities.
* **Extensibility:** New system models and model-level RBAC easily added; model publishing writes a persistent JSON file and creates a versioned snapshot for traceability.
* **What to watch for:** If you plan to run in production:

  * Move secrets to a secure vault
  * Use HTTPS + `COOKIE_SECURE=true`
  * Use `prisma migrate deploy` in CI
  * Reconsider storing RSA private key in repo; use KMS
