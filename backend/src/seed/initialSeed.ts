#!/usr/bin/env ts-node
/**
 * src/scripts/seed_system_and_models_fixed.ts
 *
 * Fixed idempotent seed script:
 *  - creates permissions, roles, users (DB rows)
 *  - creates/publishes system modelDefinition rows (User, Role)
 *  - creates ModelVersion snapshots
 *  - writes /models/*.json (files include isSystem flag)
 *  - creates corresponding Record rows for the DB User & Role rows (so Records mirror table rows)
 *  - creates domain models (Category, Product, Department, Employee, Group, GroupMember)
 *  - creates sample records; ownerId always admin.id
 *
 * Important: this script assumes PostgreSQL datasource (used for JSON path query).
 * Run: npx prisma generate && npx ts-node src/scripts/seed_system_and_models_fixed.ts
 */

import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../generated/prisma/client";

const prisma = new PrismaClient();
const MODELS_DIR = path.join(process.cwd(), "models");
const HASH_ROUNDS = Number(process.env.HASH_ROUNDS ?? 12);

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@local.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "AdminPass123!";
const MANAGER_EMAIL = process.env.SEED_MANAGER_EMAIL ?? "manager@local.test";
const MANAGER_PASSWORD = process.env.SEED_MANAGER_PASSWORD ?? "ManagerPass123!";
const VIEWER_EMAIL = process.env.SEED_VIEWER_EMAIL ?? "viewer@local.test";
const VIEWER_PASSWORD = process.env.SEED_VIEWER_PASSWORD ?? "ViewerPass123!";

const FEATURE_KEYS = [
  "CREATE_ROLE",
  "ASSIGN_ROLE",
  "CREATE_USER",
  "MANAGE_MODELS",
  "PUBLISH_MODEL",
  "VIEW_AUDIT",
  "MANAGE_FEATURES",
];
const MODEL_ACTION_KEYS = ["MODEL.CREATE", "MODEL.READ", "MODEL.UPDATE", "MODEL.DELETE"];

type RawModel = {
  name: string;
  tableName?: string;
  fields: Array<Record<string, any>>;
  ownerField?: string | null;
  rbac?: Record<string, string[]>;
  seedPublished?: boolean;
  isSystem?: boolean;
};

/* ------------------------- Domain models ------------------------- */
const Category: RawModel = {
  name: "Category",
  tableName: "categories",
  fields: [
    { name: "title", type: "string", required: true },
    { name: "description", type: "string" },
  ],
  rbac: { Admin: ["ALL"], Manager: ["CREATE", "READ", "UPDATE"], Viewer: ["READ"] },
  seedPublished: true,
};

const Product: RawModel = {
  name: "Product",
  tableName: "products",
  fields: [
    { name: "name", type: "string", required: true },
    { name: "price", type: "number", required: true },
    { name: "inStock", type: "boolean", default: true },
    { name: "categoryId", type: "relation", relation: { model: "Category", field: "id", type: "many-to-one" } },
    { name: "ownerId", type: "string" },
  ],
  ownerField: "ownerId",
  rbac: { Admin: ["ALL"], Manager: ["CREATE", "READ", "UPDATE"], Viewer: ["READ"] },
  seedPublished: true,
};

const Department: RawModel = {
  name: "Department",
  tableName: "departments",
  fields: [
    { name: "name", type: "string", required: true },
    { name: "floor", type: "number" },
  ],
  rbac: { Admin: ["ALL"], Manager: ["CREATE", "READ", "UPDATE"], Viewer: ["READ"] },
  seedPublished: true,
};

const Employee: RawModel = {
  name: "Employee",
  tableName: "employees",
  fields: [
    { name: "name", type: "string", required: true },
    { name: "age", type: "number" },
    { name: "isActive", type: "boolean", default: true },
    { name: "departmentId", type: "relation", relation: { model: "Department", field: "id", type: "many-to-one" } },
    { name: "ownerId", type: "string" },
  ],
  ownerField: "ownerId",
  rbac: { Admin: ["ALL"], Manager: ["CREATE", "READ", "UPDATE"], Viewer: ["READ"] },
  seedPublished: true,
};

