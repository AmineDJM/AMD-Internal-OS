/**
 * LES RÈGLES DE SEGMENTATION — leur forme, et leur lecture sûre depuis la base (Segmentation Studio).
 *
 * Une version de règles est IMMUABLE (table `SegmentationRegle`) ; son contenu est ce JSON. Rien n'y est
 * codé en dur : ni « 22 patients », ni « 10 % », ni « 2 visites » — chaque valeur vient d'une version
 * publiée (par une personne, ou proposée par l'import d'un classeur puis publiée). `lireRegles` refuse un
 * contenu incohérent plutôt que de deviner une valeur manquante.
 *
 * Module PUR, zéro import : le moteur, l'import, les écrans et les tests lisent la même forme.
 */

export const SEGMENTS = ["A", "B", "C", "D"] as const;
export type Segment = (typeof SEGMENTS)[number];

/** L'état d'un praticien pour UN produit. Une donnée manquante est EN_ATTENTE — jamais D. */
export type EtatProduit = "NON_CIBLE" | "EN_ATTENTE" | Segment;

/**
 * LA LETTRE D'UN PRATICIEN (Direction, 07/10) — ce que l'écran montre, pour le produit #1 : H (décideur), A/B/C/D,
 * NA (une réponse manque — jamais D), NC (non ciblé : ne consulte pas, statut ou spécialité non visés, décision).
 */
export const LETTRES = ["H", "A", "B", "C", "D", "NA", "NC"] as const;
export type Lettre = (typeof LETTRES)[number];
/** Les lettres qu'une personne autorisée peut FORCER (NA n'est pas une décision : c'est une réponse qui manque). */
export const LETTRES_FORCABLES = ["H", "A", "B", "C", "D", "NC"] as const;

export const STATUTS = ["DECIDEUR", "INFLUENCEUR", "REFERENT", "PRESCRIPTEUR"] as const;
export type Statut = (typeof STATUTS)[number];

export const STATUT_LABELS: Record<Statut, string> = {
  DECIDEUR: "Décideur", INFLUENCEUR: "Influenceur", REFERENT: "Référent", PRESCRIPTEUR: "Prescripteur",
};

export const ETAT_LABELS: Record<EtatProduit, string> = {
  NON_CIBLE: "Non ciblé", EN_ATTENTE: "En attente de données", A: "A", B: "B", C: "C", D: "D",
};

export type Comparaison = ">" | ">=";

/**
 * Comment l'AFFINITÉ se calcule à partir de ce que le terrain a déclaré :
 *   • SUR_10 — « sur 10 patients, combien sous le produit » ÷ 10 : la part du produit chez ce praticien ;
 *   • RATIO_FICHIER — la méthode du classeur historique : (sur 10) ÷ (patients par semaine). Gardée pour
 *     reproduire les classements existants ; elle mélange deux unités, d'où le choix laissé à la Direction.
 */
export type MethodeAffinite = "SUR_10" | "RATIO_FICHIER";
export const METHODE_LABELS: Record<MethodeAffinite, string> = {
  SUR_10: "Part du produit (sur 10 patients ÷ 10)",
  RATIO_FICHIER: "Méthode du classeur (Q2 ÷ Q1 : sur 10 ÷ patients par semaine)",
};

/**
 * L'AFFINITÉ AFFICHÉE (colonne « % ») selon la méthode : Q2 ÷ 10, ou Q2 ÷ Q1 (la formule du classeur, « =I40/H40 »).
 * `null` quand elle ne se calcule pas (une réponse manque, ou Q1 = 0 pour le ratio). Fraction 0..1+.
 */
export function affiniteAffichee(q1: number | null, q2: number | null, methode: MethodeAffinite): number | null {
  if (q2 === null) return null;
  if (methode === "SUR_10") return q2 / 10;
  return q1 !== null && q1 > 0 ? q2 / q1 : null;
}

/**
 * D'OÙ VIENT L'AFFINITÉ (cahier des charges §34-35) : la déclaration du praticien (terrain), ou l'affinité de son
 * ÉTABLISSEMENT calculée sur la consommation — un PROXY que la BU choisit explicitement et que le « pourquoi »
 * affiche. Jamais une affinité d'hôpital attribuée en silence à un médecin.
 */
