"use client";
import { useState } from "react";

// Image from the token's URI when it is a direct image link; otherwise a
// deterministic gradient generated from the mint address.
export default function TokenAvatar({ seed, uri, size = 46 }: { seed: string; uri?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 70 + (h % 90)) % 360;
  const isImg = !!uri && /^https:\/\/.+\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(uri);
  const style = { width: size, height: size, borderRadius: size * 0.3, flexShrink: 0 } as const;
  if (isImg && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={uri} alt="" style={{ ...style, objectFit: "cover" }} onError={() => setBroken(true)} />;
  }
  return <div style={{ ...style, background: `conic-gradient(from ${a}deg, hsl(${a} 90% 60%), hsl(${b} 80% 55%), hsl(${(a + 200) % 360} 60% 40%), hsl(${a} 90% 60%))` }} />;
}