const Group: RawModel = {
  name: "Group",
  tableName: "groups",
  fields: [{ name: "title", type: "string", required: true }],
  rbac: { Admin: ["ALL"], Manager: ["CREATE", "READ", "UPDATE"], Viewer: ["READ"] },
  seedPublished: true,
};

const GroupMember: RawModel = {
  name: "GroupMember",
  tableName: "group_members",
  fields: [
    { name: "groupId", type: "relation", relation: { model: "Group", field: "id", type: "many-to-one" } },
    { name: "userId", type: "relation", relation: { model: "User", field: "id", type: "many-to-one" } }, // system user relation
  ],
  rbac: { Admin: ["ALL"], Manager: ["CREATE", "READ"], Viewer: ["READ"] },
  seedPublished: true,
};

const DOMAIN_MODELS: RawModel[] = [Category, Product, Department, Employee, Group, GroupMember];

/* ------------------------- System models ------------------------- */
const SYSTEM_MODELS: RawModel[] = [
  {
    name: "Role",
    tableName: "roles",
    fields: [
      { name: "name", type: "string", required: true },
      { name: "description", type: "string" },
      { name: "isSystem", type: "boolean", default: true },
      // reverse relation not needed in definition, but role has many users
    ],
    isSystem: true,
    seedPublished: true,
    rbac: {
      Admin: ["ALL"],
      Manager: ["READ"],
      Viewer: ["READ"],
    },
  },

  {
    name: "User",
    tableName: "users",
    fields: [
      { name: "name", type: "string", required: true },
      { name: "email", type: "string", required: true },
      { name: "password", type: "string", required: true },
      {
        name: "roleId",
        type: "relation",
        relation: {
          model: "Role",
          field: "id",
          type: "many-to-one",
        },
      },
      { name: "isActive", type: "boolean", default: true },
    ],
    ownerField: "id", // optional, for audit linking
    isSystem: true,
    seedPublished: true,
    rbac: {
      Admin: ["ALL"],
      Manager: ["READ", "UPDATE"],
      Viewer: ["READ"],
    },
  },
];


/* ------------------------- Helpers ------------------------- */
async function ensureModelsDir() {
  await fs.ensureDir(MODELS_DIR);
}

async function writePublishedModelFile(opts: {
  name: string;
  modelId: string;
  tableName?: string | null;
  ownerField?: string | null;
  version: number;
  definition: any;
  isSystem?: boolean;
  publishedAt: string;
}) {
  await ensureModelsDir();
  const safeName = opts.name.replace(/\s+/g, "_");
  const filePath = path.join(MODELS_DIR, `${safeName}.json`);
  const content = {
    id: opts.modelId,
    name: opts.name,
    tableName: opts.tableName ?? null,
    ownerField: opts.ownerField ?? null,
    version: opts.version,
    publishedAt: opts.publishedAt,
    definition: opts.definition,
    isSystem: !!opts.isSystem,
    _generatedAt: new Date().toISOString(),
  };
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(content, null, 2), "utf8");
  await fs.move(tmp, filePath, { overwrite: true });
  return filePath;
}

function topoSortModels(models: RawModel[]) {
  const nameToModel = new Map(models.map((m) => [m.name, m]));
  const deps = new Map<string, Set<string>>();
  for (const m of models) {
    const set = new Set<string>();
    for (const f of m.fields || []) {
      if (String(f.type).toLowerCase() === "relation") {
        const target = String((f.relation && f.relation.model) || "");
        if (target && target !== m.name) set.add(target);
      }
    }
    deps.set(m.name, set);
  }

  const visited = new Set<string>();
  const temp = new Set<string>();
  const out: RawModel[] = [];

  function visit(n: string) {
    if (visited.has(n)) return;
    if (temp.has(n)) throw new Error(`Cyclic dependency detected involving model '${n}'`);
    temp.add(n);
    const ds = deps.get(n) ?? new Set();
    for (const d of ds) {
      if (!nameToModel.has(d)) continue; // external (User/System) - ignore
      visit(d);
    }
    temp.delete(n);
    visited.add(n);
    const m = nameToModel.get(n);
    if (m) out.push(m);
  }

  for (const m of models) {
    if (!visited.has(m.name)) visit(m.name);
  }
  return out;
}

