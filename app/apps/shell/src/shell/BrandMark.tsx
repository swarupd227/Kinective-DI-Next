// The Kinective mark: three rising bars and a dot, the shape the DI booklet uses.
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden style={{ flexShrink: 0 }}>
      <rect x="5" y="11" width="5" height="16" rx="2.5" fill="#1d5f9e" />
      <rect x="12.5" y="5" width="5" height="22" rx="2.5" fill="#1c8ea2" />
      <rect x="20" y="9" width="5" height="18" rx="2.5" fill="#4fb3c4" />
      <circle cx="25.5" cy="23.5" r="4" fill="#66b24a" />
    </svg>
  );
}
