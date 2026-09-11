/* Bucks Nonprofit Connection — community events calendar */

// Flip to false to keep organizer email and phone off the public page.
// The sheet keeps them either way.
const SHOW_CONTACT = true;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const state = {
  events: [],
  filtered: [],
  query: '',
  view: 'list',
  monthCursor: null,   // Date pinned to the 1st of the displayed month
  dateCounts: {},      // ISO date -> number of events, for conflict flags
};

const el = (id) => document.getElementById(id);

function wireLightbox() {
  const box = el('lightbox');
  const img = el('lightbox-img');
  let lastFocus = null;

  const close = () => {
    box.hidden = true;
    img.removeAttribute('src');
    if (lastFocus) lastFocus.focus();
  };

  // Delegated, because event rows are replaced on every render.
  document.addEventListener('click', (e) => {
    const thumb = e.target.closest('.event-thumb, .detail-image');
  if (!thumb) return;
    lastFocus = thumb;
    img.src = thumb.src;
    img.alt = thumb.alt || '';
    box.hidden = false;
    el('lightbox-close').focus();
  });

  box.addEventListener('click', (e) => {
    if (e.target === box || e.target.id === 'lightbox-close') close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !box.hidden) close();
  });


}

/* ------------------------------------------------------------------ init */

document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  loadEvents();
  wireViews();
  wireSearch();
  wireForm();
  wireLightbox();
  wireEventModal();
});

/* ---------------------------------------------------------------- config */

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.turnstileSiteKey) mountTurnstile(data.turnstileSiteKey);
  } catch (err) {
    // Turnstile is optional; the form still works without it.
  }
}

function mountTurnstile(siteKey) {
  const slot = el('turnstile-slot');
  const box = document.createElement('div');
  box.className = 'cf-turnstile';
  box.dataset.sitekey = siteKey;
  slot.appendChild(box);

  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

/* ---------------------------------------------------------------- events */

async function loadEvents() {
  const body = el('list-body');
  body.innerHTML = '<div class="empty">Loading events…</div>';

  try {
    const res = await fetch('/api/events');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Bad response');

    state.events = data.events || [];
    indexDates();
    applyFilter();
    syncFromHash()
  } catch (err) {
    body.innerHTML =
      '<div class="empty"><strong>The calendar did not load.</strong>' +
      'Refresh the page, or try again in a few minutes.</div>';
  }
  

}

function indexDates() {
  state.dateCounts = {};
  for (const ev of state.events) {
    if (!ev.startDate) continue;
    state.dateCounts[ev.startDate] = (state.dateCounts[ev.startDate] || 0) + 1;
  }
}

function applyFilter() {
  const q = state.query.trim().toLowerCase();

  state.filtered = !q ? state.events.slice() : state.events.filter((ev) => {
    const hay = [
      ev.eventName, ev.organizerName, ev.description, ev.locationName,
      ev.locationAddress, ev.locationCityStateZip, ev.eventType, ev.cost,
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });

  const n = state.filtered.length;
  el('result-count').textContent =
    n === 0 ? 'No events match.' : n === 1 ? '1 event' : n + ' events';

  if (state.view === 'list') renderList();
  else renderMonth();
}

/* ------------------------------------------------------------- list view */

function renderList() {
  const body = el('list-body');

  if (!state.filtered.length) {
    body.innerHTML =
      '<div class="empty"><strong>Nothing here yet.</strong>' +
      (state.query
        ? 'No events match that search. Try a broader term.'
        : 'Be the first to add an event using the form below.') +
      '</div>';
    return;
  }

  let html = '';
  let currentMonth = '';

  for (const ev of state.filtered) {
    const start = parseISODate(ev.startDate);
    if (!start) continue;

    const monthKey = start.getFullYear() + '-' + start.getMonth();
    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      html += '<h2 class="month-heading">' +
        start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) +
        '</h2>';
    }
    html += eventRow(ev, start);
  }

  body.innerHTML = html;
}

