import { API_BASE } from './config.js';
import { escapeHtml } from './util.js';

// Bornes de la durée d'animation d'un tronçon (le flux TAM rafraîchit ~toutes les 60 s).
const MIN_SEG_MS = 12000;
const MAX_SEG_MS = 75000;
const FALLBACK_SEG_MS = 30000;
// Au-delà, le fix GPS est trop vieux : le tram est probablement à l'arrêt / hors service.
const STALE_FIX_S = 300;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const lineOf = (v) => String(v.route_short_name || '').replace(/^0+/, '') || '?';

// Le calcul Turf est fait côté serveur. `getLineFilter` -> '1'..'5' ou 'all'.
export function setupTrams(map, markersLayer, getCurrentMode, getLineFilter = () => 'all') {
    // Sur le web : même origine. En natif : on cible le serveur de prod.
    const socket = API_BASE ? io(API_BASE) : io();
    let markers = {};
    let lastVehiclesData = [];

    socket.on('trams-update', (data) => {
        lastVehiclesData = data || [];
        renderTrams();
    });

    function renderTrams() {
        try {
            const isTram = (v) => v.route_type === 0 || ['1', '2', '3', '4', '5'].includes(lineOf(v));
            const filter = getLineFilter();
            const visible = (getCurrentMode() === 'trams')
                ? lastVehiclesData.filter(v => isTram(v) && (filter === 'all' || lineOf(v) === filter))
                : [];

            const ids = visible.map(t => t.id);
            
            // Nettoyage des vieux marqueurs
            Object.keys(markers).forEach(id => { 
                if (!ids.includes(id)) { 
                    markersLayer.removeLayer(markers[id]); 
                    delete markers[id]; 
                } 
            });

            const nowSec = Date.now() / 1000;

            visible.forEach(vehicle => {
                const { id, latitude, longitude, route_short_name, trip_headsign, route_color,
                        calculatedPath, timestamp, old_timestamp } = vehicle;

                const existing = markers[id];

                // Le flux TAM ne rafraîchit une position qu'environ toutes les 60 s : tant que
                // le fix (timestamp) est identique, on laisse le marqueur finir son animation
                // en cours. Ça évite de le recréer toutes les 30 s (popup qui se ferme, à-coups).
                if (existing && timestamp && existing._fixTs === timestamp) {
                    return;
                }

                const fixAge = timestamp ? (nowSec - timestamp) : null;
                const isStale = fixAge != null && fixAge > STALE_FIX_S;

                let startLatLngObj;
                let popupWasOpen = false;

                // 1. Position visuelle actuelle pour éviter la "téléportation"
                if (existing) {
                    startLatLngObj = existing.getLatLng();
                    popupWasOpen = existing.isPopupOpen();
                    markersLayer.removeLayer(existing);
                } else {
                    // Si c'est un nouveau tram, on démarre au début de son chemin calculé
                    startLatLngObj = calculatedPath && calculatedPath.length > 0
                        ? L.latLng(calculatedPath[0][0], calculatedPath[0][1])
                        : L.latLng(latitude, longitude);
                }

                const ln = lineOf(vehicle);
                const icon = L.divIcon({
                    className: '',
                    html: `<div class="tram-pin l${ln}${isStale ? ' stale' : ''}" style="background:${route_color}">${escapeHtml(ln)}</div>`,
                    iconSize: [30, 30],
                    iconAnchor: [15, 15]
                });
                const popupHtml = (extra = '') => `<div class="pop-card"><div class="pop-title"><span class="line-badge l${ln}">${escapeHtml(ln)}</span> vers ${escapeHtml(trip_headsign || '—')}</div>${extra}</div>`;

                // Fix trop vieux : on pose un marqueur fixe, sans animation trompeuse.
                if (isStale) {
                    const m = L.marker([latitude, longitude], { icon })
                        .bindPopup(popupHtml(`<div class="pop-lbl" style="margin-top:8px">Position figée depuis ${Math.round(fixAge / 60)} min</div>`));
                    m._fixTs = timestamp;
                    markers[id] = m;
                    markersLayer.addLayer(m);
                    if (popupWasOpen) m.openPopup();
                    return;
                }

                // 1. Nettoyage du chemin : On ignore les points trop proches (évite les bugs de direction Leaflet)
                let validPath = [startLatLngObj]; // On démarre toujours de la position visuelle
                
                if (calculatedPath && calculatedPath.length > 0) {
                    for (let i = 0; i < calculatedPath.length; i++) {
                        let nextPt = L.latLng(calculatedPath[i][0], calculatedPath[i][1]);
                        // On ajoute le point seulement s'il est à plus d'1 mètre du précédent
                        if (validPath[validPath.length - 1].distanceTo(nextPt) > 1) { 
                            validPath.push(nextPt);
                        }
                    }
                }

                // Si le chemin final n'a qu'un point (le tram n'a pas bougé), on ajoute sa destination
                if (validPath.length === 1) {
                    validPath.push(L.latLng(latitude, longitude));
                }

                // 2. Calcul de la distance totale réelle sur les rails
                let pathTotalDist = 0;
                for (let i = 0; i < validPath.length - 1; i++) {
                    pathTotalDist += validPath[i].distanceTo(validPath[i+1]);
                }

                // 3. Durée de l'animation = durée RÉELLE du tronçon (écart entre les deux
                // fixes GPS), bornée. Le tram glisse ainsi à sa vitesse réelle plutôt que de
                // « sprinter » puis se figer un cycle sur deux. Repli à 30 s si pas d'horodatage.
                const realSegMs = (timestamp && old_timestamp && timestamp > old_timestamp)
                    ? clamp((timestamp - old_timestamp) * 1000, MIN_SEG_MS, MAX_SEG_MS)
                    : FALLBACK_SEG_MS;
                const animationDuration = realSegMs;
                let durations = [];

                if (pathTotalDist < 5) {
                    // Si le tram a bougé de moins de 5 mètres sur les rails, 
                    // on le fait glisser doucement sur 5 secondes plutôt que 28 pour éviter l'effet "limace"
                    durations = [5000];
                } else {
                    for (let i = 0; i < validPath.length - 1; i++) {
                        let segmentDist = validPath[i].distanceTo(validPath[i+1]);
                        durations.push((segmentDist / pathTotalDist) * animationDuration);
                    }
                }

                // 4. Création du marqueur avec sécurité sur le tableau des durées
                if (durations.length === validPath.length - 1) {
                    const m = L.Marker.movingMarker(validPath, durations, { autostart: true, icon: icon })
                        .bindPopup(popupHtml());
                    m._fixTs = timestamp || null; // pour ne pas le recréer tant que le fix ne change pas
                    markers[id] = m;
                    markersLayer.addLayer(m);

                    // On rouvre le popup s'il était ouvert avant la recréation du marqueur.
                    if (popupWasOpen) m.openPopup();
                }
            });
 
        } catch (e) {
            console.error("Erreur d'affichage des trams:", e);
        }
    }

    // On renvoie la fonction de rendu pour permettre un re-rendu forcé (ex: retour sur le mode "trams")
    return renderTrams;
}