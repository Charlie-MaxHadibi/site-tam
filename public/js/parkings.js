import { escapeHtml } from './util.js';
import { API_BASE } from './config.js';

// Vert si large dispo, orange si ça se remplit, rouge si presque plein / fermé.
function colorFor(p) {
    if (p.closed) return '#9aa1ab';
    if (p.available == null || p.total == null || p.total === 0) return '#2a72d6';
    const ratio = p.available / p.total;
    if (ratio <= 0.05) return '#e0402e';
    if (ratio <= 0.15) return '#e08a1e';
    return '#1f9d55';
}

export async function fetchParkings(parkingsLayer) {
    try {
        const parkings = await fetch(`${API_BASE}/api/parkings`).then(r => r.json());
        if (!Array.isArray(parkings)) throw new Error('réponse inattendue');

        parkings.forEach(p => {
            const marker = L.circleMarker([p.lat, p.lon], {
                radius: 7, fillColor: colorFor(p), color: '#ffffff', weight: 2, opacity: 1, fillOpacity: 0.95,
            });

            const maj = p.updated
                ? new Date(p.updated).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
                : null;

            let stats = '';
            if (!p.closed && p.available != null) {
                stats = `<div class="pop-stats">
                    <div class="pop-stat"><div class="pop-num ok">${p.available}</div><div class="pop-lbl">places libres</div></div>
                    <div class="pop-stat"><div class="pop-num">${p.total ?? '—'}</div><div class="pop-lbl">total</div></div>
                </div>`;
            }

            marker.bindPopup(`
                <div class="pop-card">
                    <div class="pop-title"><svg class="ic" aria-hidden="true"><use href="#i-parking"/></svg>${escapeHtml(p.name)}</div>
                    ${stats}
                    ${p.closed ? '<div class="pop-lbl" style="margin-top:8px">fermé</div>'
                        : maj ? `<div class="pop-lbl" style="margin-top:8px">maj ${maj}</div>` : ''}
                </div>`);
            marker.addTo(parkingsLayer);
        });
    } catch (error) {
        console.error('Erreur Parkings :', error.message);
    }
}
