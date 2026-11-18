"use client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { Buffer } from "buffer";
import { RPC_URL } from "@/lib/solana";

if (typeof window !== "undefined" && !(window as unknown as { Buffer?: unknown }).Buffer) {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

// Wallets that implement the Wallet Standard (Phantom, Solflare, Backpack…) are detected automatically.
export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
