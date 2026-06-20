// Source unique de vérité pour les lignes de tram (couleurs + détection).
// Côté serveur uniquement : le frontend reçoit ces infos déjà calculées via /api/shapes
// et via les données temps réel, il n'a donc pas besoin de dupliquer cette logique.

export const LINE_COLORS = {
  '1': '#0055A4',
  '2': '#EE7F00',
  '3': '#A8A900',
  '4': '#8F6E3B',
  '5': 'rgb(155, 202, 255)'
};

// Déduit le numéro de ligne ('1'..'4') à partir des propriétés d'un tracé GeoJSON,
// dont le format n'est pas garanti (on cherche la valeur dans tous les champs).
export function detectLine(properties) {
  const vals = Object.values(properties).map(v => String(v).trim().toLowerCase());
  for (const n of ['1', '2', '3', '4']) {
    if (vals.includes(n) || vals.includes(`ligne ${n}`)) return n;
  }
  return null;
}
