import type { TokenMeta } from "@/lib/meta";

const ICONS: Record<string, React.ReactNode> = {
  website: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" /></svg>
  ),
  twitter: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z" /></svg>
  ),
  telegram: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21.4 4.3 18.3 19c-.2 1-.8 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.3.3-.5.5-1 .5l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L6.5 13 2 11.6c-1-.3-1-1 .2-1.5l17.6-6.8c.8-.3 1.5.2 1.6 1z" /></svg>
  ),
  discord: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.3 5.3A16.5 16.5 0 0 0 15.2 4l-.5 1a15 15 0 0 0-5.4 0L8.8 4a16.5 16.5 0 0 0-4.1 1.3C2.1 9.2 1.4 13 1.7 16.7a16.6 16.6 0 0 0 5 2.5l1.1-1.7c-.6-.2-1.2-.5-1.7-.9l.4-.3a11.8 11.8 0 0 0 11 0l.4.3c-.5.4-1.1.7-1.7.9l1.1 1.7a16.6 16.6 0 0 0 5-2.5c.4-4.3-.7-8-3-11.4zM8.7 14.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z" /></svg>
  ),
};

export const LABELS = { website: "Website", twitter: "X", telegram: "Telegram", discord: "Discord" } as const;

export function SocialIcon({ kind }: { kind: keyof typeof LABELS }) {
  return <>{ICONS[kind]}</>;
}

export default function Socials({ links }: { links?: TokenMeta["extensions"] }) {
  const entries = Object.entries(links ?? {}).filter(([k, v]) => v && k in LABELS) as [keyof typeof LABELS, string][];
  if (!entries.length) return null;
  return (
    <div className="socials">
      {entries.map(([k, v]) => (
        <a key={k} href={v} target="_blank" rel="noreferrer nofollow" title={LABELS[k]} aria-label={LABELS[k]}>{ICONS[k]}</a>
      ))}
    </div>
  );
}
