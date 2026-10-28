/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SÉRIES TEMPORELLES (mandat 5 §39) — pur.
 *
 * Décomposition tendance / saisonnalité / résidu, lissage exponentiel de HOLT-WINTERS (niveau,
 * tendance, saison — additive ou multiplicative), détection automatique de la période par
 * autocorrélation, ruptures de niveau, et une PRÉVISION qui porte son intervalle.
 *
 * La règle non négociable : une prévision se juge sur des points que le modèle N'A PAS VUS.
 * `backtester` réajuste sur une fenêtre glissante et compare à la marche naïve et à la saisonnalité
 * naïve — un modèle qui ne bat pas « demain = aujourd'hui » n'est pas un modèle, et le code le DIT.
 * L'intervalle vient de l'erreur mesurée en validation, jamais d'une formule sur les résidus
 * d'ajustement (qui donnerait un intervalle deux fois trop étroit).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { type Rigueur, arrondi, ecartType, mediane, moyenne, rigueurVide } from "./rigueur";

export const POINTS_MIN = 6;
export const POINTS_MAX = 100_000;
export const HORIZON_MAX = 120;

export interface Point { instant: string | number | Date; valeur: number }

export interface Prevision {
  pas: number;
  instant: string | null;
  valeur: number;
  bas: number;
  haut: number;
}

export interface Rupture { position: number; instant: string | null; avant: number; apres: number; ecartRelatif: number }

export interface ResultatSerie {
  ok: true;
  n: number;
  periode: number | null;
  periodeDetectee: boolean;
  modele: "moyenne" | "tendance" | "tendance+saison";
  saisonnalite: "additive" | "multiplicative" | null;
  /** La composante de tendance lissée, alignée sur la série. */
  tendance: number[];
  /** Les coefficients saisonniers (longueur = période), 1-indexés sur le cycle. */
  coefficientsSaison: number[] | null;
  residus: number[];
  previsions: Prevision[];
  /** Erreur en validation par fenêtre glissante — la SEULE qui compte. */
  validation: {
    points: number;
    erreurMoyenneAbsolue: number;
    erreurPourcentMoyenne: number;
    racineErreurQuadratique: number;
    /** Rapport à la marche naïve : < 1 = le modèle fait mieux, ≥ 1 = il ne sert à rien. */
    contreNaif: number;
    contreSaisonNaif: number | null;
  } | null;
  ruptures: Rupture[];
  croissanceMoyennePourcent: number | null;
  rigueur: Rigueur;
  ms: number;
}
export type Serie = ResultatSerie | { ok: false; erreur: string };

const nombreDe = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = v.trim().replace(/\s/g, "").replace(",", "."); const n = t ? Number(t) : NaN; return Number.isFinite(n) ? n : null; }
  return null;
};

const instantTexte = (i: Point["instant"]): string | null => {
  if (i instanceof Date) return Number.isNaN(i.getTime()) ? null : i.toISOString().slice(0, 10);
  if (typeof i === "string") return i;
  if (typeof i === "number") return String(i);
  return null;
};

/** L'autocorrélation à un décalage donné (série centrée). */
export function autocorrelation(xs: readonly number[], decalage: number): number {
  const n = xs.length;
  if (decalage <= 0 || decalage >= n) return 0;
  const m = moyenne(xs);
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) { const d = xs[i]! - m; den += d * d; if (i + decalage < n) num += d * (xs[i + decalage]! - m); }
  return den > 0 ? num / den : 0;
}

/** Cherche la période saisonnière : le décalage dont l'autocorrélation domine nettement. */
export function detecterPeriode(xs: readonly number[], candidats: readonly number[] = [4, 7, 12, 52]): { periode: number; force: number } | null {
  const n = xs.length;
  const testables = candidats.filter((p) => p >= 2 && n >= p * 3);
  if (!testables.length) return null;
  let meilleur: { periode: number; force: number } | null = null;
  for (const p of testables) {
    const a = autocorrelation(xs, p);
    if (a > 0.3 && (!meilleur || a > meilleur.force)) meilleur = { periode: p, force: a };
  }
  return meilleur;
}

interface Etat { niveau: number; tendance: number; saison: number[] }

