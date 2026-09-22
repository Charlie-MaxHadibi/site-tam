import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLine, LINE_COLORS } from '../src/lines.js';

test('détecte la ligne via une valeur nue ("1".."5")', () => {
  assert.equal(detectLine({ NUMLIGNE: '1' }), '1');
  assert.equal(detectLine({ ligne: ' 5 ' }), '5'); // trim appliqué
});

test('détecte la ligne via "ligne N" (valeur exacte)', () => {
  assert.equal(detectLine({ nom: 'Ligne 3' }), '3');
  assert.equal(detectLine({ label: 'LIGNE 4' }), '4'); // insensible à la casse
});

test('ligne 5 prise en charge (régression)', () => {
  assert.equal(detectLine({ ref: 'ligne 5' }), '5');
  assert.ok(LINE_COLORS['5']);
});

test('propriétés sans numéro de ligne -> null', () => {
  assert.equal(detectLine({ nom: 'Bus 12', autre: 'tram' }), null);
  assert.equal(detectLine({}), null);
});

test('une couleur est définie pour chaque ligne 1..5', () => {
  for (const n of ['1', '2', '3', '4', '5']) {
    assert.match(LINE_COLORS[n], /^(#|rgb)/);
  }
});
