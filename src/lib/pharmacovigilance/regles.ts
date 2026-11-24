/**
 * PHARMACOVIGILANCE — les règles PURES (Direction, 06/10 ; déclaration à l'autorité, Super Admin 24/11/2026).
 *
 * Le KAM signale un cas depuis les Rapports terrain ; Regulatory l'ÉVALUE (gravité, caractère attendu, imputabilité),
 * le DÉCLARE à l'autorité (hors plateforme, puis enregistre la déclaration), en assure le SUIVI et le clôt avec une
 * note. Ce module ne lit rien : il dit les statuts, leurs libellés, les passages permis et qui lit un cas. Les écrans
 * (composants client compris) et les actions serveur le lisent tous — une seule écriture de la règle (§118.5). Le délai
 * de déclaration et ses alertes vivent à côté, dans `declaration.ts`.
 */

/** Le CIRCUIT, dans l'ordre : ce que comptent les tuiles et ce que proposent les filtres. */
export const STATUTS_PV = ["RECU", "ENQUETE", "EVALUE", "DECLARE", "SUIVI", "CLOS"] as const;
/**
 * Toutes les valeurs que la base peut porter : le circuit, plus « EN_ANALYSE », l'ancienne étape reprise en « Reçu » par
 * la migration du 24/11/2026 — gardée lisible au cas où une ligne la porterait encore.
 */
export type StatutPv = (typeof STATUTS_PV)[number] | "EN_ANALYSE";
const TOUS_LES_STATUTS: readonly StatutPv[] = [...STATUTS_PV, "EN_ANALYSE"];

export const GRAVITES_PV = ["NON_GRAVE", "GRAVE", "DECES", "INCONNU"] as const;
export type GravitePv = (typeof GRAVITES_PV)[number];

type Ton = "neutral" | "info" | "success" | "warning" | "danger" | "purple";

export const STATUT_PV: Record<StatutPv, { label: string; tone: Ton }> = {
  RECU: { label: "Reçu", tone: "warning" },
  EN_ANALYSE: { label: "En analyse", tone: "warning" },
  ENQUETE: { label: "Enquête approfondie", tone: "purple" },
  EVALUE: { label: "Évalué — à déclarer", tone: "info" },
  DECLARE: { label: "Déclaré à l'autorité", tone: "success" },
  SUIVI: { label: "Suivi", tone: "purple" },
  CLOS: { label: "Clos", tone: "neutral" },
};

export const GRAVITE_PV: Record<GravitePv, { label: string; tone: Ton }> = {
  NON_GRAVE: { label: "Non grave", tone: "neutral" },
  GRAVE: { label: "Grave", tone: "danger" },
  DECES: { label: "Décès", tone: "danger" },
  INCONNU: { label: "Gravité inconnue", tone: "neutral" },
};

export const SEXE_PV: Record<string, string> = { F: "Femme", M: "Homme" };

export const PREFIXE_REFERENCE_PV = "PV";

export function estStatutPv(v: string | null | undefined): v is StatutPv {
  return !!v && (TOUS_LES_STATUTS as readonly string[]).includes(v);
}

/** Les étapes AVANT l'évaluation : le cas n'a pas encore de gravité arrêtée par Regulatory. */
export const AVANT_EVALUATION_PV: readonly StatutPv[] = ["RECU", "EN_ANALYSE", "ENQUETE"];
/** Les étapes où la déclaration à l'autorité est ENCORE À FAIRE (le délai court). */
export const A_DECLARER_PV: readonly StatutPv[] = [...AVANT_EVALUATION_PV, "EVALUE"];

export function estGravitePv(v: string | null | undefined): v is GravitePv {
  return !!v && (GRAVITES_PV as readonly string[]).includes(v);
}

/** Ce que le changement de statut a besoin de savoir du cas, au-delà de son statut. */
export interface ContexteCasPv {
  /** La déclaration à l'autorité est enregistrée. */
  declare: boolean;
  /** Regulatory a évalué le cas. */
  evalue: boolean;
  /** La gravité arrêtée à l'évaluation (`null` : pas évalué). */
  evalGrave: boolean | null;
  /** Un pharmacien responsable est désigné pour la société du cas : son visa est attendu. */
  visaRequis: boolean;
  /** Il a visé. */
  vise: boolean;
}

export const CONTEXTE_PV_VIERGE: ContexteCasPv = { declare: false, evalue: false, evalGrave: null, visaRequis: false, vise: false };

/**
 * LES PASSAGES PAR LE SÉLECTEUR DE STATUT. Les étapes du circuit ont chacune leur geste (évaluer, demander des
 * informations, déclarer) ; ici ne restent que le suivi après déclaration, la clôture et la réouverture. On ne revient
 * jamais à « Reçu » à la main : quelqu'un l'a lu.
 */
const SUIVANTS: Record<StatutPv, readonly StatutPv[]> = {
  RECU: ["CLOS"],
  EN_ANALYSE: ["CLOS"],
  ENQUETE: ["CLOS"],
  EVALUE: ["CLOS"],
  DECLARE: ["SUIVI", "CLOS"],
  SUIVI: ["CLOS"],
  CLOS: [],
};