function holtWinters(xs: readonly number[], periode: number | null, saisonMultiplicative: boolean, params: { alpha: number; beta: number; gamma: number }): { ajuste: number[]; etat: Etat } {
  const n = xs.length;
  const { alpha, beta, gamma } = params;
  const P = periode ?? 0;
  let niveau = P ? moyenne(xs.slice(0, P)) : xs[0]!;
  let tendance = 0;
  if (P && n >= 2 * P) tendance = (moyenne(xs.slice(P, 2 * P)) - moyenne(xs.slice(0, P))) / P;
  else if (n >= 2) tendance = (xs[Math.min(n - 1, 3)]! - xs[0]!) / Math.max(1, Math.min(n - 1, 3));
  const saison = new Array<number>(Math.max(1, P)).fill(saisonMultiplicative ? 1 : 0);
  if (P) for (let i = 0; i < P; i += 1) {
    const memes: number[] = [];
    for (let j = i; j < n; j += P) memes.push(xs[j]!);
    const mm = moyenne(memes), mg = moyenne(xs);
    saison[i] = saisonMultiplicative ? (mg !== 0 ? mm / mg : 1) : mm - mg;
  }
  const ajuste: number[] = [];
  for (let t = 0; t < n; t += 1) {
    const s = P ? saison[t % P]! : saisonMultiplicative ? 1 : 0;
    const prevu = saisonMultiplicative ? (niveau + tendance) * s : niveau + tendance + s;
    ajuste.push(prevu);
    const y = xs[t]!;
    const niveauPrec = niveau;
    if (saisonMultiplicative) {
      niveau = s !== 0 ? alpha * (y / s) + (1 - alpha) * (niveau + tendance) : niveau + tendance;
      tendance = beta * (niveau - niveauPrec) + (1 - beta) * tendance;
      if (P && niveau !== 0) saison[t % P] = gamma * (y / niveau) + (1 - gamma) * s;
    } else {
      niveau = alpha * (y - s) + (1 - alpha) * (niveau + tendance);
      tendance = beta * (niveau - niveauPrec) + (1 - beta) * tendance;
      if (P) saison[t % P] = gamma * (y - niveau) + (1 - gamma) * s;
    }
  }
  return { ajuste, etat: { niveau, tendance, saison } };
}

function prevoirDepuis(etat: Etat, periode: number | null, saisonMultiplicative: boolean, depuis: number, horizon: number): number[] {
  const out: number[] = [];
  for (let h = 1; h <= horizon; h += 1) {
    const s = periode ? etat.saison[(depuis + h - 1) % periode]! : saisonMultiplicative ? 1 : 0;
    const base = etat.niveau + h * etat.tendance;
    out.push(saisonMultiplicative ? base * s : base + s);
  }
  return out;
}

/** Cherche α, β, γ par balayage grossier puis fin, sur l'erreur de prévision à un pas. */
function calibrer(xs: readonly number[], periode: number | null, mult: boolean): { alpha: number; beta: number; gamma: number } {
  const grille = [0.05, 0.2, 0.4, 0.6, 0.8];
  let best = { alpha: 0.3, beta: 0.1, gamma: 0.1 }, bestErr = Infinity;
  const depart = periode ? periode * 2 : 2;
  for (const alpha of grille) for (const beta of [0, ...grille]) for (const gamma of periode ? [0.05, 0.2, 0.4] : [0]) {
    const { ajuste } = holtWinters(xs, periode, mult, { alpha, beta, gamma });
    let err = 0, k = 0;
    for (let i = depart; i < xs.length; i += 1) { err += Math.abs(xs[i]! - ajuste[i]!); k += 1; }
    if (k && err / k < bestErr) { bestErr = err / k; best = { alpha, beta, gamma }; }
  }
  return best;
}

export interface OptionsSerie {
  /** Absente ou « auto » : la période est CHERCHÉE. `null` : aucune saisonnalité, explicitement. */
  periode?: number | null | "auto";
  horizon?: number;
  saisonnalite?: "additive" | "multiplicative" | "auto";
  /** Nombre de points gardés pour la validation glissante (0 = pas de validation). */
  validation?: number;
}

