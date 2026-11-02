/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA GÉOGRAPHIE (mandat 5 §40) — pur.
 *
 * L'Algérie fait 2 400 km du nord au sud. Une distance calculée « à plat » y perd des dizaines
 * de kilomètres, et une tournée bâtie dessus visite les villes dans le mauvais ordre. Ici : la
 * distance orthodromique (haversine, rayon moyen de la Terre), le cap, l'enveloppe, le
 * barycentre, l'appartenance à une zone (polygone), l'aire, et les densités par maille.
 *
 * Ce que ce module NE fait PAS, et le dit : il ne connaît pas les ROUTES. Une distance à vol
 * d'oiseau n'est pas un temps de trajet ; le facteur de détour usuel est déclaré, jamais caché
 * dans un chiffre présenté comme une durée. Un géocodage — transformer « 15 rue Didouche Mourad,
 * Alger » en coordonnées — demande un service externe : le code le nomme comme une RESSOURCE
 * manquante, pas comme une impossibilité.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Lieu {
  id: string;
  libelle: string;
  lat: number;
  lon: number;
  /** Ce que le lieu pèse : un chiffre d'affaires, une population, un nombre de commandes. */
  poids?: number;
  type?: string;
  attributs?: Record<string, string | number | null>;
}

/** Rayon moyen de la Terre (IUGG), en kilomètres. */
export const RAYON_TERRE_KM = 6371.0088;
/** Le détour routier moyen par rapport au vol d'oiseau — DÉCLARÉ, jamais appliqué en douce. */
export const FACTEUR_DETOUR_ROUTIER = 1.3;

const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

export const coordonneesValides = (l: { lat: number; lon: number }): boolean =>
  Number.isFinite(l.lat) && Number.isFinite(l.lon) && Math.abs(l.lat) <= 90 && Math.abs(l.lon) <= 180 && !(l.lat === 0 && l.lon === 0);

/** LA DISTANCE ORTHODROMIQUE en kilomètres (haversine) — la vraie, sur la sphère. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * RAYON_TERRE_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** La distance ROUTIÈRE ESTIMÉE — le vol d'oiseau majoré du détour usuel. C'est une ESTIMATION, et le mot compte. */
export const distanceRoutiereEstimeeKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }, facteur = FACTEUR_DETOUR_ROUTIER): number =>
  distanceKm(a, b) * facteur;

/** Le CAP initial de a vers b, en degrés depuis le nord (0 = nord, 90 = est). */
export function cap(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export const CARDINAUX = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"] as const;
export const cardinal = (capDegres: number): (typeof CARDINAUX)[number] => CARDINAUX[Math.round((capDegres % 360) / 45) % 8]!;

/** L'ENVELOPPE de plusieurs lieux (le rectangle qui les contient tous). */
export function enveloppe(lieux: readonly { lat: number; lon: number }[]): { sud: number; nord: number; ouest: number; est: number; diagonaleKm: number } | null {
  const bons = lieux.filter(coordonneesValides);
  if (!bons.length) return null;
  const sud = Math.min(...bons.map((l) => l.lat)), nord = Math.max(...bons.map((l) => l.lat));
  const ouest = Math.min(...bons.map((l) => l.lon)), est = Math.max(...bons.map((l) => l.lon));
  return { sud, nord, ouest, est, diagonaleKm: distanceKm({ lat: sud, lon: ouest }, { lat: nord, lon: est }) };
}

/** Le BARYCENTRE — moyenne sur la sphère (par les vecteurs, pas par les degrés : la moyenne des longitudes est fausse à cheval sur l'antiméridien). */
export function barycentre(lieux: readonly Lieu[]): { lat: number; lon: number } | null {
  const bons = lieux.filter(coordonneesValides);
  if (!bons.length) return null;
  let x = 0, y = 0, z = 0, total = 0;
  for (const l of bons) {
    const p = l.poids && l.poids > 0 ? l.poids : 1;
    const la = rad(l.lat), lo = rad(l.lon);
    x += Math.cos(la) * Math.cos(lo) * p;
    y += Math.cos(la) * Math.sin(lo) * p;
    z += Math.sin(la) * p;
    total += p;
  }
  if (!total) return null;
  x /= total; y /= total; z /= total;
  const hyp = Math.sqrt(x * x + y * y);
  if (hyp < 1e-12 && Math.abs(z) < 1e-12) return null;
  return { lat: deg(Math.atan2(z, hyp)), lon: deg(Math.atan2(y, x)) };
}

export type Polygone = { lat: number; lon: number }[];

/** UN POINT EST-IL DANS LA ZONE ? (lancer de rayon ; un point sur le bord compte dedans.) */
export function dansLaZone(point: { lat: number; lon: number }, polygone: Polygone): boolean {
  const n = polygone.length;
  if (n < 3) return false;
  let dedans = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = polygone[i]!, b = polygone[j]!;
    // Le bord compte : un dépôt posé exactement sur la limite d'un territoire en fait partie.
    const surSegment = Math.abs((b.lat - a.lat) * (point.lon - a.lon) - (b.lon - a.lon) * (point.lat - a.lat)) < 1e-12
      && point.lon >= Math.min(a.lon, b.lon) - 1e-12 && point.lon <= Math.max(a.lon, b.lon) + 1e-12
      && point.lat >= Math.min(a.lat, b.lat) - 1e-12 && point.lat <= Math.max(a.lat, b.lat) + 1e-12;
    if (surSegment) return true;
    if ((a.lon > point.lon) !== (b.lon > point.lon)) {
      const x = ((b.lat - a.lat) * (point.lon - a.lon)) / (b.lon - a.lon) + a.lat;
      if (point.lat < x) dedans = !dedans;
    }
  }
  return dedans;
}

