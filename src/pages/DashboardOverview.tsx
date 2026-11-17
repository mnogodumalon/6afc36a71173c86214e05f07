import { useMemo, useState } from 'react';
import { format, parseISO, isValid } from 'date-fns';
import { IconPlus, IconMapPin, IconUsers, IconCalendarEvent, IconCircleCheck, IconInbox, IconChevronRight } from '@tabler/icons-react';
import type { DashboardData } from '@/hooks/useDashboardData';
import { useEntityCrud } from '@/components/EntityCrud';
import { flowActionFor, countOf } from '@/config/plan';
import type { EnrichedUmfragen, EnrichedTerminvorschlaege, EnrichedAntworten } from '@/types/enriched';
import { extractRecordId } from '@/services/livingAppsService';
import { lookupKey } from '@/lib/formatters';
import { useClock, gruss } from '@/lib/polish';
import { tx, appLabel, dateFnsLocale } from '@/i18n';
import { submissionsOf, topOne } from '@/lib/journey';
import { DashboardGrid } from '@/components/DashboardGrid';
import { WorkList } from '@/components/WorkList';
import { StatStrip, StatStripItem } from '@/components/StatCard';
import { RecordDoorLink } from '@/components/widgets/RecordDoorLink';
import { Button } from '@/components/ui/button';

type Filter = 'all' | 'open' | 'nofinal' | 'noanswers';

interface PollView {
  poll: EnrichedUmfragen;
  termine: EnrichedTerminvorschlaege[];
  answers: EnrichedAntworten[];
  teilnehmer: number;
  counts: Map<string, { ja: number; vielleicht: number }>;
  top: EnrichedTerminvorschlaege | null;
  isOpen: boolean;
}

