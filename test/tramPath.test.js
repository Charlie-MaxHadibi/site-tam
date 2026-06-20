import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapPastSegment } from '../src/tramPath.js';

// Rail synthétique : segment est-ouest à la latitude 43.600, de lon 3.860 à 3.880 (~1,6 km).
const railFeature = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [[3.860, 43.600], [3.880, 43.600]] }
};
const geometry = { '2': [railFeature] };

function vehicle(overrides) {
  return {
    id: 'T1',
    route_short_name: '2',
    old_latitude: 43.600, old_longitude: 3.862,
    latitude: 43.600, longitude: 3.866,
    ...overrides
  };
}

test('snappe un tram qui avance le long du rail', () => {
  const path = snapPastSegment(vehicle(), geometry);
  assert.ok(Array.isArray(path) && path.length >= 2, 'le chemin doit avoir au moins 2 points');
  // Part de ~old (lon 3.862) et finit vers ~actuel (lon 3.866), dans le sens de la marche.
  assert.ok(path[0][1] < path[path.length - 1][1], 'doit progresser vers l\'est (lon croissant)');
  assert.ok(Math.abs(path[0][1] - 3.862) < 0.001, 'commence près de la position de départ');
  assert.ok(Math.abs(path[path.length - 1][1] - 3.866) < 0.001, 'finit près de la position actuelle');
});

test('respecte le sens de la marche (tram vers l\'ouest)', () => {
  const path = snapPastSegment(vehicle({ old_longitude: 3.870, longitude: 3.864 }), geometry);
  assert.ok(path[0][1] > path[path.length - 1][1], 'doit progresser vers l\'ouest (lon décroissant)');
});

test('tram quasi immobile -> simple segment old/actuel', () => {
  const path = snapPastSegment(vehicle({ old_longitude: 3.866, longitude: 3.866001 }), geometry);
  assert.equal(path.length, 2);
  assert.deepEqual(path[0], [43.600, 3.866]);
});

test('saut GPS aberrant (>800 m) -> simple segment, pas de snapping', () => {
  const path = snapPastSegment(vehicle({ old_longitude: 3.840, longitude: 3.879 }), geometry);
  assert.equal(path.length, 2);
});

test('ligne inconnue -> simple segment old/actuel', () => {
  const path = snapPastSegment(vehicle({ route_short_name: '99' }), geometry);
  assert.equal(path.length, 2);
});

test('véhicule hors des rails (>50 m) -> simple segment', () => {
  // ~150 m au nord du rail
  const path = snapPastSegment(vehicle({ old_latitude: 43.6015, latitude: 43.6015 }), geometry);
  assert.equal(path.length, 2);
});
