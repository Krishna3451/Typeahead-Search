'use strict';

// ---- tiny DOM helpers ----
const $ = (id) => document.getElementById(id);
const els = {
  q: $('q'),
  dropdown: $('dropdown'),
  spinner: $('spinner'),
  searchBtn: $('searchBtn'),
  sourceBadge: $('sourceBadge'),
  hint: $('hint'),
  error: $('error'),
  result: $('result'),
  trending: $('trending'),
  trendingWindow: $('trendingWindow'),
  corpusCount: $('corpusCount'),
  modeHint: $('modeHint'),
};

const state = {
  mode: 'popular',
  items: [],
  active: -1,
  controller: null, // aborts the in-flight /suggest so stale responses can't win
};

const DEBOUNCE_MS = 180;
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function highlight(text, prefix) {
  const safe = escapeHtml(text);
  if (prefix && text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `<strong>${safe.slice(0, prefix.length)}</strong>${safe.slice(prefix.length)}`;
  }
  return safe;
}

// ---- debounce ----
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- suggestions ----
async function fetchSuggestions() {
  const q = els.q.value;
  if (q.trim() === '') {
    closeDropdown();
    hide(els.sourceBadge);
    return;
  }

  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  show(els.spinner);

  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(q)}&mode=${state.mode}`, {
      signal: state.controller.signal,
    });
    if (!res.ok) throw new Error(`suggest failed (${res.status})`);
    const data = await res.json();
    hide(els.error);
    state.items = data.suggestions || [];
    state.active = -1;
    renderDropdown(data.prefix);
    renderBadge(data);
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded by a newer keystroke
    showError(err.message);
  } finally {
    hide(els.spinner);
  }
}

function renderDropdown(prefix) {
  if (!state.items.length) {
    els.dropdown.innerHTML = `<li class="row"><span class="text muted">No matches for “${escapeHtml(prefix)}”</span></li>`;
    els.dropdown.hidden = false;
    return;
  }
  els.dropdown.innerHTML = state.items
    .map((it, i) => {
      const rec = it.recent ? `<span class="rec">+${it.recent} recent</span>` : '';
      return `<li class="row ${i === state.active ? 'active' : ''}" role="option" data-i="${i}">
        <span class="text">${highlight(it.query, prefix)}</span>
        <span style="display:flex;align-items:center">
          <span class="count">${Number(it.count).toLocaleString()}</span>${rec}
        </span>
      </li>`;
    })
    .join('');
  els.dropdown.hidden = false;
}

function renderBadge(data) {
  const b = els.sourceBadge;
  if (data.source === 'cache') {
    b.textContent = `⚡ cache hit · ${data.node} · ${data.latencyMs ?? 0} ms`;
    b.className = 'badge';
  } else if (data.source === 'index') {
    b.textContent = `↻ computed · cached to ${data.node} · ${data.latencyMs ?? 0} ms`;
    b.className = 'badge miss';
  } else {
    hide(b);
    return;
  }
  show(b);
}

function closeDropdown() {
  els.dropdown.hidden = true;
  els.dropdown.innerHTML = '';
  state.items = [];
  state.active = -1;
}

// ---- search submission ----
async function submitSearch(query) {
  const text = (query ?? els.q.value).trim();
  if (!text) return;
  els.q.value = text;
  closeDropdown();
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `search failed (${res.status})`);
    hide(els.error);
    els.result.innerHTML = `<b>✓ ${escapeHtml(data.message)}</b> — “${escapeHtml(text)}” recorded. It will climb suggestions &amp; trending as the count updates.`;
    show(els.result);
    loadTrending();
  } catch (err) {
    showError(err.message);
  }
}

// ---- trending ----
async function loadTrending() {
  try {
    const res = await fetch(`/trending?n=10`);
    if (!res.ok) return;
    const data = await res.json();
    els.trendingWindow.textContent = `last ${Math.round((data.windowMs || 0) / 60000)} min · ${data.activeQueries} active`;
    if (!data.trending || !data.trending.length) {
      els.trending.innerHTML = `<li class="muted">No recent searches yet — submit a few to see trending update.</li>`;
      return;
    }
    els.trending.innerHTML = data.trending
      .map(
        (t, i) => `<li>
          <span class="num">${i + 1}</span>
          <span class="tq" data-q="${escapeHtml(t.query)}">${escapeHtml(t.query)}</span>
          <span class="tc">${t.recent} recent · ${Number(t.count).toLocaleString()} total</span>
        </li>`
      )
      .join('');
  } catch (_) {
    /* trending is best-effort */
  }
}

// ---- small UI utils ----
function show(el) {
  el.hidden = false;
}
function hide(el) {
  el.hidden = true;
}
function showError(msg) {
  els.error.textContent = `⚠ ${msg}`;
  show(els.error);
}

// ---- events ----
els.q.addEventListener('input', debounce(fetchSuggestions, DEBOUNCE_MS));

els.q.addEventListener('keydown', (e) => {
  const n = state.items.length;
  if (e.key === 'ArrowDown' && n) {
    e.preventDefault();
    state.active = (state.active + 1) % n;
    renderDropdown(els.q.value);
  } else if (e.key === 'ArrowUp' && n) {
    e.preventDefault();
    state.active = (state.active - 1 + n) % n;
    renderDropdown(els.q.value);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    submitSearch(state.active >= 0 ? state.items[state.active].query : els.q.value);
  } else if (e.key === 'Escape') {
    closeDropdown();
  }
});

// mousedown (not click) so the input doesn't blur before we read the target
els.dropdown.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.row');
  if (!row || row.dataset.i === undefined) return;
  e.preventDefault();
  submitSearch(state.items[Number(row.dataset.i)].query);
});

els.searchBtn.addEventListener('click', () => submitSearch());

els.trending.addEventListener('click', (e) => {
  const tq = e.target.closest('.tq');
  if (tq) {
    els.q.value = tq.dataset.q;
    submitSearch(tq.dataset.q);
  }
});

document.querySelectorAll('.mode').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('is-active');
    btn.setAttribute('aria-selected', 'true');
    state.mode = btn.dataset.mode;
    els.modeHint.textContent =
      state.mode === 'trending'
        ? 'recency-aware: recent bursts ranked higher'
        : 'sorted by all-time search count';
    fetchSuggestions();
  });
});

document.addEventListener('click', (e) => {
  if (!els.q.contains(e.target) && !els.dropdown.contains(e.target)) closeDropdown();
});

// ---- boot ----
async function boot() {
  try {
    const res = await fetch('/stats');
    const data = await res.json();
    els.corpusCount.textContent = Number(data.indexedQueries || 0).toLocaleString();
  } catch (_) {
    els.corpusCount.textContent = 'many';
  }
  loadTrending();
  setInterval(loadTrending, 7000);
}
boot();
