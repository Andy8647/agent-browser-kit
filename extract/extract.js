/* Element-table extractor: runs inside the page, produces Jev's input +
 * a clickable candidate index.
 *
 * Key design point (from smoke tests, 2026-09-20):
 *   Decision accuracy depends on the QUALITY OF DISAMBIGUATION CONTEXT,
 *   not on model strength. Two buttons with identical text (e.g. 16×
 *   "Add to cart") can only be told apart via context, so every candidate
 *   carries `context` (nearest titled container or aria-label).
 *
 * Usage: pass this entire file as the expression to CDP Runtime.evaluate,
 * or as the function body of your MCP client's evaluate_script.
 * Returns a JSON-serializable object.
 */
(() => {
  const MAX_CANDIDATES = 120;
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], label[for]';

  // Clear last round's markers to prevent index drift.
  document.querySelectorAll('[data-bench-idx]').forEach((e) => e.removeAttribute('data-bench-idx'));

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    // Off-viewport elements are kept (they can be scrolled to);
    // only zero-size ones are excluded.
    return true;
  };

  const accessibleName = (el) => {
    const al = norm(el.getAttribute('aria-label'));
    if (al) return al;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => norm(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
      if (t) return t;
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const id = el.id;
      const lbl = id ? norm(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : '';
      const type = (el.getAttribute('type') || '').toLowerCase();
      const isBtn = ['submit', 'button', 'reset'].includes(type);
      // Button-like inputs use value as the label; text fields must NOT use
      // value (that's user-typed content, not a name).
      if (isBtn) return lbl || norm(el.value) || norm(el.getAttribute('name')) || 'button';
      return lbl || norm(el.getAttribute('placeholder')) || norm(el.getAttribute('name')) || norm(el.id) || '';
    }
    return norm(el.innerText || el.textContent) || norm(el.getAttribute('title')) || norm(el.getAttribute('alt')) || norm(el.value) || '';
  };

  /* The "name" inside a card. Prefer elements whose class looks like
     name/title, then headings, then the first link.
     Note: on real sites a product name is often <div class="..._name">,
     not an <h*>, so headings alone are not enough. */
  const labelIn = (container, selfText) => {
    const nodes = container.querySelectorAll('[class*=name],[class*=title],[itemprop=name],h1,h2,h3,h4,h5,h6,a');
    for (const c of nodes) {
      const t = norm(c.innerText || c.textContent);
      if (t && t.length <= 80 && t !== selfText) return t;
    }
    return '';
  };

  /* Disambiguation context (the critical piece of the whole scheme).
     Hard-won lesson (2026-09-20): with 6 buttons all labeled "Add to cart"
     and no context, a decision model can only guess — task fails. So we use
     a 4-layer progressive heuristic:
       1) an ancestor whose class looks like card|item|product|result|...
       2) repeated siblings: ≥3 siblings with the same tag+class = list item
       3) semantic containers (LI/ARTICLE/TR/SECTION/FIGURE)
       4) explicit heading or aria-label
     Then grab a "name" from inside that container. */
  const contextOf = (el) => {
    const selfText = norm(el.innerText || el.textContent || el.value);
    let n = el.parentElement, hops = 0;
    while (n && hops < 10 && n !== document.body) {
      const cls = String(n.className || '');
      if (/card|item|product|result|tile|row|entry|listing/i.test(cls)) {
        const t = labelIn(n, selfText);
        if (t) return t.slice(0, 70);
      }
      const p = n.parentElement;
      if (p) {
        const sibs = [...p.children].filter((c) => c.tagName === n.tagName && String(c.className) === String(n.className));
        if (sibs.length >= 3) {
          const t = labelIn(n, selfText);
          if (t) return t.slice(0, 70);
        }
      }
      if (/^(LI|ARTICLE|TR|SECTION|FIGURE)$/.test(n.tagName)) {
        const t = labelIn(n, selfText);
        if (t) return t.slice(0, 70);
      }
      const h = n.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6');
      if (h) { const t = norm(h.innerText || h.textContent); if (t) return t.slice(0, 70); }
      const al = norm(n.getAttribute && n.getAttribute('aria-label'));
      if (al && al.length < 70) return al;
      n = n.parentElement; hops++;
    }
    return '';
  };

  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'LABEL') return 'label';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return tag.toLowerCase();
  };

  const actionOf = (el) => {
    const r = roleOf(el);
    if (r === 'combobox' && el.tagName === 'SELECT') return 'select';
    if (r === 'textbox' || r === 'textarea' || r === 'searchbox') return 'fill';
    if (r === 'checkbox' || r === 'radio' || r === 'switch') return 'toggle';
    return 'click';
  };

  const cands = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (cands.length >= MAX_CANDIDATES) break;
    if (!visible(el)) continue;
    const role = roleOf(el);
    const action = actionOf(el);
    const name = accessibleName(el);
    const ctx = contextOf(el);

    let opts = [];
    if (action === 'select') {
      opts = Array.from(el.options || [])
        .filter((o, i) => i > 0 || o.value !== '') // skip placeholder entries
        .slice(0, 12)
        .map((o) => ({ label: norm(o.textContent).slice(0, 40), value: o.value }));
    }

    const idx = cands.length + 1;
    el.setAttribute('data-bench-idx', String(idx));
    cands.push({
      idx, role, action, name: name.slice(0, 90), context: ctx,
      inputType: el.getAttribute('type') || '', selectOptions: opts,
      // Current state: the decision model uses it to tell whether a step is
      // already done (without it, the same control gets clicked repeatedly).
      value: action === 'fill' ? norm(el.value).slice(0, 50) : norm(el.value).slice(0, 30),
      checked: el.checked === true,
    });

    /* <select>: expose each option as its own candidate.
       Reason (measured 2026-09-20): if only the dropdown itself is listed,
       the loop can't know which option to pick and keeps re-operating the
       same dropdown. The decider needs "Price (high to low)" as a direct
       candidate. */
    if (action === 'select') {
      for (const o of opts) {
        if (cands.length >= MAX_CANDIDATES) break;
        const sel = o.value === '' ? o.label : o.value;
        cands.push({
          idx: cands.length + 1, // display numbering only; options get no DOM marker
          role: 'option',
          action: 'select_option',
          name: o.label || o.value,
          context: `${name} — dropdown entry` + (o.value === el.value ? ' (currently selected)' : ''),
          inputType: '', selectOptions: [],
          value: '', checked: false,
          target: { selectIdx: idx, optionValue: sel },
        });
      }
    }
  }

  return {
    url: location.href,
    title: document.title,
    candidates: cands,
    totalMatched: document.querySelectorAll(SEL).length,
    truncated: Math.max(0, document.querySelectorAll(SEL).length - cands.length),
  };
})()
