const STATES = new Set(['screen_off','verified_waiting','login_required','human_required','stopping','checking','switching','resuming','preparing','running','recovering','idle']);
const escape = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderLookupCardStatus(occupancy) {
  const item = occupancy?.lookup;
  if (!item || !STATES.has(item.state)) return '';
  const human = ['human_required','login_required'].includes(item.state) && item.needsHuman === true;
  const tone = human ? 'human' : item.state === 'idle' ? 'ready' : ['screen_off','checking','recovering'].includes(item.state) ? 'warning' : 'normal';
  return `<div class="lookup-card-status is-${tone}" data-lookup-state="${item.state}" title="${escape(item.hint)}">
    <span class="lookup-card-status-mark" aria-hidden="true">${human ? '!' : '·'}</span>
    <div><strong>${escape(item.label)}</strong><small>${escape(item.hint)}</small></div>
    ${human ? '<span class="lookup-card-status-action">需人工</span>' : ''}
  </div>`;
}