function buildSampleFromModel(m: RawModel) {
  const payload: any = {};
  const relationKeys: { key: string; definition: any }[] = [];
  for (const f of m.fields || []) {
    const t = String((f.type ?? "")).toLowerCase();
    if (t === "string") payload[f.name] = f.example ?? (f.name === "name" ? `${m.name} sample` : "sample");
    else if (t === "number") payload[f.name] = f.example ?? 1;
    else if (t === "boolean") payload[f.name] = f.example ?? (f.default ?? true);
    else if (t === "relation") {
      payload[f.name] = null;
      relationKeys.push({ key: f.name, definition: f });
    } else payload[f.name] = f.example ?? null;
  }
  return { payload, relationKeys };
}

async function upsertPermission(tx: any, key: string, name: string, category = "feature") {
  return tx.permission.upsert({ where: { key }, update: { name, category }, create: { key, name, category } });
}

/* ------------------------- Raw-DB helpers (Postgres JSON checks) ------------------------- */
/**
 * Check if a record exists in Record table for given modelId where record.data->>'id' == sourceId
 * Uses a raw SQL query (Postgres). Returns the record id or null.
 */
async function findRecordIdBySource(modelId: string, sourceId: string) {
  // prisma.$queryRaw returns array of rows; parameterized via template interpolation
  const rows: Array<{ id: string }> = (await prisma.$queryRawUnsafe(
    `SELECT id FROM "Record" WHERE "modelId" = $1 AND (data->>'id') = $2 LIMIT 1`,
    modelId,
    sourceId
  )) as any;
  if (Array.isArray(rows) && rows.length) return rows[0].id;
  return null;
}