export type SourceAffinite = "DECLAREE" | "ETABLISSEMENT" | "DECLAREE_SINON_ETABLISSEMENT";
export const SOURCE_AFFINITE_LABELS: Record<SourceAffinite, string> = {
  DECLAREE: "Déclarée par le praticien (terrain)",
  ETABLISSEMENT: "Proxy : affinité de son établissement (consommation)",
  DECLAREE_SINON_ETABLISSEMENT: "Déclarée, sinon proxy établissement",
};

export interface ExceptionZone {
  /** Le libellé : le NOM du secteur (ou, pour les règles d'avant les secteurs, une zone libre « Ouest »). */
  zone: string;
  /** LE SECTEUR DE LA BU visé (Direction, 07/10). Absent = règle d'avant : la zone se compare au nom. */
  secteurId?: string;
  seuilPotentiel?: number;
  seuilAffinite?: number;
  comparaisonAffinite?: Comparaison;
}

export interface RegleProduit {
  productId: string;
  /** Ce que mesure le potentiel — « patients VIH / semaine ». Affiché tel quel. */
  metrique: string;
  /** Haut potentiel si potentiel ≥ seuil. */
  seuilPotentiel: number;
  /** Haute affinité si affinité (fraction 0..1) dépasse le seuil selon `comparaisonAffinite`. */
  seuilAffinite: number;
  comparaisonAffinite: Comparaison;
  methodeAffinite: MethodeAffinite;
  /** Absent = DECLAREE (les versions publiées avant la consommation gardent leur sens). */
  sourceAffinite?: SourceAffinite;
  exceptions: ExceptionZone[];
  /** Repère affiché à côté du seuil — « moyenne nationale 2026 : 7,21 % » (fraction). Ne classe personne. */
  reference?: { valeur: number; annee: number };
}

/**
 * LA GRILLE DES FRÉQUENCES PAR LETTRE (Direction, 07/10) — visites par cycle selon la lettre du praticien et son In/Out :
 * H (décideur, réglable à part — au moins A & B), A & B, C & D. NA et non ciblé : aucune visite requise.
 */
export const CLES_FREQUENCE = ["H_IN", "H_OUT", "AB_IN", "AB_OUT", "CD_IN", "CD_OUT"] as const;
export type CleFrequence = (typeof CLES_FREQUENCE)[number];
export type GrilleFrequence = Record<CleFrequence, number>;
export interface GrilleSecteur { secteurId: string; nom: string; valeurs: Partial<GrilleFrequence> }
export interface Grille { defaut: GrilleFrequence; secteurs: GrilleSecteur[] }
/** La capacité d'un KAM : contacts par jour, jours ouvrés d'un cycle. */
export interface Capacite { contactsParJour: number; joursParCycle: number }

/** « Au moins N produits en A », « exactement A + B + B », « produit #1 en A ». Évaluées dans l'ordre. */
export interface ReglePriorite {
  priorite: string;
  auMoins?: { segment: Segment; nombre: number };
  combinaison?: Segment[];
  rang1?: Segment[];
}

export interface ReplisPriorite {
  scores: Record<Segment, number>;
  /** Poids du produit #1, #2, #3. */
  poidsParRang: number[];
  /** Score moyen pondéré ≥ min → priorité ; lus du plus haut au plus bas. */
  paliers: { min: number; priorite: string }[];
}

