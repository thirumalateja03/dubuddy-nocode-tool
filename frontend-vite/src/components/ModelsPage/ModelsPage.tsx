/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useEffect, useState } from "react";
import ModelEditModal from "./ModelEditModal";
import ModelViewModal from "./ModelViewModal";
import ModelDeleteModal from "./ModelDeleteModal";

interface Model {
  id: string;
  name: string;
  tableName: string;
  version: number;
  ownerField: string;
  createdAt: string;
  updatedAt: string;
  published: boolean;
  json: Record<string, any>;
}

type FilterOption = "all" | "published";

const ModelsPage: React.FC = () => {
  const [models, setModels] = useState<Model[]>([]);
  const [filteredModels, setFilteredModels] = useState<Model[]>([]);
  const [filter, setFilter] = useState<FilterOption>("all");
  const [loading, setLoading] = useState<boolean>(false);
  const [modal, setModal] = useState<{ open: boolean; type: string; modelId?: string }>({
    open: false,
    type: "",
    modelId: undefined,
  });

  // Fetch all models once on mount
  useEffect(() => {
    const fetchModels = async () => {
      setLoading(true);
      try {
        const token = localStorage.getItem("accessToken");
        const res = await fetch("http://localhost:3000/models/all", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.success) {
          setModels(data.models);
          setFilteredModels(data.models);
        }
      } catch (err) {
        console.error("Failed to fetch models", err);
      } finally {
        setLoading(false);
      }
    };
    fetchModels();
  }, []);

  //  Handle filter change
  useEffect(() => {
    if (filter === "all") setFilteredModels(models);
    else setFilteredModels(models.filter((m) => m.published === true)); // depends on backend later
  }, [filter, models]);

  // Open modal (View/Edit/Create)
  const openModal = (type: string, modelId?: string) => {
    setModal({ open: true, type, modelId });
  };

  // Close modal
  const closeModal = () => setModal({ open: false, type: "", modelId: undefined });

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Models</h1>
        <div className="flex items-center gap-3">
          <select
            className="border px-3 py-2 rounded-md text-sm"
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterOption)}
          >
            <option value="all">All Models</option>
            <option value="published">Published</option>
          </select>
          <button
            onClick={() => openModal("create")}
            className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
          >
            + Create Model
          </button>
        </div>
      </div>

      {/* Models Grid */}
      {loading ? (
        <p>Loading models...</p>
      ) : filteredModels.length === 0 ? (
        <p className="text-gray-500">No models found.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredModels.map((model) => (
            <div
              key={model.id}
              className="border rounded-lg shadow-sm p-4 bg-white hover:shadow-md transition"
            >
              <h2 className="text-lg font-semibold mb-2">{model.name}</h2>
              <p className="text-sm text-gray-600">Table: {model.tableName}</p>
              <p className="text-sm text-gray-600">
                Fields: {model.json.fields?.length ?? 0}
              </p>
              <p className="text-xs text-gray-400 mt-2">
                Created: {new Date(model.createdAt).toLocaleString()}
              </p>

              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => window.open(`/models/${model.name}`, "_blank")}
                  className="border border-gray-300 text-gray-700 px-3 py-1 text-sm rounded hover:bg-gray-100"
                >
                  Open
                </button>
                <button
                  onClick={() => openModal("view", model.id)}
                  className="border border-gray-300 text-gray-700 px-3 py-1 text-sm rounded hover:bg-gray-100"
                >
                  View
                </button>
                <button
                  onClick={() => openModal("edit", model.id)}
                  className="border border-blue-500 text-blue-600 px-3 py-1 text-sm rounded hover:bg-blue-50"
                >
                  Edit
                </button>
                <button
                  onClick={() => openModal("delete", model.id)}
                  className="border border-red-500 text-red-600 px-3 py-1 text-sm rounded hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {modal.open && modal.type === "edit" && modal.modelId && (
        <ModelEditModal
          modelId={modal.modelId}
          onClose={closeModal}
          onSaved={(updated) => {
            // update UI list locally to reflect saved changes
            setModels((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
            // re-apply filter
            setFilteredModels((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
          }}
        />
      )}

      {modal.open && modal.type === "view" && modal.modelId && (
        <ModelViewModal
          modelId={modal.modelId}
          onClose={closeModal}
        />
      )}

      {modal.open && modal.type === "delete" && modal.modelId && (
        <ModelDeleteModal
          modelId={modal.modelId}
          onClose={closeModal}
          onDeleted={(deletedId) => {
            setModels((prev) => prev.filter((m) => m.id !== deletedId));
            setFilteredModels((prev) => prev.filter((m) => m.id !== deletedId));
          }}
        />
      )}
    </div>
  );
};

export default ModelsPage;
