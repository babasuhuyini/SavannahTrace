// Bulk upload: template → file (CSV or Excel) → row-by-row review → import.
// Nothing is saved until "Import" is pressed. Rows with errors are never sent; they can be
// downloaded, fixed and uploaded again. Event uploads are idempotent: uploading the same
// file twice does not create duplicates.
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, RotateCcw, Upload, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { MAX_FILE_BYTES, readTableFile, type Sheet } from '../domain/import/table';
import { SPECS, mapSheet, templateFor, type Ctx, type Entry, type ImportKind, type Mapped } from '../domain/import/specs';
import { downloadCsv } from '../domain/reports';
import { useStore } from '../domain/store';
import type { BulkOutcome, MasterImport } from '../domain/storeTypes';

type Phase = 'pick' | 'review' | 'importing' | 'done';
const today = () => new Date().toISOString().slice(0, 10);

export function BulkImport({ kinds, initial, onDone }: { kinds: ImportKind[]; initial?: ImportKind; onDone?: () => void }) {
  const store = useStore();
  const [kind, setKind] = useState<ImportKind>(initial && kinds.includes(initial) ? initial : kinds[0]);
  const spec = SPECS[kind];
  const [options, setOptions] = useState<Record<string, boolean>>({});
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mapped, setMapped] = useState<Mapped | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [phase, setPhase] = useState<Phase>('pick');
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [outcomes, setOutcomes] = useState<Map<string, BulkOutcome>>(new Map());
  const [masterDone, setMasterDone] = useState<{ ok: boolean; count?: number; error?: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const input = useRef<HTMLInputElement>(null);

  const ctx = (name = fileName, opts = options): Ctx => ({ db: store.db, analysis: store.analysis, viewer: store.viewer, role: store.role, mode: store.mode, fileName: name, options: opts });

  const reset = () => {
    setFileName('');
    setSheets([]);
    setMapped(null);
    setEntries([]);
    setPhase('pick');
    setError('');
    setOutcomes(new Map());
    setMasterDone(null);
    setFilter('all');
    if (input.current) input.current.value = '';
  };

  async function analyse(sheet: Sheet, name: string, k: ImportKind, opts: Record<string, boolean>) {
    const m = mapSheet(sheet.rows, SPECS[k]);
    setMapped(m);
    setEntries([]);
    if (m.missing.length || !m.rows.length) {
      setPhase('review');
      return;
    }
    setEntries(await SPECS[k].prepare(m.rows, ctx(name, opts)));
    setPhase('review');
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    reset();
    setFileName(f.name);
    try {
      const s = await readTableFile(f);
      if (!s.length) throw new Error('The file has no sheets.');
      setSheets(s);
      // pick the first sheet that has data
      const idx = Math.max(0, s.findIndex((x) => x.rows.length > 1));
      setSheetIdx(idx);
      await analyse(s[idx], f.name, kind, options);
    } catch (e) {
      setError((e as Error).message);
      setPhase('pick');
    }
  }

  const ready = entries.filter((e) => !e.errors.length && !e.duplicate && (e.master || e.bulk));
  const problems = entries.filter((e) => e.errors.length);
  const warned = ready.filter((e) => e.warnings.length);
  const dups = entries.filter((e) => e.duplicate);
  const shown = useMemo(() => (filter === 'problems' ? entries.filter((e) => e.errors.length || e.warnings.length || outcomes.get(e.bulk?.key ?? '')?.ok === false) : entries), [entries, filter, outcomes]);

  async function doImport() {
    setPhase('importing');
    if (spec.group === 'master') {
      const r = await store.importMaster({ kind, items: ready.map((e) => e.master) } as unknown as MasterImport);
      setMasterDone(r);
      if (r.ok) store.toast(`${r.count ?? ready.length} ${spec.title.toLowerCase()} saved.`);
      setPhase('done');
      return;
    }
    const items = ready.map((e) => e.bulk!);
    setProgress([0, items.length]);
    const out = await store.recordEvents(items, (d, t) => setProgress([d, t]));
    setOutcomes(new Map(out.map((o) => [o.key, o])));
    const saved = out.filter((o) => o.ok && !o.duplicate).length;
    const failed = out.filter((o) => !o.ok).length;
    store.toast(`${saved} saved${failed ? `, ${failed} refused by the server` : ''}.`, failed ? 'warn' : 'ok');
    setPhase('done');
  }

  const rowsCsv = (list: Entry[], status: (e: Entry) => string) => {
    const byRow = new Map<number, string[]>();
    for (const r of mapped?.rows ?? []) byRow.set(r._row, r.raw);
    const out: string[][] = [];
    for (const e of list) for (const n of e.rows) out.push([...(byRow.get(n) ?? []).slice(0, mapped?.headers.length ?? 0), status(e)]);
    return out;
  };
  const statusText = (e: Entry): string => {
    const o = e.bulk ? outcomes.get(e.bulk.key) : undefined;
    if (o) return o.ok ? (o.duplicate ? 'Already recorded earlier (skipped)' : `Saved${o.warnings?.length ? ` — ${o.warnings.join(' ')}` : ''}`) : `Refused: ${o.error}`;
    if (e.duplicate) return 'Already recorded earlier (skipped)';
    if (e.errors.length) return `Not imported: ${e.errors.join(' ')}`;
    if (phase === 'done' && spec.group === 'master') return masterDone?.ok ? 'Saved' : `Not saved: ${masterDone?.error ?? ''}`;
    return e.warnings.length ? `Ready, check: ${e.warnings.join(' ')}` : 'Ready';
  };

  return (
    <div className="stack">
      {phase === 'pick' && (
        <>
          <div className="card card-pad stack-sm">
            {kinds.length > 1 && (
              <label className="field" style={{ maxWidth: 360 }}>
                <span>What are you uploading?</span>
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as ImportKind);
                    setOptions({});
                    setError('');
                  }}
                >
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {SPECS[k].title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="small">{spec.description}</p>
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  const t = templateFor(spec, ctx());
                  downloadCsv({ filename: `savannah-trace-${kind.replace('_', '-')}-template-${today()}.csv`, headers: t[0], rows: t.slice(1) });
                }}
              >
                <Download size={14} /> Download template (CSV)
              </button>
              <span className="tiny muted">{spec.prefill ? 'The template lists what is waiting for you; fill in the empty columns.' : 'Rows starting with # are examples and are ignored.'}</span>
            </div>
            <details>
              <summary className="small" style={{ cursor: 'pointer' }}>
                Columns ({spec.columns.filter((c) => c.required).length} required)
              </summary>
              <table className="table imp-table" style={{ marginTop: 8 }}>
                <tbody>
                  {spec.columns.map((c) => (
                    <tr key={c.key}>
                      <td className="mono nowrap">
                        {c.label}
                        {c.required && <b style={{ color: 'var(--danger)' }}> *</b>}
                      </td>
                      <td>
                        {c.help}
                        {c.aliases?.length ? <div className="tiny muted">Also recognised: {c.aliases.slice(0, 5).join(', ')}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            {spec.options?.map((o) => (
              <label key={o.key} className="row small" style={{ gap: 8, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <input type="checkbox" checked={!!options[o.key]} onChange={(e) => setOptions({ ...options, [o.key]: e.target.checked })} />
                <span>
                  {o.label}
                  <span className="tiny muted" style={{ display: 'block' }}>
                    {o.help}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <label
            className={`drop ${over ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              onFile(e.dataTransfer.files[0]);
            }}
          >
            <FileSpreadsheet size={26} />
            <b>Choose a CSV or Excel file</b>
            <span className="tiny muted">or drag it here · .csv or .xlsx · up to {MAX_FILE_BYTES / 1024 / 1024} MB · nothing is saved until you review and press Import</span>
            <input ref={input} type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          {error && (
            <div className="notice danger small">
              <XCircle size={16} /> {error}
            </div>
          )}
        </>
      )}

      {phase !== 'pick' && mapped && (
        <>
          <div className="card card-pad stack-sm">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="small">
                <b>{spec.title}</b> from <span className="mono">{fileName}</span>
                {sheets.length > 1 && (
                  <>
                    {' · sheet '}
                    <select
                      value={sheetIdx}
                      disabled={phase !== 'review'}
                      onChange={(e) => {
                        const i = Number(e.target.value);
                        setSheetIdx(i);
                        analyse(sheets[i], fileName, kind, options);
                      }}
                      style={{ width: 'auto', height: 28 }}
                    >
                      {sheets.map((s, i) => (
                        <option key={i} value={i}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              {phase === 'review' && (
                <button className="btn btn-sm" onClick={reset}>
                  <RotateCcw size={13} /> Choose another file
                </button>
              )}
            </div>
            <div className="tiny muted">
              Columns recognised: {mapped.matched.map((m) => (m.header === m.col.label ? m.header : `${m.header} → ${m.col.label}`)).join(', ') || 'none'}
              {mapped.ignored.length > 0 && <> · ignored: {mapped.ignored.join(', ')}</>}
            </div>
            {mapped.missing.length > 0 && (
              <div className="notice danger small">
                <XCircle size={16} style={{ flex: 'none' }} />
                <span>
                  Required column{mapped.missing.length > 1 ? 's' : ''} missing: <b>{mapped.missing.map((c) => c.label).join(', ')}</b>. {mapped.missing.map((c) => `${c.label}: ${c.help}`).join(' ')} Download the
                  template to see the expected headers.
                </span>
              </div>
            )}
            {!mapped.missing.length && !mapped.rows.length && <div className="notice amber small">No data rows found under the header row.</div>}
            {phase === 'review' &&
              spec.options?.map((o) => (
                <label key={o.key} className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={!!options[o.key]}
                    onChange={(e) => {
                      const next = { ...options, [o.key]: e.target.checked };
                      setOptions(next);
                      analyse(sheets[sheetIdx], fileName, kind, next);
                    }}
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            {entries.length > 0 && (
              <div className="imp-summary">
                <span>
                  <b>{mapped.rows.length}</b> row{mapped.rows.length === 1 ? '' : 's'} → <b>{entries.length}</b> {spec.group === 'master' ? 'record' : 'entr'}
                  {entries.length === 1 ? (spec.group === 'master' ? '' : 'y') : spec.group === 'master' ? 's' : 'ies'}
                </span>
                <span style={{ color: 'var(--forest)' }}>
                  <CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> <b>{ready.length}</b> ready
                  {spec.group === 'master' && ready.some((e) => e.update) ? ` (${ready.filter((e) => e.update).length} update existing)` : ''}
                </span>
                {warned.length > 0 && (
                  <span style={{ color: 'var(--amber)' }}>
                    <AlertTriangle size={13} style={{ verticalAlign: -2 }} /> <b>{warned.length}</b> to check
                  </span>
                )}
                {problems.length > 0 && (
                  <span style={{ color: 'var(--danger)' }}>
                    <XCircle size={13} style={{ verticalAlign: -2 }} /> <b>{problems.length}</b> with errors (not imported)
                  </span>
                )}
                {dups.length > 0 && (
                  <span className="muted">
                    <b>{dups.length}</b> already recorded earlier
                  </span>
                )}
              </div>
            )}
            {phase === 'importing' && (
              <div className="stack-sm">
                <div className="progress" role="progressbar" aria-valuenow={progress[0]} aria-valuemax={progress[1]}>
                  <div style={{ width: `${progress[1] ? (progress[0] / progress[1]) * 100 : 30}%` }} />
                </div>
                <span className="tiny muted">{spec.group === 'master' ? 'Saving in one transaction…' : `Saving ${progress[0]} of ${progress[1]}… keep this window open.`}</span>
              </div>
            )}
            {phase === 'done' && spec.group === 'master' && masterDone && (
              <div className={`notice ${masterDone.ok ? 'ok' : 'danger'} small`}>
                {masterDone.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                <span>{masterDone.ok ? `${masterDone.count} record(s) saved.` : `Nothing was saved: ${masterDone.error}`}</span>
              </div>
            )}
            {phase === 'done' && spec.group === 'event' && (
              <div className="notice ok small">
                <CheckCircle2 size={16} />
                <span>
                  {[...outcomes.values()].filter((o) => o.ok && !o.duplicate).length} saved · {[...outcomes.values()].filter((o) => o.duplicate).length} already recorded ·{' '}
                  {[...outcomes.values()].filter((o) => !o.ok).length} refused by the server
                </span>
              </div>
            )}
            <div className="row">
              {phase === 'review' && (
                <button className="btn btn-primary" disabled={!ready.length} onClick={doImport}>
                  <Upload size={14} /> Import {ready.length} {spec.group === 'master' ? 'record' : 'entr'}
                  {ready.length === 1 ? (spec.group === 'master' ? '' : 'y') : spec.group === 'master' ? 's' : 'ies'}
                  {problems.length ? ' (skip rows with errors)' : ''}
                </button>
              )}
              {problems.length > 0 && phase !== 'importing' && (
                <button
                  className="btn"
                  onClick={() => downloadCsv({ filename: `${kind}-rows-to-fix-${today()}.csv`, headers: [...(mapped.headers ?? []), 'problem'], rows: rowsCsv(problems, (e) => e.errors.join(' ')) })}
                >
                  <Download size={14} /> Rows with errors (CSV)
                </button>
              )}
              {phase === 'done' && (
                <>
                  <button className="btn" onClick={() => downloadCsv({ filename: `${kind}-upload-result-${today()}.csv`, headers: [...(mapped.headers ?? []), 'result'], rows: rowsCsv(entries, statusText) })}>
                    <Download size={14} /> Result per row (CSV)
                  </button>
                  <button className="btn" onClick={reset}>
                    <Upload size={14} /> Upload another file
                  </button>
                  {onDone && (
                    <button className="btn btn-primary" onClick={onDone}>
                      Done
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {entries.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>Review</h3>
                <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'problems')} style={{ width: 'auto', height: 28 }} aria-label="Show">
                  <option value="all">All ({entries.length})</option>
                  <option value="problems">Errors and checks only</option>
                </select>
              </div>
              <div className="imp-scroll">
                <table className="table imp-table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>{spec.group === 'master' ? 'Record' : 'Entry'}</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.slice(0, 1000).map((e) => {
                      const o = e.bulk ? outcomes.get(e.bulk.key) : undefined;
                      const bad = e.errors.length > 0 || o?.ok === false;
                      return (
                        <tr key={e.id} className={bad ? 'err' : e.warnings.length ? 'warn' : ''}>
                          <td className="mono nowrap">{e.rows.length > 3 ? `${e.rows[0]}–${e.rows[e.rows.length - 1]}` : e.rows.join(', ')}</td>
                          <td>{e.label}</td>
                          <td>
                            <span className={`status ${bad ? 'bad' : e.duplicate || o?.duplicate ? 'info' : e.warnings.length ? 'wait' : 'ok'}`}>
                              {o ? (o.ok ? (o.duplicate ? 'Already recorded' : 'Saved') : 'Refused') : e.duplicate ? 'Already recorded' : bad ? 'Error' : e.warnings.length ? 'Check' : e.update ? 'Update' : 'Ready'}
                            </span>
                            {(e.errors.length > 0 || e.warnings.length > 0 || o?.error || o?.warnings?.length) && (
                              <ul className="msgs">
                                {e.errors.map((m, i) => (
                                  <li key={`e${i}`} style={{ color: 'var(--danger)' }}>
                                    {m}
                                  </li>
                                ))}
                                {o?.error && <li style={{ color: 'var(--danger)' }}>{o.error}</li>}
                                {[...e.warnings, ...(o?.warnings ?? [])].map((m, i) => (
                                  <li key={`w${i}`}>{m}</li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {shown.length > 1000 && <p className="tiny muted" style={{ padding: '8px 12px' }}>Showing the first 1,000. Download the CSV for the full list.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
