/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useState } from "react";
import axios from "axios";

interface ModelDeleteModalProps {
  modelId: string;
  onClose: () => void;
  onDeleted: (id: string) => void;
}

type RefInfo = {
  modelId: string;
  modelName: string;
  fieldName: string;
  published?: boolean;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

/**
 * Safe delete modal:
 * - shows model info
 * - computes referencing models by scanning /models/all client-side
 * - disables delete if references found or if server indicates records exist
 * - does NOT expose force-delete; instead instructs user to remove relations or records
 */
const ModelDeleteModal: React.FC<ModelDeleteModalProps> = ({ modelId, onClose, onDeleted }) => {
  const [model, setModel] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // referencing models discovered client-side
  const [references, setReferences] = useState<RefInfo[] | null>(null);
  const [refsLoading, setRefsLoading] = useState<boolean>(false);

  // server-side message from last delete attempt (if any)
  const [serverMessage, setServerMessage] = useState<string | null>(null);

  // helper for auth header (localStorage like other components)
  const authHeaders = () => {
    const token = localStorage.getItem("accessToken");
    const h: any = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  };

  // fetch model details
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await axios.get(`${API_BASE}/models/${modelId}`, { headers: authHeaders() });
        if (!mounted) return;
        if (res.data?.success && res.data?.model) {
          setModel(res.data.model);
        } else {
          setError(res.data?.message ?? "Failed to load model details.");
          setModel(null);
        }
      } catch (err: any) {
        console.error("Failed fetching model:", err);
        setError(err?.response?.data?.message ?? err?.message ?? "Failed to fetch model.");
        setModel(null);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, [modelId]);

  // compute referencing models by scanning /models/all
  const computeReferences = async () => {
    setRefsLoading(true);
    setReferences(null);
    try {
      const res = await axios.get(`${API_BASE}/models/all`, { headers: authHeaders() });
      if (!res.data?.success || !Array.isArray(res.data.models)) {
        setReferences([]);
        setRefsLoading(false);
        return;
      }

      const allModels: any[] = res.data.models;
      const refs: RefInfo[] = [];

      const targetName = model?.name;
      if (!targetName) {
        setReferences([]);
        setRefsLoading(false);
        return;
      }

      for (const m of allModels) {
        if (!m || !m.json || !Array.isArray(m.json.fields)) continue;
        if (String(m.id) === String(modelId)) continue;
        const defFields = m.json.fields;
        for (const f of defFields) {
          if (!f) continue;
          const t = String(f.type ?? "").toLowerCase();
          if (t !== "relation") continue;
          // relation may be stored as object or string
          const rel = f.relation;
          let relModelName = null;
          if (!rel) {
            // some legacy shapes may encode relation as string e.g., "User.id"
            if (typeof f.relation === "string") {
              relModelName = String((f.relation as string).split(".")[0] ?? null);
            } else {
              // try if relation has model property on other fields
              relModelName = f.relation?.model ?? f.relation?.modelName ?? null;
            }
          } else {
            relModelName = rel.model ?? rel.modelName ?? null;
          }

          if (!relModelName) continue;

          if (String(relModelName).toLowerCase() === String(targetName).toLowerCase()) {
            refs.push({
              modelId: m.id,
              modelName: m.name ?? m.tableName ?? "Unknown",
              fieldName: f.name ?? "(unnamed)",
              published: Boolean(m.published),
            });
          }
        }
      }
      setReferences(refs);
    } catch (err) {
      console.warn("Failed fetching models for references:", err);
      setReferences([]);
    } finally {
      setRefsLoading(false);
    }
  };

  // automatically compute references once model is loaded
  useEffect(() => {
    if (!model) return;
    computeReferences();
  }, [model]);

  // attempt delete (no force option)
  const handleDelete = async () => {
    if (!model) return;
    setServerMessage(null);
    setError(null);

    // final confirm (explain we will not force delete)
    const ok = window.confirm(
      `Delete model "${model.name}" permanently?\n\nThis operation will NOT force-remove referencing models or cascade records. If the model has records or is referenced by other models the server will refuse the request.`
    );
    if (!ok) return;

    setDeleting(true);
    try {
      const res = await axios.delete(`${API_BASE}/models/${modelId}`, { headers: authHeaders() });
      // success path
      if (res.data?.deleted || res.data?.success) {
        onDeleted(modelId);
        onClose();
      } else {
        // server responded without success flag
        const msg = res.data?.message ?? "Delete failed";
        setServerMessage(String(msg));
        setError(msg);
        // re-run references to show up-to-date info
        await computeReferences();
      }
    } catch (err: any) {
      console.error("Delete error:", err);
      const serverMsg =
        err?.response?.data?.message ??
        (err?.response?.data ? JSON.stringify(err.response.data) : null) ??
        err?.message ??
        "Delete failed";
      setServerMessage(String(serverMsg));
      setError(serverMsg);
      // re-check references after server error
      try {
        await computeReferences();
      } catch {
        // ignore
      }
    } finally {
      setDeleting(false);
    }
  };

  // helper to copy referencing details to clipboard
  const copyReferences = async () => {
    if (!references || references.length === 0) return;
    const text = references.map((r) => `${r.modelName}.${r.fieldName} (id: ${r.modelId})`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      alert("Referencing models copied to clipboard");
    } catch (e) {
      console.warn("Clipboard copy failed", e);
      // fallback: show prompt
      window.prompt("Copy referencing models", text);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-2xl max-h-[92vh] overflow-auto p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-red-600">Delete Model</h2>
            <p className="text-sm text-gray-600">Dangerous operation — please review references and data before deleting.</p>
          </div>
          <div>
            <button onClick={onClose} className="px-3 py-1 rounded bg-gray-100 hover:bg-gray-200">Close</button>
          </div>
        </div>

        <div className="mt-4">
          {loading ? (
            <div className="text-sm text-gray-600">Loading model details…</div>
          ) : error && !model ? (
            <div className="text-sm text-red-600">{error}</div>
          ) : model ? (
            <>
              <div className="mb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-base font-medium">{model.name}</div>
                    <div className="text-xs text-gray-500">{model.tableName ?? model.json?.tableName ?? "—"}</div>
                  </div>
                  <div className="text-right text-sm text-gray-600">
                    <div>Created: {new Date(model.createdAt).toLocaleString()}</div>
                    <div>Published: {model.published ? <span className="text-green-600">Yes</span> : <span className="text-gray-500">No</span>}</div>
                    <div>Version: {model.version ?? "—"}</div>
                  </div>
                </div>
              </div>

              {/* Server message (from prior delete attempt) */}
              {serverMessage && (
                <div className="mb-4 p-3 rounded border bg-yellow-50 text-sm text-yellow-800">
                  <strong>Server message:</strong> {serverMessage}
                </div>
              )}

              {/* References summary */}
              <div className="mb-4 border rounded p-3 bg-gray-50">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="font-medium">References</div>
                    <div className="text-xs text-gray-500">Other models that reference this model's primary key through relation fields.</div>
                  </div>
                  <div className="text-sm text-gray-600">
                    {refsLoading ? "Checking…" : (references ? `${references.length} found` : "-")}
                  </div>
                </div>

                {refsLoading ? (
                  <div className="text-xs text-gray-500">Scanning models for relations…</div>
                ) : !references ? (
                  <div className="text-xs text-gray-500">No reference data available.</div>
                ) : references.length === 0 ? (
                  <div className="text-sm text-green-700">No referencing models found.</div>
                ) : (
                  <>
                    <ul className="list-disc ml-5 text-sm mb-3">
                      {references.map((r) => (
                        <li key={`${r.modelId}-${r.fieldName}`} className="mb-1">
                          <span className="font-medium">{r.modelName}</span>
                          <span className="text-gray-600"> .{r.fieldName}</span>
                          {r.published ? <span className="ml-2 text-xs text-green-600">(published)</span> : null}
                          <button
                            onClick={() => {
                              // try to open edit page for that model — adapt if your route is different
                              const url = `/models/edit/${r.modelId}`;
                              window.open(url, "_blank");
                            }}
                            className="ml-3 text-xs px-2 py-0.5 border rounded hover:bg-gray-100"
                          >
                            Open
                          </button>
                        </li>
                      ))}
                    </ul>

                    <div className="flex gap-2">
                      <button onClick={copyReferences} className="text-sm px-3 py-1 border rounded">Copy list</button>
                      <button
                        onClick={() => {
                          // advise manual remediation steps in a small overlay prompt
                          alert(
                            `Suggested remediation steps:
1) Open each referencing model (Open).
2) Remove or change the relation field that points to ${model.name} (e.g., change relation to another model or remove the field).
3) If there are records in this model, export or delete records first.
4) After cleaning references & records, retry deletion.`
                          );
                        }}
                        className="text-sm px-3 py-1 border rounded"
                      >
                        How to fix
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Explanation & safety guidance */}
              <div className="mb-4 p-3 rounded border-l-4 border-red-200 bg-red-50 text-sm text-red-800">
                <div className="font-medium">Why deletion is blocked</div>
                <ul className="list-disc ml-5 mt-2 text-sm">
                  <li>Models that reference this model via relation fields prevent safe deletion because removing this model would break those references.</li>
                  <li>If there are existing records for this model, deleting could cascade and remove user data.</li>
                  <li>We do not expose a "force delete" here to avoid accidental data loss. Please remove references and/or records first, then retry deletion.</li>
                </ul>
              </div>

              {/* Action row */}
              <div className="flex justify-end gap-3">
                <button onClick={onClose} className="px-3 py-2 rounded border hover:bg-gray-100">Cancel</button>

                <button
                  onClick={handleDelete}
                  disabled={deleting || !(references && references.length === 0)}
                  title={!(references && references.length === 0) ? "Resolve references before deleting" : "Permanently delete model"}
                  className={`px-4 py-2 rounded text-white ${deleting ? "bg-gray-400" : (references && references.length === 0 ? "bg-red-600 hover:bg-red-700" : "bg-gray-300")}`}
                >
                  {deleting ? "Deleting..." : "Delete permanently"}
                </button>
              </div>
            </>
          ) : (
            <div className="text-sm text-gray-600">Model not found.</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModelDeleteModal;
