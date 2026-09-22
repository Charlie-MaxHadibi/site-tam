// Map à capacité bornée : au-delà de `max` entrées, la plus ancienne insérée est évincée (FIFO).
// Sert aux caches indexés par `trip_id` : ces identifiants tournent chaque jour, donc sans borne
// le cache grossit indéfiniment sur un serveur qui tourne des semaines.
export class BoundedMap extends Map {
  constructor(max = 5000) {
    super();
    this.max = max;
  }

  set(key, value) {
    // Map conserve l'ordre d'insertion : la première clé est la plus ancienne.
    if (!this.has(key) && this.size >= this.max) {
      this.delete(this.keys().next().value);
    }
    return super.set(key, value);
  }
}
