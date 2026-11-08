/**
 * PHARMACOVIGILANCE — les règles PURES (Direction, 06/10).
 *
 * Le KAM signale un cas depuis les Rapports terrain ; Regulatory le reçoit, l'analyse, ouvre au besoin une enquête
 * approfondie (en demandant des informations complémentaires) et le clôt avec une note. Ce module ne lit rien : il
 * dit les statuts, leurs libellés, les passages permis et qui lit un cas. Les écrans (composants client compris) et
 * les actions serveur le lisent tous — une seule écriture de la règle (§118.5).
 */

export const STATUTS_PV = ["RECU", "EN_ANALYSE", "ENQUETE", "CLOS"] as const;
export type StatutPv = (typeof STATUTS_PV)[number];

export const GRAVITES_PV = ["NON_GRAVE", "GRAVE", "DECES", "INCONNU"] as const;
export type GravitePv = (typeof GRAVITES_PV)[number];

type Ton = "neutral" | "info" | "success" | "warning" | "danger" | "purple";

export const STATUT_PV: Record<StatutPv, { label: string; tone: Ton }> = {
  RECU: { label: "Reçu", tone: "warning" },
  EN_ANALYSE: { label: "En analyse", tone: "info" },
  ENQUETE: { label: "Enquête approfondie", tone: "purple" },
  CLOS: { label: "Clos", tone: "success" },
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
  return !!v && (STATUTS_PV as readonly string[]).includes(v);
}

export function estGravitePv(v: string | null | undefined): v is GravitePv {
  return !!v && (GRAVITES_PV as readonly string[]).includes(v);
}

/**
 * LES PASSAGES PERMIS. Un cas reçu se prend en analyse, part en enquête ou se clôt ; une enquête revient en analyse
 * quand les informations sont arrivées ; un cas clos se ROUVRE (en analyse) — un fait nouveau ne se perd pas parce
 * qu'on avait fermé trop tôt. On ne revient jamais à « Reçu » : quelqu'un l'a lu.
 */
const SUIVANTS: Record<StatutPv, readonly StatutPv[]> = {
  RECU: ["EN_ANALYSE", "ENQUETE", "CLOS"],
  EN_ANALYSE: ["ENQUETE", "CLOS"],
  ENQUETE: ["EN_ANALYSE", "CLOS"],
  CLOS: ["EN_ANALYSE"],
};

export function statutsSuivantsPv(de: StatutPv): readonly StatutPv[] {
  return SUIVANTS[de];
}

/** Le refus d'un changement de statut, dit en clair — ou `null` quand il est permis. */
export function refusTransitionPv(de: StatutPv, vers: StatutPv, note: string | null | undefined): string | null {
  if (de === vers) return `Le cas est déjà « ${STATUT_PV[vers].label} ».`;
  if (!SUIVANTS[de].includes(vers)) return `Un cas « ${STATUT_PV[de].label} » ne passe pas à « ${STATUT_PV[vers].label} ».`;
  if (vers === "CLOS" && !(note ?? "").trim()) return "Une note de clôture est requise : elle dit ce qui a été conclu.";
  return null;
}

/** L'ouverture d'une enquête approfondie : les informations demandées sont obligatoires, et un cas clos se rouvre d'abord. */
export function refusEnquetePv(de: StatutPv, infos: string | null | undefined): string | null {
  if (de === "CLOS") return "Le cas est clos : rouvrez-le avant d'ouvrir une enquête.";
  if (!(infos ?? "").trim()) return "Précisez les informations complémentaires demandées.";
  return null;
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
