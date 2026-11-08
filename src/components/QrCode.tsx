import QRCode from 'qrcode';
import { AlertTriangle, Copy, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Handoff } from '../data/types';
import { useStore } from '../domain/store';

/** A real, scannable QR generated in the browser (no QR API). */
export function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) QRCode.toCanvas(ref.current, text, { width: size, margin: 1, color: { dark: '#173a29', light: '#ffffff' }, errorCorrectionLevel: 'M' });
  }, [text, size]);
  return (
    <div className="qr-box">
      <canvas ref={ref} width={size} height={size} aria-label={`QR code for ${text}`} role="img" />
    </div>
  );
}

const isLocalHost = () => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);

export function TraceLinkPanel({ handoff, compact }: { handoff: Handoff; compact?: boolean }) {
  const { toast, traceLink, mode } = useStore();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    traceLink(handoff)
      .then((u) => alive && (u ? setUrl(u) : setFailed(true)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff.id, handoff.token]);
  if (failed) return <div className="notice danger small">The trace link could not be issued. You may not have access to this handoff, or the server is unavailable.</div>;
  if (!url) return <div className="muted small">Preparing link…</div>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Demo trace link copied.');
    } catch {
      toast('Could not copy automatically — select the link text instead.', 'warn');
    }
  };
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
      <QrCode text={url} size={compact ? 132 : 168} />
      <div className="stack-sm" style={{ flex: 1, minWidth: 220 }}>
        <div className="tiny muted" style={{ fontWeight: 700 }}>
          LOCAL DEMO TRACE LINK
        </div>
        <code className="link-box">{url}</code>
        <div className="row">
          <button className="btn btn-sm" onClick={copy}>
            <Copy size={14} /> Copy link
          </button>
          <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Open customer view
          </a>
        </div>
        <div className="tiny muted">
          {mode === 'demo'
            ? 'Prototype link only: no production security, expiry or revocation. It opens this same local app; data lives only in the browser that opens it.'
            : 'Customer-safe link: the server returns only approved fields. Treat the link like a key — anyone holding it can view this trace until it is revoked or expires.'}
        </div>
        {isLocalHost() && (
          <div className="tiny" style={{ color: 'var(--amber-ink)', display: 'flex', gap: 6 }}>
            <AlertTriangle size={13} style={{ flex: 'none', marginTop: 2 }} />
            <span>
              This address uses <b>localhost</b>, so a phone cannot reach it. To scan with a phone on the same Wi-Fi, start the app with <code>npm run dev:lan</code> and open the “Network” address it prints.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
