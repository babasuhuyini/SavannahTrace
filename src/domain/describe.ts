import type { DemoDB, TraceEvent } from '../data/types';
import { TRANSFORM_LABEL, type Analysis } from './engine';
import { fmtKg } from './format';
import { eventLines } from './trace';

export const EVENT_TYPE_LABEL: Record<TraceEvent['type'], string> = {
  commission: 'Purchase (Commission)',
  ship: 'Ship',
  receive: 'Receive',
  issue: 'Issue to group',
  transform: 'Transform',
  ready: 'Ready for pickup',
  deliver: 'Deliver to client',
};

export function describeEvent(e: TraceEvent, a: Analysis, db: DemoDB): string {
  const place = (id: string) => a.places.get(id)?.name ?? id;
  const lines = eventLines(e);
  const lots = (ls: typeof lines) => (ls.length > 2 ? `${ls[0].lotId} +${ls.length - 1} more` : ls.map((l) => l.lotId).join(', '));
  const kg = (ls: typeof lines) => fmtKg(ls.reduce((s, l) => s + l.qty, 0));
  switch (e.type) {
    case 'commission': {
      const c = db.collectors.find((x) => x.id === e.collectorId);
      return `${e.outputs[0].lotId} · ${fmtKg(e.outputs[0].qty)} ${e.outputs[0].product} from ${c?.name ?? 'unknown collector'}`;
    }
    case 'ship':
      return `${lots(lines)} · ${kg(lines)} · ${place(e.fromId)} → ${place(e.toId)}`;
    case 'receive':
      return `${lots(lines)} · ${kg(lines)} at ${place(e.locationId)}${e.outcome === 'discrepancy' ? ' · discrepancy flagged' : ''}`;
    case 'issue':
      return `${lots(lines)} · ${kg(lines)} → ${db.groups.find((g) => g.id === e.groupId)?.name ?? '?'} at ${place(e.locationId)}`;
    case 'transform': {
      const ins = lines.filter((l) => l.role === 'in');
      const outs = lines.filter((l) => l.role === 'out');
      return `${TRANSFORM_LABEL(e.kind)}: ${ins.length} input${ins.length === 1 ? '' : 's'} (${kg(ins)}) → ${outs.map((o) => o.lotId).join(', ')} (${kg(outs)})${e.kind === 'aggregation' && e.sfclStage !== 'finalized' ? ' · in progress' : ''}`;
    }
    case 'ready':
      return `${lots(lines)} · ${kg(lines)} ready for pickup at ${place(e.locationId)}`;
    case 'deliver':
      return `${lots(lines)} · ${kg(lines)} delivered to ${place(e.toId)}`;
  }
}
