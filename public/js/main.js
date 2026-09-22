import { setupTrams } from './trams.js';
import { fetchVelos } from './velos.js';
import { fetchParkings } from './parkings.js';
import { fetchStationnement } from './stationnement.js';
import { API_BASE } from './config.js';
import { escapeHtml } from './util.js';
import { createSheet } from './sheet.js';

const LINE_COLORS = { '1': '#0055A4', '2': '#E87200', '3': '#96A800', '4': '#9A7B4F', '5': '#5FB3E4' };
const LINE_NAMES = { '1': 'Mosson ↔ Odysseum', '2': 'Jacou ↔ St-Jean-de-Védas', '3': 'Juvignac ↔ Pérols / Lattes', '4': 'circulaire centre-ville', '5': 'Clapiers ↔ Montpellier' };

// ============================ CARTE ============================
const map = L.map('map', { zoomControl: false }).setView([43.6085, 3.8767], 13);
map.attributionControl.setPrefix('');

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

const mq = window.matchMedia('(prefers-color-scheme: dark)');
let themePref = localStorage.getItem('mm-theme') || 'auto';
const isDark = () => themePref === 'dark' || (themePref === 'auto' && mq.matches);

let glLayer = null;
let rasterLayer = null;

function mlMap() {
  try { return glLayer && (glLayer.getMaplibreMap ? glLayer.getMaplibreMap() : glLayer._glMap); }
  catch { return null; }
}

// Repli raster (OSM) si le fond vectoriel ne démarre pas : WebGL désactivé, GPU ancien,
// réseau capricieux… La carte n'est jamais vide.
function useRasterFallback(reason) {
  if (rasterLayer) return;
  console.warn('Fond vectoriel indisponible → repli raster :', reason);
  if (glLayer) { try { map.removeLayer(glLayer); } catch {} glLayer = null; }
  rasterLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap · TAM', className: 'raster-tiles',
  }).addTo(map);
  document.documentElement.classList.add('raster-basemap');
}

try {
  glLayer = L.maplibreGL({
    style: isDark() ? STYLES.dark : STYLES.light,
    attribution: '© OpenMapTiles · © OpenStreetMap · TAM',
  }).addTo(map);

  const readyTimer = setTimeout(() => useRasterFallback('timeout'), 6000);
  const m = mlMap();
  if (m) {
    m.on('load', () => clearTimeout(readyTimer));
    m.on('error', (e) => console.warn('maplibre:', e?.error?.message || e));
  } else {
    clearTimeout(readyTimer);
    useRasterFallback('pas d’instance');
  }
} catch (e) {
  useRasterFallback(e.message);
}

