import type { Metadata } from "next";
import AppShell from "@/components/app/AppShell";

export const metadata: Metadata = {
  title: "Patula app — launch and trade on devnet",
  description: "Launch and trade bonding-curve tokens on Solana devnet.",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