export interface Regles {
  produits: RegleProduit[];
  ciblage: {
    /** Statuts qui ne sont pas ciblés (ex. aucun par défaut). */
    statutsNonCibles: Statut[];
    /** Un potentiel DÉCLARÉ à zéro (« ne consulte pas ») rend le praticien non ciblé pour ce produit. */
    potentielNulNonCible: boolean;
    /**
     * Un potentiel déclaré à zéro donne NA — « non applicable » (glossaire du classeur de la Direction : résidents,
     * pharmaciens… qui ne consultent pas mais restent au panel). L'emporte sur `potentielNulNonCible`. Absent = non.
     */
    potentielNulNA?: boolean;
  };
  /** H = décideur stratégique : SÉPARÉ de A/B/C/D, avec sa propre fréquence. */
  h: { statuts: Statut[]; frequence: number };
  priorites: { regles: ReglePriorite[]; repli: ReplisPriorite | null };
  /** Visites par cycle et par priorité (0,5 = une visite tous les deux cycles). */
  frequences: Record<string, number>;
  /**
   * LES FRÉQUENCES PARTICULIÈRES (Direction, 06/10) — par zone et/ou In/Out : « In » = le praticien est dans la wilaya
   * PIVOT du KAM qui le couvre, « Out » = dans une autre. `priorite` vaut une priorité (« P1 ») ou « H ». La plus
   * précise l'emporte (zone ET In/Out, puis l'une des deux) ; sans exception, la fréquence générale s'applique.
   */
  exceptionsFrequence?: ExceptionFrequence[];
  /** Présente = les visites se lisent par LETTRE et In/Out, secteur par secteur (remplace priorités et fréquences). */
  grille?: Grille;
  capacite?: Capacite;
}

export type InOut = "IN" | "OUT";
export interface ExceptionFrequence { zone: string | null; inOut: InOut | null; priorite: string; frequence: number }

export type LectureRegles = { ok: true; regles: Regles } | { ok: false; erreurs: string[] };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const estSegment = (v: unknown): v is Segment => typeof v === "string" && (SEGMENTS as readonly string[]).includes(v);
const estStatut = (v: unknown): v is Statut => typeof v === "string" && (STATUTS as readonly string[]).includes(v);