function applyTheme() {
  if (themePref === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = themePref;

  const dark = isDark();
  document.documentElement.classList.toggle('dark-basemap', dark);

  const wanted = dark ? STYLES.dark : STYLES.light;
  const m = mlMap();
  if (m && m.__style !== wanted) {
    try { m.setStyle(wanted); m.__style = wanted; } catch {}
  }
  document.querySelectorAll('#theme-seg button')
    .forEach(b => b.classList.toggle('active', b.dataset.theme === themePref));
}
mq.addEventListener('change', applyTheme);
applyTheme();

// ============================ CALQUES ============================
const tramMarkers = L.layerGroup().addTo(map);
const tramStops = L.layerGroup().addTo(map);
const velosLayer = L.layerGroup();
const parkingsLayer = L.layerGroup();
const voirieLayer = L.layerGroup();
const meLayer = L.layerGroup().addTo(map);
let shapesLayer = null;

// ============================ ÉTAT ============================
let mode = 'trams';
let lineFilter = 'all';
let userCoords = null;
let forceTramRender = null;
let selectedStop = null;
const stopsByName = {};   // name -> { name, ids, lat, lon }
const stopCircles = {};   // name -> L.marker

// ============================ NAVIGATION / MODES ============================
const navBtns = [...document.querySelectorAll('.nav-btn')];
const navInd = document.getElementById('nav-indicator');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const modeTitle = document.getElementById('mode-title');
const modeTitleText = document.getElementById('mode-title-text');
const modeCount = document.getElementById('mode-count');
const lineFilterEl = document.getElementById('line-filter');
const resultsEl = document.getElementById('search-results');
const loadingBar = document.getElementById('loading-bar');

function moveIndicator() {
  const btn = navBtns.find(b => b.dataset.mode === mode);
  if (btn) navInd.style.left = (btn.offsetLeft + btn.offsetWidth / 2 - 12) + 'px';
}
window.addEventListener('resize', moveIndicator);

function setLoading(on) { loadingBar.hidden = !on; }

function setMode(next) {
  mode = next;
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === next));
  moveIndicator();
  closeStop();

  [tramMarkers, tramStops, velosLayer, parkingsLayer, voirieLayer].forEach(l => map.removeLayer(l));
  if (shapesLayer) map.removeLayer(shapesLayer);

  const isTrams = next === 'trams';
  searchInput.hidden = !isTrams;
  document.getElementById('search-clear').hidden = true;
  modeTitle.hidden = isTrams;
  lineFilterEl.classList.toggle('hidden', !isTrams);
  resultsEl.hidden = true;

  if (isTrams) {
    if (shapesLayer) map.addLayer(shapesLayer);
    map.addLayer(tramStops); map.addLayer(tramMarkers);
    forceTramRender?.();
  } else if (next === 'velos') {
    setModeTitle('Vélomagg', velosLayer);
    map.addLayer(velosLayer);
    if (!velosLayer.getLayers().length) { setLoading(true); fetchVelos(velosLayer).finally(() => { setLoading(false); updateCount(velosLayer); }); }
  } else if (next === 'parkings') {
    setModeTitle('Parkings', parkingsLayer);
    map.addLayer(parkingsLayer);
    if (!parkingsLayer.getLayers().length) { setLoading(true); fetchParkings(parkingsLayer).finally(() => { setLoading(false); updateCount(parkingsLayer); }); }
  } else if (next === 'stationnement') {
    setModeTitle('Stationnement voirie', voirieLayer);
    map.addLayer(voirieLayer);
    voirieLayer.clearLayers();
    setLoading(true);
    fetchStationnement(voirieLayer, userCoords, map).finally(() => setLoading(false));
  }
}
navBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

function setModeTitle(label, layer) {
  modeTitleText.textContent = label;
  updateCount(layer);
}
function updateCount(layer) {
  const n = layer.getLayers().length;
  modeCount.textContent = n ? `${n}` : '';
}

// ============================ FILTRE LIGNE ============================
lineFilterEl.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    lineFilter = chip.dataset.line;
    lineFilterEl.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
    applyLineFilter();
  });
});
function applyLineFilter() {
  if (shapesLayer) {
    shapesLayer.eachLayer(l => {
      const on = lineFilter === 'all' || String(l.feature?.properties?.line) === lineFilter;
      l.setStyle({ opacity: on ? 0.9 : 0.12, weight: on ? 4.5 : 3 });
    });
  }
  forceTramRender?.();
}

// ============================ RECHERCHE ============================
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  document.getElementById('search-clear').hidden = !q;
  if (q.length < 2) { resultsEl.hidden = true; resultsEl.innerHTML = ''; return; }

  const names = Object.keys(stopsByName).filter(n => n.toLowerCase().includes(q)).slice(0, 6);
  if (!names.length) { resultsEl.hidden = true; return; }
  resultsEl.innerHTML = names.map(n =>
    `<li data-name="${escapeHtml(n)}"><svg class="ic" aria-hidden="true"><use href="#i-pin"/></svg>${escapeHtml(n)}</li>`).join('');
  resultsEl.hidden = false;
});
resultsEl.addEventListener('click', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  const name = li.dataset.name;
  const circle = stopCircles[name];
  resultsEl.hidden = true;
  searchInput.value = name;
  searchInput.blur();
  document.getElementById('search-clear').hidden = false;
  if (circle) { map.flyTo(circle.getLatLng(), 16, { duration: 0.8 }); openStop(stopsByName[name], circle); }
});
document.getElementById('search-clear').addEventListener('click', () => {
  searchInput.value = ''; resultsEl.hidden = true; document.getElementById('search-clear').hidden = true; searchInput.focus();
});

