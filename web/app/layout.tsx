import type { Metadata, Viewport } from "next";
import { Inter_Tight, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import SmoothScroll from "@/components/SmoothScroll";

const sans = Inter_Tight({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

const description = "Launch and trade tokens on Solana in public or in private. Anonymous creators, private buyers, rules enforced on-chain.";

export const metadata: Metadata = {
  metadataBase: new URL("https://patula.vercel.app"),
  title: "Patula — the privacy launchpad on Solana",
  description,
  openGraph: { title: "Patula — Launch in the open. Or in the dark.", description, url: "/", siteName: "Patula", type: "website" },
  twitter: { card: "summary_large_image", title: "Patula — Launch in the open. Or in the dark.", description },
};

export const viewport: Viewport = { themeColor: "#0b0710", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>
        <SmoothScroll />
        <div className="grain" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