/** Lit et VALIDE un contenu de règles. Une valeur absente ou fausse est une erreur nommée — jamais un défaut inventé. */
export function lireRegles(brut: unknown): LectureRegles {
  const e: string[] = [];
  const o = (brut && typeof brut === "object" ? brut : {}) as Record<string, unknown>;
  const produitsBruts = Array.isArray(o.produits) ? o.produits : [];
  if (produitsBruts.length === 0) e.push("Aucun produit n'a de règle.");
  if (produitsBruts.length > 3) e.push("Une stratégie classe au plus trois produits.");
  const produits: RegleProduit[] = [];
  const vus = new Set<string>();
  produitsBruts.forEach((p, i) => {
    const r = (p ?? {}) as Record<string, unknown>;
    const nom = `Produit #${i + 1}`;
    const productId = typeof r.productId === "string" ? r.productId : "";
    if (!productId) e.push(`${nom} : produit non désigné.`);
    if (vus.has(productId)) e.push(`${nom} : produit déjà présent.`);
    vus.add(productId);
    const seuilPotentiel = num(r.seuilPotentiel);
    const seuilAffinite = num(r.seuilAffinite);
    if (seuilPotentiel === null || seuilPotentiel < 0) e.push(`${nom} : seuil de potentiel manquant.`);
    if (seuilAffinite === null || seuilAffinite < 0 || seuilAffinite > 1) e.push(`${nom} : seuil d'affinité manquant (entre 0 et 100 %).`);
    const comparaisonAffinite: Comparaison = r.comparaisonAffinite === ">=" ? ">=" : ">";
    const methodeAffinite: MethodeAffinite = r.methodeAffinite === "RATIO_FICHIER" ? "RATIO_FICHIER" : "SUR_10";
    const exceptions: ExceptionZone[] = (Array.isArray(r.exceptions) ? r.exceptions : []).flatMap((x) => {
      const z = (x ?? {}) as Record<string, unknown>;
      const zone = typeof z.zone === "string" ? z.zone.trim() : "";
      const secteurId = typeof z.secteurId === "string" && z.secteurId.trim() ? z.secteurId.trim() : null;
      if (!zone && !secteurId) return [];
      const sp = num(z.seuilPotentiel), sa = num(z.seuilAffinite);
      if (sa !== null && (sa < 0 || sa > 1)) e.push(`${nom} : seuil d'affinité de « ${zone || "secteur"} » hors de 0 à 100 %.`);
      return [{
        zone: zone || "Secteur",
        ...(secteurId ? { secteurId } : {}),
        ...(sp !== null ? { seuilPotentiel: sp } : {}),
        ...(sa !== null ? { seuilAffinite: sa } : {}),
        ...(z.comparaisonAffinite === ">=" || z.comparaisonAffinite === ">" ? { comparaisonAffinite: z.comparaisonAffinite as Comparaison } : {}),
      }];
    });
    const ref0 = (r.reference ?? null) as Record<string, unknown> | null;
    const refValeur = ref0 ? num(ref0.valeur) : null, refAnnee = ref0 ? num(ref0.annee) : null;
    produits.push({
      productId, metrique: typeof r.metrique === "string" && r.metrique.trim() ? r.metrique.trim() : "patients / semaine",
      seuilPotentiel: seuilPotentiel ?? 0, seuilAffinite: seuilAffinite ?? 0, comparaisonAffinite, methodeAffinite, exceptions,
      ...(r.sourceAffinite === "ETABLISSEMENT" || r.sourceAffinite === "DECLAREE_SINON_ETABLISSEMENT" ? { sourceAffinite: r.sourceAffinite as SourceAffinite } : {}),
      ...(refValeur !== null && refValeur >= 0 && refValeur <= 1 && refAnnee !== null ? { reference: { valeur: refValeur, annee: Math.round(refAnnee) } } : {}),
    });
  });
  const c = (o.ciblage ?? {}) as Record<string, unknown>;
  const ciblage = {
    statutsNonCibles: (Array.isArray(c.statutsNonCibles) ? c.statutsNonCibles : []).filter(estStatut),
    potentielNulNonCible: c.potentielNulNonCible !== false,
    ...(c.potentielNulNA === true ? { potentielNulNA: true } : {}),
  };
  const h0 = (o.h ?? {}) as Record<string, unknown>;
  const hFreq = num(h0.frequence);
  if (hFreq === null || hFreq < 0) e.push("Fréquence des décideurs (H) manquante.");
  const h = { statuts: (Array.isArray(h0.statuts) ? h0.statuts : []).filter(estStatut), frequence: hFreq ?? 0 };
  const p0 = (o.priorites ?? {}) as Record<string, unknown>;
  const reglesPrio: ReglePriorite[] = (Array.isArray(p0.regles) ? p0.regles : []).flatMap((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const priorite = typeof r.priorite === "string" ? r.priorite.trim() : "";
    if (!priorite) return [];
    const am = (r.auMoins ?? null) as Record<string, unknown> | null;
    const out: ReglePriorite = { priorite };
    if (am && estSegment(am.segment) && num(am.nombre) !== null) out.auMoins = { segment: am.segment, nombre: num(am.nombre)! };
    if (Array.isArray(r.combinaison) && r.combinaison.every(estSegment)) out.combinaison = r.combinaison as Segment[];
    if (Array.isArray(r.rang1) && r.rang1.every(estSegment)) out.rang1 = r.rang1 as Segment[];
    if (!out.auMoins && !out.combinaison && !out.rang1) { e.push(`Règle de priorité « ${priorite} » sans condition.`); return []; }
    return [out];
  });
  let repli: ReplisPriorite | null = null;
  if (p0.repli && typeof p0.repli === "object") {
    const r = p0.repli as Record<string, unknown>;
    const s = (r.scores ?? {}) as Record<string, unknown>;
    const scores = { A: num(s.A), B: num(s.B), C: num(s.C), D: num(s.D) };
    const poids = (Array.isArray(r.poidsParRang) ? r.poidsParRang : []).map(num);
    const paliers = (Array.isArray(r.paliers) ? r.paliers : []).flatMap((x) => {
      const z = (x ?? {}) as Record<string, unknown>;
      return num(z.min) !== null && typeof z.priorite === "string" && z.priorite.trim() ? [{ min: num(z.min)!, priorite: z.priorite.trim() }] : [];
    });
    if (Object.values(scores).some((v) => v === null) || poids.some((v) => v === null) || poids.length === 0 || paliers.length === 0) e.push("Score de repli incomplet.");
    else repli = { scores: scores as Record<Segment, number>, poidsParRang: poids as number[], paliers: [...paliers].sort((a, b) => b.min - a.min) };
  }
  const f0 = (o.frequences ?? {}) as Record<string, unknown>;
  const frequences: Record<string, number> = {};
  for (const [k, v] of Object.entries(f0)) { const n = num(v); if (n !== null && n >= 0) frequences[k] = n; }
  for (const r of reglesPrio) if (frequences[r.priorite] === undefined) e.push(`Fréquence de la priorité « ${r.priorite} » manquante.`);
  if (repli) for (const p of repli.paliers) if (frequences[p.priorite] === undefined) e.push(`Fréquence de la priorité « ${p.priorite} » manquante.`);
  if (e.length) return { ok: false, erreurs: [...new Set(e)] };
  const exceptionsFrequence: ExceptionFrequence[] = (Array.isArray(o.exceptionsFrequence) ? o.exceptionsFrequence : []).flatMap((x) => {
    const z = (x ?? {}) as Record<string, unknown>;
    const priorite = typeof z.priorite === "string" ? z.priorite.trim() : "";
    const frequence = num(z.frequence);
    const zone = typeof z.zone === "string" && z.zone.trim() ? z.zone.trim() : null;
    const inOut = z.inOut === "IN" || z.inOut === "OUT" ? z.inOut : null;
    if (!priorite || frequence === null || frequence < 0 || (!zone && !inOut)) { e.push("Fréquence particulière incomplète (priorité ou H, zone et/ou In/Out, nombre)."); return []; }
    return [{ zone, inOut, priorite, frequence }];
  });
  const grille = o.grille === undefined || o.grille === null ? null : lireGrille(o.grille, e);
  let capacite: Capacite | null = null;
  if (o.capacite !== undefined && o.capacite !== null) {
    const c0 = o.capacite as Record<string, unknown>;
    const cj = num(c0.contactsParJour), jc = num(c0.joursParCycle);
    if (cj === null || cj <= 0 || jc === null || jc <= 0) e.push("Capacité incomplète (contacts par jour, jours par cycle).");
    else capacite = { contactsParJour: cj, joursParCycle: jc };
  }
  if (e.length) return { ok: false, erreurs: [...new Set(e)] };
  return {
    ok: true,
    regles: {
      produits, ciblage, h, priorites: { regles: reglesPrio, repli }, frequences,
      ...(exceptionsFrequence.length ? { exceptionsFrequence } : {}),
      ...(grille ? { grille } : {}),
      ...(capacite ? { capacite } : {}),
    },
  };
}

