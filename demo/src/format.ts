/** Formatting helpers for the console. Every value rendered from the database goes through esc(). */

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

export function pct(value: number): string {
  if (!Number.isFinite(value)) return '0.0%';
  return `${(value * 100).toFixed(1)}%`;
}

export function money(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(2)}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 45) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function daysAgo(days: number): string {
  return `${days}d`;
}

export function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    new: 'New',
    qualified: 'Qualified',
    contacted: 'Contacted',
    replied: 'Replied',
    meeting: 'Meeting',
    won: 'Won',
    lost: 'Lost',
    disqualified: 'Disqualified',
  };
  return labels[stage] ?? stage;
}

export function stageTone(stage: string): string {
  switch (stage) {
    case 'won':
    case 'meeting':
      return 'ok';
    case 'replied':
      return 'info';
    case 'lost':
    case 'disqualified':
      return 'bad';
    case 'qualified':
      return 'accent';
    default:
      return '';
  }
}

export function bandTone(band: string): string {
  switch (band) {
    case 'hot':
      return 'bad';
    case 'warm':
      return 'warn';
    case 'cool':
      return 'info';
    default:
      return '';
  }
}

export function statusTone(status: string): string {
  switch (status) {
    case 'ok':
    case 'sent':
    case 'approved':
    case 'completed':
      return 'ok';
    case 'retried':
    case 'awaiting_approval':
    case 'pending':
      return 'warn';
    case 'failed':
    case 'rejected':
      return 'bad';
    case 'dry_run':
      return 'info';
    default:
      return '';
  }
}
