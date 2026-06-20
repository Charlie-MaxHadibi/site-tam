// Base d'URL de l'API.
// - Sur le web : le site est servi par le même serveur -> origine relative ('').
// - Dans l'app native (Capacitor) : pas de serveur local, on cible l'hôte de production.
const isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
  && window.Capacitor.isNativePlatform());

export const API_BASE = isNative ? 'https://infotram.tmaxmls.ovh' : '';