/** Un cas clos se ROUVRE là où il en était : en suivi s'il a été déclaré, à déclarer s'il a été évalué, sinon reçu. */
export function statutDeReouverturePv(ctx: Pick<ContexteCasPv, "declare" | "evalue">): StatutPv {
  return ctx.declare ? "SUIVI" : ctx.evalue ? "EVALUE" : "RECU";
}

export function statutsSuivantsPv(de: StatutPv, ctx: ContexteCasPv = CONTEXTE_PV_VIERGE): readonly StatutPv[] {
  return de === "CLOS" ? [statutDeReouverturePv(ctx)] : SUIVANTS[de];
}

/**
 * Le refus d'un changement de statut, dit en clair — ou `null` quand il est permis. Clore exige une note. Un cas évalué
 * GRAVE ne se clôt pas sans déclaration (doublon, non-cas : on se décide AVANT l'évaluation). Un cas déclaré attend le
 * visa du pharmacien responsable désigné avant sa clôture.
 */
export function refusTransitionPv(de: StatutPv, vers: StatutPv, note: string | null | undefined, ctx: ContexteCasPv = CONTEXTE_PV_VIERGE): string | null {
  if (de === vers) return `Le cas est déjà « ${STATUT_PV[vers].label} ».`;
  if (!statutsSuivantsPv(de, ctx).includes(vers)) return `Un cas « ${STATUT_PV[de].label} » ne passe pas à « ${STATUT_PV[vers].label} ».`;
  if (vers === "CLOS") {
    if (!(note ?? "").trim()) return "Une note de clôture est requise : elle dit ce qui a été conclu.";
    if (!ctx.declare && ctx.evalGrave === true) {
      return "Un cas évalué grave se déclare à l'autorité avant d'être clos : enregistrez la déclaration, ou réévaluez-le s'il s'agit d'un doublon.";
    }
    if (ctx.declare && ctx.visaRequis && !ctx.vise) return "Le pharmacien responsable n'a pas encore visé la déclaration : son visa vient avant la clôture.";
  }
  return null;
}

/** L'ouverture d'une enquête approfondie : les informations demandées sont obligatoires, et un cas clos se rouvre d'abord. */
export function refusEnquetePv(de: StatutPv, infos: string | null | undefined): string | null {
  if (de === "CLOS") return "Le cas est clos : rouvrez-le avant de demander des informations.";
  if (!(infos ?? "").trim()) return "Précisez les informations complémentaires demandées.";
  return null;
}

/**
 * OÙ VA LE CAS QUAND ON DEMANDE DES INFORMATIONS : avant l'évaluation, en « Enquête approfondie » ; un cas évalué RESTE
 * à déclarer (la demande ne suspend pas le délai) ; après la déclaration, il passe en « Suivi ».
 */
export function statutApresDemandeInfosPv(de: StatutPv): StatutPv {
  if (AVANT_EVALUATION_PV.includes(de)) return "ENQUETE";
  if (de === "DECLARE" || de === "SUIVI") return "SUIVI";
  return de;
}

/**
 * QUI LIT UN CAS — le KAM qui l'a signalé, les personnes ajoutées à l'échange, et qui reçoit les cas (Voir en portée
 * TOUT : Regulatory, la Direction). Le Super Admin lit tout.
 */
export function lecteurDuCasPv(
  lecteur: { userId: string; voitTout: boolean; superAdmin?: boolean },
  cas: { reporterId: string; participants: readonly { userId: string }[] },
): boolean {
  if (lecteur.superAdmin || lecteur.voitTout) return true;
  if (cas.reporterId === lecteur.userId) return true;
  return cas.participants.some((p) => p.userId === lecteur.userId);
}

/**
 * JOINDRE UNE PIÈCE — qui instruit, toujours ; le KAM et les participants tant que le cas n'est pas clos (une
 * photo, un compte rendu, la réponse à l'enquête). Modifier ou retirer une pièce reste à qui instruit.
 */
export function peutJoindreAuCasPv(
  acteur: { userId: string; instruit: boolean; voitTout: boolean; superAdmin?: boolean },
  cas: { reporterId: string; status: string; participants: readonly { userId: string }[] },
): boolean {
  if (acteur.instruit || acteur.superAdmin) return true;
  if (cas.status === "CLOS") return false;
  return lecteurDuCasPv(acteur, cas);
}

/**
 * SUPPRIMER UN CAS (Direction, 08/11 : « so the user who do that can delete it ») — le KAM qui l'a signalé, à TOUT
 * statut, et le Super Admin ; personne d'autre (ni Regulatory, ni les participants). La suppression est réversible
 * (corbeille, le cas revient avec ses pièces, son fil et ses participants) et journalisée. Le serveur relit la même
 * règle (`deleteOwnRecord` : le créateur — `reporterId` — ou le Super Admin).
 */
export function peutSupprimerLeCasPv(acteur: { userId: string; superAdmin?: boolean }, cas: { reporterId: string }): boolean {
  return Boolean(acteur.superAdmin) || cas.reporterId === acteur.userId;
}

/** Âge du patient : un entier plausible, ou rien. */
export function lireAgePv(brut: string | null | undefined): number | null {
  const s = (brut ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 120 ? n : null;
}