function eventRow(ev, start) {
  const end = parseISODate(ev.endDate);
  const multiDay = end && ev.endDate !== ev.startDate;
  const conflicts = state.dateCounts[ev.startDate] || 0;

  const rail =
    '<div class="rail">' +
      '<span class="rail-weekday">' +
        start.toLocaleDateString('en-US', { weekday: 'short' }) +
      '</span>' +
      '<span class="rail-day">' + start.getDate() + '</span>' +
      (multiDay
        ? '<span class="rail-through">through ' +
            end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
          '</span>'
        : '') +
    '</div>';

  const meta = [];
  const times = formatTimeRange(ev.startTime, ev.endTime);
  if (times) meta.push(times);

  const place = [ev.locationName, ev.locationAddress, ev.locationCityStateZip]
    .filter(Boolean).join(', ');
  if (place) meta.push(place);

  if (SHOW_CONTACT) {
    const contact = [ev.organizerEmail, ev.organizerPhone].filter(Boolean).join(' · ');
    if (contact) meta.push(contact);
  }

  const tags = [];
  if (ev.cost) tags.push('<span class="tag tag-cost">' + esc(ev.cost) + '</span>');
  // if (ev.eventType) tags.push('<span class="tag">' + esc(ev.eventType) + '</span>');
  if (ev.organizerName) tags.push('<span class="tag">' + esc(ev.organizerName) + '</span>');

  const title = '<a href="#event/' + esc(ev.id) + '" class="event-open" data-id="' +
    esc(ev.id) + '">' + esc(ev.eventName) + '</a>';

  const thumb = ev.eventImage
    ? '<img class="event-thumb" src="' + esc(ev.eventImage) + '" alt="" loading="lazy">'
    : '';

  return '<article class="event">' + rail +
    '<div class="event-body">' +
      '<div>' +
        '<h3 class="event-title">' + title + '</h3>' +
        '<p class="event-meta">' +
          meta.map((m) => '<span>' + esc(m) + '</span>').join('') +
        '</p>' +
        '<p class="event-desc">' + esc(truncate(ev.description, 260)) + '</p>' +
        '<div class="event-tags">' + tags.join('') + '</div>' +
        (conflicts > 1
          ? '<span class="conflict">' + conflicts +
            ' events share this date — check before scheduling</span>'
          : '') +
      '</div>' + thumb +
    '</div>' +
  '</article>';
}

/* ------------------------------------------------------------ month view */