const LIBELLE_CLE: Record<CleFrequence, string> = { H_IN: "H — In", H_OUT: "H — Out", AB_IN: "A & B — In", AB_OUT: "A & B — Out", CD_IN: "C & D — In", CD_OUT: "C & D — Out" };

/** Lit la grille des fréquences ; une case vide ou fausse est une erreur nommée. H n'est jamais sous A & B. */
function lireGrille(brut: unknown, e: string[]): Grille | null {
  const g = (brut && typeof brut === "object" ? brut : {}) as Record<string, unknown>;
  const d0 = (g.defaut ?? {}) as Record<string, unknown>;
  const defaut = {} as GrilleFrequence;
  let ok = true;
  for (const k of CLES_FREQUENCE) {
    const v = num(d0[k]);
    if (v === null || v < 0) { e.push(`Fréquence par défaut « ${LIBELLE_CLE[k]} » manquante.`); ok = false; } else defaut[k] = v;
  }
  if (!ok) return null;
  const secteurs: GrilleSecteur[] = (Array.isArray(g.secteurs) ? g.secteurs : []).flatMap((x) => {
    const s = (x ?? {}) as Record<string, unknown>;
    const secteurId = typeof s.secteurId === "string" ? s.secteurId.trim() : "";
    if (!secteurId) return [];
    const v0 = (s.valeurs ?? {}) as Record<string, unknown>;
    const valeurs: Partial<GrilleFrequence> = {};
    for (const k of CLES_FREQUENCE) { const v = num(v0[k]); if (v !== null && v >= 0) valeurs[k] = v; }
    return [{ secteurId, nom: typeof s.nom === "string" && s.nom.trim() ? s.nom.trim() : "Secteur", valeurs }];
  });
  const grille: Grille = { defaut, secteurs };
  for (const cible of [null, ...secteurs]) {
    const f = grilleDuSecteur(grille, cible?.secteurId ?? null);
    const ou = cible ? ` (${cible.nom})` : "";
    if (f.H_IN < f.AB_IN || f.H_OUT < f.AB_OUT) e.push(`La fréquence des décideurs (H) ne peut pas être sous celle de A & B${ou}.`);
  }
  return grille;
}

