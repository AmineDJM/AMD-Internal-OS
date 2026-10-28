/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CALIBRATION DE CONFIANCE (mandat 4 §29) — pure, un seul import : les durées du socle.
 *
 * Ce qu'Adam sait se range en six états, et chacun COMMANDE une conduite :
 *
 *   CERTAIN        → AGIR       (lu dans l'ERP ou calculé par le code, frais, sous droits)
 *   PROBABLE       → VÉRIFIER   (un document indexé, une lecture OCR, une déduction)
 *   PERIME         → RELIRE     (une COPIE indexée plus vieille que sa nature ne le permet)
 *   HYPOTHÈSE      → CHERCHER   (la mémoire d'un modèle, le web, une estimation)
 *   MANQUANT       → DEMANDER   (aucun fait pour ce que la question exige)
 *   CONTRADICTION  → ARBITRER   (deux sources, deux valeurs, un même libellé)
 *
 * ── POURQUOI « PÉRIMÉ » EST UN ÉTAT ET NON UN DEGRÉ DE CONFIANCE ────────────────────────
 *
 * Un fait lu dans une copie indexée il y a six mois avait `base: "metadata"` et une confiance
 * de 0,95 : il sortait CERTAIN, et Adam agissait dessus en annonçant « FAIT VÉRIFIÉ ». La date
 * était pourtant là, dans `horodatage` — déclarée sur l'interface, lue par personne. C'est le
 * même faux succès que §118.46, un cran plus haut : rien, nulle part, ne se souvenait de QUAND.
 *
 * L'ÂGE ET LA PROVENANCE SONT DEUX AXES (§118.16). Un fait peut être certain-et-vieux ; les
 * confondre perdrait l'un des deux. Et la conduite n'est pas la même : sur une provenance
 * faible on CHERCHE ailleurs, sur une donnée vieille on RELIT la même source.
 *
 * ── CE QUI NE VIEILLIT PAS, ET C'EST LA MOITIÉ DE LA RÈGLE ─────────────────────────────
 *
 * Une lecture en TEMPS RÉEL ne périme pas de la date de sa donnée : une facture de 2024 EST de
 * 2024, elle n'est pas « périmée » — la table était vivante au moment de la lecture. Seule une
 * COPIE indexée vieillit, parce que la source a pu bouger depuis sans que la copie le sache.
 * Et un fait dont on ne lit pas la date à coup sûr n'est JAMAIS déclaré périmé : une garde qui
 * refuse ce qu'elle ne comprend pas est désactivée dans la semaine (§118.16).
 *
 * La règle est ARITHMÉTIQUE et se relit : le maillon le plus faible gouverne. Vingt faits
 * certains et un fait de mémoire font une réponse « hypothèse » — parce que c'est celui-là qu'on
 * aurait cité sans le savoir. Elle ne remplace ni la vérification indépendante des missions
 * critiques (§49) ni l'échelle des recours (§118 : TROUVÉ / DÉDUIT / CANDIDAT / INCONNU) : elle
 * parle le même vocabulaire, à l'échelle d'un tour de conversation ou d'un rapport de spécialiste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { AGES_CREDIBLES_H, direDuree } from "@/lib/fraicheur/ages";

export type Certitude = "CERTAIN" | "PROBABLE" | "PERIME" | "HYPOTHESE" | "MANQUANT" | "CONTRADICTION";
export type Conduite = "AGIR" | "VERIFIER" | "RELIRE" | "CHERCHER" | "DEMANDER" | "ARBITRER";
export type Enjeu = "FAIBLE" | "NORMAL" | "ELEVE";

export const CONDUITE_PAR_CERTITUDE: Record<Certitude, Conduite> = { CERTAIN: "AGIR", PROBABLE: "VERIFIER", PERIME: "RELIRE", HYPOTHESE: "CHERCHER", MANQUANT: "DEMANDER", CONTRADICTION: "ARBITRER" };
export const LIBELLE_CERTITUDE: Record<Certitude, string> = { CERTAIN: "certain", PROBABLE: "probable", PERIME: "périmé", HYPOTHESE: "hypothèse", MANQUANT: "manquant", CONTRADICTION: "contradiction" };
export const LIBELLE_CONDUITE: Record<Conduite, string> = { AGIR: "agir", VERIFIER: "vérifier avant d'agir", RELIRE: "relire la source avant d'agir", CHERCHER: "chercher encore", DEMANDER: "demander à la personne", ARBITRER: "arbitrer la contradiction" };

/** Ce qu'un fait doit dire pour être calibré — la forme de `FaitSource` (F8), sans dépendre d'elle. */
export interface FaitCalibrable {
  id: string;
  libelle: string;
  valeur: string | null;
  /** ERP, DOCUMENT, EMAIL, CALCUL, EXTERNE… */
  nature: string;
  outil: string;
  confiance: number;
  /** metadata, native, ocr, luna, terra, calcul, externe, declare. */
  base: string;
  fraicheur: string;
  horodatage: string | null;
  preuveNegative: boolean | null;
}

export interface Contradiction { libelle: string; valeurs: string[]; outils: string[] }

/** Une COPIE indexée plus vieille que ce que sa nature autorise — avec de quoi le dire. */
export interface FaitPerime {
  libelle: string;
  outil: string;
  ageH: number;
  seuilH: number;
  phrase: string;
}

export interface Calibration {
  certitude: Certitude;
  conduite: Conduite;
  motif: string;
  enjeu: Enjeu;
  faits: number;
  parCertitude: Record<"CERTAIN" | "PROBABLE" | "HYPOTHESE", number>;
  contradictions: Contradiction[];
  manquants: string[];
  /** Les copies trop vieilles pour leur nature. Vide quand rien n'est datable à coup sûr. */
  perimes: FaitPerime[];
}

const plier = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const chiffres = (s: string): string => s.replace(/[^0-9]/g, "");

/** LA CERTITUDE D'UN FAIT : d'où il vient et à quel point la source le tient. */
export function certitudeDuFait(f: Pick<FaitCalibrable, "confiance" | "base" | "nature">): "CERTAIN" | "PROBABLE" | "HYPOTHESE" {
  const base = (f.base || "").toLowerCase();
  /**
   * UNE ESTIMATION N'EST JAMAIS UN FAIT, quel que soit le nombre de tirages.
   *
   * Un P90 de Monte-Carlo et une prévision de série sortaient avec `base: "calcul"` et une
   * confiance de 1 — parce que `faitCalcule` prend la PIRE confiance de ses entrées, et que
   * les entrées d'une simulation sont des LOIS, pas des faits. Ils sortaient donc CERTAIN →
   * AGIR, annoncés « FAIT VÉRIFIÉ » : le même mot que pour une ligne lue dans l'ERP. Le
   * moteur, lui, le savait — il écrit ses hypothèses et ses limites à côté du chiffre, et
   * l'en-tête de `calcul-tools.ts` dit en toutes lettres qu'« un P90 sans le nombre de
   * tirages est un chiffre qui a l'air sûr ». La calibration le contredisait.
   *
   * La confiance ne rachète RIEN ici, et c'est voulu : elle mesure la qualité du modèle, pas
   * la vérité du monde. Cent mille tirages ne transforment pas une projection en mesure.
   */
  if (base === "estimation") return "HYPOTHESE";
  // Une lecture de modèle (Luna / Terra) ou le web n'est JAMAIS certaine : au mieux probable.
  if (base === "luna" || base === "terra" || base === "externe" || f.nature === "EXTERNE") return f.confiance >= 0.9 ? "PROBABLE" : "HYPOTHESE";
  if (f.confiance >= 0.85 && (base === "metadata" || base === "native" || base === "calcul" || base === "declare")) return "CERTAIN";
  if (f.confiance >= 0.6) return "PROBABLE";
  return "HYPOTHESE";
}

/** DEUX VALEURS POUR UN MÊME LIBELLÉ : la contradiction se constate, elle ne se tranche pas ici. */
export function contradictionsDe(faits: readonly FaitCalibrable[]): Contradiction[] {
  const groupes = new Map<string, { libelle: string; valeurs: Map<string, string>; outils: Set<string> }>();
  for (const f of faits) {
    if (f.preuveNegative || !f.valeur || !f.libelle) continue;
    const cle = plier(f.libelle);
    if (!cle) continue;
    const g = groupes.get(cle) ?? { libelle: f.libelle, valeurs: new Map(), outils: new Set() };
    const v = plier(f.valeur).replace(/\s+/g, "");
    if (v) { if (!g.valeurs.has(v)) g.valeurs.set(v, f.valeur); g.outils.add(f.outil); }
    groupes.set(cle, g);
  }
  return [...groupes.values()].filter((g) => g.valeurs.size > 1).map((g) => ({ libelle: g.libelle, valeurs: [...g.valeurs.values()], outils: [...g.outils] }));
}

/** CE QUE LA QUESTION EXIGE ET QU'AUCUN FAIT NE PORTE : nombres ou noms ancrés dans la question. */
export function manquantsDe(faits: readonly FaitCalibrable[], requis: readonly string[]): string[] {
  const textes = faits.map((f) => `${plier(f.libelle)} ${plier(f.valeur ?? "")}`);
  const nombres = faits.map((f) => chiffres(`${f.libelle} ${f.valeur ?? ""}`));
  return requis.filter((r) => {
    const rp = plier(r);
    if (!rp) return false;
    const rn = chiffres(r);
    if (rn.length >= 2 && nombres.some((n) => n.includes(rn))) return false;
    return !textes.some((t) => t.includes(rp));
  });
}

/**
 * LA NATURE D'UN FAIT, dans le vocabulaire des durées du socle.
 *
 * Le registre des sources parle en `NatureSource` (ERP, DOCUMENT, EMAIL…), les durées parlent en
 * familles de péremption. Ce n'est pas une bijection et il n'y a pas à en faire une : un e-mail
 * et une réunion vieillissent comme une parole humaine, une page de PDF comme un document.
 */
const NATURE_VERS_AGE: Record<string, string> = {
  ERP: "ERP", PERSONNE: "ERP",
  DOCUMENT: "DOCUMENT", PAGE_PDF: "DOCUMENT", PIECE: "DOCUMENT", CELLULE: "DOCUMENT",
  EMAIL: "HUMAIN", FIL: "HUMAIN", REUNION: "HUMAIN",
  EXTERNE: "AUTRE", DATE: "AUTRE",
  /**
   * UN CALCUL SE JUGE SUR LE BUDGET LE PLUS LARGE, et c'est une décision, pas un oubli.
   *
   * `faitCalcule` date un total par sa donnée la plus ANCIENNE et lui donne la fraîcheur de sa
   * PIRE entrée — mais il ne garde pas la NATURE de cette entrée. On ne peut donc pas lire quel
   * seuil gouverne. Le ranger dans « AUTRE » (48 h) enverrait relire un total bâti sur des
   * documents au bout de deux jours, alors que les documents eux-mêmes tiennent trente : c'est
   * du bruit, et un avertissement qu'on voit trop souvent cesse d'être lu (§118.32).
   *
   * Sous-signaler est ici le côté sûr : quand les entrées sont dans le même lot — elles y sont
   * dès que l'outil les déclare avec le total — elles sont jugées sur LEUR seuil, plus strict,
   * et c'est ce jugement-là qui parle.
   */
  CALCUL: "DOCUMENT",
};

/**
 * LES FAITS PÉRIMÉS — et les trois conditions, toutes nécessaires.
 *
 *   1. C'est une COPIE (`fraicheur: "INDEXEE"`). Une lecture en temps réel ne périme pas de la
 *      date de sa donnée : une facture de 2024 EST de 2024, la table était vivante.
 *   2. Sa date se LIT (`horodatage` valide). Sans date, on ne déclare rien — deviner ferait
 *      dire « périmé » sur une donnée d'hier, et la garde serait retirée dans la semaine.
 *   3. Elle dépasse ce que sa nature autorise. Un document indexé tient trente jours, un
 *      chiffre financier vingt-quatre heures : un seuil unique serait faux dans les deux sens.
 *
 * `maintenant` arrive en paramètre : ce module reste pur, et un test peut vieillir une donnée
 * sans attendre.
 */
export function perimesDe(faits: readonly FaitCalibrable[], maintenant: Date = new Date()): FaitPerime[] {
  const out: FaitPerime[] = [];
  for (const f of faits) {
    if (f.preuveNegative) continue;
    if ((f.fraicheur || "").toUpperCase() !== "INDEXEE") continue;
    const t = f.horodatage ? Date.parse(f.horodatage) : NaN;
    if (!Number.isFinite(t)) continue;
    const ageH = (maintenant.getTime() - t) / 3_600_000;
    // Une date FUTURE n'est pas une péremption : c'est une donnée mal saisie, et l'annoncer
    // périmée enverrait relire pour rien. On se tait — le contrôle qualité des données la voit.
    if (ageH < 0) continue;
    const cle = NATURE_VERS_AGE[(f.nature || "").toUpperCase()] ?? "AUTRE";
    const seuilH = AGES_CREDIBLES_H[cle] ?? AGES_CREDIBLES_H.AUTRE;
    if (ageH < seuilH) continue;
    out.push({
      libelle: f.libelle, outil: f.outil, ageH, seuilH,
      phrase: `« ${f.libelle} » vient d'une copie indexée datée d'il y a ${direDuree(ageH)} `
        + `(${f.outil}) ; une donnée de cette nature n'est plus tenue pour fraîche au-delà de ${direDuree(seuilH)}.`,
    });
  }
  return out.sort((a, b) => b.ageH - a.ageH);
}

/**
 * CALIBRER un lot de faits — pour un tour, un rapport de spécialiste, une étape de mission.
 * `requis` : les ancres de la question (montant, référence, nom) ; sans fait qui les porte, MANQUANT.
 */
export function calibrer(
  faits: readonly FaitCalibrable[],
  opts: { requis?: readonly string[]; enjeu?: Enjeu; maintenant?: Date } = {},
): Calibration {
  const enjeu = opts.enjeu ?? "NORMAL";
  const utiles = faits.filter((f) => !f.preuveNegative);
  const parCertitude = { CERTAIN: 0, PROBABLE: 0, HYPOTHESE: 0 };
  for (const f of utiles) parCertitude[certitudeDuFait(f)] += 1;
  const contradictions = contradictionsDe(utiles);
  const manquants = manquantsDe(faits, opts.requis ?? []);
  const perimes = perimesDe(utiles, opts.maintenant ?? new Date());
  let certitude: Certitude;
  let motif: string;
  if (contradictions.length) {
    const c = contradictions[0];
    certitude = "CONTRADICTION";
    motif = `contradiction sur « ${c.libelle} » : ${c.valeurs.slice(0, 3).join(" ≠ ")} (${c.outils.join(", ")})${contradictions.length > 1 ? ` — et ${contradictions.length - 1} autre(s)` : ""}`;
  } else if (!utiles.length) {
    certitude = "MANQUANT";
    motif = faits.length ? "seules des preuves négatives ont été lues : rien d'établi" : "aucun fait lu par un outil : rien n'est établi";
  } else if (manquants.length) {
    certitude = "MANQUANT";
    motif = `aucun fait lu ne porte ${manquants.slice(0, 3).map((m) => `« ${m} »`).join(", ")}${manquants.length > 3 ? "…" : ""}`;
  } else if (parCertitude.HYPOTHESE > 0) {
    certitude = "HYPOTHESE";
    motif = `${parCertitude.HYPOTHESE} fait(s) de mémoire, du web ou à faible confiance dans le lot (${parCertitude.CERTAIN} certain(s), ${parCertitude.PROBABLE} probable(s)) : le maillon faible gouverne`;
  } else if (perimes.length) {
    // APRÈS l'hypothèse et avant le probable : une copie vieille reste une lecture d'une vraie
    // source, mais on ne peut pas AGIR dessus sans l'avoir relue. La conduite est RELIRE, pas
    // CHERCHER : on sait exactement où retourner.
    certitude = "PERIME";
    motif = perimes.length === 1
      ? perimes[0].phrase
      : `${perimes.length} copies indexées trop anciennes, la plus vieille de ${direDuree(perimes[0].ageH)} : ${perimes[0].libelle}`;
  } else if (parCertitude.PROBABLE > 0) {
    certitude = "PROBABLE";
    motif = `${parCertitude.PROBABLE} fait(s) lus dans un document ou déduits, ${parCertitude.CERTAIN} certain(s)`;
  } else {
    certitude = "CERTAIN";
    motif = `${parCertitude.CERTAIN} fait(s) lus dans l'ERP ou calculés par le code`;
  }
  let conduite = CONDUITE_PAR_CERTITUDE[certitude];
  // Un enjeu FAIBLE (une lecture sans conséquence) ne fait pas vérifier un fait probable ; un enjeu
  // ÉLEVÉ ne fait pas agir sur une hypothèse — la table dit déjà CHERCHER.
  if (certitude === "PROBABLE" && enjeu === "FAIBLE") conduite = "AGIR";
  return { certitude, conduite, motif, enjeu, faits: faits.length, parCertitude, contradictions, manquants, perimes };
}

/** L'ENJEU d'une demande, depuis ce qu'on en sait : une action proposée ou un montant fort pèse ; une question courte pèse peu. */
export function enjeuDe(question: string, ctx: { propositions?: number; montantMax?: number | null } = {}): Enjeu {
  const q = plier(question);
  if ((ctx.propositions ?? 0) > 0) return "ELEVE";
  if ((ctx.montantMax ?? 0) >= 1_000_000) return "ELEVE";
  if (/\b(paie|payer|paiement|virement|vire|signe|signer|supprime|supprimer|envoie|envoyer|valide|valider|approuve|approuver|refuse|refuser|annule|annuler|resilie|resilier|denonce|denoncer)\b/.test(q)) return "ELEVE";
  if (q.length <= 60 && /^(quel|quelle|quels|quelles|combien|ou|qui|quand|c est quoi|liste|montre)\b/.test(q)) return "FAIBLE";
  return "NORMAL";
}

/** Une ligne pour la trace et l'écran : ce qu'on sait, pourquoi, et ce que ça commande. */
export function expliquerCalibration(c: Calibration): string {
  return `Certitude : ${LIBELLE_CERTITUDE[c.certitude]} — ${c.motif} → ${LIBELLE_CONDUITE[c.conduite]}`;
}
