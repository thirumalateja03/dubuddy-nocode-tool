/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { useAuth } from "../../context/useAuth";

type FieldType = "string" | "number" | "boolean" | "date" | "json" | "string[]" | "relation";

type RelationValue = {
  modelId?: string; // selected suggestion id (we'll map to modelName on save)
  model?: string; // model name (for compatibility with backend)
  field?: string; // target field name (typically "id")
  type?: string; // relation cardinality (many-to-one, one-to-many, ...)
} | null;

type FieldItem = {
  id: string;
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  default?: string | number | boolean | null;
  relation?: RelationValue;
};

type RbacMap = Record<string, string[]>;

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

type Props = {
  modelId: string;
  onClose: () => void;
  onSaved?: (model: any) => void;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const TYPE_OPTIONS: FieldType[] = ["string", "number", "boolean", "date", "json", "string[]", "relation"];
const RELATION_TYPES = ["many-to-one", "one-to-many", "one-to-one", "many-to-many"];

function uid(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 9);
}

/**
 * Helper: parse legacy string relation forms like "User.id" into object
 */
function parseRelationInput(rel: any): RelationValue {
  if (!rel) return null;
  if (typeof rel === "string") {
    const parts = rel.split(".");
    return { model: parts[0] ?? undefined, field: parts[1] ?? "id", type: "many-to-one" };
  }
  if (typeof rel === "object") {
    return {
      modelId: rel.modelId ?? undefined,
      model: rel.model ?? rel.modelName ?? undefined,
      field: rel.field ?? rel.targetField ?? "id",
      type: (rel.type ?? rel.kind ?? "many-to-one"),
    };
  }
  return null;
}

function reconcileFieldsWithSuggestions(
  currentFields: FieldItem[],
  suggestions: RelationSuggestion[] | null
): FieldItem[] {
  if (!Array.isArray(currentFields) || !Array.isArray(suggestions)) return currentFields;
  return currentFields.map((f) => {
    if (String(f.type).toLowerCase() !== "relation" || !f.relation) return f;
    // if modelId already present, keep as-is
    if (f.relation.modelId) return f;

    const targetModelName = f.relation.model ?? null;
    const suggestion = suggestions.find(
      (s) => s.modelName === targetModelName || s.modelId === f.relation?.modelId
    );
    if (!suggestion) return f;

    return {
      ...f,
      relation: {
        modelId: suggestion.modelId,
        model: suggestion.modelName,
        field: f.relation.field ?? suggestion.displayField ?? suggestion.fields?.[0]?.name ?? "id",
        type: f.relation.type ?? "many-to-one",
      },
    };
  });
}


