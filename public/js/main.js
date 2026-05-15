import { setupTrams } from './trams.js';
import { fetchVelos } from './velos.js';
import { fetchParkings } from './parkings.js';
import { fetchStationnement } from './stationnement.js';

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
let tramLinesGeometry = { '1': [], '2': [], '3': [], '4': [] }; // Pour Turf.js (nouveau trams.js)

// --- GESTION DU MENU BURGER ---
window.toggleMenu = function() {
    const menu = document.getElementById('side-menu');
    const overlay = document.getElementById('menu-overlay');
    
    if (menu.classList.contains('open')) {
        menu.classList.remove('open');
        if(overlay) overlay.style.display = 'none';
    } else {
        menu.classList.add('open');
        if(overlay) overlay.style.display = 'block';
    }
};

// --- GESTION DES MODES ---
window.setMode = function(mode, btnElement) {
    currentMode = mode;
    
    document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));
    btnElement.classList.add('active');

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

    // 3. Fermer le menu si ouvert (mobile)
    const sideMenu = document.getElementById('side-menu');
    if (sideMenu && sideMenu.classList.contains('open')) {
        if (typeof toggleMenu === 'function') toggleMenu();
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
        const responseShapes = await fetch('/api/shapes');
        const geojsonShapes = await responseShapes.json();
        
        L.geoJSON(geojsonShapes, {
            style: function(feature) {
                const vals = Object.values(feature.properties).map(v => String(v).trim().toLowerCase());
                let num = null;
                if (vals.includes('1') || vals.includes('ligne 1')) num = '1';
                if (vals.includes('2') || vals.includes('ligne 2')) num = '2';
                if (vals.includes('3') || vals.includes('ligne 3')) num = '3';
                if (vals.includes('4') || vals.includes('ligne 4')) num = '4';

                // SAUVEGARDE DE LA GÉOMÉTRIE POUR LE NOUVEAU TRAMS.JS
                if (num && feature.geometry.type === 'LineString') {
                    tramLinesGeometry[num].push(feature);
                }

                const colorMap = { '1': '#0055A4', '2': '#EE7F00', '3': '#A8A900', '4': '#8F6E3B' };
                return { color: num ? colorMap[num] : '#888', weight: 4, opacity: 0.8 };
            }
        }).addTo(tramLinesLayer);

        // 2. Initialisation des Trams (Maintenant qu'on a les tracés)
        setupTrams(map, tramMarkersLayer, () => currentMode, tramLinesGeometry);

        // 3. Récupération et affichage interactif des arrêts de tram
        const responseStops = await fetch('/api/stops');
        const stops = await responseStops.json();
        
        stops.forEach(station => {
            const circle = L.circleMarker([station.lat, station.lon], {
                radius: 5, fillColor: '#ffffff', color: '#000000', weight: 2, opacity: 1, fillOpacity: 1
            });
            
            // On sauvegarde pour la barre de recherche
            stationMarkers[station.name] = circle;

            // Affichage des horaires en temps réel au clic
            circle.on('click', async () => {
                circle.bindPopup(`<div style="text-align:center;"><b>${station.name}</b><br>⏳ Calcul...</div>`).openPopup();
                try {
                    let arrivals = [];
                    for (let id of station.ids) {
                        const res = await fetch(`https://infotram.tmaxmls.ovh/api/times/${id}`);
                        const times = await res.json();
                        arrivals = arrivals.concat(times);
                    }
                    arrivals.sort((a, b) => a.minutes - b.minutes);
                    let html = `<div style="min-width: 200px;"><b>📍 ${station.name}</b><hr style="margin:8px 0;">`;
                    if (arrivals.length === 0) {
                        html += `<i>Aucun tram prévu prochainement</i>`;
                    } else {
                        arrivals.slice(0, 4).forEach((t) => {
                            let line = String(t.routeId).replace(/^0+/, ''); 
                            let time = t.minutes === 0 ? "<b style='color:green;'>À l'approche</b>" : `<b>${t.minutes} min</b>`;
                            html += `<div style="margin-bottom:6px; font-size:13px;"><span style="display:inline-block; width:18px; text-align:center; background:#ddd; border-radius:3px; margin-right:4px;"><b>${line}</b></span> vers ${t.headsign}<br><span style="margin-left: 26px;">⏱️ ${time}</span></div>`;
                        });
                    }
                    html += `</div>`;
                    circle.setPopupContent(html);
                } catch (e) { circle.setPopupContent(`❌ Info indisponible`); }
            });
            circle.addTo(tramStopsLayer);
        });

    } catch (e) { console.error("Erreur d'initialisation de l'API :", e); }
}

// Lancement au chargement
init();