export function analyserSerie(points: readonly (Point | Record<string, unknown>)[], options: OptionsSerie = {}): Serie {
  const t0 = Date.now();
  const rigueur = rigueurVide();
  // Accepte {instant, valeur} ou une ligne quelconque à deux colonnes.
  const propres: { instant: string | null; valeur: number }[] = [];
  for (const p of points) {
    const o = p as Record<string, unknown>;
    const valeur = nombreDe(o.valeur ?? o.value ?? o.montant ?? o.y);
    const instant = o.instant ?? o.date ?? o.periode ?? o.mois ?? o.x ?? null;
    if (valeur === null) continue;
    propres.push({ instant: instant === null ? null : instantTexte(instant as Point["instant"]), valeur });
  }
  const n = propres.length;
  if (n < POINTS_MIN) return { ok: false, erreur: `${n} point(s) exploitable(s) : au moins ${POINTS_MIN} sont nécessaires pour distinguer une tendance du bruit.` };
  if (n > POINTS_MAX) return { ok: false, erreur: `${n} points : ${POINTS_MAX} au plus.` };
  const xs = propres.map((p) => p.valeur);
  const manquants = points.length - n;

  // Période. `periode: null` DEMANDE explicitement l'absence de saisonnalité ; absente, elle est cherchée.
  const auto = options.periode === undefined || (options.periode as unknown) === "auto";
  let periode: number | null = auto || typeof options.periode !== "number" ? null : options.periode;
  let periodeDetectee = false;
  if (auto) {
    const d = detecterPeriode(xs);
    if (d) { periode = d.periode; periodeDetectee = true; }
  }
  if (periode !== null && (periode < 2 || n < periode * 3)) {
    if (periode !== null && n < periode * 3) rigueur.avertissements.push(`Saisonnalité de période ${periode} demandée mais ${n} points seulement : il en faut au moins ${periode * 3} pour l'estimer — elle est IGNORÉE.`);
    periode = null;
  }

  // Additive ou multiplicative : la variabilité grandit-elle avec le niveau ?
  let mult = false;
  if (periode && options.saisonnalite !== "additive") {
    if (options.saisonnalite === "multiplicative") mult = true;
    else if (xs.every((x) => x > 0)) {
      const blocs: { m: number; s: number }[] = [];
      for (let i = 0; i + periode <= n; i += periode) { const b = xs.slice(i, i + periode); blocs.push({ m: moyenne(b), s: ecartType(b) }); }
      if (blocs.length >= 3) {
        const bas = blocs.slice(0, Math.ceil(blocs.length / 2)), haut = blocs.slice(Math.ceil(blocs.length / 2));
        const cvBas = moyenne(bas.map((b) => (b.m > 0 ? b.s / b.m : 0)));
        const ratioBas = moyenne(bas.map((b) => b.s)), ratioHaut = moyenne(haut.map((b) => b.s));
        const niveauBas = moyenne(bas.map((b) => b.m)), niveauHaut = moyenne(haut.map((b) => b.m));
        if (niveauHaut > niveauBas * 1.2 && ratioHaut > ratioBas * 1.3 && cvBas > 0) mult = true;
      }
    }
  }

  const params = calibrer(xs, periode, mult);
  const { ajuste, etat } = holtWinters(xs, periode, mult, params);
  const residus = xs.map((x, i) => x - ajuste[i]!);

  // Validation glissante : réajuster sur le passé, prévoir un pas, comparer.
  const reserve = options.validation ?? Math.max(0, Math.min(Math.floor(n / 4), periode ? periode * 2 : 12));
  let validation: ResultatSerie["validation"] = null;
  if (reserve >= 3 && n - reserve >= Math.max(POINTS_MIN, (periode ?? 1) * 2)) {
    const erreurs: number[] = [], erreursNaif: number[] = [], erreursSaison: number[] = [], pourcents: number[] = [];
    for (let coupe = n - reserve; coupe < n; coupe += 1) {
      const passe = xs.slice(0, coupe);
      const p2 = periode && coupe >= periode * 2 ? periode : null;
      const { etat: e2 } = holtWinters(passe, p2, mult, params);
      const prevu = prevoirDepuis(e2, p2, mult, coupe, 1)[0]!;
      const reel = xs[coupe]!;
      erreurs.push(Math.abs(prevu - reel));
      erreursNaif.push(Math.abs(passe[coupe - 1]! - reel));
      if (periode && coupe >= periode) erreursSaison.push(Math.abs(passe[coupe - periode]! - reel));
      if (Math.abs(reel) > 1e-9) pourcents.push(Math.abs((prevu - reel) / reel) * 100);
    }
    const eam = moyenne(erreurs);
    const eamNaif = moyenne(erreursNaif);
    validation = {
      points: erreurs.length,
      erreurMoyenneAbsolue: eam,
      erreurPourcentMoyenne: pourcents.length ? moyenne(pourcents) : NaN,
      racineErreurQuadratique: Math.sqrt(moyenne(erreurs.map((e) => e * e))),
      contreNaif: eamNaif > 0 ? eam / eamNaif : eam === 0 ? 1 : Infinity,
      contreSaisonNaif: erreursSaison.length ? (moyenne(erreursSaison) > 0 ? eam / moyenne(erreursSaison) : 1) : null,
    };
  }

  // Prévision + intervalle depuis l'erreur MESURÉE (validation) ou, à défaut, les résidus élargis.
  const horizon = Math.max(0, Math.min(options.horizon ?? (periode ?? 3), HORIZON_MAX));
  const valeurs = prevoirDepuis(etat, periode, mult, n, horizon);
  const sigma = validation ? validation.racineErreurQuadratique : ecartType(residus) * 1.5;
  const previsions: Prevision[] = valeurs.map((v, h) => {
    // L'incertitude grandit avec l'horizon (√h, comme une marche aléatoire).
    const marge = 1.96 * sigma * Math.sqrt(h + 1);
    return { pas: h + 1, instant: null, valeur: v, bas: v - marge, haut: v + marge };
  });

  // Ruptures de niveau : une moyenne mobile qui saute nettement.
  const ruptures: Rupture[] = [];
  const fenetre = Math.max(3, Math.min(12, Math.floor(n / 5)));
  if (n >= fenetre * 3) {
    const bruit = mediane(residus.map((r) => Math.abs(r))) || ecartType(xs) * 0.1;
    const sauts: { i: number; saut: number; avant: number; apres: number }[] = [];
    for (let i = fenetre; i <= n - fenetre; i += 1) {
      const avant = moyenne(xs.slice(i - fenetre, i)), apres = moyenne(xs.slice(i, i + fenetre));
      sauts.push({ i, saut: Math.abs(apres - avant), avant, apres });
    }
    // Le point de rupture est le MAXIMUM local du saut : le premier franchissement du seuil tombe
    // au bord de la fenêtre et sous-estimerait l'écart de moitié.
    const candidats = sauts
      .filter((s) => s.saut > Math.max(4 * bruit, Math.abs(s.avant) * 0.25))
      .sort((a, b) => b.saut - a.saut);
    for (const c of candidats) {
      if (ruptures.some((r) => Math.abs(r.position - c.i) <= fenetre)) continue;
      ruptures.push({ position: c.i, instant: propres[c.i]?.instant ?? null, avant: c.avant, apres: c.apres, ecartRelatif: Math.abs(c.avant) > 1e-9 ? (c.apres - c.avant) / Math.abs(c.avant) : 0 });
    }
    ruptures.sort((a, b) => a.position - b.position);
  }

  const croissanceMoyennePourcent = xs[0]! > 0 && xs[n - 1]! > 0 && n > 1 ? ((xs[n - 1]! / xs[0]!) ** (1 / (n - 1)) - 1) * 100 : null;
  const modele: ResultatSerie["modele"] = periode ? "tendance+saison" : Math.abs(etat.tendance) > 1e-9 ? "tendance" : "moyenne";

  rigueur.hypotheses.push(`Lissage exponentiel${periode ? ` avec saisonnalité ${mult ? "multiplicative" : "additive"} de période ${periode}${periodeDetectee ? " (DÉTECTÉE par autocorrélation, non déclarée)" : ""}` : " sans saisonnalité"} ; α=${params.alpha}, β=${params.beta}${periode ? `, γ=${params.gamma}` : ""}.`);
  rigueur.hypotheses.push("Points supposés RÉGULIÈREMENT espacés et dans l'ordre : un trou non déclaré est traité comme une observation continue.");
  rigueur.limites.push("Une prévision prolonge le passé : elle ne connaît ni la décision qui n'a pas encore été prise, ni le choc qui n'a pas eu lieu.");
  if (validation) {
    rigueur.limites.push(`Intervalle bâti sur l'erreur MESURÉE en validation (${validation.points} points hors échantillon), pas sur l'ajustement — c'est ce qui l'empêche d'être trop étroit.`);
    if (validation.contreNaif >= 1) rigueur.avertissements.push(`Le modèle ne bat PAS la prévision naïve « demain = aujourd'hui » (rapport ${arrondi(validation.contreNaif, 2)}) : sur cette série, il n'apporte rien — utiliser la dernière valeur.`);
    if (validation.contreSaisonNaif !== null && validation.contreSaisonNaif >= 1) rigueur.avertissements.push(`Le modèle ne bat pas non plus la saisonnalité naïve (même période l'an dernier, rapport ${arrondi(validation.contreSaisonNaif, 2)}).`);
    if (Number.isFinite(validation.erreurPourcentMoyenne) && validation.erreurPourcentMoyenne > 30) rigueur.avertissements.push(`Erreur de prévision moyenne ${arrondi(validation.erreurPourcentMoyenne, 1)} % hors échantillon : la série est trop irrégulière pour une prévision fiable.`);
  } else rigueur.avertissements.push("Série trop courte pour une validation hors échantillon : l'intervalle est estimé sur les résidus d'ajustement et sera OPTIMISTE.");
  if (n < 24 && periode) rigueur.avertissements.push(`${n} points pour une saisonnalité de période ${periode} : deux cycles complets au minimum, trois pour être crédible.`);
  if (manquants) rigueur.avertissements.push(`${manquants} point(s) sans valeur numérique écarté(s) : les trous décalent la saisonnalité.`);
  if (ruptures.length) rigueur.avertissements.push(`${ruptures.length} rupture(s) de niveau détectée(s)${ruptures[0]!.instant ? ` (la première vers ${ruptures[0]!.instant})` : ""} : le passé d'avant la rupture ne décrit plus le présent, la prévision est fragile.`);
  if (periodeDetectee) rigueur.avertissements.push(`Période ${periode} DÉTECTÉE automatiquement : vérifier qu'elle correspond à un cycle réel (mois, semaine, trimestre) et non à un artefact.`);

  return {
    ok: true, n, periode, periodeDetectee, modele, saisonnalite: periode ? (mult ? "multiplicative" : "additive") : null,
    tendance: ajuste.map((a, i) => (periode ? a - (mult ? 0 : etat.saison[i % periode]!) : a)),
    coefficientsSaison: periode ? [...etat.saison] : null,
    residus, previsions, validation, ruptures, croissanceMoyennePourcent, rigueur, ms: Date.now() - t0,
  };
}

