// src/context/AuthContext.ts
import { createContext } from "react";

/**
 * Keep this shape in sync with your backend /auth/token user payload
 * and /utils/types if you maintain that file.
 */
export type UserShape = {
  id: string;
  email: string;
  name?: string | null;
  // backend sometimes sends role or roleName — normalize to `role`
  role?: string | null;
  roleId?: string | null;
};

export type ModelPerm = { model: string; action: string; allowed: boolean };

export type AuthContextProps = {
  user: UserShape | null;
  accessToken: string | null;
  loading: boolean;

  // system-level keys (FEATURE keys, plus MODEL.CREATE etc.)
  systemPermissions: string[];

  // flattened model-level permissions for quick checks (model/action rows)
  modelPermissions: ModelPerm[];

  // list of published models for UI rendering
  models: Array<{ id: string; name: string }>;

  // actions
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
  fetchPermissions: (userId?: string) => Promise<void>;

  // checks
  can: (featureKey: string) => boolean;
  canModel: (model: string, action: string) => boolean;
};

export const AuthContext = createContext<AuthContextProps | undefined>(undefined);
