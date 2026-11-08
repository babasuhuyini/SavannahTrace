import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { captureAuthFragment } from './backend/authFragment';
import { LIVE } from './backend/config';
import { DemoStoreProvider } from './domain/store';
import './styles.css';

// Invitation links return #access_token=… — capture it before the hash router reads it.
if (LIVE) captureAuthFragment();

// Live mode (Supabase) is loaded only when configured, so the demo never ships the client.
const LiveStoreProvider = lazy(() => import('./backend/liveStore').then((m) => ({ default: m.LiveStoreProvider })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {LIVE ? (
      <Suspense fallback={<div className="empty">Connecting…</div>}>
        <LiveStoreProvider>
          <App />
        </LiveStoreProvider>
      </Suspense>
    ) : (
      <DemoStoreProvider>
        <App />
      </DemoStoreProvider>
    )}
  </StrictMode>,
);