/** L'AIRE d'un polygone en km² (formule sphérique de l'excès ; exacte pour de petites zones comme pour un pays). */
export function aireKm2(polygone: Polygone): number {
  const n = polygone.length;
  if (n < 3) return 0;
  let somme = 0;
  for (let i = 0; i < n; i += 1) {
    const a = polygone[i]!, b = polygone[(i + 1) % n]!;
    somme += rad(b.lon - a.lon) * (2 + Math.sin(rad(a.lat)) + Math.sin(rad(b.lat)));
  }
  return Math.abs((somme * RAYON_TERRE_KM * RAYON_TERRE_KM) / 2);
}

/** Les lieux à moins de N kilomètres, triés par distance — « qu'est-ce qu'on a autour d'Oran ? ». */
export function autour(centre: { lat: number; lon: number }, lieux: readonly Lieu[], rayonKm: number): { lieu: Lieu; distanceKm: number; cap: number; direction: string }[] {
  return lieux
    .filter(coordonneesValides)
    .map((l) => ({ lieu: l, distanceKm: distanceKm(centre, l), cap: cap(centre, l), direction: cardinal(cap(centre, l)) }))
    .filter((x) => x.distanceKm <= rayonKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export interface Maille { sud: number; nord: number; ouest: number; est: number; n: number; poids: number; densiteParKm2: number; lieux: string[] }

/** LES DENSITÉS par maille — où se concentre l'activité, sans supposer de découpage administratif. */
export function densites(lieux: readonly Lieu[], mailles = 6): { grille: Maille[]; enveloppe: ReturnType<typeof enveloppe>; note: string } {
  const bons = lieux.filter(coordonneesValides);
  const env = enveloppe(bons);
  if (!env || bons.length < 2) return { grille: [], enveloppe: env, note: "Trop peu de lieux localisés pour une densité." };
  const k = Math.max(2, Math.min(20, mailles));
  const dLat = (env.nord - env.sud) / k || 1e-9;
  const dLon = (env.est - env.ouest) / k || 1e-9;
  const grille: Maille[] = [];
  for (let i = 0; i < k; i += 1) for (let j = 0; j < k; j += 1) {
    const sud = env.sud + i * dLat, nord = sud + dLat, ouest = env.ouest + j * dLon, est = ouest + dLon;
    const dedans = bons.filter((l) => l.lat >= sud && l.lat <= nord + (i === k - 1 ? 1e-9 : 0) && l.lon >= ouest && l.lon <= est + (j === k - 1 ? 1e-9 : 0));
    if (!dedans.length) continue;
    const aire = aireKm2([{ lat: sud, lon: ouest }, { lat: sud, lon: est }, { lat: nord, lon: est }, { lat: nord, lon: ouest }]);
    grille.push({
      sud, nord, ouest, est, n: dedans.length,
      poids: dedans.reduce((s, l) => s + (l.poids ?? 1), 0),
      densiteParKm2: aire > 0 ? dedans.length / aire : 0,
      lieux: dedans.slice(0, 10).map((l) => l.libelle),
    });
  }
  grille.sort((a, b) => b.poids - a.poids);
  return { grille, enveloppe: env, note: `Grille ${k}×${k} sur l'enveloppe des lieux (diagonale ${Math.round(env.diagonaleKm)} km) — un découpage régulier, pas administratif.` };
}
