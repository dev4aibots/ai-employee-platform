import {
  bandTone,
  esc,
  money,
  pct,
  shortId,
  stageLabel,
  stageTone,
  statusTone,
  timeAgo,
} from './format';
import type { Model, StepRow, View } from './types';

/**
 * Render functions. The console is server-rendered HTML strings plus delegated
 * events, which keeps the whole UI in one place and makes every number on
 * screen traceable to the query that produced it.
 */

const ICONS: Record<string, string> = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  leads:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  approvals:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  runs: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  isolation: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
};

function icon(name: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

const VIEW_TITLES: Record<View, string> = {
  overview: 'Overview',
  leads: 'Leads',
  approvals: 'Approvals',
  runs: 'Run ledger',
  isolation: 'Isolation',
};

function badge(text: string, tone = ''): string {
  return `<span class="badge${tone ? ` badge-${tone}` : ''}">${esc(text)}</span>`;
}

function statusBadge(status: string): string {
  return badge(status.replace(/_/g, ' '), statusTone(status));
}

function chainBadge(chain: Model['chain']): string {
  if (!chain) return '';
  if (chain.checked === 0) return badge('no decisions yet');
  return chain.ok ? badge(`chain verified · ${chain.checked}`, 'ok') : badge('chain broken', 'bad');
}

function navItem(view: View, label: string, iconName: string, count: number, active: View): string {
  return `<button class="nav-item" data-action="nav" data-view="${view}" aria-current="${view === active ? 'page' : 'false'}">
    ${icon(iconName)}
    <span>${esc(label)}</span>
    ${count > 0 ? `<span class="nav-count">${count}</span>` : ''}
  </button>`;
}

function pageHead(title: string, sub: string, actions = ''): string {
  return `<div class="page-head">
    <div>
      <h1>${esc(title)}</h1>
      <p class="page-sub">${esc(sub)}</p>
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </div>`;
}

function emptyState(title: string, hint: string, action = ''): string {
  return `<div class="empty">
    <strong>${esc(title)}</strong>
    <span>${esc(hint)}</span>
    ${action}
  </div>`;
}

function kpi(label: string, value: string, foot: string): string {
  return `<div class="card kpi">
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value">${value}</span>
    <span class="kpi-foot">${foot}</span>
  </div>`;
}

function contribList(contributions: { label: string; points: number; reason: string }[]): string {
  if (contributions.length === 0) return `<p class="muted">No scored signals on this lead.</p>`;
  const max = Math.max(...contributions.map((item) => Math.abs(item.points)), 1);
  return `<div class="contrib-list">${contributions
    .map(
      (item) => `<div class="contrib">
        <div class="contrib-head">
          <span>${esc(item.label)}</span>
          <span class="mono ${item.points < 0 ? 'neg' : 'pos'}">${item.points > 0 ? '+' : ''}${item.points}</span>
        </div>
        <div class="contrib-bar"><span class="${item.points < 0 ? 'neg' : ''}" style="width:${Math.round((Math.abs(item.points) / max) * 100)}%"></span></div>
        <div class="contrib-note">${esc(item.reason)}</div>
      </div>`,
    )
    .join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function topbar(model: Model): string {
  return `<header class="topbar">
    <div class="crumbs">
      <span class="crumb-tenant">Acme Robotics</span>
      <span class="crumb-sep" aria-hidden="true">/</span>
      <span class="crumb-view">${esc(VIEW_TITLES[model.view])}</span>
    </div>
    <div class="topbar-actions">
      <span class="chip">audit ${
        model.chain && model.chain.checked > 0
          ? model.chain.ok
            ? `${model.chain.checked} verified`
            : 'broken'
          : 'empty'
      }</span>
      <span class="chip">PostgreSQL 18 · WASM</span>
      <button class="btn btn-primary" data-action="run-play" ${model.busy ? 'disabled' : ''}>
        ${icon('play')}<span>${model.busy === 'run' ? 'Running…' : 'Run play'}</span>
      </button>
    </div>
  </header>`;
}

function rail(model: Model): string {
  const pending = model.analytics?.drafts.pending ?? 0;
  const chain = model.chain;
  return `<aside class="rail">
    <div class="rail-head">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span class="brand-text">
        <span class="brand-name">AI Employee</span>
        <span class="brand-sub">Operations console</span>
      </span>
    </div>

    <nav class="nav" aria-label="Sections">
      ${navItem('overview', 'Overview', 'overview', 0, model.view)}
      ${navItem('leads', 'Leads', 'leads', model.analytics?.leads.total ?? 0, model.view)}
      ${navItem('approvals', 'Approvals', 'approvals', pending, model.view)}
      ${navItem('runs', 'Run ledger', 'runs', model.runs.length, model.view)}
      ${navItem('isolation', 'Isolation', 'isolation', 0, model.view)}
    </nav>

    <div class="rail-foot">
      <div class="rail-block">
        <span class="label">Tenant</span>
        <span class="row gap-2"><span class="dot ok"></span><strong>Acme Robotics</strong></span>
        <span class="mono muted">growth · 5 seats</span>
      </div>
      <div class="rail-block">
        <span class="label">Audit chain</span>
        ${chainBadge(chain)}
      </div>
      <a class="rail-link" href="https://github.com/dev4aibots/ai-employee-platform">source · architecture ${icon('arrow')}</a>
    </div>
  </aside>`;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function funnelRow(label: string, value: number, total: number): string {
  const width = total === 0 ? 0 : Math.round((value / total) * 100);
  return `<div class="funnel-row">
    <span class="funnel-label">${esc(label)}</span>
    <span class="funnel-track"><span class="funnel-fill" style="width:${width}%"></span></span>
    <span class="funnel-value mono">${value} <small>${pct(total === 0 ? 0 : value / total)}</small></span>
  </div>`;
}

function overview(model: Model): string {
  const a = model.analytics;
  if (!a) return '';
  const pending = a.drafts.pending;
  const lastRun = model.lastRun;
  const recentRuns = model.runs.slice(0, 5);

  const steps = lastRun
    ? `<div class="timeline">${lastRun.steps
        .map(
          (step) => `<div class="tl-item ${step.status === 'ok' ? 'ok' : step.status === 'failed' ? 'bad' : ''}">
            <span class="tl-mark" aria-hidden="true"></span>
            <div class="tl-body">
              <div class="tl-title"><span>${esc(step.name)}</span>${statusBadge(step.status)}${step.attempts > 1 ? badge(`${step.attempts} attempts`, 'warn') : ''}</div>
              <div class="tl-meta">${step.latencyMs} ms</div>
            </div>
          </div>`,
        )
        .join('')}</div>`
    : emptyState('No run yet', 'Run the sales play to produce drafts and a ledger entry.');

  return `${pageHead(
    'Pipeline overview',
    'One sales play: find leads that went quiet, rank them by buying signal, draft the outreach, stop for a human.',
    `<button class="btn" data-action="nav" data-view="approvals">Review queue ${pending > 0 ? badge(String(pending), 'warn') : ''}</button>`,
  )}

  <div class="kpi-grid">
    ${kpi('Leads in play', String(a.leads.total), `${a.leads.qualified} qualified · ${a.leads.contacted} contacted`)}
    ${kpi('Awaiting approval', String(pending), `${a.drafts.approved} approved · ${a.drafts.sent} sent`)}
    ${kpi('Human decisions', pct(a.approval.interventionRate), `${a.approval.decisions} decisions over ${a.drafts.pending + a.drafts.approved + a.drafts.rejected + a.drafts.sent + a.drafts.failed} drafts`)}
    ${kpi('Run success', pct(a.runs.successRate), `${a.runs.completed} of ${a.runs.total} runs · ${a.runs.failed} failed`)}
  </div>

  <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2>Pipeline</h2><span class="label">lead stage</span></div>
      <div class="card-body funnel">
        ${funnelRow('All leads', a.leads.total, a.leads.total)}
        ${funnelRow('Qualified', a.leads.qualified, a.leads.total)}
        ${funnelRow('Contacted', a.leads.contacted, a.leads.total)}
        ${funnelRow('Replied', a.leads.replied, a.leads.total)}
        ${funnelRow('Meeting', a.leads.meeting, a.leads.total)}
        ${funnelRow('Won', a.leads.won, a.leads.total)}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Sources</h2><span class="label">reply rate</span></div>
      <div class="card-body flush">
        <table class="table table-compact">
          <thead><tr><th>Source</th><th class="num">Leads</th><th class="num">Replies</th><th class="num">Rate</th></tr></thead>
          <tbody>
            ${a.sources
              .map(
                (source) => `<tr><td>${esc(source.source)}</td><td class="num">${source.leads}</td><td class="num">${source.replies}</td><td class="num">${pct(source.replyRate)}</td></tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>
  </div>

  <div class="grid-2">
    <section class="card">
      <div class="card-head">
        <h2>Last run</h2>
        ${lastRun ? statusBadge(lastRun.status) : ''}
      </div>
      <div class="card-body">
        ${lastRun ? `<div class="run-facts">
          <span><span class="label">leads</span><strong>${lastRun.leadsSeen}</strong></span>
          <span><span class="label">drafts</span><strong>${lastRun.draftsMade}</strong></span>
          <span><span class="label">skipped</span><strong>${lastRun.draftsSkipped}</strong></span>
          <span><span class="label">cost</span><strong>${money(lastRun.costUsd)}</strong></span>
        </div>` : ''}
        ${steps}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Recent runs</h2><button class="btn btn-sm btn-ghost" data-action="nav" data-view="runs">Open ledger</button></div>
      <div class="card-body flush">
        ${
          recentRuns.length === 0
            ? emptyState('No runs yet', 'The ledger fills as the play runs.')
            : `<table class="table table-compact">
          <thead><tr><th>Run</th><th>Status</th><th class="num">Leads</th><th class="num">Drafts</th><th class="num">Cost</th><th>Started</th></tr></thead>
          <tbody>${recentRuns
            .map(
              (run) => `<tr data-action="select-run" data-id="${esc(run.id)}" data-clickable="true">
                <td class="mono">${shortId(run.id)}</td>
                <td>${statusBadge(run.status)}</td>
                <td class="num">${run.leadsSeen}</td>
                <td class="num">${run.draftsMade}</td>
                <td class="num">${money(run.costUsd)}</td>
                <td class="muted">${esc(timeAgo(run.startedAt))}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`
        }
      </div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

function leadDrawer(model: Model): string {
  const lead = model.leads.find((item) => item.lead.id === model.selectedLeadId);
  if (!lead) return '';
  const l = lead.lead;
  const topSignal = lead.signals[0];

  return `<div class="scrim" data-action="close-drawer"></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
    <div class="drawer-head">
      <div>
        <span class="label">Lead · ${esc(l.source)}</span>
        <h2 id="drawer-title">${esc(l.company)}</h2>
        <p class="muted">${esc(l.contact_name)} · ${esc(l.contact_role)}</p>
      </div>
      <button class="btn btn-icon btn-ghost" data-action="close-drawer" aria-label="Close lead">${icon('close')}</button>
    </div>
    <div class="drawer-body">
      <div class="score-block">
        <div>
          <span class="label">Score</span>
          <div class="score-value mono">${lead.score}<small>/100</small></div>
        </div>
        ${badge(lead.band, bandTone(lead.band))}
      </div>

      <h3 class="section-title">Why this score</h3>
      ${contribList(lead.contributions)}

      <h3 class="section-title">Observed signals</h3>
      ${
        lead.signals.length === 0
          ? '<p class="muted">No enrichment signals on record.</p>'
          : `<ul class="signal-list">${lead.signals
              .map(
                (signal) => `<li><span class="badge">${esc(signal.kind)}</span><span>${esc(signal.value)}</span><span class="mono muted">${signal.weight > 0 ? '+' : ''}${signal.weight}</span></li>`,
              )
              .join('')}</ul>`
      }

      <h3 class="section-title">Record</h3>
      <dl class="meta-grid">
        <div><dt>Domain</dt><dd class="mono">${esc(l.domain)}</dd></div>
        <div><dt>Email</dt><dd class="mono">${esc(l.contact_email)}</dd></div>
        <div><dt>Stage</dt><dd>${badge(stageLabel(l.stage), stageTone(l.stage))}</dd></div>
        <div><dt>Size</dt><dd>${l.employees ?? 'unknown'} employees</dd></div>
        <div><dt>Funding</dt><dd>${esc(l.funding_stage ?? 'unknown')}</dd></div>
        <div><dt>HQ</dt><dd>${esc(l.hq_city ?? 'unknown')}</dd></div>
        <div><dt>Last touch</dt><dd>${esc(timeAgo(l.last_contact_at))}</dd></div>
        <div><dt>Top signal</dt><dd>${esc(topSignal?.value ?? 'none')}</dd></div>
      </dl>
    </div>
    <div class="drawer-foot"><button class="btn" data-action="close-drawer">Close</button></div>
  </aside>`;
}

function leads(model: Model): string {
  const rows = model.leads;
  return `${pageHead(
    'Leads',
    'Every row is scored from its own signals. Click a company to see the attribution behind the number.',
    `<span class="chip">${rows.length} scored</span>`,
  )}

  <section class="card">
    <div class="card-body flush">
      ${
        rows.length === 0
          ? emptyState('No leads visible', 'This tenant owns no leads in the current database.')
          : `<div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>Company</th><th>Contact</th><th>Stage</th><th class="num">Size</th><th>Last touch</th><th class="num">Score</th><th>Band</th><th>Top signal</th>
          </tr></thead>
          <tbody>
            ${rows
              .map(
                (item) => `<tr data-action="select-lead" data-id="${esc(item.lead.id)}" data-clickable="true">
                  <td><button class="linklike" data-action="select-lead" data-id="${esc(item.lead.id)}">${esc(item.lead.company)}</button></td>
                  <td><span class="cell-strong">${esc(item.lead.contact_name)}</span><span class="cell-sub">${esc(item.lead.contact_role)}</span></td>
                  <td>${badge(stageLabel(item.lead.stage), stageTone(item.lead.stage))}</td>
                  <td class="num">${item.lead.employees ?? '—'}</td>
                  <td class="muted">${esc(timeAgo(item.lead.last_contact_at))}</td>
                  <td class="num"><span class="score-cell"><span class="score-track"><span style="width:${item.score}%"></span></span>${item.score}</span></td>
                  <td>${badge(item.band, bandTone(item.band))}</td>
                  <td class="muted truncate" style="max-width:260px">${esc(item.signals[0]?.value ?? 'no signals')}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`
      }
    </div>
  </section>
  ${leadDrawer(model)}`;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

function draftDetail(model: Model): string {
  const item = model.queue.find((entry) => entry.draftId === model.selectedDraftId);
  if (!item) {
    return `<section class="card approval-detail">
      <div class="card-body">${emptyState('Select a draft', 'Pick a draft on the left to read it, see the evidence, and decide.')}</div>
    </section>`;
  }
  const max = Math.max(...item.contributions.map((c) => Math.abs(c.points)), 1);

  return `<section class="card approval-detail">
    <div class="card-head">
      <div>
        <span class="label">${esc(item.lead.company)} · ${esc(item.lead.contact_role)}</span>
        <h2>${esc(item.subject)}</h2>
      </div>
      <div class="row gap-3">${badge(`${item.band} ${item.score}`, bandTone(item.band))}</div>
    </div>
    <div class="card-body">
      <div class="draft-meta">
        <span><span class="label">to</span> ${esc(item.lead.contact_name)} &lt;${esc(item.lead.contact_email)}&gt;</span>
        <span><span class="label">writer</span> ${esc(item.writer)}</span>
        <span><span class="label">cost</span> ${money(0)}</span>
        <span><span class="label">queued</span> ${esc(timeAgo(item.createdAt))}</span>
      </div>

      <pre class="email">${esc(item.body)}</pre>

      <h3 class="section-title">Why this lead</h3>
      <div class="contrib-list compact">
        ${item.contributions
          .map(
            (c) => `<div class="contrib">
              <div class="contrib-head"><span>${esc(c.label)}</span><span class="mono ${c.points < 0 ? 'neg' : 'pos'}">${c.points > 0 ? '+' : ''}${c.points}</span></div>
              <div class="contrib-bar"><span class="${c.points < 0 ? 'neg' : ''}" style="width:${Math.round((Math.abs(c.points) / max) * 100)}%"></span></div>
              <div class="contrib-note">${esc(c.reason)}</div>
            </div>`,
          )
          .join('')}
      </div>

      <label class="field decision-note">
        <span>Note for the audit trail (optional)</span>
        <textarea class="textarea" id="decision-note" rows="2" placeholder="e.g. wrong buyer profile, hold until Q1"></textarea>
      </label>
    </div>
    <div class="drawer-foot">
      <button class="btn btn-danger" data-action="reject" data-id="${esc(item.draftId)}">${icon('close')}<span>Reject</span></button>
      <button class="btn btn-primary" data-action="approve" data-id="${esc(item.draftId)}">${icon('check')}<span>Approve</span></button>
    </div>
  </section>`;
}

function approvals(model: Model): string {
  const queue = model.queue;
  const decided = model.drafts.filter((draft) => draft.status !== 'pending');

  return `${pageHead(
    'Approvals',
    'Nothing is sent without a named decision. Approving a draft writes a hash-chained audit entry before it can leave the system.',
    `<span class="chip">${queue.length} waiting</span>`,
  )}

  <div class="approval-layout">
    <section class="card approval-list">
      <div class="card-head"><h2>Queue</h2><span class="label">oldest first</span></div>
      <div class="card-body flush">
        ${
          queue.length === 0
            ? emptyState('Queue clear', 'Run the play to generate new drafts.', `<button class="btn btn-sm" data-action="run-play">Run play</button>`)
            : `<ul class="queue">${queue
                .map(
                  (item) => `<li>
                    <button class="queue-item" data-action="select-draft" data-id="${esc(item.draftId)}" aria-current="${item.draftId === model.selectedDraftId ? 'true' : 'false'}">
                      <span class="queue-top"><span class="queue-company">${esc(item.lead.company)}</span>${badge(item.band, bandTone(item.band))}</span>
                      <span class="queue-subject">${esc(item.subject)}</span>
                      <span class="queue-meta mono">${item.score}/100 · ${esc(timeAgo(item.createdAt))}</span>
                    </button>
                  </li>`,
                )
                .join('')}</ul>`
        }
      </div>
    </section>

    ${draftDetail(model)}
  </div>

  <section class="card">
    <div class="card-head"><h2>Decided</h2><span class="label">send only after approval</span></div>
    <div class="card-body flush">
      ${
        decided.length === 0
          ? emptyState('No decisions yet', 'Approved and rejected drafts appear here with their audit status.')
          : `<table class="table table-compact">
          <thead><tr><th>Draft</th><th>Company</th><th>Status</th><th>Queued</th><th class="num">Action</th></tr></thead>
          <tbody>${decided
            .map(
              (draft) => `<tr>
                <td class="truncate" style="max-width:420px">${esc(draft.subject)}</td>
                <td>${esc(draft.company)}</td>
                <td>${statusBadge(draft.status)}</td>
                <td class="muted">${esc(timeAgo(draft.createdAt))}</td>
                <td class="num">${
                  draft.status === 'approved'
                    ? `<button class="btn btn-sm" data-action="send" data-id="${esc(draft.id)}">${icon('send')}<span>Send</span></button>`
                    : draft.status === 'failed'
                      ? `<button class="btn btn-sm" data-action="send" data-id="${esc(draft.id)}">Retry send</button>`
                      : ''
                }</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`
      }
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function runSteps(steps: StepRow[]): string {
  if (steps.length === 0) return emptyState('No steps recorded', 'Select a run to inspect its ledger.');
  return `<div class="timeline">${steps
    .map(
      (step) => `<div class="tl-item ${step.status === 'ok' ? 'ok' : step.status === 'failed' ? 'bad' : 'run'}">
        <span class="tl-mark" aria-hidden="true"></span>
        <div class="tl-body">
          <div class="tl-title">
            <span>${esc(step.name)}</span>
            ${statusBadge(step.status)}
            ${step.attempts > 1 ? badge(`${step.attempts} attempts`, 'warn') : ''}
          </div>
          <div class="tl-meta">${step.latency_ms} ms${step.error ? ` · ${esc(step.error)}` : ''}</div>
          ${Object.keys((step.detail as Record<string, unknown>) ?? {}).length > 0 ? `<pre class="code detail">${esc(JSON.stringify(step.detail))}</pre>` : ''}
        </div>
      </div>`,
    )
    .join('')}</div>`;
}

function runs(model: Model): string {
  const selected = model.runs.find((run) => run.id === model.selectedRunId) ?? model.runs[0];

  return `${pageHead(
    'Run ledger',
    'One row per invocation, one row per step. A failed run keeps its steps instead of pretending it is still running.',
    `<span class="chip">${model.runs.length} runs</span>`,
  )}

  <div class="runs-layout">
    <section class="card">
      <div class="card-head"><h2>Runs</h2></div>
      <div class="card-body flush">
        ${
          model.runs.length === 0
            ? emptyState('No runs', 'Run the play to create the first ledger entry.')
            : `<ul class="queue">${model.runs
                .map(
                  (run) => `<li>
                    <button class="queue-item" data-action="select-run" data-id="${esc(run.id)}" aria-current="${run.id === selected?.id ? 'true' : 'false'}">
                      <span class="queue-top"><span class="queue-company mono">${shortId(run.id)}</span>${statusBadge(run.status)}</span>
                      <span class="queue-subject truncate">${esc(run.goal)}</span>
                      <span class="queue-meta mono">${run.leadsSeen} leads · ${run.draftsMade} drafts · ${money(run.costUsd)}</span>
                    </button>
                  </li>`,
                )
                .join('')}</ul>`
        }
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>${selected ? `Run ${shortId(selected.id)}` : 'Run detail'}</h2>
        ${selected ? statusBadge(selected.status) : ''}
      </div>
      <div class="card-body">
        ${
          selected
            ? `<div class="run-facts">
                <span><span class="label">goal</span><strong class="truncate" style="max-width:420px">${esc(selected.goal)}</strong></span>
                <span><span class="label">started</span><strong>${esc(timeAgo(selected.startedAt))}</strong></span>
                <span><span class="label">leads</span><strong>${selected.leadsSeen}</strong></span>
                <span><span class="label">drafts</span><strong>${selected.draftsMade}</strong></span>
                <span><span class="label">tokens</span><strong>${selected.tokens}</strong></span>
              </div>
              ${runSteps(model.steps)}`
            : emptyState('Nothing selected', 'Pick a run on the left.')
        }
      </div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

function isolation(model: Model): string {
  const rows = model.isolation;
  const attack = model.attack;

  return `${pageHead(
    'Isolation',
    'The console sets the same JWT claim Supabase uses, then switches role. Every number below is queried twice, as two different tenants.',
    `<span class="chip">${model.chain && model.chain.checked > 0 ? (model.chain.ok ? 'chain verified' : 'chain broken') : 'no decisions yet'}</span>`,
  )}

  <section class="card">
    <div class="card-head"><h2>Rows visible per tenant</h2><span class="label">same database, two sessions</span></div>
    <div class="card-body flush">
      <table class="table">
        <thead><tr><th>Table</th><th class="num">Acme Robotics</th><th class="num">Globex Logistics</th><th>Verdict</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (row) => `<tr>
                <td class="mono">${esc(row.table)}</td>
                <td class="num">${row.acme}</td>
                <td class="num">${row.globex}</td>
                <td>${
                  row.globex > 0
                    ? badge('leak', 'bad')
                    : row.acme > 0
                      ? badge('isolated', 'ok')
                      : badge('empty')
                }</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
  </section>

  <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2>Try to break it</h2><span class="label">runs as Globex</span></div>
      <div class="card-body">
        <p class="muted">Both actions run against the live database with Globex's identity. The error text is what PostgreSQL returned, not a mock.</p>
        <div class="row gap-3 wrap">
          <button class="btn" data-action="attack" data-kind="write">Insert a lead owned by Acme</button>
          <button class="btn" data-action="attack" data-kind="anon">Read leads as anon</button>
        </div>
        ${
          attack
            ? `<div class="attack-result">
                <div class="row gap-3">${badge('blocked', 'ok')}<span class="mono">${esc(attack.label)}</span></div>
                <pre class="code">${esc(attack.sql)}</pre>
                <pre class="code error-code">${esc(attack.error)}</pre>
              </div>`
            : ''
        }
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Audit chain</h2>${model.chain ? badge(model.chain.ok ? 'verified' : 'broken', model.chain.ok ? 'ok' : 'bad') : ''}</div>
      <div class="card-body">
        <p class="muted">Every approval stores <span class="mono">prev_hash</span>, its own sequence number, the draft's content hash and the decision. Verification recomputes the chain from the database.</p>
        <div class="run-facts">
          <span><span class="label">entries</span><strong>${model.chain?.checked ?? 0}</strong></span>
          <span><span class="label">broken at</span><strong>${model.chain?.brokenAt ? shortId(model.chain.brokenAt) : '—'}</strong></span>
        </div>
        <button class="btn btn-sm" data-action="verify-chain">Re-verify</button>
      </div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function renderApp(model: Model): string {
  if (model.stage === 'boot') return renderBoot(model);
  if (model.stage === 'error') {
    return `<div class="boot"><div class="boot-panel">
      <span class="label">Startup failed</span>
      <h1>The database did not boot</h1>
      <pre class="code error-code">${esc(model.bootError ?? 'unknown error')}</pre>
      <p class="muted">The demo needs WebAssembly and a modern browser. The repository has the same tests running under Node.</p>
      <a class="btn" href="https://github.com/dev4aibots/ai-employee-platform">Open the repository</a>
    </div></div>`;
  }

  const body =
    model.view === 'overview'
      ? overview(model)
      : model.view === 'leads'
        ? leads(model)
        : model.view === 'approvals'
          ? approvals(model)
          : model.view === 'runs'
            ? runs(model)
            : isolation(model);

  return `<div class="shell">
    ${rail(model)}
    <div class="main">
      ${topbar(model)}
      <main class="content" id="content">${body}</main>
    </div>
  </div>
  ${
    model.toast
      ? `<div class="toast-stack"><div class="toast ${model.toast.kind}" role="status">
          ${model.toast.kind === 'ok' ? icon('check') : icon('close')}
          <span>${esc(model.toast.text)}</span>
          <button class="btn btn-icon btn-ghost" data-action="dismiss-toast" aria-label="Dismiss">${icon('close')}</button>
        </div></div>`
      : ''
  }`;
}

const BOOT_STEPS = [
  'Booting PostgreSQL 18 compiled to WebAssembly',
  'Applying schema, roles and row level security',
  'Seeding two tenants and 140 leads',
  'Running the sales play for Acme Robotics',
];

function renderBoot(model: Model): string {
  return `<div class="boot">
    <div class="boot-panel">
      <span class="brand-mark large" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <h1>AI Employee</h1>
      <p class="muted">Booting a real Postgres in this tab. No server, no keys, no fixtures shipped as JSON.</p>
      <ol class="boot-steps">
        ${BOOT_STEPS.map(
          (step, index) => `<li class="${index < model.bootStep ? 'done' : index === model.bootStep ? 'active' : ''}">
            <span class="boot-dot" aria-hidden="true">${index < model.bootStep ? icon('check') : ''}</span>
            <span>${esc(step)}</span>
          </li>`,
        ).join('')}
      </ol>
    </div>
  </div>`;
}
