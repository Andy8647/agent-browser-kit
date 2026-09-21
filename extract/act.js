/* act.js — act on a candidate by its data-bench-idx (set by extract.js).
 *
 * Pass this as the body of your MCP client's evaluate_script, with args
 * (idx, action, text):
 *   ("5", "click")          — DOM click with occlusion check
 *   ("2", "fill", "standard_user")
 *   ("3", "select", "hilo") — select by option value
 *
 * Why DOM click instead of synthetic mouse events: measured 2026-09-20,
 * Puppeteer-style mouse events (including the mouseMoved prelude) do NOT
 * trigger React onClick handlers. el.click() does. Use real input events
 * only for canvas/drag scenarios.
 *
 * Fill uses the native setter trick so React controlled components
 * register the change (direct el.value assignment is invisible to React).
 *
 * Returns a JSON-serializable result: {ok, ...} or {ok: false, reason}.
 */
(idx, action, text) => {
  const el = document.querySelector(`[data-bench-idx="${idx}"]`);
  if (!el) return { ok: false, reason: `no element with data-bench-idx=${idx} — re-run extract.js (indices drift after every page change)` };

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  if (action === 'click') {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const occluded = top && !el.contains(top) && !top.contains(el);
    if (occluded) {
      return { ok: false, reason: 'occluded', by: norm(top.innerText || top.tagName).slice(0, 80) };
    }
    el.click();
    return { ok: true, action: 'click', idx };
  }

  if (action === 'fill') {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, action: 'fill', idx, value: norm(el.value).slice(0, 50) };
  }

  if (action === 'select') {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, action: 'select', idx, value: el.value };
  }

  if (action === 'toggle') {
    el.click();
    return { ok: true, action: 'toggle', idx, checked: el.checked === true };
  }

  return { ok: false, reason: `unknown action ${action}` };
}