function renderMonth() {
  if (!state.monthCursor) {
    const first = state.filtered.find((ev) => parseISODate(ev.startDate));
    const seed = first ? parseISODate(first.startDate) : new Date();
    state.monthCursor = new Date(seed.getFullYear(), seed.getMonth(), 1);
  }

  const cursor = state.monthCursor;
  el('month-label').textContent =
    cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayISO = toISO(new Date());

  // Bucket events by every date they span, so multi-day events show on each day.
  const byDate = {};
  for (const ev of state.filtered) {
    const start = parseISODate(ev.startDate);
    if (!start) continue;
    const end = parseISODate(ev.endDate) || start;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = toISO(d);
      (byDate[key] = byDate[key] || []).push(ev);
    }
  }

  let html = '';
  for (let i = 0; i < firstWeekday; i++) html += '<div class="day is-outside"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = toISO(new Date(year, month, day));
    const dayEvents = byDate[iso] || [];
    const classes = ['day'];
    if (iso === todayISO) classes.push('is-today');
    if (dayEvents.length > 1) classes.push('has-conflict');

    html += '<div class="' + classes.join(' ') + '">' +
      '<span class="day-num">' + day + '</span>' +
      dayEvents.map((ev) =>
        '<button type="button" class="day-event" data-date="' + iso + '" ' +
        'title="' + esc(ev.eventName) + '">' + esc(truncate(ev.eventName, 34)) + '</button>'
      ).join('') +
    '</div>';
  }

  const grid = el('month-grid');
  grid.innerHTML = html;

  // Clicking an event jumps to that date in the list view.
  grid.querySelectorAll('.day-event').forEach((btn) => {
    btn.addEventListener('click', () => {
      setView('list');
      const target = document.querySelector('.event');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

/* --------------------------------------------------------------- wiring */

function wireViews() {
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  el('month-prev').addEventListener('click', () => shiftMonth(-1));
  el('month-next').addEventListener('click', () => shiftMonth(1));
}

function setView(view) {
  state.view = view;

  document.querySelectorAll('.view-btn').forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  el('list-view').hidden = view !== 'list';
  el('month-view').hidden = view !== 'month';

  if (view === 'list') renderList();
  else renderMonth();
}

function shiftMonth(delta) {
  const c = state.monthCursor || new Date();
  state.monthCursor = new Date(c.getFullYear(), c.getMonth() + delta, 1);
  renderMonth();
}

function wireSearch() {
  let timer;
  el('search-input').addEventListener('input', (e) => {
    clearTimeout(timer);
    const value = e.target.value;
    timer = setTimeout(() => {
      state.query = value;
      state.monthCursor = null;   // re-seed month view to the first match
      applyFilter();
    }, 180);
  });
}

/* ------------------------------------------------------------------ form */

const FIELD_MAP = {
  'Event Name': 'f-name',
  'Organizer Name': 'f-org-name',
  'Organizer Phone': 'f-org-phone',
  'Organizer Email': 'f-org-email',
  'Start Date': 'f-start-date',
  'Start Time': 'f-start-time',
  'End Date': 'f-end-date',
  'End Time': 'f-end-time',
  'Event Type': 'f-type',
  'Expected Attendance': 'f-attendance',
  'Location Name': 'f-loc-name',
  'Location Address': 'f-loc-address',
  'Location City State Zip': 'f-loc-csz',
  'Location Phone': 'f-loc-phone',
  'Description': 'f-description',
  'Cost': 'f-cost',
  'Website': 'f-website',
  'Comments for BNC': 'f-comments',
  'Submitted By':'f-submitted-by',
};

const REQUIRED = [
  'Event Name', 'Organizer Name', ,
  'Start Date', 'Event Type', 'Location Name', 'Description', 
];

function wireForm() {
  const form = el('event-form');
  const typeSelect = el('f-type');

  // A street address only makes sense when people physically show up.
  // const syncAddress = () => {
  //   const virtual = typeSelect.value === 'Virtual';
  //   el('addr-req').style.display = virtual ? 'none' : '';
  //   el('loc-name-help').textContent = virtual
  //     ? 'Name the platform, such as Zoom.'
  //     : 'For virtual events, name the platform.';
  // };
  // typeSelect.addEventListener('change', syncAddress);
  // syncAddress();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitForm();
  });
}

async function submitForm() {
  const button = el('form-submit');
  const status = el('form-status');

  const event = {};
  for (const [key, id] of Object.entries(FIELD_MAP)) {
    event[key] = el(id).value.trim();
  }

  // Clear any prior invalid marks before revalidating.
  Object.values(FIELD_MAP).forEach((id) => el(id).removeAttribute('aria-invalid'));

  const missing = REQUIRED.filter((k) => !event[k]);
  // if (event['Event Type'] !== 'Virtual' && !event['Location Address']) {
  //   missing.push('Street Address');
  // }

  if (missing.length) {
    missing.forEach((k) => {
      const id = k === 'Street Address' ? 'f-loc-address' : FIELD_MAP[k];
      if (id) el(id).setAttribute('aria-invalid', 'true');
    });
    setStatus(status, 'Fill in the highlighted fields, then add your event again.', 'is-error');
    const firstBad = document.querySelector('[aria-invalid="true"]');
    if (firstBad) firstBad.focus();
    return;
  }

  if (event['End Date'] && event['End Date'] < event['Start Date']) {
    el('f-end-date').setAttribute('aria-invalid', 'true');
    setStatus(status, 'The end date comes before the start date.', 'is-error');
    return;
  }

  let image = null;
  const file = el('f-image').files[0];
  if (file) {
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus(status, 'That image is over 5 MB. Choose a smaller one.', 'is-error');
      return;
    }
    try {
      image = {
        name: file.name,
        mimeType: file.type,
        dataBase64: await fileToBase64(file),
      };
    } catch (err) {
      setStatus(status, 'That image could not be read. Try a different file.', 'is-error');
      return;
    }
  }

  const tokenField = document.querySelector('[name="cf-turnstile-response"]');

  button.disabled = true;
  setStatus(status, 'Adding your event…', '');

  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event,
        image,
        website2: el('f-website2').value,
        turnstileToken: tokenField ? tokenField.value : '',
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      setStatus(status, data.error || 'The event was not added.', 'is-error');
      button.disabled = false;
      return;
    }

    insertLocally(event, data.id, file);
    el('event-form').reset();
    setStatus(status, 'Added. Your event is on the calendar.', 'is-ok');
    button.disabled = false;

    if (window.turnstile) window.turnstile.reset();
  } catch (err) {
    setStatus(status, 'The event could not be sent. Check your connection and try again.', 'is-error');
    button.disabled = false;
  }
}

