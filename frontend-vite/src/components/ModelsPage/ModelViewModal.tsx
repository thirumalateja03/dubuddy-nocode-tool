/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import axios from "axios";

interface ModelViewModalProps {
  modelId: string;
  onClose: () => void;
}

type VersionItem = {
  id: string;
  versionNumber: number;
  json: any;
  createdAt?: string;
  createdBy?: { id?: string; name?: string; email?: string } | null;
  isDraft?: boolean;
  isPublished?: boolean;
};

type RelationSuggestion = {
  modelId: string;
  modelName: string;
  tableName: string;
  versionNumber: number;
  displayField: string | null;
  fields: Array<{ name: string; type: string }>;
  recordsCount: number;
  sampleRecords: Array<{ id: string; label: string | null }>;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

function prettyRelation(rel: any) {
  if (!rel) return "—";
  const model = rel.model ?? rel.targetModel ?? rel.modelName ?? "Unknown";
  const fld = rel.field ?? rel.targetField ?? "id";
  const t = String(rel.type ?? rel.kind ?? "").toLowerCase() || "unknown";
  return `${model}.${fld} (${t})`;
}

const ModelViewModal: React.FC<ModelViewModalProps> = ({ modelId, onClose }) => {
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<VersionItem | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // relation suggestions state
  const [relationSuggestions, setRelationSuggestions] = useState<RelationSuggestion[] | null>(null);
  const [relationLoading, setRelationLoading] = useState<boolean>(false);
  const [relationOpen, setRelationOpen] = useState<Record<string, boolean>>({});

  // helper: token header
  const getAuthHeaders = () => {
    const token = localStorage.getItem("accessToken");
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  // fetch draft (model) and versions
  const fetchAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = getAuthHeaders();

      const [draftRes, versionsRes] = await Promise.allSettled([
        axios.get(`${API_BASE}/models/${modelId}`, { headers }),
        axios.get(`${API_BASE}/models/${modelId}/versions`, { headers }),
      ]);

      const list: VersionItem[] = [];
      let liveNumber: number | null = null;
      let publishedFlag = false;

      if (draftRes.status === "fulfilled" && draftRes.value?.data?.model) {
        const dm = draftRes.value.data.model;
        publishedFlag = Boolean(dm.published === true);
        liveNumber = publishedFlag && typeof dm.version === "number" ? dm.version : liveNumber;
        list.push({
          id: `draft-${dm.id}`,
          versionNumber: -1,
          json: {
            ...dm.json,
            name: dm.name,
            tableName: dm.tableName ?? dm.json?.tableName,
            ownerField: dm.ownerField ?? dm.json?.ownerField,
          },
          createdAt: dm.updatedAt ?? dm.createdAt,
          createdBy: null,
          isDraft: true,
          isPublished: false,
        });
      }

      if (versionsRes.status === "fulfilled" && versionsRes.value?.data?.versions) {
        const vs: any[] = versionsRes.value.data.versions;
        const sorted = [...vs].sort((a, b) => b.versionNumber - a.versionNumber);
        for (const v of sorted) {
          list.push({
            id: v.id,
            versionNumber: v.versionNumber,
            json: v.json ?? {},
            createdAt: v.createdAt,
            createdBy: v.createdBy ?? null,
            isDraft: false,
            isPublished: liveNumber !== null && v.versionNumber === liveNumber,
          });
        }
      }

      if (list.length === 0) {
        setError("No draft or versions found for this model.");
        setVersions([]);
        setSelectedVersion(null);
        return;
      }

      // ensure published flags updated (some backends may provide model.version after versions list)
      const normalized = list.map((it) => {
        if (it.isDraft) return it;
        return { ...it, isPublished: it.isPublished ?? false };
      });

      setVersions(normalized);

      // select draft by default if present
      const draftItem = normalized.find((v) => v.isDraft);
      setSelectedVersion(draftItem ?? normalized[0]);
    } catch (err: any) {
      console.error("fetchAll error", err);
      setError(err?.response?.data?.message ?? err?.message ?? "Failed to fetch model data");
      setVersions([]);
      setSelectedVersion(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, [modelId]);

  // fetch relation suggestions for selected version (if has relation fields)
  const fetchRelationSuggestions = async () => {
    if (!selectedVersion) {
      setRelationSuggestions(null);
      return;
    }

    // if there are no relation fields, skip
    const fields: any[] = Array.isArray(selectedVersion.json?.fields) ? selectedVersion.json.fields : [];
    const hasRelation = fields.some((f) => (String(f.type ?? "").toLowerCase() === "relation"));
    if (!hasRelation) {
      setRelationSuggestions(null);
      return;
    }

    setRelationLoading(true);
    try {
      const headers = getAuthHeaders();
      const res = await axios.get(`${API_BASE}/models/${modelId}/relation-suggestions`, { headers });
      if (res.data?.success) {
        setRelationSuggestions(res.data.suggestions ?? []);
        // initialize open map
        const map: Record<string, boolean> = {};
        (res.data.suggestions ?? []).forEach((s: RelationSuggestion) => (map[s.modelId] = false));
        setRelationOpen(map);
      } else {
        setRelationSuggestions([]);
      }
    } catch (err: any) {
      console.warn("relation suggestions error", err);
      setRelationSuggestions([]);
    } finally {
      setRelationLoading(false);
    }
  };

  useEffect(() => {
    fetchRelationSuggestions();
  }, [selectedVersion?.id]);

  // transient UI alerts auto dismiss
  useEffect(() => {
    if (!alert) return;
    const t = setTimeout(() => setAlert(null), 4000);
    return () => clearTimeout(t);
  }, [alert]);

  const handleSelectChange = (value: string) => {
    const found = versions.find((v) => v.id === value);
    if (found) setSelectedVersion(found);
  };

  // backend actions -----------------------------------------------------------
  const revertToDraft = async (versionNumber: number) => {
    if (!selectedVersion || selectedVersion.isDraft) return;
    const ok = window.confirm(`Revert draft to version ${versionNumber}?`);
    if (!ok) return;

    setActionLoading(true);
    try {
      const headers = { ...getAuthHeaders(), "Content-Type": "application/json" };
      const res = await axios.post(`${API_BASE}/models/${modelId}/revert/${versionNumber}`, { message: `Reverted to ${versionNumber}` }, { headers });
      if (res.data?.success) {
        setAlert({ type: "success", message: res.data.message ?? "Reverted to draft" });
        await fetchAll();
      } else {
        setAlert({ type: "error", message: res.data?.message ?? "Revert failed" });
      }
    } catch (err: any) {
      console.error("revert error", err);
      setAlert({ type: "error", message: err?.response?.data?.message ?? err?.message ?? "Revert failed" });
    } finally {
      setActionLoading(false);
    }
  };

  const publishVersion = async (versionNumber: number) => {
    if (!selectedVersion || selectedVersion.isDraft) return;
    if (selectedVersion.isPublished) {
      setAlert({ type: "error", message: "This version is already published." });
      return;
    }
    const ok = window.confirm(`Publish version ${versionNumber}?`);
    if (!ok) return;

    setActionLoading(true);
    try {
      const headers = { ...getAuthHeaders(), "Content-Type": "application/json" };
      const res = await axios.post(`${API_BASE}/models/${modelId}/versions/${versionNumber}/publish`, {}, { headers });
      if (res.data?.success) {
        setAlert({ type: "success", message: res.data.message ?? "Version published" });
        await fetchAll();
      } else {
        setAlert({ type: "error", message: res.data?.message ?? "Publish failed" });
      }
    } catch (err: any) {
      console.error("publish version error", err);
      setAlert({ type: "error", message: err?.response?.data?.message ?? err?.message ?? "Publish failed" });
    } finally {
      setActionLoading(false);
    }
  };

  const publishDraft = async () => {
    if (!selectedVersion || !selectedVersion.isDraft) return;
    const ok = window.confirm("Publish current draft?");
    if (!ok) return;

    setActionLoading(true);
    try {
      const headers = { ...getAuthHeaders(), "Content-Type": "application/json" };
      const res = await axios.post(`${API_BASE}/models/${modelId}/publish`, {}, { headers });
      if (res.data?.success) {
        setAlert({ type: "success", message: res.data.message ?? "Draft published" });
        await fetchAll();
      } else {
        setAlert({ type: "error", message: res.data?.message ?? "Publish draft failed" });
      }
    } catch (err: any) {
      console.error("publish draft error", err);
      setAlert({ type: "error", message: err?.response?.data?.message ?? err?.message ?? "Publish draft failed" });
    } finally {
      setActionLoading(false);
    }
  };

  // UI ------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-xl p-6 w-[600px] shadow-lg">
          <p className="text-gray-700">Loading model data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-xl p-6 w-[600px] shadow-lg">
          <p className="text-red-600">{error}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={fetchAll} className="px-3 py-1 bg-blue-600 text-white rounded">Retry</button>
            <button onClick={onClose} className="px-3 py-1 bg-gray-200 rounded">Close</button>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedVersion) return null;

  const json = selectedVersion.json ?? {};
  const isDraftSelected = !!selectedVersion.isDraft;
  const availableVersions = versions.filter((v) => !v.isDraft);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-[960px] max-h-[92vh] overflow-y-auto shadow-lg">
        {/* header */}
        <div className="flex justify-between items-start border-b pb-3 mb-4 gap-4">
          <div>
            <h2 className="text-2xl font-semibold">{json.name ?? "Model"}</h2>
            <p className="text-sm text-gray-500">View draft, versions and relation suggestions</p>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={selectedVersion.id}
              onChange={(e) => handleSelectChange(e.target.value)}
              className="border rounded-md px-3 py-2 text-sm"
            >
              {versions.some((v) => v.isDraft) && (
                <option key="draft" value={versions.find((v) => v.isDraft)!.id}>Draft (saved)</option>
              )}
              {availableVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.versionNumber} — {new Date(v.createdAt ?? "").toLocaleString()}
                  {v.isPublished ? " (live)" : ""}
                </option>
              ))}
            </select>

            <button onClick={onClose} title="Close" className="p-2 rounded bg-gray-100 hover:bg-gray-200">
              <X className="w-5 h-5 text-gray-600" />
            </button>
          </div>
        </div>

        {/* alert */}
        {alert && (
          <div className={`mb-4 p-3 rounded text-sm ${alert.type === "success" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
            {alert.message}
          </div>
        )}

        {/* Model info */}
        <div className="grid grid-cols-3 gap-4 mb-6 text-sm text-gray-700">
          <div><strong>Table:</strong> {json.tableName ?? "—"}</div>
          <div><strong>Version:</strong> {isDraftSelected ? "Draft (current)" : selectedVersion.versionNumber}{selectedVersion.isPublished ? " (live)" : ""}</div>
          <div><strong>Owner Field:</strong> {json.ownerField ?? "—"}</div>

          <div><strong>Created:</strong> {selectedVersion.createdAt ? new Date(selectedVersion.createdAt).toLocaleString() : "—"}</div>
          <div><strong>Created By:</strong> {selectedVersion.createdBy?.name ?? selectedVersion.createdBy?.email ?? "—"}</div>
          <div><strong>Model ID:</strong> {modelId}</div>
        </div>

        {/* actions */}
        <div className="mb-4 flex gap-2">
          <button
            disabled={actionLoading || isDraftSelected}
            onClick={() => revertToDraft(selectedVersion.versionNumber)}
            className={`px-3 py-2 rounded text-sm ${isDraftSelected ? "bg-gray-200 text-gray-600" : "bg-yellow-500 text-white hover:bg-yellow-600"}`}
            title={isDraftSelected ? "Cannot revert draft" : "Revert draft to this version"}
          >
            {actionLoading ? "Working..." : "Revert to Draft"}
          </button>

          {isDraftSelected ? (
            <button
              disabled={actionLoading}
              onClick={publishDraft}
              className="px-3 py-2 rounded text-sm bg-green-600 text-white hover:bg-green-700"
            >
              {actionLoading ? "Working..." : "Publish Draft"}
            </button>
          ) : (
            <button
              disabled={actionLoading || !!selectedVersion.isPublished}
              onClick={() => publishVersion(selectedVersion.versionNumber)}
              className={`px-3 py-2 rounded text-sm ${selectedVersion.isPublished ? "bg-gray-200 text-gray-600" : "bg-green-600 text-white hover:bg-green-700"}`}
              title={selectedVersion.isPublished ? "This version is already published" : "Publish this version"}
            >
              {actionLoading ? "Working..." : selectedVersion.isPublished ? "Published" : "Publish Version"}
            </button>
          )}

          <button onClick={fetchAll} className="px-3 py-2 rounded text-sm bg-gray-100 hover:bg-gray-200">Refresh</button>
        </div>

        {/* fields table */}
        <div className="mb-6">
          <h3 className="text-lg font-medium mb-2">Fields</h3>
          {Array.isArray(json.fields) && json.fields.length > 0 ? (
            <table className="w-full border text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="border p-2 text-left">Name</th>
                  <th className="border p-2 text-left">Type</th>
                  <th className="border p-2 text-left">Required</th>
                  <th className="border p-2 text-left">Default</th>
                  <th className="border p-2 text-left">Relation</th>
                  <th className="border p-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody>
                {json.fields.map((field: any, i: number) => {
                  const t = String(field.type ?? "").toLowerCase();
                  const isRelation = t === "relation";
                  const relationSummary = isRelation ? prettyRelation(field.relation) : "—";
                  const notes: string[] = [];
                  if (field.required) notes.push("required");
                  if (field.unique) notes.push("unique");
                  if (isRelation && field.relation) notes.push(String(field.relation.type ?? field.relation.kind ?? "relation"));
                  return (
                    <tr key={field.name ?? i}>
                      <td className="border p-2 align-top">{field.name ?? "—"}</td>
                      <td className="border p-2 align-top">{field.type ?? "—"}</td>
                      <td className="border p-2 align-top">{field.required ? "true" : "false"}</td>
                      <td className="border p-2 align-top">{field.default !== undefined ? String(field.default) : "—"}</td>
                      <td className="border p-2 align-top">{relationSummary}</td>
                      <td className="border p-2 align-top">{notes.join(", ") || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-gray-500">No fields defined in this version.</p>
          )}
        </div>

        {/* relation suggestions */}
        <div className="mb-6">
          <h3 className="text-lg font-medium mb-2">Relation Suggestions</h3>
          {relationLoading ? (
            <p className="text-gray-600">Loading relation suggestions…</p>
          ) : relationSuggestions === null ? (
            <p className="text-gray-500">No relation fields in this version.</p>
          ) : relationSuggestions.length === 0 ? (
            <p className="text-gray-500">No relation suggestions available.</p>
          ) : (
            <div className="space-y-3">
              {relationSuggestions.map((s) => (
                <div key={s.modelId} className="border rounded p-3">
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="font-medium">{s.modelName} <span className="text-xs text-gray-500">({s.tableName})</span></div>
                      <div className="text-xs text-gray-500">display: {s.displayField ?? "—"} • {s.recordsCount} records</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        className="text-sm px-2 py-1 border rounded bg-white hover:bg-gray-50"
                        onClick={() => setRelationOpen((p) => ({ ...p, [s.modelId]: !p[s.modelId] }))}
                      >
                        {relationOpen[s.modelId] ? "Hide sample" : "View sample"}
                      </button>
                    </div>
                  </div>

                  {relationOpen[s.modelId] && (
                    <div className="mt-3 text-sm">
                      <div className="mb-2 text-xs text-gray-600">Fields: {s.fields.map((f) => f.name).join(", ")}</div>
                      <table className="w-full border text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="border p-2 text-left">ID</th>
                            <th className="border p-2 text-left">Label</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.sampleRecords.map((r) => (
                            <tr key={r.id}>
                              <td className="border p-2 text-xs">{r.id}</td>
                              <td className="border p-2 text-xs">{r.label ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RBAC */}
        <div className="mb-6">
          <h3 className="text-lg font-medium mb-2">Role Permissions (RBAC)</h3>
          {json.rbac && Object.keys(json.rbac).length > 0 ? (
            <table className="w-full border text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="border p-2 text-left">Role</th>
                  <th className="border p-2 text-left">Permissions</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(json.rbac).map(([role, perms]: any) => (
                  <tr key={role}>
                    <td className="border p-2 font-medium">{role}</td>
                    <td className="border p-2">{(perms as string[]).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-gray-500">No RBAC configuration available for this version.</p>
          )}
        </div>

        {/* version history */}
        <div className="mb-6">
          <h3 className="text-lg font-medium mb-2">Version History</h3>
          {versions.length > 0 ? (
            <ul className="list-disc ml-5 text-sm">
              {versions.map((v) => (
                <li key={v.id} className={`${v.id === selectedVersion.id ? "text-blue-600 font-medium" : "text-gray-700"}`}>
                  {v.isDraft ? "Draft (saved)" : `Version ${v.versionNumber}`} — {v.createdAt ? new Date(v.createdAt).toLocaleString() : "—"} {v.createdBy?.name ? `by ${v.createdBy.name}` : ""} {v.isPublished ? " (live)" : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-gray-500">No version history available.</p>
          )}
        </div>

        {/* footer */}
        <div className="text-right">
          <button onClick={onClose} className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300">Close</button>
        </div>
      </div>
    </div>
  );
};

export default ModelViewModal;
