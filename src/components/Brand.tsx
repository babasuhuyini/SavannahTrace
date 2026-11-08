// Savannah Trace brand mark and wordmark. Geometry and colours follow docs/BRAND.md:
// a Shea-gold sun over the savannah horizon; below it, the route from origin lot (ivory)
// to destination lot (gold). Keep these values in step with docs/brand/*.svg.
export const BRAND = { name: 'Savannah Trace', owner: 'Savannah Fruits Company Limited' } as const;

export function BrandMark({ size = 26, tile = true }: { size?: number; tile?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" style={{ flex: 'none', display: 'block' }}>
      {tile && <rect width="32" height="32" rx="1.5" fill="#1c4532" />}
      <path d="M7 16a9 9 0 0 1 18 0Z" fill="#d2a24c" />
      <rect x="3.5" y="15.2" width="25" height="1.8" fill="#f6f3eb" />
      <rect x="9" y="21.7" width="14" height="1.4" fill="#f6f3eb" />
      <rect x="4.6" y="20" width="4.8" height="4.8" fill="#f6f3eb" />
      <rect x="22.6" y="20" width="4.8" height="4.8" fill="#d2a24c" />
    </svg>
  );
}

/** "Savannah" SemiBold + "Trace" Regular. `reversed` for dark grounds (Trace in Shea Gold). */
export function Wordmark({ reversed = false, className = '' }: { reversed?: boolean; className?: string }) {
  return (
    <span className={`wordmark${reversed ? ' reversed' : ''}${className ? ' ' + className : ''}`}>
      <span className="wm-a">Savannah</span> <span className="wm-b">Trace</span>
    </span>
  );
}