/** Les fréquences qui s'appliquent dans un secteur : celles du secteur, case par case, sinon celles par défaut. */
export function grilleDuSecteur(g: Grille, secteurId: string | null | undefined): GrilleFrequence {
  const s = secteurId ? g.secteurs.find((x) => x.secteurId === secteurId) : undefined;
  return { ...g.defaut, ...(s?.valeurs ?? {}) };
}

/**
 * Les seuils effectifs d'un produit pour un praticien (l'exception l'emporte, champ par champ). L'exception d'un
 * SECTEUR se reconnaît à son identifiant ; celle d'une règle d'avant les secteurs, à son nom — comparé à la zone libre
 * de la fiche, puis au nom du secteur.
 */
export function seuilsPourZone(
  r: RegleProduit, zone: string | null | undefined, secteur?: { id: string | null; nom: string | null } | null,
): { seuilPotentiel: number; seuilAffinite: number; comparaisonAffinite: Comparaison; exception: string | null } {
  const norme = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const parId = secteur?.id ? r.exceptions.find((e) => e.secteurId === secteur.id) : undefined;
  const parNom = (cle: string) => (cle ? r.exceptions.find((e) => !e.secteurId && norme(e.zone) === cle) : undefined);
  const x = parId ?? parNom(norme(zone)) ?? parNom(norme(secteur?.nom));
  return {
    seuilPotentiel: x?.seuilPotentiel ?? r.seuilPotentiel,
    seuilAffinite: x?.seuilAffinite ?? r.seuilAffinite,
    comparaisonAffinite: x?.comparaisonAffinite ?? r.comparaisonAffinite,
    exception: x ? x.zone : null,
  };
}

/** « 10 % », « 7,5 % » — l'affichage d'une fraction. */
export function pct(v: number): string {
  const n = Math.round(v * 1000) / 10;
  return `${String(n).replace(".", ",")} %`;
}

/**
 * LA FRÉQUENCE QUI S'APPLIQUE à une priorité (ou à « H ») pour un praticien : l'exception la plus précise (zone ET
 * In/Out, puis In/Out, puis zone), sinon la fréquence générale. Rend aussi la raison, pour le « pourquoi ».
 */
export function frequenceEffective(
  regles: Pick<Regles, "frequences" | "h" | "exceptionsFrequence">, cle: string, zone: string | null | undefined, inOut: InOut | null | undefined,
): { frequence: number; exception: string | null } {
  const base = cle === "H" ? regles.h.frequence : regles.frequences[cle] ?? 0;
  const z = (zone ?? "").trim().toLowerCase();
  const candidats = (regles.exceptionsFrequence ?? []).filter((x) => x.priorite === cle
    && (x.zone === null || x.zone.trim().toLowerCase() === z)
    && (x.inOut === null || x.inOut === inOut));
  const score = (x: ExceptionFrequence) => (x.zone ? 1 : 0) + (x.inOut ? 2 : 0);
  const best = candidats.sort((a, b) => score(b) - score(a))[0];
  if (!best) return { frequence: base, exception: null };
  const lieu = [best.zone, best.inOut === "IN" ? "In (wilaya pivot du KAM)" : best.inOut === "OUT" ? "Out (hors wilaya pivot)" : null].filter(Boolean).join(", ");
  return { frequence: best.frequence, exception: lieu };
}
