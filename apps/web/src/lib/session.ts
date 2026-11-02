"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminRole, KycStatus, UserType } from "@tradechainx/shared";
import { api, ApiError } from "./api";

export type Profile = {
  id: string;
  email: string;
  userType: UserType | null;
  displayName: string | null;
  orgName: string | null;
  walletAddress: string | null;
  adminRoles: AdminRole[];
  kyc: { status: KycStatus; track: "individual" | "business" | null; message: string | null };
  identity: { tier: number; validUntil: number; active: boolean } | null;
};

export function useSession() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return (await api<{ user: Profile }>("/me")).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 30_000,
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return async () => {
    await api("/auth/logout", { method: "POST", body: {} });
    qc.setQueryData(["me"], null);
    qc.clear();
  };
}

export function hasRole(user: Profile | null | undefined, ...roles: AdminRole[]) {
  if (!user) return false;
  return user.adminRoles.includes("super_admin") || roles.some((r) => user.adminRoles.includes(r));
}

export const isAdmin = (user: Profile | null | undefined) => !!user && user.adminRoles.length > 0;
