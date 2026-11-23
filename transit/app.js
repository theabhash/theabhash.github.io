/* My Commute — live buses + trains from Transport for NSW Open Data */
'use strict';

const TZ = 'Australia/Sydney';
const API = 'https://api.transport.nsw.gov.au';
const LS_KEY = 'commute.settings.v1';
const LS_STOPS = 'commute.stops.v1';
const BUS_EVERY = 20_000;    // bus positions refresh (ms)
const TRAIN_EVERY = 60_000;  // train times refresh (ms)

const DEFAULTS = {
  apiKey: '',
  proxy: '',
  buses: '1035, 4028',
  from: 'Glenfield Station',
  to: 'Redfern Station',
  cutover: 12,
};

/* ---------- storage (safe) ---------- */
function lsGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

let S = { ...DEFAULTS, ...lsGet(LS_KEY, {}) };
let dirMode = 'auto';
let lastVehicles = [];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- time helpers ---------- */
function sydParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}
function fmtTime(d) {
  return new Date(d).toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}
function minsUntil(d) { return Math.round((new Date(d) - Date.now()) / 60000); }
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}

/* ---------- API ---------- */
class ApiError extends Error {}

async function api(path, params = {}, binary = false) {
  const base = (S.proxy || '').trim().replace(/\/+$/, '') || API;
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
  const headers = {};
  if (S.apiKey.trim()) headers.Authorization = 'apikey ' + S.apiKey.trim();
  let res;
  try {
    res = await fetch(url, { headers, cache: 'no-store' });
  } catch (e) {
    throw new ApiError(S.proxy
      ? 'Could not reach your proxy. Check the proxy URL in Settings.'
      : 'Your browser blocked the request (network or CORS). Check your connection, or set up the proxy (see README).');
  }
  if (res.status === 401 || res.status === 403) throw new ApiError('API key rejected. Check the key in Settings, and that it has access to Trip Planner and Realtime Vehicle Positions.');
  if (!res.ok) throw new ApiError(`TfNSW API error ${res.status}`);
  return binary ? new Uint8Array(await res.arrayBuffer()) : res.json();
}

function needsKey() { return !S.apiKey.trim() && !S.proxy.trim(); }

/* ---------- tiny GTFS-realtime protobuf decoder ---------- */
// Only decodes what we need from FeedMessage -> FeedEntity -> VehiclePosition.
function pbFields(buf, start, end, cb) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = start;
  const varint = () => {
    let r = 0, m = 1, b;
    do { b = buf[p++]; r += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    return r;
  };
  while (p < end) {
    const tag = varint();
    const field = Math.floor(tag / 8), wire = tag % 8;
    let val;
    if (wire === 0) val = varint();
    else if (wire === 1) { val = dv.getFloat64(p, true); p += 8; }
    else if (wire === 2) { const len = varint(); val = [p, p + len]; p += len; }
    else if (wire === 5) { val = dv.getFloat32(p, true); p += 4; }
    else throw new Error('Unsupported protobuf wire type ' + wire);
    cb(field, wire, val);
  }
}
const td = new TextDecoder();
const pbStr = (buf, [s, e]) => td.decode(buf.subarray(s, e));

function decodeVehicles(buf) {
  const out = [];
  pbFields(buf, 0, buf.length, (f, w, v) => {
    if (f !== 2 || w !== 2) return; // entity
    const ent = {};
    pbFields(buf, v[0], v[1], (f2, w2, v2) => {
      if (f2 === 1 && w2 === 2) ent.entityId = pbStr(buf, v2);
      if (f2 !== 4 || w2 !== 2) return; // vehicle position
      pbFields(buf, v2[0], v2[1], (f3, w3, v3) => {
        if (f3 === 1 && w3 === 2) { // TripDescriptor
          pbFields(buf, v3[0], v3[1], (f4, w4, v4) => {
            if (w4 !== 2) return;
            if (f4 === 1) ent.tripId = pbStr(buf, v4);
            if (f4 === 2) ent.startTime = pbStr(buf, v4);
            if (f4 === 5) ent.routeId = pbStr(buf, v4);
          });
        } else if (f3 === 2 && w3 === 2) { // Position
          pbFields(buf, v3[0], v3[1], (f4, w4, v4) => {
            if (f4 === 1) ent.lat = v4;
            if (f4 === 2) ent.lon = v4;
            if (f4 === 3) ent.bearing = v4;
            if (f4 === 5) ent.speed = v4;
          });
        } else if (f3 === 5 && w3 === 0) ent.ts = v3 * 1000;
        else if (f3 === 7 && w3 === 2) ent.stopId = pbStr(buf, v3);
        else if (f3 === 9 && w3 === 0) ent.occupancy = v3;
        else if (f3 === 8 && w3 === 2) { // VehicleDescriptor
          pbFields(buf, v3[0], v3[1], (f4, w4, v4) => {
            if (w4 !== 2) return;
            if (f4 === 1) ent.vehicleId = pbStr(buf, v4);
            if (f4 === 2) ent.label = pbStr(buf, v4);
            if (f4 === 3) ent.plate = pbStr(buf, v4);
          });
        }
      });
      ent.ok = true;
    });
    if (ent.ok && typeof ent.lat === 'number') out.push(ent);
  });
  return out;
}

