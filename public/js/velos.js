import { escapeHtml } from './util.js';
import { API_BASE } from './config.js';

// Vert s'il reste des vélos, orange s'il n'en reste qu'un ou deux, rouge/gris si vide ou HS.
function colorFor(s) {
    if (s.offline) return '#9aa1ab';
    if (s.bikes === 0) return '#e0402e';
    if (s.bikes <= 2) return '#e08a1e';
    return '#1f9d55';
}

export async function fetchVelos(velosLayer) {
    try {
        const stations = await fetch(`${API_BASE}/api/velos`).then(r => r.json());
        if (!Array.isArray(stations)) throw new Error('réponse inattendue');

        stations.forEach(s => {
            const marker = L.circleMarker([s.lat, s.lon], {
                radius: 7, fillColor: colorFor(s), color: '#ffffff', weight: 2, opacity: 1, fillOpacity: 0.95,
            });
            marker.bindPopup(`
                <div class="pop-card">
                    <div class="pop-title"><svg class="ic" aria-hidden="true"><use href="#i-bike"/></svg>${escapeHtml(s.name)}</div>
                    <div class="pop-stats">
                        <div class="pop-stat"><div class="pop-num ok">${s.bikes}</div><div class="pop-lbl">vélos dispo</div></div>
                        <div class="pop-stat"><div class="pop-num">${s.docks}</div><div class="pop-lbl">places libres</div></div>
                    </div>
                    ${s.offline ? '<div class="pop-lbl" style="margin-top:8px">station hors service</div>' : ''}
                </div>`);
            marker.addTo(velosLayer);
        });
    } catch (error) {
        console.error('Erreur Vélos :', error.message);
    }
}
