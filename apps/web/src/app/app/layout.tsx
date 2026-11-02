import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";

export default function AccountLayout({ children }: { children: ReactNode }) {
  return <AppShell area="app">{children}</AppShell>;
}
