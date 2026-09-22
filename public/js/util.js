// Échappe les caractères HTML sensibles avant de les injecter dans un popup Leaflet.
// Les libellés (noms d'arrêts, destinations, noms de parkings) viennent d'API externes :
// on ne fait pas confiance à leur contenu.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
