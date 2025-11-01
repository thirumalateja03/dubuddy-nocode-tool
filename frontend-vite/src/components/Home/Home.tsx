/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useEffect, useState } from "react";
import axios from "axios";
import SummaryCards from "./SummaryCards";
import ModelTable from "./ModelTable";
import RecentActivity from "./RecentActivity";

interface Stats {
  models: number;
  users: number;
  roles: number;
  records: number;
  published: number;
}

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

interface Log {
  id: string;
  action: string;
  modelName?: string | null;
  recordId?: string | null;
  userId: string;
  createdAt: string;
  details?: any;
}

const Home: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);

  const token = localStorage.getItem("accessToken");

  const api = axios.create({
    baseURL: "http://localhost:3000",
    headers: { Authorization: `Bearer ${token}` },
  });

  const fetchAll = async () => {
    try {
      const [s, m, l] = await Promise.all([
        api.get("/support/stats"),
        api.get("/models/all"),
        api.get("/support/audit?limit=5"),
      ]);

      setStats(s.data.stats);
      setModels(m.data.models);
      setLogs(l.data.logs);
    } catch (err) {
      console.error("Error fetching dashboard data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30000); // auto refresh every 30s
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div className="p-6 text-gray-500">Loading dashboard...</div>;
  }

  return (
    <div className="p-6 space-y-8 bg-gray-50 min-h-screen">
      <SummaryCards stats={stats!} />
      <ModelTable models={models} />
      <RecentActivity logs={logs} />
    </div>
  );
};

export default Home;
