// Explicit, calendar-valid ISO dates only. Date-only deadlines begin at 00:00 UTC.
export const LIFECYCLE_FIELDS = Object.freeze(['retirement_date','retired_at','expiration_date']);
export function validDeadline(value) {
  if (typeof value !== 'string') return false;
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const date=new Date(Date.UTC(+match[1],+match[2]-1,+match[3]));
  return date.toISOString().slice(0,10)===match.slice(1,4).join('-');
}
export function explicitDeadlines(records) {
  return [...new Set(records.flatMap(raw=>LIFECYCLE_FIELDS.map(field=>raw?.[field]).filter(validDeadline)))];
}
export function lifecycle(raw,now=Date.now()) {
  const status=String(raw?.status??raw?.lifecycle??'').toLowerCase();
  if(raw?.retired===true || ['retired','discontinued','removed'].includes(status) || explicitDeadlines([raw]).some(d=>Date.parse(d)<=now)) return 'retired';
  return status==='deprecated'||raw?.deprecated===true?'deprecated':'active';
}
