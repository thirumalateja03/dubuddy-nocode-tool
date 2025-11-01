/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";

interface Log {
  id: string;
  action: string;
  modelName?: string | null;
  recordId?: string | null;
  userId: string;
  createdAt: string;
  details?: any;
}

interface Props {
  logs: Log[];
}

const RecentActivity: React.FC<Props> = ({ logs }) => {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <h2 className="text-lg font-semibold mb-4">Recent Activity</h2>
      {logs.length === 0 ? (
        <p className="text-gray-500 text-sm">No recent actions.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {logs.map((log) => (
            <li key={log.id} className="py-3 flex items-center justify-between">
              <div>
                <p className="text-gray-800 font-medium">
                  {log.action}{" "}
                  {log.modelName && (
                    <span className="text-gray-600">on {log.modelName}</span>
                  )}
                </p>
                <p className="text-xs text-gray-500">
                  User: {log.userId?.slice(0,5)} •{" "}
                  {new Date(log.createdAt).toLocaleString()}
                </p>
              </div>
              <span className="text-xs text-gray-400">
                {log.details?.ip ? "via IP hidden" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default RecentActivity;