/**
 * Shows a just-submitted event immediately, without refetching.
 *
 * KV is eventually consistent, so /api/events can serve a cached copy for up
 * to a minute after handleSubmit purges it. The row is already safely in the
 * sheet — this only fixes what the submitter sees in the meantime. Everyone
 * else picks it up on the normal cycle.
 */
function insertLocally(fields, id, file) {
  // doGet drops past events, so don't show one the server would omit.
  if (fields['Start Date'] < toISO(new Date())) return;

  const ev = { id: id || 'pending' };
  const map = {
    'Event Name': 'eventName',
    'Organizer Name': 'organizerName',
    'Organizer Phone': 'organizerPhone',
    'Organizer Email': 'organizerEmail',
    'Start Date': 'startDate',
    'Start Time': 'startTime',
    'End Date': 'endDate',
    'End Time': 'endTime',
    'Event Type': 'eventType',
    'Expected Attendance': 'expectedAttendance',
    'Location Name': 'locationName',
    'Location Address': 'locationAddress',
    'Location City State Zip': 'locationCityStateZip',
    'Location Phone': 'locationPhone',
    'Description': 'description',
    'Cost': 'cost',
    'Website': 'website',
  };
  for (const [from, to] of Object.entries(map)) ev[to] = fields[from] || '';

  // Local preview of the upload — the Drive URL arrives on the next real fetch.
  if (file) ev.eventImage = URL.createObjectURL(file);

  state.events.push(ev);
  state.events.sort((a, b) =>
    (a.startDate + (a.startTime || '00:00'))
      .localeCompare(b.startDate + (b.startTime || '00:00'))
  );

  indexDates();
  applyFilter();
}

