export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

export type Health = {
  ok: boolean;
  cluster: string;
  programId: string;
  programDeployed: boolean;
  relayer: string;
  relayerBalanceSol: number;
};

export type Stats = {
  phase0: { tx: string; proveMs: number; computeUnits: number; txBytes: number }[];
  constraints: number;
  testsPassed: number;
  testsTotal: number;
  pool: { deposits: number; root: string } | null;
};

export async function getJSON<T>(path: string): Promise<T | null> {
  if (!API_URL) return null;
  try {
    const r = await fetch(API_URL + path, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