/** Le texte court d'une prévision. */
export function resumerSerie(s: ResultatSerie): string[] {
  const lignes: string[] = [];
  lignes.push(`${s.n} points, modèle ${s.modele}${s.periode ? ` (saison ${s.periode}, ${s.saisonnalite})` : ""}.`);
  if (s.previsions.length) {
    const p = s.previsions[0]!;
    const dernier = s.previsions[s.previsions.length - 1]!;
    lignes.push(`Prochain pas : ${arrondi(p.valeur, 3)} (intervalle ${arrondi(p.bas, 3)} → ${arrondi(p.haut, 3)}) ; à ${dernier.pas} pas : ${arrondi(dernier.valeur, 3)} (${arrondi(dernier.bas, 3)} → ${arrondi(dernier.haut, 3)}).`);
  }
  if (s.validation) lignes.push(`Erreur hors échantillon : ${arrondi(s.validation.erreurMoyenneAbsolue, 3)} en moyenne${Number.isFinite(s.validation.erreurPourcentMoyenne) ? ` (${arrondi(s.validation.erreurPourcentMoyenne, 1)} %)` : ""} ; ${s.validation.contreNaif < 1 ? `${arrondi((1 - s.validation.contreNaif) * 100, 0)} % mieux que` : "pas mieux que"} la prévision naïve.`);
  if (s.ruptures.length) lignes.push(`Rupture(s) de niveau : ${s.ruptures.map((r) => `${r.instant ?? `position ${r.position}`} (${r.ecartRelatif > 0 ? "+" : ""}${arrondi(r.ecartRelatif * 100, 1)} %)`).join(", ")}.`);
  if (s.croissanceMoyennePourcent !== null) lignes.push(`Croissance moyenne par pas : ${arrondi(s.croissanceMoyennePourcent, 2)} %.`);
  return lignes;
}