// Hand-built poll cards: ChartWidget/KanbanWidget were rejected — neither can show a per-date
// Ja/Vielleicht tally with a highlighted winner inside ONE poll card plus its share link.
export default function DashboardOverview({ data }: { data: DashboardData }) {
  const crud = useEntityCrud(data, {
    footer: (top) => {
      if (top.type !== 'umfragen') return undefined;
      const v = views.find(x => x.poll.record_id === top.record.record_id);
      if (!v || !v.isOpen || !v.top) return undefined;
      const go = flowActionFor('umfragen', 'finaler_termin', v.poll.record_id, v.top.record_id);
      return go ? { label: tx('Beliebtesten Termin festlegen & schließen'), onClick: go } : undefined;
    },
  });
  const clock = useClock();
  const [filter, setFilter] = useState<Filter>('all');
  const { umfragen, terminvorschlaege, antworten } = data;

  const views: PollView[] = useMemo(() => {
    return crud.enriched.umfragen.map(poll => {
      const termine = crud.enriched.terminvorschlaege
        .filter(t => extractRecordId(t.fields.umfrage) === poll.record_id)
        .sort((a, b) => (a.fields.beginn ?? '').localeCompare(b.fields.beginn ?? ''));
      const ans = crud.enriched.antworten.filter(a => extractRecordId(a.fields.umfrage) === poll.record_id);
      const counts = new Map<string, { ja: number; vielleicht: number }>();
      for (const t of termine) counts.set(t.record_id, { ja: 0, vielleicht: 0 });
      for (const a of ans) {
        const tid = extractRecordId(a.fields.terminvorschlag);
        const c = tid ? counts.get(tid) : undefined;
        if (!c) continue;
        const k = lookupKey(a.fields.antwort);
        if (k === 'ja') c.ja++;
        else if (k === 'vielleicht') c.vielleicht++;
      }
      const top = topOne(
        termine,
        [t => counts.get(t.record_id)?.ja ?? 0, t => counts.get(t.record_id)?.vielleicht ?? 0],
        t => t.fields.beginn,
      );
      return {
        poll, termine, answers: ans, counts, top,
        teilnehmer: submissionsOf(ans, { names: ['teilnehmer_vorname', 'teilnehmer_nachname'] }).length,
        isOpen: lookupKey(poll.fields.status) !== 'geschlossen',
      };
    }).sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || (b.poll.createdat ?? '').localeCompare(a.poll.createdat ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [umfragen, terminvorschlaege, antworten, crud.enriched]);

  const open = views.filter(v => v.isOpen);
  const noFinal = views.filter(v => !v.poll.fields.finaler_termin);
  const noAnswers = open.filter(v => v.teilnehmer === 0);
  const ready = open.filter(v => v.teilnehmer > 0 && v.top);

  const shown = views.filter(v =>
    filter === 'open' ? v.isOpen
      : filter === 'nofinal' ? !v.poll.fields.finaler_termin
      : filter === 'noanswers' ? v.isOpen && v.teilnehmer === 0
      : true);

  const fmt = (iso?: string, pattern = 'EEE d. MMM, HH:mm') => {
    if (!iso) return '';
    const d = parseISO(iso);
    return isValid(d) ? format(d, pattern, { locale: dateFnsLocale() }) : '';
  };
  const range = (t: EnrichedTerminvorschlaege) => {
    const s = fmt(t.fields.beginn);
    const e = t.fields.ende ? fmt(t.fields.ende, 'HH:mm') : '';
    return e ? `${s} – ${e}` : s;
  };

  const closeAction = (v: PollView) => {
    if (!v.isOpen || !v.top) return undefined;
    const go = flowActionFor('umfragen', 'finaler_termin', v.poll.record_id, v.top.record_id);
    return go ? { label: tx('Festlegen'), onClick: go } : undefined;
  };

  const nextDates = useMemo(() => {
    const now = format(clock, "yyyy-MM-dd'T'HH:mm");
    return views
      .filter(v => v.isOpen)
      .flatMap(v => v.termine.map(t => ({ v, t })))
      .filter(x => (x.t.fields.beginn ?? '') >= now)
      .sort((a, b) => (a.t.fields.beginn ?? '').localeCompare(b.t.fields.beginn ?? ''));
  }, [views, clock]);

  const contextLine = (() => {
    if (views.length === 0) return tx('Lege deine erste Umfrage an und teile den Link.');
    if (ready.length > 0) {
      const first = ready[0].poll.fields.titel ?? '';
      return ready.length === 1
        ? tx`„${first}“ hat Antworten — du kannst den Termin festlegen.`
        : tx`„${first}“ und ${ready.length - 1} weitere warten auf deine Entscheidung.`;
    }
    if (noAnswers.length > 0) {
      const first = noAnswers[0].poll.fields.titel ?? '';
      return tx`Auf „${first}“ hat noch niemand geantwortet — teile den Link.`;
    }
    return tx`Alle Umfragen sind abgeschlossen.`;
  })();

  const toggle = (f: Filter) => setFilter(cur => (cur === f ? 'all' : f));

  const primary = views.length === 0 ? (
    <div className="rounded-[27px] bg-card shadow-sm p-8 flex flex-col items-center text-center gap-3 overflow-hidden">
      <IconCalendarEvent size={48} className="text-muted-foreground" />
      <p className="text-sm text-muted-foreground max-w-sm">{tx('Noch keine Umfrage. Lege eine an, trage Terminvorschläge ein und teile den Link.')}</p>
      {crud.umfragen.canWrite && (
        <Button onClick={() => crud.umfragen.openCreate({ status: 'offen' })}>
          <IconPlus size={16} className="shrink-0" /> {tx('Erste Umfrage anlegen')}
        </Button>
      )}
    </div>
  ) : (
    <div className="space-y-4">
      {shown.length === 0 && (
        <div className="rounded-[27px] bg-card shadow-sm p-6 text-sm text-muted-foreground">{tx('Keine Umfrage in dieser Ansicht.')}</div>
      )}
      {shown.map(v => {
        const act = closeAction(v);
        return (
          <article key={v.poll.record_id} className="rounded-[27px] bg-card shadow-sm p-4 sm:p-5 space-y-3 overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-semibold tracking-tight truncate">{v.poll.fields.titel ?? '—'}</h3>
                <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={v.isOpen ? 'font-medium text-emerald-600' : 'font-medium text-muted-foreground'}>
                    {v.poll.fields.status?.label}
                  </span>
                  {v.poll.fields.ort && <span className="inline-flex items-center gap-1 min-w-0"><IconMapPin size={12} className="shrink-0" /><span className="truncate">{v.poll.fields.ort}</span></span>}
                  <span className="inline-flex items-center gap-1"><IconUsers size={12} className="shrink-0" />{countOf('antworten', v.teilnehmer, appLabel('antworten'))}</span>
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => crud.umfragen.openDetail(v.poll)}>
                {tx('Details')} <IconChevronRight size={14} className="shrink-0" />
              </Button>
            </div>

            {v.poll.fields.finaler_termin && (
              <p className="text-sm flex items-center gap-2 rounded-xl bg-emerald-50 text-emerald-800 px-3 py-2">
                <IconCircleCheck size={16} className="shrink-0" />
                <span className="min-w-0 truncate">{tx('Finaler Termin')}: <b>{v.poll.finaler_terminName}</b></span>
              </p>
            )}

            {v.termine.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tx('Noch keine Terminvorschläge.')}</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {v.termine.map(t => {
                  const c = v.counts.get(t.record_id) ?? { ja: 0, vielleicht: 0 };
                  const isTop = v.top?.record_id === t.record_id;
                  return (
                    <button
                      key={t.record_id}
                      type="button"
                      onClick={() => crud.terminvorschlaege.openDetail(t)}
                      className={`text-left rounded-xl border px-3 py-2 min-w-0 transition-colors ${isTop ? 'border-emerald-500 bg-emerald-50' : 'bg-background hover:bg-muted/50'}`}
                    >
                      <div className="text-sm font-medium truncate">{range(t)}</div>
                      <div className="text-xs mt-0.5 flex flex-wrap gap-x-3">
                        <span className="text-emerald-700 font-medium">{tx`${c.ja} Ja`}</span>
                        <span className="text-amber-600 font-medium">{tx`${c.vielleicht} Vielleicht`}</span>
                        {isTop && <span className="text-emerald-700 font-semibold">★ {tx('Meiste Ja')}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <RecordDoorLink page="termin-abstimmen" recordId={v.poll.record_id} qr />

            {act && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={act.onClick}>
                  <IconCircleCheck size={16} className="shrink-0" /> {tx('Beliebtesten Termin festlegen & schließen')}
                </Button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{gruss(clock)}</h1>
          <p className="text-sm text-muted-foreground">{contextLine}</p>
        </div>
        {crud.umfragen.canWrite && views.length > 0 && (
          <Button onClick={() => crud.umfragen.openCreate({ status: 'offen' })}>
            <IconPlus size={16} className="shrink-0" /> {tx('Neue Umfrage')}
          </Button>
        )}
      </header>

      <DashboardGrid
        variant="split"
        kpis={views.length > 0 ? (
          <StatStrip>
            <StatStripItem
              title={tx('Offene Umfragen')} value={open.length}
              icon={<IconInbox size={18} className="text-muted-foreground" />}
              tone={open.length > 0 ? 'primary' : 'default'}
              onClick={() => toggle('open')} active={filter === 'open'}
            />
            <StatStripItem
              title={tx('Ohne finalen Termin')} value={noFinal.length}
              icon={<IconCalendarEvent size={18} className="text-muted-foreground" />}
              onClick={() => toggle('nofinal')} active={filter === 'nofinal'}
            />
            <StatStripItem
              title={tx('Ohne Antworten')} value={noAnswers.length}
              icon={<IconUsers size={18} className="text-muted-foreground" />}
              tone={noAnswers.length > 0 ? 'warning' : 'default'}
              onClick={() => toggle('noanswers')} active={filter === 'noanswers'}
            />
          </StatStrip>
        ) : undefined}
        aside={views.length > 0 ? (
          <>
            <WorkList
              title={tx('Bereit zur Entscheidung')}
              items={ready.map(v => ({
                id: v.poll.record_id,
                title: v.poll.fields.titel ?? '—',
                secondLine: (
                  <>
                    <span className="font-medium text-emerald-600">{countOf('antworten', v.teilnehmer, appLabel('antworten'))}</span>
                    <span className="text-muted-foreground"> · {v.top ? range(v.top) : ''}</span>
                  </>
                ),
                action: closeAction(v),
              }))}
              onItemClick={id => { const v = views.find(x => x.poll.record_id === id); if (v) crud.umfragen.openDetail(v.poll); }}
              empty={{ text: tx('Noch keine offene Umfrage mit Antworten.') }}
            />
            <WorkList
              title={tx('Nächste Terminvorschläge')}
              items={nextDates.slice(0, 5).map(({ v, t }) => ({
                id: t.record_id,
                title: range(t),
                secondLine: <span className="text-muted-foreground">{v.poll.fields.titel}</span>,
              }))}
              onItemClick={id => { const x = nextDates.find(n => n.t.record_id === id); if (x) crud.terminvorschlaege.openDetail(x.t); }}
              empty={{ text: tx('Keine anstehenden Terminvorschläge in offenen Umfragen.') }}
            />
          </>
        ) : undefined}
        primary={primary}
      />
      {crud.surfaces}
    </div>
  );
}
