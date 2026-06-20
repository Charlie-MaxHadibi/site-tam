import * as turf from '@turf/turf';

// --- Réglages du tracé ---
const MIN_MOVE_M = 8;            // en dessous : tram quasi immobile -> simple ligne
const MAX_JUMP_M = 800;          // au dessus : saut GPS aberrant -> simple ligne
const MAX_OFFRAIL_KM = 0.05;     // 50 m : au delà, le véhicule n'est pas vraiment sur ce rail

// Découpe le tronçon de rail RÉELLEMENT parcouru entre la position d'il y a 30 s (old)
// et la dernière position connue (actuelle). On rejoue le passé : le tram glisse le long
// des rails, sans jamais dépasser ni revenir en arrière (~30 s de retard, assumé).
//
// `tramLinesGeometry` : { '1': [features...], '2': [...], ... } indexé par route_short_name.
// Retourne un tableau de points [lat, lon] (au moins 2).
export function snapPastSegment(vehicle, tramLinesGeometry) {
  const { id, latitude, longitude, old_latitude, old_longitude, route_short_name } = vehicle;

  const startPt = turf.point([old_longitude, old_latitude]);
  const endPt = turf.point([longitude, latitude]);
  const straight = turf.distance(startPt, endPt, { units: 'meters' });

  // Quasi immobile ou saut GPS aberrant : on relie simplement les deux points.
  if (straight < MIN_MOVE_M || straight > MAX_JUMP_M) {
    return [[old_latitude, old_longitude], [latitude, longitude]];
  }

  const lines = tramLinesGeometry[route_short_name];
  if (!lines || lines.length === 0) return [[old_latitude, old_longitude], [latitude, longitude]];

  try {
    // 1. Rail le plus proche de la position d'arrivée.
    let bestLine = lines[0];
    let minDist = Infinity;
    for (const l of lines) {
      const snapped = turf.nearestPointOnLine(l, endPt);
      if (snapped.properties.dist < minDist) { minDist = snapped.properties.dist; bestLine = l; }
    }
    if (minDist > MAX_OFFRAIL_KM) return [[old_latitude, old_longitude], [latitude, longitude]];

    // 2. Tronçon de rail entre la position d'il y a 30 s et la position actuelle.
    const snapStart = turf.nearestPointOnLine(bestLine, startPt);
    const snapEnd = turf.nearestPointOnLine(bestLine, endPt);
    const sliced = turf.lineSlice(snapStart, snapEnd, bestLine);
    let coords = sliced.geometry.coordinates.map(c => [c[1], c[0]]);

    // 3. Sens de la marche : le chemin doit partir de la position de départ.
    const head = turf.point([coords[0][1], coords[0][0]]);
    const tail = turf.point([coords[coords.length - 1][1], coords[coords.length - 1][0]]);
    if (turf.distance(startPt, tail) < turf.distance(startPt, head)) coords.reverse();

    // 4. Garde-fou : si le tronçon est anormalement long (Turf s'est trompé de sens ou de
    //    branche à un aiguillage), on retombe sur une simple ligne droite snappée.
    const pathLength = turf.length(sliced, { units: 'meters' });
    if (pathLength > straight * 2.5) {
      return [
        [snapStart.geometry.coordinates[1], snapStart.geometry.coordinates[0]],
        [snapEnd.geometry.coordinates[1], snapEnd.geometry.coordinates[0]]
      ];
    }

    return coords.length >= 2 ? coords : [[old_latitude, old_longitude], [latitude, longitude]];
  } catch (e) {
    console.error(`[Turf] Snap Ligne ${route_short_name} (ID: ${id}):`, e.message);
    return [[old_latitude, old_longitude], [latitude, longitude]];
  }
}
