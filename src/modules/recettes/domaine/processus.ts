/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PROCESSUS ET LEURS CIRCUITS (J10, décision 0028) — pur.
 *
 * Une RECETTE décrit un CIRCUIT réel (une catégorie Ad & Pro, les validations d'un module, le recrutement, une forme
 * de travail qui a réussi). Chaque circuit appartient à un PROCESSUS, et c'est le processus qui a un RESPONSABLE
 * (un rôle désigné par la Direction) : lui seul valide, corrige, rejette ou retire les recettes de son processus.
 *
 * La VISIBILITÉ d'une recette suit l'écran du circuit : elle ne se montre qu'à qui voit le module qui sert ces
 * dossiers (`modulesDuCircuit`) — une recette « Recrutement » n'apprend rien à qui n'ouvre pas le recrutement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const PROCESSUS = ["AD_PRO", "REGLEMENTAIRE", "RH", "FINANCES", "MARKETING", "VALIDATIONS", "TRAVAUX"] as const;
export type Processus = (typeof PROCESSUS)[number];

export const LIBELLE_PROCESSUS: Record<Processus, string> = {
  AD_PRO: "Ad & Pro",
  REGLEMENTAIRE: "Réglementaire",
  RH: "RH",
  FINANCES: "Finances",
  MARKETING: "Marketing",
  VALIDATIONS: "Autres validations",
  TRAVAUX: "Travaux de l'assistant",
};

export const estProcessus = (v: unknown): v is Processus => typeof v === "string" && (PROCESSUS as readonly string[]).includes(v);

/** Les catégories du moteur de circuit Ad & Pro (`WorkflowDefinition.category`). */
const CATEGORIES_AD_PRO: Record<string, { libelle: string; module: string }> = {
  SPONSORING: { libelle: "Sponsoring", module: "SPONSORING" },
  CONGRESS_INTERNATIONAL: { libelle: "Prise en charge internationale", module: "CONGRESS_INTERNATIONAL" },
  CONGRESS_NATIONAL: { libelle: "Prise en charge nationale", module: "CONGRESS_NATIONAL" },
  EVENTS: { libelle: "Événement", module: "EVENTS" },
  OTHER: { libelle: "Autre demande Ad & Pro", module: "AD_PRO_OTHER" },
};

/** Les modules des validations génériques (`ValidationRequest.module`) et leur processus. */
const MODULES_VALIDATION: Record<string, { processus: Processus; libelle: string }> = {
  REGULATORY: { processus: "REGLEMENTAIRE", libelle: "Validation réglementaire" },
  RH: { processus: "RH", libelle: "Validation RH" },
  FINANCES: { processus: "FINANCES", libelle: "Validation Finances" },
  BUDGETS: { processus: "FINANCES", libelle: "Validation budgétaire" },
  MARKETING: { processus: "MARKETING", libelle: "Validation Marketing" },
  PROMO_MATERIAL: { processus: "MARKETING", libelle: "Validation du matériel promotionnel" },
  LEGAL: { processus: "VALIDATIONS", libelle: "Validation juridique" },
};

/** Les mots qui désignent chaque circuit dans une demande — le point de départ des mots-clés d'une recette. */
const MOTS_DES_CIRCUITS: Record<string, string> = {
  "WF:SPONSORING": "sponsoring sponsoriser parrainage parrainer sponsor association societe savante",
  "WF:CONGRESS_INTERNATIONAL": "prise en charge internationale international etranger congres international voyage visa billet avion hotel medecins",
  "WF:CONGRESS_NATIONAL": "prise en charge nationale national congres national medecins inscription hebergement",
  "WF:EVENTS": "evenement journee soiree symposium table ronde staff seminaire",
  "WF:OTHER": "autre demande ad pro",
  "VAL:REGULATORY": "reglementaire dossier enregistrement amm anpp variation renouvellement depot",
  "VAL:RH": "rh ressources humaines conge avance contrat avenant",
  "VAL:FINANCES": "finances paiement depense facture reglement fournisseur",
  "VAL:BUDGETS": "budget budgetaire enveloppe ligne budgetaire",
  "VAL:MARKETING": "marketing campagne plan marketing lancement",
  "VAL:PROMO_MATERIAL": "materiel promotionnel goodies objets promotionnels",
  "VAL:LEGAL": "juridique contrat convention",
  REC: "recrutement recruter embauche embaucher poste candidat delegue",
};

export interface DescriptionCircuit {
  circuit: string;
  processus: Processus;
  libelle: string;
  /** Les modules dont l'écran sert ces dossiers : il faut en VOIR au moins un pour voir la recette. */
  modules: string[];
  /** Réservée au Super Admin (les formes de missions d'Adam). */
  superAdminSeul: boolean;
  motsCles: string;
}

/** Ce qu'est un circuit, d'après sa clé (`WF:SPONSORING`, `VAL:REGULATORY`, `REC`, `TRAVAIL:…`, `FORME:…`). */
export function decrireCircuit(circuit: string): DescriptionCircuit | null {
  const [tete, ...reste] = circuit.split(":");
  const queue = reste.join(":");
  if (tete === "WF") {
    const c = CATEGORIES_AD_PRO[queue];
    return c ? { circuit, processus: "AD_PRO", libelle: c.libelle, modules: [c.module], superAdminSeul: false, motsCles: MOTS_DES_CIRCUITS[circuit] ?? "" } : null;
  }
  if (tete === "VAL" && queue) {
    const m = MODULES_VALIDATION[queue];
    return {
      circuit, processus: m?.processus ?? "VALIDATIONS", libelle: m?.libelle ?? `Validation · ${queue}`,
      modules: ["VALIDATIONS", queue], superAdminSeul: false, motsCles: MOTS_DES_CIRCUITS[circuit] ?? queue.toLowerCase(),
    };
  }
  if (tete === "REC") return { circuit, processus: "RH", libelle: "Recrutement", modules: ["RECRUITMENT"], superAdminSeul: false, motsCles: MOTS_DES_CIRCUITS.REC };
  if (tete === "TRAVAIL" && queue) return { circuit, processus: "TRAVAUX", libelle: "Travail de l'assistant", modules: ["ASSISTANT_IA"], superAdminSeul: false, motsCles: "" };
  if (tete === "FORME" && queue) return { circuit, processus: "TRAVAUX", libelle: "Forme de mission d'Adam", modules: [], superAdminSeul: true, motsCles: "" };
  return null;
}

/** Les familles de la console IA qui, FERMÉES, retirent les recettes d'un processus à l'Assistant IA. */
export const PROCESSUS_DES_FAMILLES: Readonly<Record<string, Processus[]>> = {
  AD_PRO: ["AD_PRO", "MARKETING"],
  REGLEMENTAIRE: ["REGLEMENTAIRE"],
  BUDGETS: ["FINANCES"],
  FICHES: ["RH"],
};

export const processusExclusPar = (famillesFermees: readonly string[]): Processus[] =>
  [...new Set(famillesFermees.flatMap((f) => PROCESSUS_DES_FAMILLES[f] ?? []))];
