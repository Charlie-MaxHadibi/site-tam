import { setupTrams } from './trams.js';
import { fetchVelos } from './velos.js';
import { fetchParkings } from './parkings.js';
import { fetchStationnement } from './stationnement.js';
import { API_BASE } from './config.js';

// --- INITIALISATION DE LA CARTE ---
const map = L.map('map', { zoomControl: false }).setView([43.611, 3.8767], 14);

// --- GESTION DU THÈME SOMBRE / CLAIR ---
const lightTheme = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap &copy; CARTO' });
const darkTheme = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap &copy; CARTO' });
const prefersDarkScheme = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(isDark) {
    if (isDark) {
        if (map.hasLayer(lightTheme)) map.removeLayer(lightTheme);
        darkTheme.addTo(map);
    } else {
        if (map.hasLayer(darkTheme)) map.removeLayer(darkTheme);
        lightTheme.addTo(map);
    }
}
applyTheme(prefersDarkScheme.matches);
prefersDarkScheme.addEventListener("change", (e) => applyTheme(e.matches));

// --- CALQUES GLOBAUX ---
const tramLinesLayer = L.layerGroup().addTo(map);
const tramStopsLayer = L.layerGroup().addTo(map);
const tramMarkersLayer = L.layerGroup().addTo(map);
const velosLayer = L.layerGroup();
const parkingsLayer = L.layerGroup();
const stationnementLayer = L.layerGroup();
const userLocationLayer = L.layerGroup().addTo(map);

// --- ÉTAT GLOBAL ---
let currentMode = 'trams';
let userCoords = null;
let stationMarkers = {}; // Pour la barre de recherche
let forceTramRender = null;

// --- GESTION DES MODES ---
window.setMode = function(mode, btnElement) {
    currentMode = mode;

    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    const searchBox = document.getElementById('search-box');

    // 1. Nettoyage de la carte
    map.removeLayer(tramLinesLayer);
    map.removeLayer(tramStopsLayer);
    map.removeLayer(tramMarkersLayer);
    map.removeLayer(velosLayer);
    map.removeLayer(parkingsLayer);
    map.removeLayer(stationnementLayer);

    // 2. Affichage du mode sélectionné
    if (mode === 'trams') {
        if (searchBox) searchBox.style.display = 'block';
        map.addLayer(tramLinesLayer);
        map.addLayer(tramStopsLayer);
        map.addLayer(tramMarkersLayer);

        if (forceTramRender) forceTramRender();
    }
    else if (mode === 'velos') {
        if (searchBox) searchBox.style.display = 'none';
        map.addLayer(velosLayer);
        if (Object.keys(velosLayer._layers).length === 0) fetchVelos(velosLayer);
    }
    else if (mode === 'parkings') {
        if (searchBox) searchBox.style.display = 'none';
        map.addLayer(parkingsLayer);
        if (Object.keys(parkingsLayer._layers).length === 0) fetchParkings(parkingsLayer);
    }
    else if (mode === 'stationnement') {
        if (searchBox) searchBox.style.display = 'none';
        map.addLayer(stationnementLayer);
        stationnementLayer.clearLayers();
        fetchStationnement(stationnementLayer, userCoords, map);
    }
};

// --- BARRE DE RECHERCHE ---
window.filterSearch = function() {
    const query = document.getElementById('search-input').value.toLowerCase();
    const list = document.getElementById('search-results');
    list.innerHTML = '';
    
    if (query.length < 2) { list.style.display = 'none'; return; }

    const names = Object.keys(stationMarkers).filter(n => n.toLowerCase().includes(query));
    
    if (names.length > 0) {
        list.style.display = 'block';
        names.slice(0, 5).forEach(name => {
            const li = document.createElement('li');
            li.textContent = name;
            li.onclick = () => {
                const marker = stationMarkers[name];
                map.flyTo(marker.getLatLng(), 16); 
                marker.fire('click'); 
                list.style.display = 'none';
                document.getElementById('search-input').value = name;
            };
            list.appendChild(li);
        });
    } else { list.style.display = 'none'; }
};

// --- GÉOLOCALISATION EN DIRECT ---
function initUserLocation() {
    if ("geolocation" in navigator) {
        let premiereFois = true; // On crée un marqueur pour le premier centrage

        navigator.geolocation.watchPosition((position) => {
            userCoords = { lat: position.coords.latitude, lon: position.coords.longitude };
            userLocationLayer.clearLayers();
            
            L.circleMarker([userCoords.lat, userCoords.lon], {
                radius: 8, fillColor: '#2196F3', color: '#ffffff', weight: 2, fillOpacity: 1
            }).addTo(userLocationLayer).bindPopup("📍 Vous êtes ici");

            // Si c'est la première fois qu'on trouve la position, on centre la carte
            if (premiereFois) {
                map.flyTo([userCoords.lat, userCoords.lon], 15, {
                    animate: true,
                    duration: 1.5 // Petite animation fluide d'une seconde et demi
                });
                premiereFois = false; // On désactive pour les prochains mouvements
            }

        }, (error) => { 
            console.warn("GPS indisponible ou refusé par l'utilisateur :", error); 
            // La carte restera centrée sur Montpellier (défini au tout début du fichier)
        }, { enableHighAccuracy: true });
    }
}