/* ---------- bus matching ---------- */
const tokens = (s) => String(s || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
const routeShort = (routeId) => (routeId ? String(routeId).split('_').pop() : '');

function matchBus(v, n) {
  if (routeShort(v.routeId) === n) return 'route';
  if ([v.vehicleId, v.label, v.plate].some((x) => tokens(x).includes(n))) return 'fleet';
  return null;
}
function targetBuses() {
  return S.buses.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/* ---------- map ---------- */
let map, busLayer, didFit = false;
function initMap() {
  if (!window.L) { $('#map').innerHTML = '<div class="empty">Map could not load.</div>'; return; }
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([-33.972, 150.892], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  busLayer = L.layerGroup().addTo(map);
}

function drawBuses(found) {
  if (!map) return;
  busLayer.clearLayers();
  const pts = [];
  for (const { n, v } of found) {
    const arrow = typeof v.bearing === 'number'
      ? `<span class="arrow" style="transform:rotate(${v.bearing}deg)">&#x2191;</span>` : '';
    const icon = L.divIcon({ className: '', html: `<span class="bus-pin">${esc(n)}${arrow}</span>`, iconSize: [0, 0] });
    L.marker([v.lat, v.lon], { icon }).addTo(busLayer)
      .bindPopup(`<b>Bus ${esc(n)}</b><br>Route ${esc(routeShort(v.routeId) || '?')}<br>${v.ts ? 'Updated ' + ago(v.ts) : ''}`);
    pts.push([v.lat, v.lon]);
  }
  if (pts.length && !didFit) {
    map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
    didFit = true;
  }
}

/* ---------- buses ---------- */
const OCC = ['Empty', 'Many seats', 'Few seats', 'Standing room', 'Crushed standing', 'Full', 'Not accepting'];

async function loadBuses() {
  const list = $('#busList');
  if (needsKey()) { list.innerHTML = '<div class="empty">Waiting for API key.</div>'; return; }
  try {
    const buf = await api('/v1/gtfs/vehiclepos/buses', {}, true);
    lastVehicles = decodeVehicles(buf);
    const found = [];
    const rows = targetBuses().map((n) => {
      const hits = lastVehicles.filter((v) => matchBus(v, n));
      hits.forEach((v) => found.push({ n, v }));
      if (!hits.length) {
        return `<div class="item"><span class="dot off"></span><span class="badge bus">${esc(n)}</span>
          <div class="main"><div class="title">Not running right now</div>
          <div class="meta">No live GPS for ${esc(n)} in the feed</div></div></div>`;
      }
      return hits.map((v) => {
        const how = matchBus(v, n);
        const speed = typeof v.speed === 'number' ? `${Math.round(v.speed * 3.6)} km/h` : '';
        const occ = typeof v.occupancy === 'number' ? OCC[v.occupancy] || '' : '';
        const meta = [
          how === 'route' ? `Route ${esc(n)}` : `Fleet ${esc(n)} · route ${esc(routeShort(v.routeId) || '?')}`,
          speed, occ,
        ].filter(Boolean).join(' · ');
        return `<div class="item tap" data-lat="${v.lat}" data-lon="${v.lon}">
          <span class="dot live"></span><span class="badge bus">${esc(n)}</span>
          <div class="main"><div class="title">Live on map</div><div class="meta">${meta}</div></div>
          <div class="right small">${v.ts ? ago(v.ts) : ''}</div></div>`;
      }).join('');
    });
    list.innerHTML = rows.join('');
    drawBuses(found);
    $('#busStamp').textContent = 'Updated ' + fmtTime(Date.now());
  } catch (e) {
    list.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

$('#busList').addEventListener('click', (e) => {
  const it = e.target.closest('.item.tap');
  if (it && map) {
    map.setView([+it.dataset.lat, +it.dataset.lon], 16);
    $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

/* ---------- trains ---------- */
const LINE_COLOURS = {
  T1: '#F99D1C', T2: '#0098CD', T3: '#F37021', T4: '#005AA3', T5: '#C4258F',
  T6: '#7D3F21', T7: '#6F818E', T8: '#00954C', T9: '#D11F2F',
};

async function stopId(name) {
  const cache = lsGet(LS_STOPS, {});
  if (cache[name]) return cache[name];
  const j = await api('/v1/tp/stop_finder', {
    outputFormat: 'rapidJSON', type_sf: 'any', name_sf: name,
    coordOutputFormat: 'EPSG:4326', TfNSWSF: 'true', version: '10.2.1.42',
  });
  const locs = (j.locations || []).filter((l) => l.type === 'stop');
  const best = locs.find((l) => l.isBest) || locs[0];
  if (!best) throw new ApiError(`Couldn't find station "${name}". Check the name in Settings.`);
  cache[name] = best.id;
  lsSet(LS_STOPS, cache);
  return best.id;
}

function direction() {
  if (dirMode === 'out') return 'out';
  if (dirMode === 'back') return 'back';
  return +sydParts().hour < +S.cutover ? 'out' : 'back';
}

const isWalk = (leg) => [99, 100].includes(leg.transportation?.product?.class);
const platformOf = (stop) => {
  const m = /Platform\s*([\w]+)/i.exec(stop?.disassembledName || stop?.name || '');
  return m ? m[1] : null;
};
const lineOf = (leg) => {
  const t = leg.transportation || {};
  return t.disassembledName || (t.number || '').split(' ')[0] || 'Train';
};

async function loadTrains() {
  const list = $('#trainList');
  const dir = direction();
  const [a, b] = dir === 'out' ? [S.from, S.to] : [S.to, S.from];
  $('#routeTitle').textContent = `${a.replace(/ Station$/i, '')} → ${b.replace(/ Station$/i, '')}`;
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x.dataset.dir === dirMode));
  const autoBtn = document.querySelector('.seg [data-dir="auto"]');
  autoBtn.textContent = dirMode === 'auto' ? `Auto (${dir === 'out' ? 'to city' : 'home'})` : 'Auto';
  if (needsKey()) { list.innerHTML = '<div class="empty">Waiting for API key.</div>'; return; }

  try {
    const [o, d] = await Promise.all([stopId(a), stopId(b)]);
    const p = sydParts();
    const j = await api('/v1/tp/trip', {
      outputFormat: 'rapidJSON', coordOutputFormat: 'EPSG:4326',
      depArrMacro: 'dep', itdDate: p.year + p.month + p.day, itdTime: p.hour + p.minute,
      type_origin: 'any', name_origin: o, type_destination: 'any', name_destination: d,
      calcNumberOfTrips: '6', TfNSWTR: 'true', version: '10.2.1.42',
      excludedMeans: 'checkbox', exclMOT_4: '1', exclMOT_5: '1', exclMOT_7: '1',
      exclMOT_9: '1', exclMOT_11: '1',
    });

    const journeys = (j.journeys || []).map((jr) => {
      const legs = (jr.legs || []).filter((l) => !isWalk(l));
      if (!legs.length) return null;
      const first = legs[0], last = legs[legs.length - 1];
      const depPlan = first.origin.departureTimePlanned;
      const dep = first.origin.departureTimeEstimated || depPlan;
      const arr = last.destination.arrivalTimeEstimated || last.destination.arrivalTimePlanned;
      const cancelled = legs.some((l) => (l.realtimeStatus || []).includes('CANCELLED') || l.isCancelled);
      return {
        legs, dep, depPlan, arr, cancelled,
        live: !!first.origin.departureTimeEstimated,
        delay: Math.round((new Date(dep) - new Date(depPlan)) / 60000),
        platform: platformOf(first.origin),
        towards: first.transportation?.destination?.name || '',
      };
    }).filter((x) => x && new Date(x.dep) > Date.now() - 30_000);

    if (!journeys.length) { list.innerHTML = '<div class="empty">No upcoming trains found.</div>'; return; }

    list.innerHTML = journeys.slice(0, 5).map((x) => {
      const m = minsUntil(x.dep);
      const badges = x.legs.map((l) => {
        const line = lineOf(l);
        return `<span class="badge" style="background:${LINE_COLOURS[line] || '#555'}">${esc(line)}</span>`;
      }).join(' ');
      const changes = x.legs.length - 1;
      let status;
      if (x.cancelled) status = '<span class="cancel">Cancelled</span>';
      else if (!x.live) status = '<span class="small">Scheduled</span>';
      else if (x.delay >= 2) status = `<span class="late">${x.delay} min late</span>`;
      else status = '<span class="ontime">On time</span>';
      const meta = [
        `${fmtTime(x.dep)} → ${fmtTime(x.arr)}`,
        x.platform ? `Platform ${esc(x.platform)}` : '',
        changes ? `${changes} change${changes > 1 ? 's' : ''}` : 'Direct',
      ].filter(Boolean).join(' · ');
      return `<div class="item">
        <div class="main">
          <div class="title">${badges} ${status}</div>
          <div class="meta">${meta}</div>
          ${x.towards ? `<div class="small">towards ${esc(x.towards)}</div>` : ''}
        </div>
        <div class="right"><div class="big">${m <= 0 ? 'Now' : m}</div><div class="small">${m <= 0 ? '' : 'min'}</div></div>
      </div>`;
    }).join('');
    $('#trainStamp').textContent = 'Updated ' + fmtTime(Date.now());
  } catch (e) {
    list.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

document.querySelector('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  dirMode = b.dataset.dir;
  loadTrains();
});

/* ---------- refresh loop ---------- */
let busTimer, trainTimer;
async function refreshAll() {
  const btn = $('#refreshBtn');
  btn.classList.add('spin');
  $('#setupBanner').hidden = !needsKey();
  await Promise.allSettled([loadBuses(), loadTrains()]);
  btn.classList.remove('spin');
}
function startTimers() {
  clearInterval(busTimer); clearInterval(trainTimer);
  busTimer = setInterval(() => { if (!document.hidden) loadBuses(); }, BUS_EVERY);
  trainTimer = setInterval(() => { if (!document.hidden) loadTrains(); }, TRAIN_EVERY);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
$('#refreshBtn').addEventListener('click', refreshAll);

function tickClock() {
  $('#clock').textContent = new Date().toLocaleString('en-AU', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}
setInterval(tickClock, 15_000);

/* ---------- settings ---------- */
const dlg = $('#settings');
const form = $('#settingsForm');
function openSettings() {
  for (const k of Object.keys(DEFAULTS)) form.elements[k].value = S[k];
  renderFinder();
  dlg.showModal();
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#openSettings2').addEventListener('click', openSettings);
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  const old = S;
  S = { ...S };
  for (const k of Object.keys(DEFAULTS)) S[k] = form.elements[k].value.trim();
  S.cutover = Math.min(23, Math.max(0, parseInt(S.cutover, 10) || DEFAULTS.cutover));
  S.from = S.from || DEFAULTS.from;
  S.to = S.to || DEFAULTS.to;
  lsSet(LS_KEY, S);
  if (old.from !== S.from || old.to !== S.to) lsSet(LS_STOPS, {});
  didFit = false;
  refreshAll();
});

function renderFinder() {
  const q = $('#finderInput').value.trim().toLowerCase();
  const out = $('#finderOut');
  if (!q) { out.innerHTML = lastVehicles.length ? `<span class="hint">${lastVehicles.length} buses in the latest feed.</span>` : ''; return; }
  const hits = lastVehicles.filter((v) =>
    [v.routeId, v.vehicleId, v.label, v.plate, v.tripId].some((x) => String(x || '').toLowerCase().includes(q))).slice(0, 25);
  out.innerHTML = hits.length
    ? hits.map((v) => `<div><b>route</b> ${esc(v.routeId)} · <b>vehicle</b> ${esc(v.vehicleId)}${v.label ? ' · <b>label</b> ' + esc(v.label) : ''}${v.plate ? ' · <b>plate</b> ' + esc(v.plate) : ''}</div>`).join('')
    : '<span class="hint">No live buses match.</span>';
}
$('#finderInput').addEventListener('input', renderFinder);

/* ---------- boot ---------- */
tickClock();
initMap();
refreshAll();
startTimers();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