// ============================ FEUILLE HORAIRES ============================
const arrSheet = createSheet(document.getElementById('arrivals-sheet'), { onClose: closeStop });
const sheetTitle = document.getElementById('sheet-title');
const sheetSub = document.getElementById('sheet-sub');
const sheetBody = document.getElementById('sheet-body');
document.getElementById('sheet-close').addEventListener('click', () => arrSheet.close());
sheetBody.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) refetchArrivals(); });

let arr = null; // { station, data, fetchT, tickT }

function stopIcon(sel) {
  return L.divIcon({ className: '', html: `<div class="stop-dot${sel ? ' sel' : ''}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
}
function closeStop() {
  if (arr) { clearInterval(arr.fetchT); clearInterval(arr.tickT); arr = null; }
  if (selectedStop) { selectedStop.setIcon(stopIcon(false)); selectedStop = null; }
}
function fmtDist(m) {
  if (m == null) return '';
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`.replace('.', ',');
}

async function openStop(station, circle) {
  closeStop();
  selectedStop = circle || null;
  circle?.setIcon(stopIcon(true));
  arr = { station, data: [] };

  sheetTitle.textContent = station.name;
  let dist = null;
  if (userCoords) dist = map.distance([userCoords.lat, userCoords.lon], [station.lat, station.lon]);
  sheetSub.textContent = dist != null ? `à ${fmtDist(dist)} · temps réel TAM` : 'temps réel TAM';
  sheetBody.innerHTML = `<div class="skeleton">${'<div class="skeleton-row"></div>'.repeat(4)}</div>`;
  arrSheet.open();

  await refetchArrivals();
  if (!arr) return;
  arr.fetchT = setInterval(refetchArrivals, 25000);
  arr.tickT = setInterval(renderArrivals, 10000);
}

async function refetchArrivals() {
  const st = arr; if (!st) return;
  try {
    const lots = await Promise.all(st.station.ids.map(id =>
      fetch(`${API_BASE}/api/times/${id}`).then(r => r.json()).catch(() => [])));
    if (arr !== st) return;
    const seen = new Set();
    st.data = lots.flat()
      .filter(t => { const k = t.tripId || `${t.routeId}@${t.epoch}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (a.epoch || a.minutes) - (b.epoch || b.minutes));
    renderArrivals();
  } catch {
    if (arr === st) sheetBody.innerHTML = `<div class="sheet-error">Info momentanément indisponible.<button data-retry>Réessayer</button></div>`;
  }
}

function renderArrivals() {
  const st = arr; if (!st || !arrSheet.isOpen()) return;
  if (!st.data.length) {
    sheetBody.innerHTML = `<p class="sheet-empty">Aucun passage prévu dans les 90 prochaines minutes.</p>`;
    return;
  }
  const now = Date.now() / 1000;
  sheetBody.innerHTML = st.data.slice(0, 6).map(t => {
    const line = String(t.routeId).replace(/^0+/, '') || '?';
    const cls = ['1', '2', '3', '4', '5'].includes(line) ? `l${line}` : '';
    const mins = t.epoch ? Math.max(0, Math.round((t.epoch - now) / 60)) : t.minutes;
    const eta = mins <= 0
      ? `<span class="arr-eta soon">à l'approche</span>`
      : `<span class="arr-eta">${mins} min</span>`;
    return `<div class="arr-row">
        <span class="line-badge ${cls}">${escapeHtml(line)}</span>
        <span class="arr-dest">vers ${escapeHtml(t.headsign || '—')}</span>
        ${eta}
      </div>`;
  }).join('');
}

// ============================ MENU ============================
const menuSheet = createSheet(document.getElementById('menu-sheet'));
document.getElementById('menu-btn').addEventListener('click', () => menuSheet.open());
document.getElementById('menu-close').addEventListener('click', () => menuSheet.close());

document.querySelectorAll('#theme-seg button').forEach(b => {
  b.addEventListener('click', () => {
    themePref = b.dataset.theme;
    localStorage.setItem('mm-theme', themePref);
    applyTheme();
  });
});

document.getElementById('legend-list').innerHTML = ['1', '2', '3', '4', '5'].map(n =>
  `<div class="legend-row"><span class="legend-dot" style="background:${LINE_COLORS[n]}"></span><b style="color:var(--text)">Ligne ${n}</b> · ${LINE_NAMES[n]}</div>`).join('');

document.getElementById('report-bug').addEventListener('click', () => {
  const ua = navigator.userAgent;
  let os = 'Inconnu';
  if (/android/i.test(ua)) os = 'Android';
  else if (/iPad|iPhone|iPod/.test(ua)) os = 'iOS';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/macintosh|mac os x/i.test(ua)) os = 'Mac';
  const body = `Bonjour,\n\nJe souhaite signaler le bug suivant :\n\n\n\n--- INFOS ---\nOS : ${os}\nAppareil : ${ua}`;
  window.location.href = `mailto:bloowest@gmail.com?subject=${encodeURIComponent('Bug - Montpellier Mobilité')}&body=${encodeURIComponent(body)}`;
});

// ============================ GÉOLOCALISATION ============================
const locateBtn = document.getElementById('locate-btn');
let firstFix = true;

function initGeoloc() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.watchPosition((pos) => {
    userCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    locateBtn.classList.add('is-on');
    meLayer.clearLayers();
    L.circle([userCoords.lat, userCoords.lon], {
      radius: Math.min(pos.coords.accuracy || 40, 120), stroke: false, fillColor: '#2a86ff', fillOpacity: 0.12,
    }).addTo(meLayer);
    L.marker([userCoords.lat, userCoords.lon], {
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    }).addTo(meLayer);
    if (firstFix) { map.flyTo([userCoords.lat, userCoords.lon], 15, { duration: 1.2 }); firstFix = false; }
  }, (err) => {
    console.warn('GPS indisponible :', err.message);
    locateBtn.classList.remove('is-on');
  }, { enableHighAccuracy: true, maximumAge: 10000 });
}
locateBtn.addEventListener('click', () => {
  if (userCoords) map.flyTo([userCoords.lat, userCoords.lon], 16, { duration: 0.8 });
  else initGeoloc();
});

// ============================ INIT ============================
async function init() {
  initGeoloc();
  moveIndicator();

  try {
    const shapes = await fetch(`${API_BASE}/api/shapes`).then(r => r.json());
    shapesLayer = L.geoJSON(shapes, {
      style: (f) => ({ color: f.properties.color || '#888', weight: 4.5, opacity: 0.9, lineCap: 'round' }),
    });
    if (mode === 'trams') shapesLayer.addTo(map);

    forceTramRender = setupTrams(map, tramMarkers, () => mode, () => lineFilter);

    const stops = await fetch(`${API_BASE}/api/stops`).then(r => r.json());
    stops.forEach(station => {
      stopsByName[station.name] = station;
      const circle = L.marker([station.lat, station.lon], { icon: stopIcon(false), keyboard: false });
      circle.on('click', () => openStop(station, circle));
      circle.addTo(tramStops);
      stopCircles[station.name] = circle;
    });
  } catch (e) {
    console.error("Erreur d'initialisation :", e);
  }
}
init();
