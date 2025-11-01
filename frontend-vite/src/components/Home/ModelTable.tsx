/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";

interface Model {
  id: string;
  name: string;
  tableName: string;
  version: number;
  ownerField: string;
  createdAt: string;
  updatedAt: string;
  json: any;
}

interface Props {
  models: Model[];
}

const ModelTable: React.FC<Props> = ({ models }) => {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <h2 className="text-lg font-semibold mb-4">Models</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left text-gray-700">
          <thead className="border-b text-gray-600 bg-gray-50">
            <tr>
              <th className="py-2 px-3">Name</th>
              <th className="py-2 px-3">Table</th>
              <th className="py-2 px-3">Version</th>
              <th className="py-2 px-3">Owner Field</th>
              <th className="py-2 px-3">Roles</th>
              <th className="py-2 px-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr
                key={m.id}
                className="border-b last:border-none hover:bg-gray-50 transition"
              >
                <td className="py-2 px-3 font-medium">{m.name}</td>
                <td className="py-2 px-3">{m.tableName}</td>
                <td className="py-2 px-3">{m.version}</td>
                <td className="py-2 px-3">{m.ownerField}</td>
                <td className="py-2 px-3">
                  {Object.keys(m.json?.rbac || {}).join(", ")}
                </td>
                <td className="py-2 px-3 text-gray-500">
                  {new Date(m.updatedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ModelTable;