function setStatus(node, message, cls) {
  node.textContent = message;
  node.className = 'form-status' + (cls ? ' ' + cls : '');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/* --------------------------------------------------------------- helpers */

/** Build a local Date. `new Date('2026-09-05')` parses as UTC and shifts the
 *  day backward for anyone west of Greenwich. */
function parseISODate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toISO(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + m + '-' + d;
}

function formatTimeRange(start, end) {
  const a = formatTime(start);
  const b = formatTime(end);
  if (a && b) return a + ' to ' + b;
  return a || '';
}

function formatTime(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return hour + ':' + String(m).padStart(2, '0') + ' ' + period;
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : s.slice(0, max).trimEnd() + '…';
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ----------------------------------------------------------- event modal */

function wireEventModal() {
  document.addEventListener('click', (e) => {
    // The image has its own job (lightbox), and real links should behave
    // like links — middle-click, ctrl-click, open in new tab.
    if (e.target.closest('.event-thumb')) return;
    if (e.target.closest('a') && !e.target.closest('.event-open')) return;

    // Don't hijack a click that ended a text selection.
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    const row = e.target.closest('.event');
    if (!row) return;

    const link = row.querySelector('.event-open');
    if (!link) return;

    e.preventDefault();
    const id = link.dataset.id;
    history.pushState({ eventId: id }, '', '#event/' + encodeURIComponent(id));
    openEvent(id);
  });

  el('event-modal').addEventListener('click', (e) => {
    if (e.target.id === 'event-modal' || e.target.id === 'event-modal-close') closeEvent();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('event-modal').hidden) closeEvent();
  });

  window.addEventListener('popstate', syncFromHash);
}

/** Opens the modal if the URL points at an event. Runs after events load. */
function syncFromHash() {
  const match = location.hash.match(/^#event\/(.+)$/);
  if (match) openEvent(decodeURIComponent(match[1]));
  else hideModal();
}

function openEvent(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;                       // stale link, or events not loaded yet
  el('event-modal-body').innerHTML = eventDetail(ev);
  el('event-modal').hidden = false;
  document.body.style.overflow = 'hidden';
  el('event-modal-close').focus();
}

function closeEvent() {
  // Back, so the URL and history stay in step.
  if (location.hash.startsWith('#event/')) history.back();
  else hideModal();
}

function hideModal() {
  el('event-modal').hidden = true;
  el('event-modal-body').innerHTML = '';
  document.body.style.overflow = '';
}

function eventDetail(ev) {
  const start = parseISODate(ev.startDate);
  const end = parseISODate(ev.endDate);
  const times = formatTimeRange(ev.startTime, ev.endTime);

  const whenParts = [longDate(start)];
  if (end && ev.endDate !== ev.startDate) whenParts.push('through ' + longDate(end));
  if (times) whenParts.push(times);

  const address = [ev.locationAddress, ev.locationCityStateZip].filter(Boolean).join(', ');

  const details = [
    ['Date', longDate(start)],
    ['Time', times],
    ['Cost', ev.cost],
    ['Type', ev.eventType],
    ['Website', ev.website
      ? '<a href="' + esc(ev.website) + '" target="_blank" rel="noopener noreferrer">' +
        esc(ev.website) + '</a>'
      : ''],
  ];

  const organizer = [
    ['Name', ev.organizerName],
    ['Phone', SHOW_CONTACT && ev.organizerPhone
      ? '<a href="tel:' + esc(ev.organizerPhone) + '">' + esc(ev.organizerPhone) + '</a>' : ''],
    ['Email', SHOW_CONTACT && ev.organizerEmail
      ? '<a href="mailto:' + esc(ev.organizerEmail) + '">' + esc(ev.organizerEmail) + '</a>' : ''],
  ];

  const venue = [
    ['Venue', ev.locationName],
    ['Address', address
      ? esc(address) + ' <a href="https://maps.google.com/maps?q=' +
        encodeURIComponent(address) + '" target="_blank" rel="noopener noreferrer">Map</a>'
      : ''],
    ['Phone', ev.locationPhone
      ? '<a href="tel:' + esc(ev.locationPhone) + '">' + esc(ev.locationPhone) + '</a>' : ''],
  ];

  const paragraphs = String(ev.description || '')
    .split(/\n+/)
    .filter(Boolean)
    .map((p) => '<p>' + esc(p) + '</p>')
    .join('');

  return (
    (ev.eventImage
      ? '<img class="detail-image" src="' + esc(ev.eventImage) + '" alt="">'
      : '') +
    '<h2 class="detail-title" id="event-modal-title">' + esc(ev.eventName) + '</h2>' +
    '<p class="detail-when">' + esc(whenParts.join(' · ')) + '</p>' +
    '<div class="detail-desc">' + paragraphs + '</div>' +
    block('Details', details) +
    block('Organizer', organizer) +
    block('Venue', venue) +
    '<div class="detail-actions">' +      (ev.website
        ? '<a href="' + esc(ev.website) + '" target="_blank" rel="noopener noreferrer">' +
          'Event website</a>'
        : '') +
      '<a href="' + googleCalendarUrl(ev) + '" target="_blank" rel="noopener noreferrer">' +
        'Add to Google Calendar</a>' +
          
    '</div>'
  );
}

/** Values are pre-escaped or intentional markup; keys never are. */
function block(heading, rows) {
  const live = rows.filter(([, value]) => value);
  if (!live.length) return '';
  return '<div class="detail-block"><h3>' + esc(heading) + '</h3><dl>' +
    live.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') +
    '</dl></div>';
}

function longDate(date) {
  if (!date) return '';
  return date.toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function googleCalendarUrl(ev) {
  const stamp = (iso, time) => iso.replace(/-/g, '') +
    (time ? 'T' + time.replace(':', '') + '00' : '');

  let dates;
  if (ev.startTime) {
    const endDate = ev.endDate || ev.startDate;
    const endTime = ev.endTime || ev.startTime;
    dates = stamp(ev.startDate, ev.startTime) + '/' + stamp(endDate, endTime);
  } else {
    // All-day events use an exclusive end date.
    const last = parseISODate(ev.endDate || ev.startDate);
    last.setDate(last.getDate() + 1);
    dates = ev.startDate.replace(/-/g, '') + '/' + toISO(last).replace(/-/g, '');
  }

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.eventName || '',
    details: ev.description || '',
    location: [ev.locationName, ev.locationAddress, ev.locationCityStateZip]
      .filter(Boolean).join(', '),
    dates,
    ctz: 'America/New_York',
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}