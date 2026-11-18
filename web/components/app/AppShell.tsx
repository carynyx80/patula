"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Providers from "@/components/WalletProvider";
import { Logo } from "@/components/Hero";
import ShieldedProvider from "./ShieldedProvider";
import { IS_MAINNET } from "@/lib/solana";
import ShieldedPanel from "./ShieldedPanel";

const WalletButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

export default function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const tab = (href: string, label: string) => (
    <Link href={href} className={`app-tab ${path === href ? "on" : ""}`}>{label}</Link>
  );
  return (
    <Providers>
      <ShieldedProvider>
      <header className="app-head">
        <div className="wrap app-head-in">
          <Link href="/" className="logo"><Logo /> Patula</Link>
          <nav className="app-tabs">
            {tab("/app", "Explore")}
            {tab("/app/create", "Launch")}
          </nav>
          <div className="app-head-right">
            <span className="net-badge"><span className={`dot ${IS_MAINNET ? "on" : "warn"}`} /> {IS_MAINNET ? "Mainnet" : "Devnet"}</span>
            <ShieldedPanel />
            <WalletButton />
          </div>
        </div>
      </header>
      <main className="app-main wrap">{children}</main>
      <footer className="app-foot wrap">
        {IS_MAINNET ? "Solana mainnet · use at your own risk · see the audit status in the docs." : "Solana devnet · test SOL only · not audited."}
      </footer>
      </ShieldedProvider>
    </Providers>
  );
}
