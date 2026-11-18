"use client";
import { useState } from "react";
import { useTokenMeta } from "@/lib/meta";

// The token's image from its metadata; a deterministic gradient from the mint
// address while loading or when there is none.
export default function TokenAvatar({ seed, uri, src, size = 46 }: { seed: string; uri?: string; src?: string; size?: number }) {
  const meta = useTokenMeta(src ? undefined : uri);
  const image = src || meta?.image;
  const [broken, setBroken] = useState<string | null>(null);
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 70 + (h % 90)) % 360;
  const style = { width: size, height: size, borderRadius: size * 0.3, flexShrink: 0 } as const;
  if (image && broken !== image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image} alt="" style={{ ...style, objectFit: "cover", background: "rgba(255,255,255,.04)" }} onError={() => setBroken(image)} />;
  }
  return <div style={{ ...style, background: `conic-gradient(from ${a}deg, hsl(${a} 90% 60%), hsl(${b} 80% 55%), hsl(${(a + 200) % 360} 60% 40%), hsl(${a} 90% 60%))` }} />;
}
