/* src/components/ModelCreate.tsx */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useAuth } from "../../context/useAuth";

type FieldType = "string" | "number" | "boolean" | "date" | "json" | "string[]" | "relation";

type RelationValue = {
  modelId?: string;
  model?: string;
  field?: string;
  type?: string;
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
  onSaved?: (model: any) => void;
  initialRoles?: string[];
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const TYPE_OPTIONS: FieldType[] = ["string", "number", "boolean", "date", "json", "string[]", "relation"];
const RELATION_TYPES = ["many-to-one", "one-to-many", "one-to-one", "many-to-many"];
const DEFAULT_ROLES = ["Admin", "Manager", "Viewer"];

function uid(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 9);
}

/**
 * parse legacy string relation e.g. "User.id" into structured object
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
      type: rel.type ?? rel.kind ?? "many-to-one",
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


export const ModelCreate: React.FC<Props> = ({ onSaved, initialRoles }) => {
  const { accessToken } = useAuth();
  const rolesStart = initialRoles && initialRoles.length > 0 ? initialRoles : DEFAULT_ROLES;

  // meta
  const [name, setName] = useState("");
  const [tableName, setTableName] = useState("");
  const [ownerField, setOwnerField] = useState("");

  // fields & rbac
  const [fields, setFields] = useState<FieldItem[]>([
    { id: uid("f-"), name: "name", type: "string", required: true, unique: false, default: null, relation: null },
  ]);
  const [roles, setRoles] = useState<string[]>(rolesStart);
  const [rbac, setRbac] = useState<RbacMap>(() =>
    rolesStart.reduce((acc, r) => {
      acc[r] = r === "Admin" ? ["ALL"] : r === "Viewer" ? ["READ"] : ["CREATE", "READ", "UPDATE"];
      return acc;
    }, {} as RbacMap)
  );

  // UI state
  const [newRole, setNewRole] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // relation suggestions
  const [relationSuggestions, setRelationSuggestions] = useState<RelationSuggestion[] | null>(null);
  const [relationLoading, setRelationLoading] = useState<boolean>(false);

  // auth header helper
  const headersWithAuth = useCallback(() => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = accessToken ?? localStorage.getItem("accessToken");
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }, [accessToken]);

  // fetch relation suggestions:
  // 1) try dedicated endpoint /models/relation-suggestions (some backends may provide),
  // 2) fallback to /models/all and synthesize suggestions from model.json fields & default display field
  useEffect(() => {
    let mounted = true;
    const loadSuggestions = async () => {
      setRelationLoading(true);
      try {
        // first attempt - dedicated endpoint (may exist)
        try {
          const r = await axios.get(`${API_BASE}/models/relation-suggestions`, { headers: headersWithAuth() });
          if (!mounted) return;
          if (r.data?.success && Array.isArray(r.data.suggestions)) {
            setRelationSuggestions(r.data.suggestions);
            setRelationLoading(false);
            return;
          }
        } catch {
          // ignore and fallback
        }

        // fallback: call /models/all and create suggestions
        const all = await axios.get(`${API_BASE}/models/all`, { headers: headersWithAuth() });
        if (!mounted) return;
        if (all.data?.success && Array.isArray(all.data.models)) {
          const suggestions: RelationSuggestion[] = (all.data.models as any[]).map((m: any) => {
            const fieldsArr: Array<{ name: string; type: string }> = Array.isArray(m.json?.fields) ? m.json.fields.map((f: any) => ({ name: f.name, type: f.type })) : [];
            if (!fieldsArr.some((x) => x.name === "id")) {
              fieldsArr.unshift({ name: "id", type: "string" });
            }
            const displayField =
              m.json?.fields?.find((f: any) => f.type === "string" && f.name !== "id")?.name ?? "id";
            const sampleRecords = (m.sampleRecords ?? []).slice(0, 2).map((s: any) => ({ id: s.id, label: s.label ?? s.id }));
            return {
              modelId: m.id,
              modelName: m.name ?? m.tableName ?? "Unknown",
              tableName: m.tableName ?? "",
              versionNumber: m.version ?? 1,
              displayField,
              fields: fieldsArr,
              recordsCount: m.recordsCount ?? 0,
              sampleRecords,
            };
          });
          setRelationSuggestions(suggestions);
          setFields((prev) => reconcileFieldsWithSuggestions(prev, suggestions));
        } else {
          setRelationSuggestions([]);
        }
      } catch (err) {
        console.warn("relation-suggestions fallback error", err);
        setRelationSuggestions([]);
      } finally {
        if (mounted) setRelationLoading(false);
      }
    };

    loadSuggestions();
    return () => {
      mounted = false;
    };
  }, [headersWithAuth]);

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

  // roles helpers
  const addRole = useCallback(() => {
    const trimmed = newRole.trim();
    if (!trimmed) {
      setError("Role name cannot be empty");
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
        setError("Cannot remove Admin role");
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

  // relation wiring helpers
  const onRelationModelChange = useCallback((fieldId: string, selectedModelId?: string) => {
    const suggestion = (relationSuggestions ?? []).find((s) => s.modelId === selectedModelId);
    updateField(fieldId, {
      relation: {
        modelId: selectedModelId,
        model: suggestion?.modelName,
        field: suggestion?.displayField ?? suggestion?.fields?.[0]?.name ?? "id",
        type: suggestion ? "many-to-one" : "many-to-one",
      },
    });
  }, [relationSuggestions, updateField]);

  const onRelationFieldChange = useCallback((fieldId: string, targetField: string) => {
    updateField(fieldId, { relation: { ...(fields.find((f) => f.id === fieldId)?.relation ?? {}), field: targetField } });
  }, [fields, updateField]);

  const onRelationTypeChange = useCallback((fieldId: string, relType: string) => {
    updateField(fieldId, { relation: { ...(fields.find((f) => f.id === fieldId)?.relation ?? {}), type: relType } });
  }, [fields, updateField]);

  // validation matching backend hints: required name, unique field names, relation completeness
  const validate = useCallback(() => {
    if (!name.trim()) return "Model name is required";
    const usedTable = (tableName || name).trim();
    if (!usedTable) return "Table name is required (or provide model name)";
    const trimmedNames = fields.map((f) => f.name.trim()).filter(Boolean);
    if (trimmedNames.length !== new Set(trimmedNames).size) return "Field names must be unique and non-empty";

    for (const f of fields) {
      if ((f.type ?? "").toString().toLowerCase() === "relation") {
        const rel = f.relation;
        if (!rel || (!rel.model && !rel.modelId) || !rel.field) {
          return `Relation field '${f.name || "(unnamed)"}' needs a target model and field`;
        }
      }
    }

    // roles uniqueness
    const roleNames = roles.map((r) => r.trim());
    if (roleNames.length !== new Set(roleNames).size) return "Duplicate role names detected";

    return null;
  }, [name, tableName, fields, roles]);

  // build payload (map relation.modelId -> modelName when suggestion available)
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
      name: name.trim(),
      tableName: (tableName && tableName.trim()) || (name ? name.trim().toLowerCase() + "s" : ""),
      ownerField: ownerField?.trim() || undefined,
      json: {
        fields: payloadFields,
        rbac,
      },
    };
  }, [fields, rbac, tableName, ownerField, name, relationSuggestions]);

  // submit
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setError(null);
      const v = validate();
      if (v) {
        setError(v);
        return;
      }
      const payload = buildPayload();
      setSubmitting(true);
      try {
        const res = await axios.post(`${API_BASE}/models/create`, payload, { headers: headersWithAuth() });
        if (res.data?.success) {
          onSaved?.(res.data.model);
          // reset minimal form
          setName("");
          setTableName("");
          setOwnerField("");
          setFields([{ id: uid("f-"), name: "name", type: "string", required: true, unique: false, default: null, relation: null }]);
          // keep roles/rbac for convenience
        } else {
          setError(res.data?.message ?? "Create failed");
        }
      } catch (err: any) {
        console.error("create model error", err);
        setError(err?.response?.data?.message ?? err?.message ?? "Network error");
      } finally {
        setSubmitting(false);
      }
    },
    [validate, buildPayload, headersWithAuth, onSaved]
  );

  // preview payload memoized for performance
  const payloadPreview = useMemo(() => buildPayload(), [buildPayload]);

  const hasAnyFields = fields.length > 0;
  const submitDisabled = submitting;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <h2 className="text-xl font-semibold">Create Model</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium">Model Name *</label>
            <input
              className="mt-1 w-full border px-3 py-2 rounded"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Employee"
            />
            <p className="text-xs text-gray-500 mt-1">Unique model name (PascalCase recommended).</p>
          </div>

          <div>
            <label className="block text-sm font-medium">Table Name</label>
            <input
              className="mt-1 w-full border px-3 py-2 rounded"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder="employees (defaults to name + s)"
            />
            <p className="text-xs text-gray-500 mt-1">Optional. Defaults to lowercase plural of name.</p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium">Owner Field</label>
          <input
            className="mt-1 w-full border px-3 py-2 rounded"
            value={ownerField}
            onChange={(e) => setOwnerField(e.target.value)}
            placeholder="ownerId (optional)"
          />
          <p className="text-xs text-gray-500 mt-1">Optional. Used for ownership enforcement in RBAC.</p>
        </div>

        {/* Fields editor */}
        <div className="border rounded p-3">
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-medium">Fields</h3>
            <button type="button" onClick={addField} className="text-sm bg-green-600 text-white px-3 py-1 rounded">
              + Add field
            </button>
          </div>

          {!hasAnyFields && <p className="text-sm text-gray-500">No fields added yet.</p>}

          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.id} className="grid grid-cols-12 gap-2 items-start border rounded p-3">
                <div className="col-span-3">
                  <input
                    value={f.name}
                    onChange={(e) => updateField(f.id, { name: e.target.value })}
                    placeholder="field name"
                    className="w-full border px-2 py-1 rounded"
                  />
                </div>

                <div className="col-span-2">
                  <select
                    value={f.type}
                    onChange={(e) =>
                      updateField(f.id, {
                        type: e.target.value as FieldType,
                        relation: e.target.value === "relation" ? parseRelationInput(f.relation) : null,
                      })
                    }
                    className="w-full border px-2 py-1 rounded"
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
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
                  <button type="button" onClick={() => removeField(f.id)} className="text-sm text-red-600 border px-2 py-1 rounded">
                    Remove
                  </button>
                </div>

                <div className="col-span-6 mt-2">
                  <input
                    value={f.default === null || f.default === undefined ? "" : String(f.default)}
                    onChange={(e) => updateField(f.id, { default: e.target.value === "" ? null : e.target.value })}
                    placeholder="default (optional)"
                    className="w-full border px-2 py-1 rounded"
                  />
                </div>

                {/* relation controls */}
                {String(f.type).toLowerCase() === "relation" && (
                  <>
                    <div className="col-span-6 mt-2">
                      <label className="text-xs text-gray-600">Target model</label>
                      <select
                        value={f.relation?.modelId ?? f.relation?.model ?? ""}
                        onChange={(e) => onRelationModelChange(f.id, e.target.value || undefined)}
                        className="w-full border px-2 py-1 rounded"
                      >
                        <option value="">Select target model...</option>
                        {(relationSuggestions ?? []).map((s) => (
                          <option key={s.modelId} value={s.modelId}>
                            {s.modelName} — {s.tableName}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="col-span-3 mt-2">
                      <label className="text-xs text-gray-600">Target field</label>
                      <select
                        value={f.relation?.field ?? ""}
                        onChange={(e) => onRelationFieldChange(f.id, e.target.value)}
                        className="w-full border px-2 py-1 rounded"
                      >
                        <option value="">Select field...</option>
                        {(() => {
                          const sug = (relationSuggestions ?? []).find((s) => s.modelId === f.relation?.modelId);
                          return (sug?.fields ?? []).map((ff) => (
                            <option key={ff.name} value={ff.name}>
                              {ff.name}
                            </option>
                          ));
                        })()}
                      </select>
                    </div>

                    <div className="col-span-3 mt-2">
                      <label className="text-xs text-gray-600">Relation type</label>
                      <select
                        value={f.relation?.type ?? "many-to-one"}
                        onChange={(e) => onRelationTypeChange(f.id, e.target.value)}
                        className="w-full border px-2 py-1 rounded"
                      >
                        {RELATION_TYPES.map((rt) => (
                          <option key={rt} value={rt}>
                            {rt}
                          </option>
                        ))}
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
                  <div className="font-medium text-sm">
                    {s.modelName} <span className="text-xs text-gray-500">({s.tableName})</span>
                  </div>
                  <div className="text-xs text-gray-500">display: {s.displayField ?? "—"} • {s.recordsCount} records</div>
                  <div className="mt-2 text-xs">
                    <div className="font-medium">Sample</div>
                    <ul className="list-disc ml-4">
                      {(s.sampleRecords ?? []).slice(0, 2).map((sr) => (
                        <li key={sr.id}>{sr.label ?? sr.id}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RBAC + roles */}
        <div className="border rounded p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium mb-1">Roles & RBAC</h3>
              <p className="text-xs text-gray-500">Add/remove roles and toggle their permissions.</p>
            </div>

            <div className="flex items-center gap-2">
              <input
                className="border px-2 py-1 rounded text-sm"
                placeholder="New role"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRole();
                  }
                }}
              />
              <button type="button" onClick={addRole} className="px-3 py-1 bg-gray-200 rounded text-sm">
                Add
              </button>
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
                        <button
                          key={act}
                          type="button"
                          onClick={() => toggleRbacAction(role, act)}
                          className={`px-2 py-1 border rounded text-sm ${enabled ? "bg-blue-600 text-white" : "bg-white text-gray-700"}`}
                        >
                          {act}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>{role !== "Admin" && <button type="button" onClick={() => removeRole(role)} className="text-sm px-2 py-1 border rounded text-red-600">Remove</button>}</div>
              </div>
            ))}
          </div>
        </div>

        {error && <div className="text-sm text-red-600">{error}</div>}

        <div className="flex gap-3">
          <button type="submit" disabled={submitDisabled} onClick={handleSubmit} className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-60">
            {submitting ? "Saving..." : "Save model"}
          </button>

          <button
            type="button"
            onClick={() => {
              setName("");
              setTableName("");
              setOwnerField("");
              setFields([{ id: uid("f-"), name: "name", type: "string", required: true, unique: false, default: null, relation: null }]);
              setRoles(DEFAULT_ROLES);
              setRbac(
                DEFAULT_ROLES.reduce((acc, r) => {
                  acc[r] = r === "Admin" ? ["ALL"] : r === "Viewer" ? ["READ"] : ["CREATE", "READ", "UPDATE"];
                  return acc;
                }, {} as RbacMap)
              );
              setError(null);
            }}
            className="bg-gray-200 text-gray-800 px-4 py-2 rounded"
          >
            Reset
          </button>
        </div>
      </form>

      <div className="mt-4 border rounded p-3 bg-gray-50">
        <h4 className="font-medium mb-2">Payload preview</h4>
        <pre className="text-xs max-h-64 overflow-auto">{JSON.stringify(payloadPreview, null, 2)}</pre>
      </div>
    </div>
  );
};

export default ModelCreate;