/* ------------------------- Main seed ------------------------- */
async function seed() {
  console.log("Starting fixed seed...");

  try {
    /* -------------------- 1) permissions, roles, users (DB tables) -------------------- */
    await prisma.$transaction(async (tx) => {
      // permissions
      for (const k of FEATURE_KEYS) await upsertPermission(tx, k, k.replace(/_/g, " "), "feature");
      for (const k of MODEL_ACTION_KEYS) await upsertPermission(tx, k, k.replace(".", " "), "model_action");

      // Roles (DB Role table)
      const rolesList = [
        { name: "Admin", isSystem: true, description: "Full system administrator" },
        { name: "Manager", isSystem: true, description: "Manager role" },
        { name: "Viewer", isSystem: true, description: "Read only role" },
      ];
      const rolesMap: Record<string, any> = {};
      for (const r of rolesList) {
        const roleRow = await tx.role.upsert({
          where: { name: r.name },
          update: { description: r.description, isSystem: r.isSystem },
          create: r,
        });
        rolesMap[r.name] = roleRow;
      }

      // Users (DB User table) - create/update and set roleId
      const adminHashed = await bcrypt.hash(ADMIN_PASSWORD, HASH_ROUNDS);
      const managerHashed = await bcrypt.hash(MANAGER_PASSWORD, HASH_ROUNDS);
      const viewerHashed = await bcrypt.hash(VIEWER_PASSWORD, HASH_ROUNDS);

      let adminUser = await tx.user.findUnique({ where: { email: ADMIN_EMAIL } });
      if (!adminUser) {
        adminUser = await tx.user.create({
          data: { name: "Administrator", email: ADMIN_EMAIL, password: adminHashed, roleId: rolesMap["Admin"].id, isActive: true },
        });
      } else {
        adminUser = await tx.user.update({ where: { id: adminUser.id }, data: { roleId: rolesMap["Admin"].id, isActive: true } });
      }

      let managerUser = await tx.user.findUnique({ where: { email: MANAGER_EMAIL } });
      if (!managerUser) {
        managerUser = await tx.user.create({
          data: { name: "Manager", email: MANAGER_EMAIL, password: managerHashed, roleId: rolesMap["Manager"].id, isActive: true },
        });
      } else {
        managerUser = await tx.user.update({ where: { id: managerUser.id }, data: { roleId: rolesMap["Manager"].id, isActive: true } });
      }

      let viewerUser = await tx.user.findUnique({ where: { email: VIEWER_EMAIL } });
      if (!viewerUser) {
        viewerUser = await tx.user.create({
          data: { name: "Viewer", email: VIEWER_EMAIL, password: viewerHashed, roleId: rolesMap["Viewer"].id, isActive: true },
        });
      } else {
        viewerUser = await tx.user.update({ where: { id: viewerUser.id }, data: { roleId: rolesMap["Viewer"].id, isActive: true } });
      }

      // grant feature perms to Admin role
      const features = await tx.permission.findMany({ where: { category: "feature" } });
      for (const p of features) {
        await tx.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: rolesMap["Admin"].id, permissionId: p.id } },
          update: { granted: true },
          create: { roleId: rolesMap["Admin"].id, permissionId: p.id, granted: true },
        });
      }

      // manager subset
      const managerPermKeys = ["CREATE_USER", "MANAGE_MODELS", "PUBLISH_MODEL"];
      for (const k of managerPermKeys) {
        const p = await tx.permission.findUnique({ where: { key: k } });
        if (p) {
          await tx.rolePermission.upsert({
            where: { roleId_permissionId: { roleId: rolesMap["Manager"].id, permissionId: p.id } },
            update: { granted: true },
            create: { roleId: rolesMap["Manager"].id, permissionId: p.id, granted: true },
          });
        }
      }
    }); // end tx 1

    /* -------------------- 2) system modelDefinitions (User, Role) -> publish + modelVersion -------------------- */
    const adminAfter = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (!adminAfter) throw new Error("Admin must exist after user creation");

    await prisma.$transaction(async (tx) => {
      for (const sm of SYSTEM_MODELS) {
        const canonical = { fields: sm.fields };
        const wantsPublished = Boolean(sm.seedPublished);

        const existing = await tx.modelDefinition.findUnique({ where: { name: sm.name } });
        if (!existing) {
          // create modelDefinition (do NOT set DB 'isSystem' column if it does not exist)
          const created = await tx.modelDefinition.create({
            data: {
              name: sm.name,
              tableName: sm.tableName ?? null,
              isSystem: sm.isSystem,
              json: canonical,
              version: wantsPublished ? 1 : 0,
              ownerField: sm.ownerField ?? null,
              published: wantsPublished,
              publishedAt: wantsPublished ? new Date() : null,
              publishedById: wantsPublished ? adminAfter.id : null,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as any,
          });

          if (wantsPublished) {
            await tx.modelVersion.create({
              data: { modelId: created.id, versionNumber: 1, json: canonical, createdById: adminAfter.id, createdAt: new Date() },
            });

            // create modelRolePermissions from sm.rbac
            await tx.modelRolePermission.deleteMany({ where: { modelId: created.id } });
            const permCreate = await tx.permission.findUnique({ where: { key: "MODEL.CREATE" } });
            const permRead = await tx.permission.findUnique({ where: { key: "MODEL.READ" } });
            const permUpdate = await tx.permission.findUnique({ where: { key: "MODEL.UPDATE" } });
            const permDelete = await tx.permission.findUnique({ where: { key: "MODEL.DELETE" } });

            for (const [roleName, actions] of Object.entries(sm.rbac ?? {})) {
              const roleRow = await tx.role.findUnique({ where: { name: roleName } });
              if (!roleRow) continue;
              const normalized = (actions || []).map((a) => String(a).toUpperCase());
              const allowAll = normalized.includes("ALL");
              const toAdd = new Set<string>();
              if (allowAll) {
                if (permCreate) toAdd.add(permCreate.id);
                if (permRead) toAdd.add(permRead.id);
                if (permUpdate) toAdd.add(permUpdate.id);
                if (permDelete) toAdd.add(permDelete.id);
              } else {
                if (normalized.includes("CREATE") && permCreate) toAdd.add(permCreate.id);
                if (normalized.includes("READ") && permRead) toAdd.add(permRead.id);
                if (normalized.includes("UPDATE") && permUpdate) toAdd.add(permUpdate.id);
                if (normalized.includes("DELETE") && permDelete) toAdd.add(permDelete.id);
              }
              for (const pid of Array.from(toAdd)) {
                await tx.modelRolePermission.create({ data: { modelId: created.id, roleId: roleRow.id, permissionId: pid, allowed: true } });
              }
            }
          }
        } else {
          // existing: ensure published if wanted
          if (!existing.published && wantsPublished) {
            const updated = await tx.modelDefinition.update({
              where: { id: existing.id },
              data: { json: canonical, version: 1, published: true, publishedAt: new Date(), publishedById: adminAfter.id, updatedAt: new Date(), ownerField: sm.ownerField ?? existing.ownerField } as any,
            });
            await tx.modelVersion.create({ data: { modelId: updated.id, versionNumber: 1, json: canonical, createdById: adminAfter.id, createdAt: new Date() } });

            // update modelRolePermissions
            await tx.modelRolePermission.deleteMany({ where: { modelId: updated.id } });
            const permCreate = await tx.permission.findUnique({ where: { key: "MODEL.CREATE" } });
            const permRead = await tx.permission.findUnique({ where: { key: "MODEL.READ" } });
            const permUpdate = await tx.permission.findUnique({ where: { key: "MODEL.UPDATE" } });
            const permDelete = await tx.permission.findUnique({ where: { key: "MODEL.DELETE" } });

            for (const [roleName, actions] of Object.entries(sm.rbac ?? {})) {
              const roleRow = await tx.role.findUnique({ where: { name: roleName } });
              if (!roleRow) continue;
              const normalized = (actions || []).map((a) => String(a).toUpperCase());
              const allowAll = normalized.includes("ALL");
              const toAdd = new Set<string>();
              if (allowAll) {
                if (permCreate) toAdd.add(permCreate.id);
                if (permRead) toAdd.add(permRead.id);
                if (permUpdate) toAdd.add(permUpdate.id);
                if (permDelete) toAdd.add(permDelete.id);
              } else {
                if (normalized.includes("CREATE") && permCreate) toAdd.add(permCreate.id);
                if (normalized.includes("READ") && permRead) toAdd.add(permRead.id);
                if (normalized.includes("UPDATE") && permUpdate) toAdd.add(permUpdate.id);
                if (normalized.includes("DELETE") && permDelete) toAdd.add(permDelete.id);
              }
              for (const pid of Array.from(toAdd)) {
                await tx.modelRolePermission.create({ data: { modelId: updated.id, roleId: roleRow.id, permissionId: pid, allowed: true } });
              }
            }
          } else {
            // keep current; optionally update json shape to ensure fields exist
            // Ensure model.json contains fields shape (fix missing shapes that break frontend)
            if (!existing.json || !Array.isArray((existing.json as any).fields)) {
              await tx.modelDefinition.update({
                where: { id: existing.id },
                data: { json: { fields: sm.fields }, updatedAt: new Date() } as any,
              });
            }
          }
        }
      } // end system models loop
    }); // end tx 2

    /* -------------------- 3) create Record copies for existing Role & User DB rows -------------------- */
    // fetch modelDefinition ids for User and Role
    const roleModel = await prisma.modelDefinition.findUnique({ where: { name: "Role" } });
    const userModel = await prisma.modelDefinition.findUnique({ where: { name: "User" } });
    if (!roleModel || !userModel) throw new Error("System modelDefinitions Role/User should exist and be published");

    // get latest modelVersion ids (if published)
    const roleMv = await prisma.modelVersion.findFirst({ where: { modelId: roleModel.id }, orderBy: { versionNumber: "desc" } });
    const userMv = await prisma.modelVersion.findFirst({ where: { modelId: userModel.id }, orderBy: { versionNumber: "desc" } });

    // copy Roles -> Record
    const rolesAll = await prisma.role.findMany();
    for (const r of rolesAll) {
      // check if record exists (data->>'id' == r.id)
      const found = await findRecordIdBySource(roleModel.id, r.id);
      if (found) {
        // ensure ownerId set (update if missing)
        const rec = await prisma.record.findUnique({ where: { id: found } });
        if (rec && !rec.ownerId) {
          await prisma.record.update({ where: { id: found }, data: { ownerId: adminAfter.id } });
        }
        continue;
      }
      const data = { id: r.id, name: r.name, description: r.description ?? null, _origin: { table: "role", id: r.id } };
      await prisma.record.create({
        data: {
          modelId: roleModel.id,
          modelName: roleModel.name,
          modelVersionId: roleMv?.id ?? null,
          data,
          ownerId: adminAfter.id,
        },
      });
    }

    // copy Users -> Record (don't copy passwords into UI data)
    const usersAll = await prisma.user.findMany();
    for (const u of usersAll) {
      const found = await findRecordIdBySource(userModel.id, u.id);
      if (found) {
        const rec = await prisma.record.findUnique({ where: { id: found } });
        if (rec && !rec.ownerId) {
          await prisma.record.update({ where: { id: found }, data: { ownerId: adminAfter.id } });
        }
        continue;
      }
      const data = { id: u.id, name: u.name ?? null, email: u.email ?? null, _origin: { table: "user", id: u.id } };
      await prisma.record.create({
        data: {
          modelId: userModel.id,
          modelName: userModel.name,
          modelVersionId: userMv?.id ?? null,
          data,
          ownerId: adminAfter.id,
        },
      });
    }

    /* -------------------- 4) domain models: create definitions + publish + role perms -------------------- */
    const ordered = topoSortModels(DOMAIN_MODELS);
    const createdModels: { name: string; id: string; version: number }[] = [];

    await prisma.$transaction(async (tx) => {
      const permCreate = await tx.permission.findUnique({ where: { key: "MODEL.CREATE" } });
      const permRead = await tx.permission.findUnique({ where: { key: "MODEL.READ" } });
      const permUpdate = await tx.permission.findUnique({ where: { key: "MODEL.UPDATE" } });
      const permDelete = await tx.permission.findUnique({ where: { key: "MODEL.DELETE" } });

      for (const m of ordered) {
        const canonical = { fields: m.fields };
        const wantsPublished = Boolean(m.seedPublished);
        const existing = await tx.modelDefinition.findUnique({ where: { name: m.name } });

        if (!existing) {
          if (wantsPublished) {
            const created = await tx.modelDefinition.create({
              data: { name: m.name, tableName: m.tableName ?? null, json: canonical, version: 1, ownerField: m.ownerField ?? null, published: true, publishedAt: new Date(), publishedById: adminAfter.id, createdAt: new Date(), updatedAt: new Date() } as any,
            });
            await tx.modelVersion.create({ data: { modelId: created.id, versionNumber: 1, json: canonical, createdById: adminAfter.id, createdAt: new Date() } });
            // modelRolePermissions
            await tx.modelRolePermission.deleteMany({ where: { modelId: created.id } });
            for (const [roleName, actions] of Object.entries(m.rbac ?? {})) {
              const roleRow = await tx.role.findUnique({ where: { name: roleName } });
              if (!roleRow) continue;
              const normalized = (actions || []).map((a) => String(a).toUpperCase());
              const allowAll = normalized.includes("ALL");
              const toAdd = new Set<string>();
              if (allowAll) {
                if (permCreate) toAdd.add(permCreate.id);
                if (permRead) toAdd.add(permRead.id);
                if (permUpdate) toAdd.add(permUpdate.id);
                if (permDelete) toAdd.add(permDelete.id);
              } else {
                if (normalized.includes("CREATE") && permCreate) toAdd.add(permCreate.id);
                if (normalized.includes("READ") && permRead) toAdd.add(permRead.id);
                if (normalized.includes("UPDATE") && permUpdate) toAdd.add(permUpdate.id);
                if (normalized.includes("DELETE") && permDelete) toAdd.add(permDelete.id);
              }
              for (const pid of Array.from(toAdd)) {
                await tx.modelRolePermission.create({ data: { modelId: created.id, roleId: roleRow.id, permissionId: pid, allowed: true } });
              }
            }
            createdModels.push({ name: created.name, id: created.id, version: 1 });
            await tx.auditLog.create({ data: { action: "MODEL_CREATE_PUBLISHED_SEED", modelId: created.id, modelName: created.name, details: {} } });
          } else {
            const created = await tx.modelDefinition.create({ data: { name: m.name, tableName: m.tableName ?? null, json: canonical, version: 0, ownerField: m.ownerField ?? null, published: false, createdAt: new Date(), updatedAt: new Date() } as any });
            createdModels.push({ name: created.name, id: created.id, version: 0 });
            await tx.auditLog.create({ data: { action: "MODEL_CREATE_DRAFT_SEED", modelId: created.id, modelName: created.name, details: {} } });
          }
        } else {
          if (!existing.published && wantsPublished) {
            const updated = await tx.modelDefinition.update({
              where: { id: existing.id },
              data: { json: canonical, version: 1, ownerField: m.ownerField ?? existing.ownerField, tableName: m.tableName ?? existing.tableName, published: true, publishedAt: new Date(), publishedById: adminAfter.id, updatedAt: new Date() } as any,
            });
            await tx.modelVersion.create({ data: { modelId: updated.id, versionNumber: 1, json: canonical, createdById: adminAfter.id, createdAt: new Date() } });
            createdModels.push({ name: updated.name, id: updated.id, version: updated.version });
            await tx.modelRolePermission.deleteMany({ where: { modelId: updated.id } });
            for (const [roleName, actions] of Object.entries(m.rbac ?? {})) {
              const roleRow = await tx.role.findUnique({ where: { name: roleName } });
              if (!roleRow) continue;
              const normalized = (actions || []).map((a) => String(a).toUpperCase());
              const allowAll = normalized.includes("ALL");
              const toAdd = new Set<string>();
              if (allowAll) {
                if (permCreate) toAdd.add(permCreate.id);
                if (permRead) toAdd.add(permRead.id);
                if (permUpdate) toAdd.add(permUpdate.id);
                if (permDelete) toAdd.add(permDelete.id);
              } else {
                if (normalized.includes("CREATE") && permCreate) toAdd.add(permCreate.id);
                if (normalized.includes("READ") && permRead) toAdd.add(permRead.id);
                if (normalized.includes("UPDATE") && permUpdate) toAdd.add(permUpdate.id);
                if (normalized.includes("DELETE") && permDelete) toAdd.add(permDelete.id);
              }
              for (const pid of Array.from(toAdd)) {
                await tx.modelRolePermission.create({ data: { modelId: updated.id, roleId: roleRow.id, permissionId: pid, allowed: true } });
              }
            }
            await tx.auditLog.create({ data: { action: "MODEL_PUBLISH_SEED", modelId: updated.id, modelName: updated.name, details: {} } });
          } else {
            // ensure model.json fields exist
            if (!existing.json || !Array.isArray((existing.json as any).fields)) {
              await tx.modelDefinition.update({
                where: { id: existing.id },
                data: { json: { fields: m.fields }, updatedAt: new Date() } as any,
              });
            } else {
              // update draft json to match seed shape (safe)
              await tx.modelDefinition.update({
                where: { id: existing.id },
                data: { json: { fields: m.fields }, updatedAt: new Date() } as any,
              });
            }
            createdModels.push({ name: existing.name, id: existing.id, version: existing.version });
            await tx.auditLog.create({ data: { action: "MODEL_UPDATE_DRAFT_SEED", modelId: existing.id, modelName: existing.name, details: {} } });
          }
        }
      }
    }); // end tx domain models

    /* -------------------- 5) write published model files and update filePath -------------------- */
    await ensureModelsDir();
    const defs = await prisma.modelDefinition.findMany();
    const modelVersions = await prisma.modelVersion.findMany();
    const mvMap: Record<string, any> = {};
    for (const mv of modelVersions) mvMap[`${mv.modelId}_${mv.versionNumber}`] = mv;

    for (const d of defs) {
      if (!d.published) continue;
      const mv = mvMap[`${d.id}_${d.version}`] ?? null;
      const publishedAt = (d.publishedAt ?? new Date()).toISOString();
      // include isSystem true in file if its a system model (we can't guarantee DB has that column)
      const isSys = !!(SYSTEM_MODELS.find((s) => s.name === d.name));
      const fp = await writePublishedModelFile({
        name: d.name,
        modelId: d.id,
        tableName: d.tableName,
        ownerField: d.ownerField ?? null,
        version: d.version || 1,
        definition: d.json ?? (mv?.json ?? {}),
        publishedAt,
        isSystem: isSys,
      });
      try {
        await prisma.modelDefinition.update({ where: { id: d.id }, data: { filePath: fp, updatedAt: new Date() } });
      } catch {
        // ignore filePath update failure (best-effort)
      }
    }

    /* -------------------- 6) create sample records for domain models (ownerId -> admin) -------------------- */
    const createdRecordIdsByModel: Record<string, string[]> = {};
    const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (!admin) throw new Error("Admin user must exist (final check)");

    for (const m of ordered) {
      const def = await prisma.modelDefinition.findUnique({ where: { name: m.name } });
      if (!def || !def.published) continue;

      // skip if records already exist
      const anyRec = await prisma.record.findFirst({ where: { modelId: def.id } });
      if (anyRec) {
        const recs = await prisma.record.findMany({ where: { modelId: def.id }, take: 5 });
        createdRecordIdsByModel[m.name] = recs.map((r) => r.id);
        continue;
      }

      const { payload, relationKeys } = buildSampleFromModel(m);

      // resolve relation placeholders
      for (const rk of relationKeys) {
        const rel = rk.definition.relation || {};
        const target = rel.model;
        const relType = String(rel.type ?? "").toLowerCase();

        if (String(target).toLowerCase() === "user") {
          const manager = await prisma.user.findUnique({ where: { email: MANAGER_EMAIL } });
          if (relType.includes("many") || relType.includes("one-to-many")) {
            payload[rk.key] = [admin.id, manager?.id].filter(Boolean);
          } else {
            payload[rk.key] = admin.id;
          }
          continue;
        }

        // create minimal target if missing
        let targetRecords = createdRecordIdsByModel[target] ?? [];
        if (!targetRecords.length) {
          const targetDef = await prisma.modelDefinition.findUnique({ where: { name: target } });
          if (!targetDef || !targetDef.published) {
            throw new Error(`Target model ${target} missing or not published for relation ${rk.key}`);
          }
          const tm = DOMAIN_MODELS.find((x) => x.name === target) || { fields: [] };
          const { payload: tpayload, relationKeys: trels } = buildSampleFromModel(tm as RawModel);
          for (const tr of trels) {
            const trelDef = tr.definition.relation || {};
            if (String(trelDef.model).toLowerCase() === "user") {
              tpayload[tr.key] = admin.id;
            } else {
              tpayload[tr.key] = null;
            }
          }
          if (targetDef.ownerField) tpayload[targetDef.ownerField] = admin.id;
          const tv = await prisma.modelVersion.findFirst({ where: { modelId: targetDef.id }, orderBy: { versionNumber: "desc" } });
          const rec = await prisma.record.create({ data: { modelId: targetDef.id, modelName: targetDef.name, modelVersionId: tv?.id ?? null, data: tpayload, ownerId: admin.id } });
          targetRecords = [rec.id];
          createdRecordIdsByModel[target] = targetRecords;
        }

        if (relType.includes("many-to-many") || relType.includes("one-to-many")) {
          payload[rk.key] = targetRecords;
        } else {
          payload[rk.key] = targetRecords[0];
        }
      } // relationKeys

      // owner heuristic
      if (m.ownerField) payload[m.ownerField] = admin.id;

      const mv = await prisma.modelVersion.findFirst({ where: { modelId: def.id }, orderBy: { versionNumber: "desc" } });
      const createdRec = await prisma.record.create({ data: { modelId: def.id, modelName: def.name, modelVersionId: mv?.id ?? null, data: payload, ownerId: admin.id } });
      createdRecordIdsByModel[m.name] = [createdRec.id];
      await prisma.auditLog.create({ data: { action: "CREATE_SAMPLE_RECORD_SEED", modelId: def.id, modelName: def.name, recordId: createdRec.id, details: payload } });
    }

    /* -------------------- 7) final audit -------------------- */
    await prisma.auditLog.create({ data: { action: "SEED_COMPLETED", details: { at: new Date().toISOString() } } });

    console.log(" Fixed seed completed successfully.");
  } catch (err) {
    console.error(" Fixed seed failed:", err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) seed();
