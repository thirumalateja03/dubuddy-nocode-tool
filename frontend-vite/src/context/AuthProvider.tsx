/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-explicit-any */
// src/context/AuthProvider.tsx
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import axios from "axios";
import type { AxiosInstance, AxiosRequestConfig, AxiosError } from "axios";
import { AuthContext } from "./AuthContext";
import type { UserShape, ModelPerm } from "./AuthContext";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserShape | null>(() => {
    try {
      const raw = localStorage.getItem("user");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [accessToken, setAccessToken] = useState<string | null>(() => localStorage.getItem("accessToken"));
  const [loading, setLoading] = useState<boolean>(true);

  const [systemPermissions, setSystemPermissions] = useState<string[]>([]);
  const [modelPermissions, setModelPermissions] = useState<ModelPerm[]>([]);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);

  // Stable axios instance in a ref
  const apiRef = useRef<AxiosInstance | null>(null);
  if (!apiRef.current) {
    apiRef.current = axios.create({
      baseURL: API_BASE,
      withCredentials: true, // important so refresh cookie is sent
    });
  }

  // Keep defaults Authorization header in sync with accessToken
  useEffect(() => {
    if (!apiRef.current) return;
    if (accessToken) (apiRef.current.defaults.headers as any).Authorization = `Bearer ${accessToken}`;
    else delete (apiRef.current.defaults.headers as any).Authorization;
  }, [accessToken]);

  const api = useCallback(() => {
    if (!apiRef.current) throw new Error("API not initialized");
    return apiRef.current;
  }, []);

  // ------------- Refresh queue / single-refresh logic -------------
  const isRefreshingRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);
  const refreshSubscribersRef = useRef<Array<(token: string | null) => void>>([]);

  const subscribeToken = (cb: (token: string | null) => void) => {
    refreshSubscribersRef.current.push(cb);
  };
  const notifySubscribers = (token: string | null) => {
    refreshSubscribersRef.current.forEach((cb) => cb(token));
    refreshSubscribersRef.current = [];
  };

  // Internal refresh that returns a promise resolving to the new accessToken (or null on failure)
  const doRefresh = useCallback(async (): Promise<string | null> => {
    if (isRefreshingRef.current && refreshPromiseRef.current) return refreshPromiseRef.current;

    isRefreshingRef.current = true;
    const p = (async () => {
      try {
        // POST /auth/token with empty body or useCookie true — backend accepts cookie-based refresh.
        const res = await api().post("/auth/token", { useCookie: true });
        const at: string | undefined = res?.data?.accessToken;
        if (at) {
          setAccessToken(at);
          localStorage.setItem("accessToken", at);
          // update instance default header immediately
          (api().defaults.headers as any).Authorization = `Bearer ${at}`;
          return at;
        }
        return null;
      } catch (err) {
        // refresh failed
        return null;
      } finally {
        isRefreshingRef.current = false;
        refreshPromiseRef.current = null;
      }
    })();

    refreshPromiseRef.current = p;
    const token = await p;
    notifySubscribers(token);
    return token;
  }, [api]);

  // Response interceptor: automatically try refresh on 401 and retry request once
  useEffect(() => {
    const instance = apiRef.current;
    if (!instance) return;

    const onResponseError = async (error: AxiosError) => {
      const originalRequest = (error.config ?? {}) as AxiosRequestConfig & { _retry?: boolean };

      // If there's no response or not a 401, forward
      if (!error.response || error.response.status !== 401) return Promise.reject(error);

      // Prevent infinite loop: if already retried, fail
      if (originalRequest._retry) return Promise.reject(error);
      originalRequest._retry = true;

      try {
        // If a refresh is already happening, wait for it
        if (isRefreshingRef.current) {
          const token = await new Promise<string | null>((resolve) => {
            subscribeToken(resolve);
          });
          if (!token) {
            // refresh failed
            throw error;
          }
          // set new header and retry original request
          originalRequest.headers = originalRequest.headers || {};
          (originalRequest.headers as any).Authorization = `Bearer ${token}`;
          return instance(originalRequest);
        }

        // No refresh in progress -> perform refresh
        const token = await doRefresh();
        if (!token) {
          // refresh failed -> force logout (user must login again)
          // clear local state here to be safe
          setUser(null);
          setAccessToken(null);
          localStorage.removeItem("accessToken");
          localStorage.removeItem("user");
          // optional: redirect to login
          window.location.href = "/login";
          return Promise.reject(error);
        }

        // retry original request with new token
        originalRequest.headers = originalRequest.headers || {};
        (originalRequest.headers as any).Authorization = `Bearer ${token}`;
        return instance(originalRequest);
      } catch (e) {
        // final failure
        return Promise.reject(e);
      }
    };

    const interceptorId = instance.interceptors.response.use((r) => r, onResponseError);
    return () => {
      instance.interceptors.response.eject(interceptorId);
    };
  }, [doRefresh]);

  // ------------- proactive refresh scheduling (optional, helpful) -------------
  const refreshTimerRef = useRef<number | null>(null);
  const scheduleProactiveRefresh = useCallback(
    (token?: string | null) => {
      // clear existing
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      const t = token ?? accessToken;
      if (!t) return;
      try {
        // decode token payload (simple base64 decode, no library)
        const payload = t.split(".")[1];
        if (!payload) return;
        const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
        const exp = typeof json.exp === "number" ? json.exp : null;
        if (!exp) return;
        const nowSec = Math.floor(Date.now() / 1000);
        // schedule 60 seconds before expiry, minimum of 10s from now
        const refreshAtMs = Math.max(10000, (exp - nowSec - 60) * 1000);
        // setTimeout returns number in browser
        refreshTimerRef.current = window.setTimeout(() => {
          // call doRefresh but ignore result (it will update token and notify subscribers)
          doRefresh().catch(() => {
            // fail silently; interceptor will handle subsequent 401s
          });
        }, refreshAtMs);
      } catch {
        // ignore parse errors
      }
    },
    [accessToken, doRefresh]
  );

  // call schedule when accessToken changes
  useEffect(() => {
    scheduleProactiveRefresh(accessToken);
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [accessToken, scheduleProactiveRefresh]);

  // ---------- fetchPermissions (pure; uses apiRef via api()) ----------
  const fetchPermissions = useCallback(
    async (userId?: string) => {
      const uid = userId;
      if (!uid) return;
      setLoading(true);
      try {
        const mergedRes = await api().get(`/rbac/grant/user/merged?userId=${encodeURIComponent(uid)}`);
        const mergedRows: Array<{ key: string; granted: boolean }> = Array.isArray(mergedRes.data.permissions)
          ? mergedRes.data.permissions
          : mergedRes.data.permissions ?? [];
        const grantedKeys = mergedRows.filter((p) => p.granted).map((p) => String(p.key).toUpperCase());
        setSystemPermissions(grantedKeys);

        const modelsRes = await api().get(`/models/all?onlyPublished=true`);
        const modelRows = (modelsRes.data.models ?? []).map((m: any) => ({ id: m.id, name: m.name }));
        setModels(modelRows);

        const perms: ModelPerm[] = [];
        const isAdmin = user?.role === "Admin";
        const canManageModels = grantedKeys.includes("MANAGE_MODELS") || isAdmin;

        if (canManageModels) {
          for (const m of modelRows) {
            try {
              const mres = await api().get(`/rbac/models/permissions?modelName=${encodeURIComponent(m.name)}`);
              const rows: any[] = mres.data.permissions ?? [];
              for (const r of rows) {
                const key = (r.permission?.key ?? "").toString();
                const action = key.split(".")[1]?.toUpperCase() ?? "";
                if (!action) continue;
                const allowed = Boolean(r.allowed ?? true);
                perms.push({ model: m.name, action, allowed });
              }
            } catch (err) {
              console.warn("fetch model permissions failed for", m.name, err);
            }
          }
        } else {
          const actions = ["CREATE", "READ", "UPDATE", "DELETE"].filter((a) =>
            grantedKeys.includes(`MODEL.${a}`)
          );
          for (const m of modelRows) {
            for (const a of actions) perms.push({ model: m.name, action: a, allowed: true });
          }
        }

        setModelPermissions(perms);
      } catch (err) {
        console.error("fetchPermissions error", err);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // ---------- auth actions ----------
  const login = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      try {
        const { data } = await api().post("/auth/token", { email, password, useCookie: true });
        const at: string | undefined = data?.accessToken;
        const u = data?.user ?? null;

        if (at) {
          setAccessToken(at);
          localStorage.setItem("accessToken", at);
          (api().defaults.headers as any).Authorization = `Bearer ${at}`;
        }

        if (u) {
          if ((u as any).roleName && !u.role) (u as any).role = (u as any).roleName;
          setUser(u);
          localStorage.setItem("user", JSON.stringify(u));
          await fetchPermissions(u.id);
        } else {
          try {
            const me = await api().get("/auth/me");
            const mu = me.data.user;
            if (mu) {
              if ((mu as any).roleName && !mu.role) (mu as any).role = (mu as any).roleName;
              setUser(mu);
              localStorage.setItem("user", JSON.stringify(mu));
              await fetchPermissions(mu.id);
            }
          } catch {
            // pass
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [fetchPermissions]
  );

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      // call backend logout to revoke refresh cookie/token
      await api().post("/auth/logout", {});
    } catch (err) {
      console.warn("logout error", err);
    } finally {
      setUser(null);
      setAccessToken(null);
      setSystemPermissions([]);
      setModelPermissions([]);
      setModels([]);
      localStorage.removeItem("accessToken");
      localStorage.removeItem("user");
      setLoading(false);
      window.location.href = "/login";
    }
  }, []);

  // refresh wrapper exposed to consumers (uses cookie)
  const refresh = useCallback(async (): Promise<boolean> => {
    const token = await doRefresh();
    return !!token;
  }, [doRefresh]);

  // ---------- sync helpers ----------
  const can = useCallback(
    (featureKey: string) => {
      if (!featureKey) return false;
      const k = featureKey.toUpperCase();
      if (user?.role === "Admin") return true;
      return systemPermissions.includes(k);
    },
    [systemPermissions, user?.role]
  );

  const canModel = useCallback(
    (model: string, action: string) => {
      if (!model || !action) return false;
      const act = action.toUpperCase();
      if (user?.role === "Admin") return true;
      const found = modelPermissions.find((p) => p.model === model && (p.action?.toUpperCase() ?? "") === act && p.allowed);
      if (found) return true;
      if (systemPermissions.includes(`MODEL.${act}`)) return true;
      return false;
    },
    [modelPermissions, systemPermissions, user?.role]
  );

  // ---------- restore session on mount (StrictMode safe) ----------
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    (async () => {
      try {
        const token = localStorage.getItem("accessToken");
        const userStr = localStorage.getItem("user");

        if (token && userStr) {
          setAccessToken(token);
          const u: UserShape = JSON.parse(userStr);
          if ((u as any).roleName && !u.role) (u as any).role = (u as any).roleName;
          setUser(u);
          await fetchPermissions(u.id);
          return;
        }

        const ok = await doRefresh();
        if (ok) {
          try {
            const me = await api().get("/auth/me");
            const mu = me.data.user;
            if (mu) {
              if ((mu as any).roleName && !mu.role) (mu as any).role = (mu as any).roleName;
              setUser(mu);
              localStorage.setItem("user", JSON.stringify(mu));
              await fetchPermissions(mu.id);
              return;
            }
          } catch {
            const local = localStorage.getItem("user");
            if (local) {
              try {
                const u2 = JSON.parse(local);
                if (u2?.id) {
                  setUser(u2);
                  await fetchPermissions(u2.id);
                  return;
                }
              } catch {
                // ignore
              }
            }
          }
        }
      } catch (err) {
        console.warn("session restore failed", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchPermissions, doRefresh]);

  // ---------- provider value ----------
  const value = useMemo(
    () => ({
      user,
      accessToken,
      loading,
      systemPermissions,
      modelPermissions,
      models,
      login,
      logout,
      refresh,
      fetchPermissions,
      can,
      canModel,
      // expose api() if you want components to use the same instance:
      apiInstance: api, // <--- optional: use authContext.apiInstance() in components
    }),
    [user, accessToken, loading, systemPermissions, modelPermissions, models, login, logout, refresh, fetchPermissions, can, canModel, api]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
