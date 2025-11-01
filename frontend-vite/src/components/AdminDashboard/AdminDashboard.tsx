import React, { useState } from "react";
import { LogOut, Settings, LayoutDashboard, Users, Shield } from "lucide-react";
import Home from "../Home/Home";
import ModelsPage from "../ModelsPage/ModelsPage";
import ModelCreate from "../ModelsPage/ModelCreate";

interface MenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

const menuItems: MenuItem[] = [
  { key: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { key: "models", label: "Models", icon: <Users size={18} /> },
  { key: "modelCreate", label: "Create Model", icon: <Shield size={18} /> },
  { key: "debuger", label: "Debugger", icon: <Shield size={18} /> },
];

export const AdminDashboard: React.FC = () => {
  const [selected, setSelected] = useState<string>("dashboard");

  const renderContent = () => {
    switch (selected) {
      case "models":
        return <div className="p-6">
          <ModelsPage />
        </div>;
      case "modelCreate":
        return <div className="p-6">
            <ModelCreate />
        </div>;
      default:
        return <div className="p-6">
            <Home />
        </div>;
    }
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 bg-white shadow-md flex flex-col justify-between">
        <div>
          <div className="px-6 py-4 text-lg font-semibold border-b">Admin Panel</div>

          <nav className="mt-4">
            {menuItems.map((item) => (
              <button
                key={item.key}
                onClick={() => setSelected(item.key)}
                className={`w-full flex items-center gap-3 px-6 py-3 text-left text-sm font-medium transition 
                  ${
                    selected === item.key
                      ? "bg-blue-100 text-blue-700"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Bottom Settings + Logout */}
        <div className="border-t">
          <button
            onClick={() => alert("Open Settings")}
            className="w-full flex items-center gap-3 px-6 py-3 text-left text-gray-600 hover:bg-gray-100"
          >
            <Settings size={18} />
            Settings
          </button>
          <button
            onClick={() => alert("Logging out...")}
            className="w-full flex items-center gap-3 px-6 py-3 text-left text-red-600 hover:bg-red-50"
          >
            <LogOut size={18} />
            Logout
          </button>
        </div>
      </aside>

      {/* Main Section */}
      <div className="flex-1 flex flex-col">
        {/* Top Navbar */}
        <header className="h-14 bg-white shadow-sm flex items-center justify-between px-6">
          <h1 className="text-lg font-semibold capitalize">{selected.replace("-", " ")}</h1>
          <div className="text-sm text-gray-500">Admin</div>
        </header>

        {/* Dynamic content */}
        <main className="flex-1 overflow-y-auto">{renderContent()}</main>
      </div>
    </div>
  );
};

export default AdminDashboard;
