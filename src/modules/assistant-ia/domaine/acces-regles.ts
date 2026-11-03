/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE L'ASSISTANT IA PEUT FAIRE POUR UNE PERSONNE — les FAMILLES réglées par la Direction
 * (décision 0012, précision du 29/10/2026). Règle PURE (sa seule importation : la liste des familles, au socle) : le moteur (serveur) et l'écran
 * d'administration (`/admin/ai/acces`, composant client) la lisent tous deux.
 *
 *   • Le SUPER ADMIN : tout, toujours — aucune famille ne se ferme pour lui.
 *   • Les autres : par défaut, chaque famille suit les DROITS APPLICATIFS de la personne (le module
 *     ouvert à l'écran), SAUF les familles sensibles — salaires, contrats et documents RH — FERMÉES tant
 *     que la Direction ne les ouvre pas.
 *   • Le réglage d'un RÔLE pose le défaut de ses membres ; celui d'une PERSONNE prime sur son rôle.
 *     « Ouvrir » explicitement peut donner à l'assistant plus que les droits applicatifs (c'est la
 *     Direction qui le décide, et c'est journalisé) ; « défaut » ne le peut jamais.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// La liste des familles vit au socle (J6, décision 0020) : le registre des capacités y range chaque action.
import { estFamilleIa, FAMILLES_IA, type FamilleIa } from "@/platform/ia/capacites/familles";
import { perimetreEnVigueur, perimetreQuiCouvre, type PerimetreSensible } from "./perimetres";
export { estFamilleIa, FAMILLES_IA, type FamilleIa };

export const LIBELLE_FAMILLE: Record<FamilleIa, string> = {
  SALAIRES: "Salaires & paie",
  BUDGETS: "Budgets & finances",
  CONTRATS_RH: "Contrats & documents RH",
  FICHES: "Fiches collaborateurs",
  DRIVE: "Drive & documents",
  REGLEMENTAIRE: "Réglementaire",
  AD_PRO: "Ad & Pro",
  ECRITURES: "Écritures métier",
  VISUELS: "Images & vidéos générées",
};

export const AIDE_FAMILLE: Record<FamilleIa, string> = {
  SALAIRES: "Salaire de base, brut, net, coût employeur, masse salariale. Ouverte, l'assistant les donne à la personne (au modèle en clair ou en repères : réglage « Valeurs sensibles »).",
  // T3 (banc DOS/MG) : « combien coûtent les contrats des moyens généraux » était refusé SANS appel d'outil, rangé ici par
  // « agrégats financiers ». Le périmètre dit aussi ce qui n'en relève pas : ces outils jugent eux-mêmes.
  BUDGETS: "Enveloppes budgétaires (alloué, consommé, restant) et agrégats des Finances. N'en relèvent pas : le registre des moyens généraux (contrats, primes, échéances), le suivi de dossiers, les fiches et postes d'une demande Ad & Pro — leurs outils jugent.",
  CONTRATS_RH: "Contrats, avenants, attestations et autres pièces du dossier RH d'autrui : lien de téléchargement et lecture.",
  FICHES: "Fiche RH d'un collaborateur (poste, contrat, congés) et situation RH.",
  DRIVE: "Recherche dans le Drive et dans tout l'ERP, gestes Drive ; l'Atelier : ouvrir, modifier en place et convertir un fichier du Drive ou une pièce jointe (même un contrat ou une lettre) — les droits du fichier décident.",
  REGLEMENTAIRE: "Portefeuille, charge, dossiers réglementaires — et leur création ou modification (avec les écritures).",
  AD_PRO: "Circuits et demandes Ad & Pro, bons de commande.",
  ECRITURES: "Préparer des cartes à confirmer (dossier, tâche, demande RH…). Sans elle, l'assistant ne fait que lire.",
  VISUELS: "Générer ou modifier une image, une vidéo (modèle vidéo) ou une vidéo de données (graphique animé des chiffres lus). Payant : sous les plafonds mensuels réglés en Administration › IA. Fermée par défaut : la Direction l'ouvre par rôle ou par personne.",
};

/** Fermées par défaut pour qui n'est pas Super Admin, quels que soient ses droits applicatifs. */
export const FAMILLES_SENSIBLES: ReadonlySet<FamilleIa> = new Set<FamilleIa>(["SALAIRES", "CONTRATS_RH"]);


/** Un réglage enregistré (d'un rôle ou d'une personne) : ce qu'il ouvre et ce qu'il ferme ; le reste suit le défaut. */
export interface ReglageFamilles {
  ouvertes: FamilleIa[];
  fermees: FamilleIa[];
}

/** Ce que l'assistant a le droit de faire pour la personne, CE tour-ci. Sérialisable. */
export interface AccesIa {
  superAdmin: boolean;
  ouvertes: FamilleIa[];
  /** Ouvertes par un réglage de la Direction (rôle ou personne) — au-delà, au besoin, des droits applicatifs. */
  explicites: FamilleIa[];
  /**
   * S1 (décision 0048) : les PÉRIMÈTRES sur les valeurs sensibles d'AUTRUI (paie, dossier RH) — avenant de délégation
   * ou droit daté de la console, nommément à la personne, en vigueur CE tour. Seuls eux (ou le droit applicatif) vont
   * au-delà de « ses propres données » : un réglage de rôle, large par nature, ne les ouvre jamais (02/11 : « Salaires
   * & paie » ouverte au rôle d'une assistante de direction lui rendait la paie de tous). Absents : aucun.
   */
  perimetres?: PerimetreSensible[];
}

/** Un réglage lu (base, formulaire) ramené à des familles connues ; une famille ouverte ET fermée reste au défaut. */
export function normaliserReglageFamilles(ouvertes: unknown, fermees: unknown): ReglageFamilles {
  const liste = (v: unknown) => [...new Set((Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim()).filter(estFamilleIa))];
  const o = liste(ouvertes);
  const f = liste(fermees);
  return { ouvertes: o.filter((x) => !f.includes(x)), fermees: f.filter((x) => !o.includes(x)) };
}

/**
 * L'ACCÈS EFFECTIF : défaut (droits applicatifs, familles sensibles fermées), puis le réglage du rôle,
 * puis celui de la personne. `droits` dit, famille par famille, si l'écran correspondant lui est ouvert.
 */
export function resoudreAccesIa(d: {
  superAdmin: boolean;
  droits: Record<FamilleIa, boolean>;
  role?: ReglageFamilles | null;
  personne?: ReglageFamilles | null;
  /** S1 : avenants de délégation et droits datés de la console, nommément à la personne. */
  perimetres?: PerimetreSensible[];
  maintenant?: Date;
}): AccesIa {
  if (d.superAdmin) return { superAdmin: true, ouvertes: [...FAMILLES_IA], explicites: [...FAMILLES_IA], perimetres: [] };
  const ouvertes: FamilleIa[] = [];
  const explicites: FamilleIa[] = [];
  const perimetres = (d.perimetres ?? []).filter((p) => perimetreEnVigueur(p, d.maintenant));
  for (const f of FAMILLES_IA) {
    let ouverte = FAMILLES_SENSIBLES.has(f) ? false : d.droits[f];
    let explicite = false;
    for (const r of [d.role, d.personne]) {
      if (!r) continue;
      if (r.fermees.includes(f)) { ouverte = false; explicite = false; }
      if (r.ouvertes.includes(f)) { ouverte = true; explicite = true; }
    }
    // Un périmètre en vigueur (avenant, droit daté) ouvre sa famille — sauf fermeture NOMINATIVE, qui prime toujours.
    if (!ouverte && perimetres.some((p) => p.famille === f) && !d.personne?.fermees.includes(f)) ouverte = true;
    if (ouverte) ouvertes.push(f);
    if (explicite) explicites.push(f);
  }
  return { superAdmin: false, ouvertes, explicites, perimetres: perimetres.filter((p) => !d.personne?.fermees.includes(p.famille)) };
}

/**
 * D5 (décision 0057) — L'ACCÈS PAR BASE PAR-DESSUS LES FAMILLES (sous l'application stricte seulement ; `bases` nul
 * sinon). Une base FERMÉE ferme ses familles — Super Admin compris (la Direction : « aucune exception ») ; une base
 * OUVERTE les ouvre ; une ouverture NOMINATIVE d'une base porteuse d'une famille sensible devient un périmètre nommé
 * (origine « BASE »), sur les entités ouvertes à la personne. Une fermeture nominative de la console de l'assistant
 * prime toujours sur une ouverture par base.
 */
export function appliquerBases(
  a: AccesIa,
  bases: { fermees: readonly string[]; ouvertes: readonly string[]; perimetres: readonly { famille: string; du: string; au: string | null; ref: string; motif: string }[] } | null,
  fermeesNominatives: readonly FamilleIa[] = [],
): AccesIa {
  if (!bases) return a;
  const fermees = new Set(bases.fermees.filter(estFamilleIa));
  if (a.superAdmin) {
    if (!fermees.size) return a;
    // Un Super Admin dont une base est fermée perd sa souveraineté sur CES familles : il garde le reste, sur toutes les entités.
    const ouvertes = FAMILLES_IA.filter((f) => !fermees.has(f));
    const perimetres: PerimetreSensible[] = [...FAMILLES_SENSIBLES].filter((f) => !fermees.has(f))
      .map((f) => ({ famille: f, companyId: null, du: null, au: null, origine: "ROLE" as const, ref: null, motif: "Super Admin" }));
    return { superAdmin: false, ouvertes, explicites: ouvertes, perimetres };
  }
  const ouvertes = new Set(a.ouvertes);
  for (const f of bases.ouvertes) if (estFamilleIa(f) && !fermeesNominatives.includes(f)) ouvertes.add(f);
  for (const f of fermees) ouvertes.delete(f);
  const parBase: PerimetreSensible[] = bases.perimetres
    .filter((p) => estFamilleIa(p.famille) && FAMILLES_SENSIBLES.has(p.famille as FamilleIa) && !fermees.has(p.famille) && !fermeesNominatives.includes(p.famille as FamilleIa))
    .map((p) => ({ famille: p.famille as FamilleIa, companyId: null, du: p.du, au: p.au, origine: "BASE" as const, ref: p.ref, motif: p.motif }));
  return {
    superAdmin: false,
    ouvertes: FAMILLES_IA.filter((f) => ouvertes.has(f)),
    explicites: a.explicites.filter((f) => !fermees.has(f)),
    perimetres: [...(a.perimetres ?? []).filter((p) => !fermees.has(p.famille)), ...parBase],
  };
}

export const familleOuverte = (a: AccesIa, f: FamilleIa): boolean => a.superAdmin || a.ouvertes.includes(f);
export const familleExplicite = (a: AccesIa, f: FamilleIa): boolean => a.superAdmin || a.explicites.includes(f);
/**
 * S1 : un périmètre (avenant, droit daté) couvre-t-il `f` sur l'entité `companyId` ? Sans entité (`undefined`) : un
 * périmètre quelconque de la famille suffit — à réserver à un juge qui restreint ensuite lui-même aux entités couvertes.
 */
export function perimetreCouvrant(a: AccesIa, f: FamilleIa, companyId?: string | null): PerimetreSensible | null {
  if (a.superAdmin) return { famille: f, companyId: null, du: null, au: null, origine: "ROLE", ref: null, motif: "Super Admin" };
  if (companyId === undefined) return (a.perimetres ?? []).find((p) => p.famille === f && perimetreEnVigueur(p)) ?? null;
  return perimetreQuiCouvre(a.perimetres, f, companyId);
}
/** S1 : un périmètre nominatif quelconque sur `f` (jamais un réglage de rôle). */
export const familleNominative = (a: AccesIa, f: FamilleIa, companyId?: string | null): boolean => perimetreCouvrant(a, f, companyId) !== null;

/**
 * F2 (banc réel du 02/11, TR-RH-01/02/04/06) — LES GESTES POUR SOI. « Pose-moi un congé », « mets-moi en absence maladie »,
 * « une avance de 30 000 DZD », « une attestation de travail » étaient refusés « famille Fiches collaborateurs (ou Salaires &
 * paie) fermée » : la famille de l'ACTION (son fichier `hr-actions`, son modèle `salaryAdvance`) était jugée comme si la
 * personne agissait sur AUTRUI. Règle S1 (décision 0048) : la personne a toujours accès à SON dossier et à SES demandes ; les
 * familles RH fermées concernent autrui. Un geste de cette table, SANS le champ qui désigne autrui, ne se juge donc pas sur
 * ses familles RH (« Écritures métier » et toute autre famille restent exigées) ; AVEC ce champ (une RH qui dépose pour un
 * salarié), il se juge comme avant. L'action, elle, ne regarde ce champ que pour qui gère les RH, et prend sinon la fiche
 * LIÉE au compte (`Employee.userId`) : aucun chemin vers le dossier d'autrui ne s'ouvre ici.
 */
export const GESTES_POUR_SOI: Readonly<Record<string, readonly string[]>> = {
  "hr-actions:requestLeave": ["employeeId"],
  "hr-actions:requestAdvance": ["employeeId"],
  "hr-document-actions:requestHrDocument": [],
};
const FAMILLES_DU_DOSSIER: ReadonlySet<FamilleIa> = new Set<FamilleIa>(["FICHES", "SALAIRES", "CONTRATS_RH"]);

/** Le geste vise-t-il la personne elle-même (aucun champ d'autrui rempli) ? */
export function gestePourSoi(id: string, entree: Readonly<Record<string, unknown>> = {}): boolean {
  const autrui = GESTES_POUR_SOI[id];
  return autrui !== undefined && autrui.every((k) => entree[k] === undefined || entree[k] === null || entree[k] === "");
}

/** Les familles à juger pour ce geste : sans les familles du dossier RH quand il vise la personne elle-même. */
export const famillesAJuger = (id: string, familles: readonly FamilleIa[], entree: Readonly<Record<string, unknown>> = {}): FamilleIa[] =>
  gestePourSoi(id, entree) ? familles.filter((f) => !FAMILLES_DU_DOSSIER.has(f)) : [...familles];

/** Le refus, dit tel quel par l'assistant : quelle famille, et qui l'ouvre. */
export function refusFamille(f: FamilleIa): string {
  return `La famille « ${LIBELLE_FAMILLE[f]} » est fermée à Adam pour vous. C'est la Direction qui l'ouvre, dans la console : `
    + "Administration › Contrôle de l'IA › Adam — accès.";
}

/**
 * Ce que le contexte dit au modèle des familles — fermées ET ouvertes, chacune avec son périmètre : mesuré le 29/10,
 * une liste des seules fermées (« Fiches collaborateurs ») lui faisait refuser un salaire que « Salaires & paie »,
 * ouverte, permettait. Une demande d'une famille ouverte passe par l'outil, qui juge.
 */
export function consigneFamilles(a: AccesIa): string | null {
  if (a.superAdmin) return null;
  const fermees = FAMILLES_IA.filter((f) => !a.ouvertes.includes(f));
  if (!fermees.length) return null;
  const ligne = (f: FamilleIa) => `- « ${LIBELLE_FAMILLE[f]} » : ${AIDE_FAMILLE[f]}`;
  return [
    "ACCÈS RÉGLÉS PAR LA DIRECTION pour cette personne (une famille = un périmètre ; elles sont indépendantes).",
    `FERMÉES :\n${fermees.map(ligne).join("\n")}`,
    ...(a.ouvertes.length ? [`OUVERTES :\n${a.ouvertes.map(ligne).join("\n")}`] : []),
    "Une demande qui relève d'une famille OUVERTE : appelle l'outil (un salaire relève de « Salaires & paie », une pièce du DOSSIER RH d'autrui de "
      + "« Contrats & documents RH », même si « Fiches collaborateurs » est fermée ; un fichier joint ou du Drive à ouvrir ou modifier — même un contrat — "
      + "de « Drive & documents », les droits du fichier décident). Une demande d'une famille FERMÉE : dis-le directement, "
      + "en nommant la famille, et que la Direction l'ouvre dans Administration › Contrôle de l'IA › Adam — accès.",
    // Lot Q1 (décision 0050) : mesuré par le banc d'audit, « Quel est mon salaire ? » était refusé SANS appel d'outil
    // (« Salaires & paie » fermée) — alors que l'outil rend toujours sa propre paie à la personne dont la fiche est liée.
    "SON PROPRE DOSSIER reste toujours ouvert à la personne, quelles que soient les familles : « mon salaire », « ma fiche », "
      + "« mon contrat », « mes congés » → appelle l'outil (lire_paie, lire_fiche_rh, documents_rh, nom vide) ; c'est lui qui juge. Jamais pour autrui.",
  ].join("\n");
}

/**
 * S1 (décision 0048) — « VUE EXACTE » : L'ASSISTANT EST FERMÉ. Mesuré en production le 02/11 : la Direction ouvre le
 * compte de Radia en Vue exacte ; l'écran (un RENDU) dit « Bonjour Radia », mais le message part par une ACTION
 * SERVEUR, dont le corps s'exécute au nom du Super Admin réel (§118.184) — l'assistant répondait « Salut Amine », avec
 * la mémoire et les droits du Super Admin (paie de Radia, d'Assia…). Le jouer « comme Radia » exigerait de garantir
 * qu'aucun outil n'écrit (sous-missions, chantiers, notes, mémoire automatique, visuels payants) : la voie sûre est la
 * fermeture, comme la voix, les gestes et les notes. Ce que l'assistant de la personne voit se vérifie dans
 * Administration › IA › Accès (« Ce que son assistant voit »).
 */
export function refusAssistantVueExacte(nomVisualise?: string | null): string {
  const qui = nomVisualise?.trim() ? ` de ${nomVisualise.trim()}` : "";
  return `L'assistant est fermé en « Vue exacte » : il répondrait avec votre identité et vos droits de Super Admin, pas avec ceux${qui}. `
    + "Pour vérifier ce que son assistant voit (profil, familles, périmètres) : Administration › Contrôle de l'IA › Adam — accès.";
}

/** Une identité « vue » (impersonation honorée) ou un Super Admin qui en visualise une autre : l'assistant ne joue pas. */
export const enVueExacteIa = (u: { impersonatedBy?: unknown; visualise?: unknown }): boolean => Boolean(u.impersonatedBy || u.visualise);