export const ModelEditModal: React.FC<Props> = ({ modelId, onClose, onSaved }) => {
  const { accessToken } = useAuth();
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // meta
  const [name, setName] = useState<string>("");
  const [tableName, setTableName] = useState<string>("");
  const [ownerField, setOwnerField] = useState<string>("");

  // dynamic state
  const [fields, setFields] = useState<FieldItem[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [rbac, setRbac] = useState<RbacMap>({});

  // relation suggestions
  const [relationSuggestions, setRelationSuggestions] = useState<RelationSuggestion[] | null>(null);
  const [relationLoading, setRelationLoading] = useState<boolean>(false);

  // local helpers
  const headersWithAuth = () => {
    const token = accessToken ?? localStorage.getItem("accessToken");
    const h: any = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  };

  useEffect(() => {
    if (!relationSuggestions || fields.length === 0) return;
    setFields((prev) => reconcileFieldsWithSuggestions(prev, relationSuggestions));
  }, [relationSuggestions]); // only trigger when suggestions update


  // load model (draft) and relation suggestions
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = accessToken ?? localStorage.getItem("accessToken");
        // fetch model (draft/view) - same endpoint used earlier
        const modelRes = await axios.get(`${API_BASE}/models/${modelId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        if (!mounted) return;

        if (!modelRes.data?.success || !modelRes.data?.model) {
          setError("Failed to load model");
          setLoading(false);
          return;
        }
        const m = modelRes.data.model;

        setName(m.name ?? "");
        setTableName(m.tableName ?? m.json?.tableName ?? "");
        setOwnerField(m.ownerField ?? m.json?.ownerField ?? "");

        // fields normalize
        const ff: FieldItem[] = (m.json?.fields ?? []).map((f: any) => ({
          id: uid("f-"),
          name: String(f.name ?? ""),
          type: (String(f.type ?? "string") as FieldType),
          required: Boolean(f.required),
          unique: Boolean(f.unique),
          default: f.default ?? null,
          relation: parseRelationInput(f.relation ?? null),
        }));
        setFields(ff);

        // rbac normalize
        const rbacObj: RbacMap = m.json?.rbac ?? {};
        const rKeys = Array.isArray(Object.keys(rbacObj)) ? Object.keys(rbacObj) : [];
        const mergedRoles = Array.from(new Set([...rKeys, "Admin", "Manager", "Viewer"]));
        setRoles(mergedRoles);
        const normalized: RbacMap = {};
        mergedRoles.forEach((r) => {
          normalized[r] = Array.isArray(rbacObj[r]) ? rbacObj[r].map((x: any) => String(x).toUpperCase()) : [];
          if (r === "Admin" && normalized[r].length === 0) normalized[r] = ["ALL"];
        });
        setRbac(normalized);
      } catch (err: any) {
        console.error("model load error", err);
        setError(err?.response?.data?.message ?? err?.message ?? "Network error");
      } finally {
        if (mounted) setLoading(false);
      }

      // fetch relation suggestions (independent; backend returns empty array if none)
      try {
        setRelationLoading(true);
        const rs = await axios.get(`${API_BASE}/models/${modelId}/relation-suggestions`, {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        });
        if (!mounted) return;
        if (rs.data?.success) setRelationSuggestions(rs.data.suggestions ?? []);
        else setRelationSuggestions([]);
      } catch (err) {
        console.warn("relation suggestions fetch failed", err);
        if (mounted) setRelationSuggestions([]);
      } finally {
        if (mounted) setRelationLoading(false);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, [modelId, accessToken]);

  // field helpers
  const addField = useCallback(() => {
    setFields((s) => [
      ...s,
      { id: uid("f-"), name: "", type: "string", required: false, unique: false, default: null, relation: null },
    ]);
  }, []);

  const updateField = useCallback((id: string, patch: Partial<FieldItem>) => {
    setFields((s) => s.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const removeField = useCallback((id: string) => {
    setFields((s) => s.filter((f) => f.id !== id));
  }, []);

  // role helpers
  const [newRole, setNewRole] = useState("");
  const addRole = useCallback(() => {
    const trimmed = newRole.trim();
    if (!trimmed) {
      setError("Role name required");
      return;
    }
    if (roles.includes(trimmed)) {
      setError("Role already exists");
      return;
    }
    setRoles((r) => [...r, trimmed]);
    setRbac((prev) => ({ ...prev, [trimmed]: ["CREATE", "READ", "UPDATE"] }));
    setNewRole("");
    setError(null);
  }, [newRole, roles]);

  const removeRole = useCallback(
    (roleToRemove: string) => {
      if (roleToRemove === "Admin") {
        setError("Cannot remove Admin");
        return;
      }
      setRoles((r) => r.filter((x) => x !== roleToRemove));
      setRbac((prev) => {
        const copy = { ...prev };
        delete copy[roleToRemove];
        return copy;
      });
      setError(null);
    },
    []
  );

  const toggleRbacAction = useCallback((role: string, action: string) => {
    setRbac((prev) => {
      const curr = new Set(prev[role] ?? []);
      const upper = action.toUpperCase();
      if (curr.has("ALL") && upper !== "ALL") curr.delete("ALL");
      if (curr.has(upper)) curr.delete(upper);
      else curr.add(upper);
      const basics = ["CREATE", "READ", "UPDATE", "DELETE"];
      const hasAllBasics = basics.every((b) => curr.has(b));
      if (hasAllBasics) return { ...prev, [role]: ["ALL"] };
      return { ...prev, [role]: Array.from(curr) };
    });
  }, []);

  // validation
  const validate = useCallback(() => {
    if (!name.trim()) return "Model name is required";
    const trimmedNames = fields.map((f) => f.name.trim()).filter(Boolean);
    if (trimmedNames.length !== new Set(trimmedNames).size) return "Field names must be unique and non-empty";

    // check relation fields present relation target info
    for (const f of fields) {
      if (String(f.type).toLowerCase() === "relation") {
        const rel = f.relation;
        if (!rel || (!rel.model && !rel.modelId) || !rel.field) {
          return `Relation field '${f.name}' needs a target model and field`;
        }
        // check cardinality shape hint: backend expects arrays for many-to-many / one-to-many
        const relType = String(rel.type ?? "many-to-one").toLowerCase();
        if ((relType === "one-to-many" || relType === "many-to-many") && f.default !== undefined && f.default !== null) {
          // not strictly enforcing default type but warn if user provided single default
        }
      }
    }

    return null;
  }, [name, fields]);

  // build payload
  const buildPayload = useCallback(() => {
    const payloadFields = fields
      .map((f) => {
        const nm = f.name.trim();
        if (!nm) return null;
        const out: any = { name: nm, type: f.type };
        if (f.required) out.required = true;
        if (f.unique) out.unique = true;
        if (f.default !== null && f.default !== undefined && f.default !== "") out.default = f.default;
        if (f.type === "relation" && f.relation) {
          // map modelId => modelName using relationSuggestions if available
          const suggestion = (relationSuggestions ?? []).find((s) => s.modelId === f.relation?.modelId);
          const modelName = f.relation?.model ?? suggestion?.modelName ?? undefined;
          out.relation = {
            model: modelName,
            field: f.relation.field ?? "id",
            type: f.relation.type ?? "many-to-one",
          };
        }
        return out;
      })
      .filter(Boolean);

    return {
      tableName: (tableName && tableName.trim()) || (name ? name.trim().toLowerCase() + "s" : ""),
      ownerField: ownerField?.trim() || undefined,
      json: {
        fields: payloadFields,
        rbac,
      },
    };
  }, [fields, rbac, tableName, ownerField, name, relationSuggestions]);

  // save
  const handleSave = useCallback(async () => {
    setError(null);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      const res = await axios.put(`${API_BASE}/models/${modelId}`, payload, { headers: headersWithAuth() });
      if (res.data?.success) {
        onSaved?.(res.data.model);
        onClose();
      } else {
        setError(res.data?.message ?? "Save failed");
      }
    } catch (err: any) {
      console.error("save model error", err);
      setError(err?.response?.data?.message ?? err?.message ?? "Network error");
    } finally {
      setSaving(false);
    }
  }, [validate, buildPayload, modelId, onClose, onSaved]);

  // helpers to wire relation selects
  const onRelationModelChange = (fieldId: string, selectedModelId?: string) => {
    const suggestion = (relationSuggestions ?? []).find((s) => s.modelId === selectedModelId);
    updateField(fieldId, {
      relation: {
        modelId: selectedModelId,
        model: suggestion?.modelName,
        field: suggestion?.displayField ?? suggestion?.fields?.[0]?.name ?? "id",
        type: suggestion ? "many-to-one" : "many-to-one",
      },
    });
  };

  const onRelationFieldChange = (fieldId: string, targetField: string) => {
    updateField(fieldId, { relation: { ...(fields.find((f) => f.id === fieldId)?.relation ?? {}), field: targetField } });
  };

  const onRelationTypeChange = (fieldId: string, relType: string) => {
    updateField(fieldId, { relation: { ...(fields.find((f) => f.id === fieldId)?.relation ?? {}), type: relType } });
  };

  const hasAnyFields = fields.length > 0;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div className="w-full max-w-4xl max-h-[92vh] overflow-auto bg-white rounded-md shadow-lg p-6">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">{name || "Edit Model"}</h3>
            <p className="text-sm text-gray-500">Model ID: {modelId}</p>
          </div>
          <div>
            <button onClick={onClose} className="text-sm px-3 py-1 bg-gray-200 rounded">Close</button>
          </div>
        </div>

        {loading ? (
          <p className="mt-4">Loading model...</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium">Model Name</label>
                <input className="mt-1 w-full border px-3 py-2 rounded bg-gray-50" value={name} onChange={(e) => setName(e.target.value)} />
                <p className="text-xs text-gray-500 mt-1">Rename only if backend supports it.</p>
              </div>

              <div>
                <label className="block text-sm font-medium">Table Name</label>
                <input className="mt-1 w-full border px-3 py-2 rounded" value={tableName} onChange={(e) => setTableName(e.target.value)} />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium">Owner Field</label>
              <input className="mt-1 w-full border px-3 py-2 rounded" value={ownerField} onChange={(e) => setOwnerField(e.target.value)} />
              <p className="text-xs text-gray-500 mt-1">Optional. Used for ownership enforcement (RBAC).</p>
            </div>

            {/* fields */}
            <div className="border rounded p-3">
              <div className="flex justify-between items-center mb-2">
                <h4 className="font-medium">Fields</h4>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={addField} className="text-sm bg-green-600 text-white px-3 py-1 rounded">+ Add field</button>
                </div>
              </div>

              {!hasAnyFields && <p className="text-sm text-gray-500">No fields</p>}

              <div className="space-y-3">
                {fields.map((f) => (
                  <div key={f.id} className="grid grid-cols-12 gap-2 items-start border rounded p-3">
                    <div className="col-span-3">
                      <input value={f.name} onChange={(e) => updateField(f.id, { name: e.target.value })} placeholder="field name" className="w-full border px-2 py-1 rounded" />
                    </div>

                    <div className="col-span-2">
                      <select value={f.type} onChange={(e) => updateField(f.id, { type: e.target.value as FieldType, relation: e.target.value === "relation" ? parseRelationInput(f.relation) : null })} className="w-full border px-2 py-1 rounded">
                        {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>

                    <div className="col-span-3 flex gap-2">
                      <label className="text-sm flex items-center gap-1">
                        <input type="checkbox" checked={!!f.required} onChange={(e) => updateField(f.id, { required: e.target.checked })} />
                        <span className="ml-1 text-xs">required</span>
                      </label>
                      <label className="text-sm flex items-center gap-1">
                        <input type="checkbox" checked={!!f.unique} onChange={(e) => updateField(f.id, { unique: e.target.checked })} />
                        <span className="ml-1 text-xs">unique</span>
                      </label>
                    </div>

                    <div className="col-span-2 flex justify-end gap-2">
                      <button type="button" onClick={() => removeField(f.id)} className="text-sm text-red-600 border px-2 py-1 rounded">Remove</button>
                    </div>

                    <div className="col-span-6 mt-2">
                      <input value={f.default === null || f.default === undefined ? "" : String(f.default)} onChange={(e) => updateField(f.id, { default: e.target.value === "" ? null : e.target.value })} placeholder="default (optional)" className="w-full border px-2 py-1 rounded" />
                    </div>

                    {/* relation controls */}
                    {String(f.type).toLowerCase() === "relation" && (
                      <>
                        <div className="col-span-6 mt-2">
                          <label className="text-xs text-gray-600">Target model</label>
                          <select value={f.relation?.modelId ?? f.relation?.model ?? ""} onChange={(e) => onRelationModelChange(f.id, e.target.value || undefined)} className="w-full border px-2 py-1 rounded">
                            <option value="">Select target model...</option>
                            {(relationSuggestions ?? []).map((s) => (
                              <option key={s.modelId} value={s.modelId}>{s.modelName} — {s.tableName}</option>
                            ))}
                          </select>
                        </div>

                        <div className="col-span-3 mt-2">
                          <label className="text-xs text-gray-600">Target field</label>
                          <select value={f.relation?.field ?? ""} onChange={(e) => onRelationFieldChange(f.id, e.target.value)} className="w-full border px-2 py-1 rounded">
                            <option value="">Select field...</option>
                            {(() => {
                              const sug = (relationSuggestions ?? []).find((s) => s.modelId === f.relation?.modelId);
                              return (sug?.fields ?? []).map((ff) => <option key={ff.name} value={ff.name}>{ff.name}</option>);
                            })()}
                          </select>
                        </div>

                        <div className="col-span-3 mt-2">
                          <label className="text-xs text-gray-600">Relation type</label>
                          <select value={f.relation?.type ?? "many-to-one"} onChange={(e) => onRelationTypeChange(f.id, e.target.value)} className="w-full border px-2 py-1 rounded">
                            {RELATION_TYPES.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
                          </select>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* relation suggestions quick view */}
            <div className="border rounded p-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-medium">Relation Suggestions</h4>
                <div className="text-sm text-gray-500">{relationLoading ? "Loading…" : `${relationSuggestions?.length ?? 0} suggestions`}</div>
              </div>

              {relationLoading ? (
                <p className="text-xs text-gray-600">Loading relation suggestions...</p>
              ) : !relationSuggestions || relationSuggestions.length === 0 ? (
                <p className="text-xs text-gray-600">No suggestions available for relations.</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {relationSuggestions.map((s) => (
                    <div key={s.modelId} className="p-2 border rounded">
                      <div className="font-medium text-sm">{s.modelName} <span className="text-xs text-gray-500">({s.tableName})</span></div>
                      <div className="text-xs text-gray-500">display: {s.displayField ?? "—"} • {s.recordsCount} records</div>
                      <div className="mt-2 text-xs">
                        <div className="font-medium">Sample</div>
                        <ul className="list-disc ml-4">
                          {(s.sampleRecords ?? []).slice(0, 2).map((sr) => <li key={sr.id}>{sr.label ?? sr.id}</li>)}
                        </ul>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Roles & RBAC */}
            <div className="border rounded p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h4 className="font-medium">Roles & RBAC</h4>
                  <p className="text-xs text-gray-500">Add roles and toggle permissions</p>
                </div>
                <div className="flex items-center gap-2">
                  <input value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder="New role" className="border px-2 py-1 rounded text-sm" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRole(); } }} />
                  <button type="button" onClick={addRole} className="px-3 py-1 bg-gray-200 rounded text-sm">Add</button>
                </div>
              </div>

              <div className="space-y-2">
                {roles.map((role) => (
                  <div key={role} className="flex items-center gap-4 justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-28 font-medium">{role}</div>
                      <div className="flex flex-wrap gap-2">
                        {["ALL", "CREATE", "READ", "UPDATE", "DELETE"].map((act) => {
                          const enabled = (rbac[role] ?? []).includes(act);
                          return (
                            <button key={act} type="button" onClick={() => toggleRbacAction(role, act)} className={`px-2 py-1 border rounded text-sm ${enabled ? "bg-blue-600 text-white" : "bg-white text-gray-700"}`}>
                              {act}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      {role !== "Admin" && <button type="button" onClick={() => removeRole(role)} className="text-sm px-2 py-1 border rounded text-red-600">Remove</button>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {error && <div className="text-sm text-red-600">{error}</div>}

            <div className="flex justify-end gap-3 mt-3">
              <button onClick={onClose} className="px-4 py-2 border rounded">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded">{saving ? "Saving..." : "Save changes"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ModelEditModal;