// --- RECENTRAGE SUR L'UTILISATEUR ---
window.locateUser = function() {
    if (userCoords) {
        map.flyTo([userCoords.lat, userCoords.lon], 16, { animate: true, duration: 1 });
    } else {
        alert("Position non disponible. Active la géolocalisation puis réessaie.");
    }
};

// --- REPORT DE BUG ---
window.reportBug = function() {
    const ua = navigator.userAgent;          
    let os = "Inconnu";
    if (/android/i.test(ua)) os = "Android";
    else if (/iPad|iPhone|iPod/.test(ua)) os = "iOS";
    else if (/windows/i.test(ua)) os = "Windows";
    else if (/macintosh|mac os x/i.test(ua)) os = "Mac";

    const emailBody = `Bonjour,\n\nJe souhaite signaler le bug suivant :\n\n\n\n--- INFOS TECHNIQUES ---\nOS : ${os}\nAppareil : ${ua}`;
    window.location.href = `mailto:bloowest@gmail.com?subject=Rapport de Bug - Mobilité Tracker&body=${encodeURIComponent(emailBody)}`;
};

// --- INITIALISATION GÉNÉRALE ---
async function init() {
    initUserLocation();
    
    try {
        // 1. Récupération des tracés GPS des lignes (Shapes)
        // Le serveur tague déjà chaque tracé avec sa couleur (properties.color).
        const responseShapes = await fetch(`${API_BASE}/api/shapes`);
        const geojsonShapes = await responseShapes.json();

        L.geoJSON(geojsonShapes, {
            style: (feature) => ({ color: feature.properties.color || '#888', weight: 4, opacity: 0.8 })
        }).addTo(tramLinesLayer);

        // 2. Initialisation des Trams (Maintenant qu'on a les tracés)
        // Un seul appel : il ouvre la connexion Socket.io et renvoie la fonction de rendu.
        forceTramRender = setupTrams(map, tramMarkersLayer, () => currentMode);

        // 3. Récupération et affichage interactif des arrêts de tram
        const responseStops = await fetch(`${API_BASE}/api/stops`);
        const stops = await responseStops.json();
        
        stops.forEach(station => {
            const circle = L.circleMarker([station.lat, station.lon], {
                radius: 5, fillColor: '#ffffff', color: '#000000', weight: 2, opacity: 1, fillOpacity: 1
            });
            
            // On sauvegarde pour la barre de recherche
            stationMarkers[station.name] = circle;

            // Affichage des horaires en temps réel au clic
            circle.on('click', async () => {
                circle.bindPopup(`<div class="popup-card"><div class="popup-title">${station.name}</div><div class="popup-empty">⏳ Calcul…</div></div>`).openPopup();
                try {
                    let arrivals = [];
                    for (let id of station.ids) {
                        const res = await fetch(`${API_BASE}/api/times/${id}`);
                        const times = await res.json();
                        arrivals = arrivals.concat(times);
                    }
                    arrivals.sort((a, b) => a.minutes - b.minutes);

                    let html = `<div class="popup-card"><div class="popup-title">📍 ${station.name}</div><hr class="popup-sep">`;
                    if (arrivals.length === 0) {
                        html += `<div class="popup-empty">Aucun tram prévu prochainement</div>`;
                    } else {
                        arrivals.slice(0, 4).forEach((t) => {
                            const line = String(t.routeId).replace(/^0+/, '') || '?';
                            const cls = ['1', '2', '3', '4', '5'].includes(line) ? `l${line}` : 'lx';
                            const time = t.minutes === 0
                                ? `<span class="arrival-time soon">À l'approche</span>`
                                : `<span class="arrival-time">${t.minutes} min</span>`;
                            html += `<div class="popup-row"><span class="line-badge ${cls}">${line}</span><span class="dest">vers ${t.headsign}</span>${time}</div>`;
                        });
                    }
                    html += `</div>`;
                    circle.setPopupContent(html);
                } catch (e) { circle.setPopupContent(`<div class="popup-card"><div class="popup-empty">❌ Info indisponible</div></div>`); }
            });
            circle.addTo(tramStopsLayer);
        });

    } catch (e) { console.error("Erreur d'initialisation de l'API :", e); }
}

// Lancement au chargement
init();