/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE L'ASSISTANT IA PEUT FAIRE POUR UNE PERSONNE — les FAMILLES réglées par la Direction
 * (décision 0012, précision du 29/10/2026). Règle PURE, zéro import : le moteur (serveur) et l'écran
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

export const FAMILLES_IA = ["SALAIRES", "BUDGETS", "CONTRATS_RH", "FICHES", "DRIVE", "REGLEMENTAIRE", "AD_PRO", "ECRITURES"] as const;
export type FamilleIa = (typeof FAMILLES_IA)[number];

export const LIBELLE_FAMILLE: Record<FamilleIa, string> = {
  SALAIRES: "Salaires & paie",
  BUDGETS: "Budgets & finances",
  CONTRATS_RH: "Contrats & documents RH",
  FICHES: "Fiches collaborateurs",
  DRIVE: "Drive & documents",
  REGLEMENTAIRE: "Réglementaire",
  AD_PRO: "Ad & Pro",
  ECRITURES: "Écritures métier",
};

export const AIDE_FAMILLE: Record<FamilleIa, string> = {
  SALAIRES: "Salaire de base, brut, net, coût employeur, masse salariale. Les montants ne partent jamais au modèle : ils s'affichent à la personne.",
  BUDGETS: "Enveloppes, consommé, restant, agrégats financiers.",
  CONTRATS_RH: "Contrats, avenants, attestations et autres pièces du dossier RH d'autrui : lien de téléchargement et lecture.",
  FICHES: "Fiche RH d'un collaborateur (poste, contrat, congés) et situation RH.",
  DRIVE: "Recherche dans le Drive et dans tout l'ERP, gestes Drive.",
  REGLEMENTAIRE: "Portefeuille, charge, dossiers réglementaires — et leur création ou modification (avec les écritures).",
  AD_PRO: "Circuits et demandes Ad & Pro, bons de commande.",
  ECRITURES: "Préparer des cartes à confirmer (dossier, tâche, demande RH…). Sans elle, l'assistant ne fait que lire.",
};

/** Fermées par défaut pour qui n'est pas Super Admin, quels que soient ses droits applicatifs. */
export const FAMILLES_SENSIBLES: ReadonlySet<FamilleIa> = new Set<FamilleIa>(["SALAIRES", "CONTRATS_RH"]);

export const estFamilleIa = (v: unknown): v is FamilleIa => typeof v === "string" && (FAMILLES_IA as readonly string[]).includes(v);

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
}): AccesIa {
  if (d.superAdmin) return { superAdmin: true, ouvertes: [...FAMILLES_IA], explicites: [...FAMILLES_IA] };
  const ouvertes: FamilleIa[] = [];
  const explicites: FamilleIa[] = [];
  for (const f of FAMILLES_IA) {
    let ouverte = FAMILLES_SENSIBLES.has(f) ? false : d.droits[f];
    let explicite = false;
    for (const r of [d.role, d.personne]) {
      if (!r) continue;
      if (r.fermees.includes(f)) { ouverte = false; explicite = false; }
      if (r.ouvertes.includes(f)) { ouverte = true; explicite = true; }
    }
    if (ouverte) ouvertes.push(f);
    if (explicite) explicites.push(f);
  }
  return { superAdmin: false, ouvertes, explicites };
}

export const familleOuverte = (a: AccesIa, f: FamilleIa): boolean => a.superAdmin || a.ouvertes.includes(f);
export const familleExplicite = (a: AccesIa, f: FamilleIa): boolean => a.superAdmin || a.explicites.includes(f);

/** Le refus, dit tel quel par l'assistant : quelle famille, et qui l'ouvre. */
export function refusFamille(f: FamilleIa): string {
  return `La famille « ${LIBELLE_FAMILLE[f]} » est fermée à l'Assistant IA pour vous. C'est la Direction qui l'ouvre, dans la console : `
    + "Administration › Contrôle de l'IA › Assistant IA — accès.";
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
    "Une demande qui relève d'une famille OUVERTE : appelle l'outil (un salaire relève de « Salaires & paie », un contrat ou un document RH de "
      + "« Contrats & documents RH », même si « Fiches collaborateurs » est fermée). Une demande d'une famille FERMÉE : dis-le directement, "
      + "en nommant la famille, et que la Direction l'ouvre dans Administration › Contrôle de l'IA › Assistant IA — accès.",
  ].join("\n");
}
