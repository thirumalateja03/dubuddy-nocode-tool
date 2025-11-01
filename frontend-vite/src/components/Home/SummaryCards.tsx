import React from "react";

interface StatsProps {
  stats: {
    models: number;
    users: number;
    roles: number;
    records: number;
    published: number;
  };
}

const SummaryCards: React.FC<StatsProps> = ({ stats }) => {
  const items = [
    { label: "Models", value: stats.models },
    { label: "Users", value: stats.users },
    { label: "Roles", value: stats.roles },
    { label: "Records", value: stats.records },
    { label: "Published", value: stats.published },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="bg-white rounded-xl shadow-sm p-4 border border-gray-100 text-center hover:shadow-md transition"
        >
          <div className="text-2xl font-semibold text-indigo-600">
            {item.value}
          </div>
          <div className="text-gray-500 text-sm mt-1">{item.label}</div>
        </div>
      ))}
    </div>
  );
};

export default SummaryCards;
