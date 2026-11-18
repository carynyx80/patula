"use client";
// Token metadata: fetch + cache the JSON a token's URI points to, and prepare
// images (crop/resize in the browser) before upload.
import { useEffect, useState } from "react";
import { API_URL } from "./api";

export type TokenMeta = {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  banner?: string;
  extensions?: { website?: string; twitter?: string; telegram?: string; discord?: string };
};

const cache = new Map<string, Promise<TokenMeta | null>>();
const DIRECT_IMAGE = /^https:\/\/.+\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i;

export function fetchMeta(uri?: string): Promise<TokenMeta | null> {
  if (!uri || !/^https?:\/\//.test(uri)) return Promise.resolve(null);
  if (DIRECT_IMAGE.test(uri)) return Promise.resolve({ image: uri });
  if (!cache.has(uri)) {
    cache.set(uri, fetch(uri).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cache.get(uri)!;
}

export function useTokenMeta(uri?: string) {
  const [meta, setMeta] = useState<TokenMeta | null>(null);
  useEffect(() => {
    let live = true;
    fetchMeta(uri).then((m) => live && setMeta(m));
    return () => { live = false; };
  }, [uri]);
  return meta;
}

/** Crop to the target aspect (cover) and re-encode as WebP. GIFs pass through unchanged to keep animation. */
export async function prepareImage(file: File, w: number, h: number, maxBytes: number): Promise<string> {
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) throw new Error("Use a PNG, JPG, GIF or WebP image.");
  if (file.type === "image/gif") {
    if (file.size > maxBytes) throw new Error(`GIF too large (max ${Math.round(maxBytes / 1024)} KB).`);
    return readDataUrl(file);
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.max(w / bmp.width, h / bmp.height);
  const sw = w / scale, sh = h / scale;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
  for (const q of [0.92, 0.85, 0.75, 0.6]) {
    const url = canvas.toDataURL("image/webp", q);
    if (url.startsWith("data:image/webp") && (url.length * 3) / 4 <= maxBytes) return url;
  }
  const png = canvas.toDataURL("image/png");
  if ((png.length * 3) / 4 > maxBytes) throw new Error("Image too large after resizing.");
  return png;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("could not read file"));
    r.readAsDataURL(file);
  });
}

export type MetaInput = {
  name: string; symbol: string; description: string; image: string; banner?: string;
  website?: string; twitter?: string; telegram?: string; discord?: string;
};

export async function uploadMeta(input: MetaInput): Promise<{ uri: string; image: string }> {
  const r = await fetch(API_URL + "/metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `upload failed (${r.status})`);
  return j;
}

// ---- link helpers (same rules as the relayer) ----

export function normalizeLink(kind: "website" | "twitter" | "telegram" | "discord", v: string): { value?: string; error?: string } {
  const s = v.trim();
  if (!s) return {};
  if (kind === "twitter") {
    const h = s.replace(/^@/, "");
    if (/^[A-Za-z0-9_]{1,15}$/.test(h)) return { value: `https://x.com/${h}` };
  }
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return { error: "Not a valid link" }; }
  const hosts = { website: null, twitter: ["x.com", "twitter.com"], telegram: ["t.me", "telegram.me"], discord: ["discord.gg", "discord.com"] }[kind];
  if (hosts && !hosts.some((x) => u.hostname === x || u.hostname.endsWith("." + x))) return { error: `Use a ${hosts[0]} link` };
  return { value: u.toString() };
}
