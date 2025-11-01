// src/components/ModelRecordsPage/ModelRecordsPage.tsx
/* eslint-disable @typescript-eslint/no-explicit-any */
import  { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useParams } from "react-router-dom";
import { useAuth } from "../../context/useAuth";
import type { JSX } from "react/jsx-runtime";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

type FieldDef = {
  name: string;
  type: string;
  required?: boolean;
  relation?: { model?: string; field?: string; type?: string } | any;
  default?: any;
};

type ModelDef = {
  id: string;
  name: string;
  tableName?: string;
  json?: { fields?: FieldDef[]; ownerField?: string; rbac?: any };
  published?: boolean;
};

type RecordItem = {
  id: string;
  data: Record<string, any>;
  createdAt?: string | null;
  updatedAt?: string | null;
  ownerId?: string | null;
  modelVersion?: any;
};

export default function ModelRecordsPage(): JSX.Element {
  const { modelName } = useParams<{ modelName: string }>();
  const auth = useAuth() as any;
  const accessToken = auth?.accessToken;
  const canModel = auth?.canModel;

  const [modelsAll, setModelsAll] = useState<ModelDef[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const [records, setRecords] = useState<RecordItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loadingRecords, setLoadingRecords] = useState(false);

  const [page, setPage] = useState(0);
  const limit = 20;

  const [error, setError] = useState<string | null>(null);

  // CRUD modal state
  const [editingRecord, setEditingRecord] = useState<RecordItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletePending, setDeletePending] = useState<RecordItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // relation options cache: { ModelName: [{id,label}] }
  const [relationOptions, setRelationOptions] = useState<Record<string, Array<{ id: string; label: string }>>>({});

  // Auth headers
  const authHeaders = useCallback(() => {
    const h: any = { "Content-Type": "application/json" };
    const token = accessToken ?? localStorage.getItem("accessToken");
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [accessToken]);

  // Load /models/all once (to get fields/ownerField/rbac)
  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoadingModels(true);
      try {
        const res = await axios.get(`${API_BASE}/models/all`, { headers: authHeaders() });
        if (!mounted) return;
        if (res.data?.success && Array.isArray(res.data.models)) {
          setModelsAll(res.data.models);
        } else {
          setModelsAll([]);
        }
      } catch (err: any) {
        console.error("models/all error", err);
        setModelsAll([]);
      } finally {
        if (mounted) setLoadingModels(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [authHeaders]);

  // Helper: find model definition by name (insensitive)
  const modelDef = useMemo(() => {
    if (!modelsAll || !modelName) return null;
    return (
      modelsAll.find(
        (m) =>
          String(m.name).toLowerCase() === String(modelName).toLowerCase() ||
          String(m.tableName ?? "").toLowerCase() === String(modelName).toLowerCase()
      ) ?? null
    );
  }, [modelsAll, modelName]);

  // schema fields: prefer modelVersion.json if available in records; fallback to modelDef.json.fields
  const schemaFields = useMemo((): FieldDef[] => {
    if (records && records.length > 0 && records[0].modelVersion?.json?.fields) {
      return records[0].modelVersion.json.fields as FieldDef[];
    }
    if (modelDef?.json?.fields && Array.isArray(modelDef.json.fields)) return modelDef.json.fields;
    return [];
  }, [records, modelDef]);

  // Fetch records
  const fetchRecords = useCallback(
    async (skip = 0) => {
      if (!modelName) return;
      setLoadingRecords(true);
      setError(null);
      try {
        const res = await axios.get(`${API_BASE}/api/${encodeURIComponent(modelName)}?limit=${limit}&skip=${skip}`, {
          headers: authHeaders(),
        });
        if (res.data?.success) {
          setRecords(res.data.items ?? []);
          setTotal(res.data.total ?? (res.data.items?.length ?? 0));
        } else {
          setError(res.data?.message ?? "Failed fetching records");
          setRecords([]);
          setTotal(0);
        }
      } catch (err: any) {
        console.error("fetchRecords error", err);
        setError(err?.response?.data?.message ?? err?.message ?? "Network error");
        setRecords([]);
        setTotal(0);
      } finally {
        setLoadingRecords(false);
      }
    },
    [modelName, authHeaders]
  );

  useEffect(() => {
    fetchRecords(page * limit);
  }, [fetchRecords, page]);

  // Preload relation options for any relation fields in schemaFields (limit 200)
  useEffect(() => {
    const relFields = (schemaFields ?? []).filter((f) => String(f.type).toLowerCase() === "relation" && f.relation?.model);
    if (relFields.length === 0) return;

    relFields.forEach(async (f) => {
      const targetModelName = f.relation.model as string;
      if (!targetModelName) return;
      // avoid repeated fetch
      if (relationOptions[targetModelName]) return;
      try {
        const res = await axios.get(`${API_BASE}/api/${encodeURIComponent(targetModelName)}?limit=200`, {
          headers: authHeaders(),
        });
        if (res.data?.success && Array.isArray(res.data.items)) {
          // choose a label field: prefer first string field from the target model definition (modelsAll)
          let labelField = "id";
          const targetModelDef = modelsAll?.find((m) => String(m.name).toLowerCase() === String(targetModelName).toLowerCase());
          if (targetModelDef?.json?.fields) {
            const stringField = (targetModelDef.json.fields as FieldDef[]).find((fd) => String(fd.type).toLowerCase() === "string");
            if (stringField) labelField = stringField.name;
          } else if (res.data.items.length > 0) {
            const candidate = Object.keys(res.data.items[0].data ?? {}).find((k) => typeof (res.data.items[0].data ?? {})[k] === "string");
            if (candidate) labelField = candidate;
          }

          const opts = res.data.items.map((it: any) => ({
            id: it.id,
            label: String((it.data?.[labelField] ?? it.data?.name ?? it.data?.title ?? it.id) ?? it.id),
          }));
          setRelationOptions((s) => ({ ...s, [targetModelName]: opts }));
        } else {
          setRelationOptions((s) => ({ ...s, [targetModelName]: [] }));
        }
      } catch (e) {
        console.warn("relation options fetch failed for", f.relation?.model, e);
        setRelationOptions((s) => ({ ...s, [targetModelName]: [] }));
      }
    });
  }, [schemaFields, modelsAll, authHeaders, relationOptions]);

  // Helpers to convert UI form values -> API payload types
  // const convertValueForType = (type: string, value: any) => {
  //   if (value === null || value === undefined || value === "") return null;
  //   const t = String(type).toLowerCase();
  //   if (t === "number") {
  //     const n = Number(value);
  //     return Number.isNaN(n) ? value : n;
  //   }
  //   if (t === "boolean") {
  //     if (typeof value === "boolean") return value;
  //     if (value === "true" || value === "1") return true;
  //     if (value === "false" || value === "0") return false;
  //     return Boolean(value);
  //   }
  //   if (t === "string[]") {
  //     if (Array.isArray(value)) return value;
  //     return String(value).split(",").map((s) => s.trim()).filter(Boolean);
  //   }
  //   if (t === "json") {
  //     try {
  //       return typeof value === "string" ? JSON.parse(value) : value;
  //     } catch {
  //       return value;
  //     }
  //   }
  //   return value;
  // };

  // Create or Update submit
  const handleSubmitRecord = async (payload: Record<string, any>, recordId?: string) => {
    if (!modelName) return;
    setSubmitting(true);
    setError(null);
    try {
      if (recordId) {
        const res = await axios.put(`${API_BASE}/api/${encodeURIComponent(modelName)}/${recordId}`, payload, { headers: authHeaders() });
        if (res.data) {
          await fetchRecords(page * limit);
          setEditingRecord(null);
        }
      } else {
        const res = await axios.post(`${API_BASE}/api/${encodeURIComponent(modelName)}`, payload, { headers: authHeaders() });
        if (res.data) {
          await fetchRecords(0);
          setCreating(false);
          setPage(0);
        }
      }
    } catch (err: any) {
      console.error("submit record error", err);
      setError(err?.response?.data?.message ?? err?.message ?? "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  // Delete
  const handleDelete = async (rec: RecordItem) => {
    if (!modelName || !rec) return;
    if (!window.confirm(`Delete record ${rec.id}? This is permanent.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await axios.delete(`${API_BASE}/api/${encodeURIComponent(modelName)}/${rec.id}`, { headers: authHeaders() });
      await fetchRecords(page * limit);
      setDeletePending(null);
    } catch (err: any) {
      console.error("delete error", err);
      setError(err?.response?.data?.message ?? err?.message ?? "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  // Render table headers (dedup, keep order)
  const headers = useMemo(() => {
    const base = ["id", ...(schemaFields.map((f) => f.name) ?? [])];
    const extras = ["ownerId", "createdAt", "updatedAt", "actions"];
    return Array.from(new Set([...base, ...extras]));
  }, [schemaFields]);

  // Quick check RBAC actions
  const canCreate = canModel?.(modelName ?? "", "CREATE");
  const canUpdate = canModel?.(modelName ?? "", "UPDATE");
  const canDelete = canModel?.(modelName ?? "", "DELETE");

  return (
    <div className="p-6 max-w-full">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">{modelName}</h1>
          <div className="text-sm text-gray-500">
            {loadingModels ? "Loading model..." : modelDef ? `${modelDef.name} — ${modelDef.tableName ?? ""}` : "Model not found"}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="text-sm text-gray-600 mr-3">Total: {total}</div>
          <button
            className={`px-3 py-1 rounded ${canCreate ? "bg-green-600 text-white" : "bg-gray-200 text-gray-600"}`}
            onClick={() => setCreating(true)}
            disabled={!canCreate}
            title={canCreate ? "Create record" : "No permission to create"}
          >
            + Create
          </button>
          <button className="px-3 py-1 rounded bg-gray-100" onClick={() => fetchRecords(page * limit)} title="Refresh">
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      {/* records table */}
      <div className="overflow-auto border rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              {headers.map((h, idx) => (
                <th key={`${h}-${idx}`} className="p-2 text-left border-b">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loadingRecords ? (
              <tr><td colSpan={headers.length} className="p-4 text-center">Loading...</td></tr>
            ) : records.length === 0 ? (
              <tr><td colSpan={headers.length} className="p-4 text-center text-gray-500">No records</td></tr>
            ) : (
              records.map((rec) => (
                <tr key={rec.id} className="hover:bg-gray-50">
                  <td className="p-2 border-b">{rec.id}</td>

                  {schemaFields.map((f) => {
                    const val = rec.data?.[f.name];
                    const cellKey = `${rec.id}-${f.name}`;
                    if (String(f.type).toLowerCase() === "relation") {
                      const targetName = f.relation?.model;
                      const opts = targetName ? relationOptions[targetName] ?? [] : [];
                      const found = opts.find((o) => String(o.id) === String(val));
                      return <td key={cellKey} className="p-2 border-b">{found ? found.label : String(val ?? "—")}</td>;
                    }
                    if (String(f.type).toLowerCase() === "boolean") {
                      return <td key={cellKey} className="p-2 border-b">{val ? "1" : "—"}</td>;
                    }
                    return <td key={cellKey} className="p-2 border-b">{val !== undefined && val !== null ? String(val) : "—"}</td>;
                  })}

                  <td className="p-2 border-b">{rec.ownerId ?? "—"}</td>
                  <td className="p-2 border-b">{rec.createdAt ? new Date(rec.createdAt).toLocaleString() : "—"}</td>
                  <td className="p-2 border-b">{rec.updatedAt ? new Date(rec.updatedAt).toLocaleString() : "—"}</td>

                  <td className="p-2 border-b">
                    <div className="flex gap-2">
                      <button
                        className={`px-2 py-1 rounded text-sm ${canUpdate ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-600"}`}
                        onClick={() => setEditingRecord(rec)}
                        disabled={!canUpdate}
                        title={canUpdate ? "Edit" : "No permission"}
                      >
                        Edit
                      </button>
                      <button
                        className={`px-2 py-1 rounded text-sm ${canDelete ? "bg-red-600 text-white" : "bg-gray-200 text-gray-600"}`}
                        onClick={() => setDeletePending(rec)}
                        disabled={!canDelete}
                        title={canDelete ? "Delete" : "No permission"}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* pagination */}
      <div className="flex items-center justify-between mt-3">
        <div className="text-sm text-gray-600">Showing {Math.min(total, page * limit + 1)}–{Math.min(total, (page + 1) * limit)} of {total}</div>
        <div className="flex gap-2">
          <button className="px-3 py-1 border rounded disabled:opacity-60" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</button>
          <button className="px-3 py-1 border rounded disabled:opacity-60" disabled={(page + 1) * limit >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>

      {/* Create / Edit modal */}
      {(creating || editingRecord) && (
        <RecordFormModal
          key={editingRecord ? editingRecord.id : "new"}
          modelName={modelName ?? ""}
          fields={schemaFields}
          relationOptions={relationOptions}
          initialData={editingRecord?.data ?? null}
          recordId={editingRecord?.id}
          ownerField={modelDef?.json?.ownerField ?? null}
          onClose={() => { setCreating(false); setEditingRecord(null); }}
          onSubmit={async (payload) => await handleSubmitRecord(payload, editingRecord?.id)}
          loading={submitting}
        />
      )}

      {/* Delete confirmation modal */}
      {deletePending && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded p-4 shadow max-w-md w-full">
            <h3 className="font-semibold text-lg mb-2">Confirm delete</h3>
            <p className="text-sm mb-4">Are you sure you want to delete record <span className="font-mono">{deletePending.id}</span>?</p>
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1 border rounded" onClick={() => setDeletePending(null)}>Cancel</button>
              <button className="px-3 py-1 bg-red-600 text-white rounded" onClick={() => handleDelete(deletePending)} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- RecordFormModal ---------------- */

function RecordFormModal({
  modelName,
  fields,
  relationOptions,
  initialData,
  recordId,
  ownerField,
  onClose,
  onSubmit,
  loading,
}: {
  modelName: string;
  fields: FieldDef[];
  relationOptions: Record<string, Array<{ id: string; label: string }>>;
  initialData: Record<string, any> | null;
  recordId?: string | null;
  ownerField?: string | null;
  onClose: () => void;
  onSubmit: (payload: Record<string, any>) => Promise<void>;
  loading: boolean;
}) {
  const [form, setForm] = useState<Record<string, any>>(() => ({ ...(initialData ?? {}) }));
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => setForm({ ...(initialData ?? {}) }), [initialData]);

  const setField = (name: string, v: any) => setForm((s) => ({ ...s, [name]: v }));

  const convertValueForType = (type: string, value: any) => {
    if (value === undefined || value === null || value === "") return null;
    const t = String(type).toLowerCase();
    if (t === "number") {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    if (t === "boolean") {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      return Boolean(value);
    }
    if (t === "string[]") {
      if (Array.isArray(value)) return value;
      return String(value).split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (t === "json") {
      try {
        return typeof value === "string" ? JSON.parse(value) : value;
      } catch {
        return value;
      }
    }
    return value;
  };

  const submit = async () => {
    // client-side required validation
    for (const f of fields) {
      if (f.required) {
        // skip ownerField from client-side requirement so server can assign
        if (ownerField && f.name === ownerField) continue;
        const v = form[f.name];
        if (v === undefined || v === null || v === "") {
          setFormError(`Field '${f.name}' is required`);
          return;
        }
      }
    }
    setFormError(null);

    // build payload and convert types
    const payload: Record<string, any> = {};
    for (const f of fields) {
      // Do not include ownerField unless explicitly set by user (server assigns owner automatically)
      if (ownerField && f.name === ownerField) {
        const explicit = Object.prototype.hasOwnProperty.call(form, f.name) && form[f.name] !== null && form[f.name] !== "";
        if (!explicit) {
          continue;
        }
      }

      const raw = form[f.name];
      const val = convertValueForType(String(f.type), raw);

      // Skip undefined / null for optional fields (don't overwrite)
      if ((val === null || val === undefined) && !f.required) {
        continue;
      }

      payload[f.name] = val;
    }

    console.log("Submitting payload", payload);
    await onSubmit(payload);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 pt-20">
      <div className="bg-white rounded shadow p-4 w-full max-w-2xl max-h-[80vh] overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">{recordId ? `Edit ${modelName}` : `Create ${modelName}`}</h3>
          <button onClick={onClose} className="px-2 py-1 bg-gray-100 rounded">Close</button>
        </div>

        <div className="space-y-3">
          {fields.map((f) => {
            // hide owner field from inputs unless the user already has a value
            if (ownerField && f.name === ownerField) {
              if (initialData && initialData[ownerField]) {
                return (
                  <div key={f.name}>
                    <label className="block text-sm font-medium">Owner ({f.name})</label>
                    <input className="w-full border px-2 py-1 rounded mt-1" value={String(form[f.name] ?? "")} disabled />
                    <div className="text-xs text-gray-500 mt-1">Owner is managed by the system.</div>
                  </div>
                );
              }
              return null;
            }

            const t = String(f.type).toLowerCase();
            const value = form[f.name] ?? "";

            if (t === "relation") {
              const target = f.relation?.model as string | undefined;
              const opts = target ? relationOptions[target] ?? [] : [];
              return (
                <div key={f.name}>
                  <label className="block text-sm font-medium">{f.name}</label>
                  <select value={value ?? ""} onChange={(e) => setField(f.name, e.target.value)} className="w-full border px-2 py-1 rounded mt-1">
                    <option value="">-- select --</option>
                    {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  <div className="text-xs text-gray-500 mt-1">Relation → {f.relation?.model ?? "target"}</div>
                </div>
              );
            }

            if (t === "boolean") {
              return (
                <div key={f.name} className="flex items-center gap-2">
                  <input id={f.name} type="checkbox" checked={!!value} onChange={(e) => setField(f.name, e.target.checked)} />
                  <label htmlFor={f.name} className="text-sm">{f.name}</label>
                </div>
              );
            }

            if (t === "json") {
              return (
                <div key={f.name}>
                  <label className="block text-sm font-medium">{f.name}</label>
                  <textarea className="w-full border px-2 py-1 rounded mt-1" rows={4} value={typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2)} onChange={(e) => setField(f.name, e.target.value)} />
                </div>
              );
            }

            if (t === "string[]") {
              return (
                <div key={f.name}>
                  <label className="block text-sm font-medium">{f.name} (comma separated)</label>
                  <input className="w-full border px-2 py-1 rounded mt-1" value={Array.isArray(value) ? value.join(", ") : value} onChange={(e) => setField(f.name, e.target.value)} />
                </div>
              );
            }

            return (
              <div key={f.name}>
                <label className="block text-sm font-medium">{f.name}</label>
                <input
                  className="w-full border px-2 py-1 rounded mt-1"
                  value={value ?? ""}
                  onChange={(e) => setField(f.name, e.target.value)}
                  type={t === "number" ? "number" : t === "date" ? "date" : "text"}
                />
                {f.required && <div className="text-xs text-gray-500 mt-1">required</div>}
              </div>
            );
          })}

          {formError && <div className="text-sm text-red-600">{formError}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1 border rounded">Cancel</button>
          <button onClick={submit} disabled={loading} className="px-3 py-1 bg-blue-600 text-white rounded">
            {loading ? "Saving..." : recordId ? "Update" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
