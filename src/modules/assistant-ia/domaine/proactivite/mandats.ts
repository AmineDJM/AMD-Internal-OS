import { FAMILLES_SENSIBLES, type FamilleIa } from "../acces-regles";
import type { CodeVeilleur } from "./veilleurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MANDATS (J12, décision 0024) — une approbation DURABLE, BORNÉE, RÉVOCABLE, accordée par la
 * personne, pour qu'un geste se fasse sans carte à chaque fois.
 *
 * « Si une de mes validations attend plus de 5 jours, relance le validateur » : la personne le dit
 * UNE fois, à l'écran « Ce que mon assistant surveille », avec ses bornes :
 *   • la CAPACITÉ (un seul geste, nommé) — et seulement un geste de niveau R1 par défaut : une
 *     écriture INTERNE et RÉVERSIBLE (ou sans conséquence au-delà de l'ERP). L'argent, les droits, les
 *     signatures, la suppression et tout envoi hors de l'entreprise ne se mandatent pas ;
 *   • les DESTINATAIRES (qui peut être touché par le geste — vide : seulement ceux que le geste vise
 *     déjà, les validateurs de SES demandes) ;
 *   • un MONTANT plafond quand le geste en porte un ;
 *   • un nombre de gestes par jour ;
 *   • une ÉCHÉANCE (obligatoire, 90 jours au plus) — un mandat n'est jamais perpétuel.
 * Une capacité d'une famille sensible (salaires, contrats RH) ou d'un niveau au-delà de R1 exige EN
 * PLUS l'accord de la console (Super Admin) avant de servir.
 *
 * Le MODÈLE n'y décide rien : le veilleur (une règle de code) constate, le mandat borne, l'action
 * métier de l'écran exécute et revérifie tout (droits, arrêt d'urgence). Chaque geste laisse un reçu
 * et une ligne d'audit ; le récapitulatif de ce qui a été fait part dans le point du matin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** R0 lecture · R1 écriture interne réversible · R2 interne, visible d'autrui ou peu réversible · R3 argent ou engagement · R4 signature, droits, suppression, externe. */
export type NiveauRisque = "R0" | "R1" | "R2" | "R3" | "R4";

/**
 * LE NIVEAU DES OPÉRATIONS DE L'ASSISTANT IA — la table de J12, en attendant le registre des capacités
 * (J6) qui le dérivera de chaque action. Une opération absente vaut R4 : par défaut, on ne mandate pas.
 */
export const NIVEAU_OPERATION: Readonly<Record<string, NiveauRisque>> = {
  preparer_relance: "R1",
  preparer_depot_piece: "R2",
  preparer_rendez_vous: "R2",
  preparer_reponse_message: "R2",
  programmer_routine: "R2",
  gerer_routine: "R2",
  enregistrer_document: "R2",
  preparer_document: "R2",
  preparer_formulaire_pdf: "R2",
  preparer_traduction: "R2",
  preparer_voyageur_passeport: "R3",
  preparer_sponsoring: "R3",
  preparer_prise_en_charge: "R3",
  preparer_evenement: "R3",
  preparer_materiel_promo: "R3",
  preparer_demande_autre: "R3",
  preparer_poste: "R3",
  preparer_bon_de_commande: "R4",
  preparer_bc_depuis_devis: "R4",
};

export const niveauDe = (operation: string): NiveauRisque => NIVEAU_OPERATION[operation] ?? "R4";

/** Ce qu'un mandat peut confier — un geste, le veilleur qui le déclenche, sa famille. */
export interface CapaciteMandat {
  code: string;
  /** L'opération du registre de l'Assistant IA qui fait le geste (proposer puis exécuter). */
  operation: string;
  veilleur: CodeVeilleur;
  famille: FamilleIa;
  libelle: string;
  description: string;
  /** Le geste porte-t-il un montant (alors `montantMax` s'applique) ? */
  montant: boolean;
}

export const CAPACITES_MANDAT: readonly CapaciteMandat[] = [
  {
    code: "RELANCER_VALIDATEUR", operation: "preparer_relance", veilleur: "VALIDATION_EN_ATTENTE", famille: "ECRITURES",
    libelle: "Relancer le validateur d'une de mes demandes",
    description: "Quand une de vos demandes de validation attend le même validateur au-delà du seuil, l'assistant écrit une relance courtoise dans sa discussion (ou par le bouton de relance, pour la Direction). Une seule relance par étape.",
    montant: false,
  },
];

export const CAPACITE: ReadonlyMap<string, CapaciteMandat> = new Map(CAPACITES_MANDAT.map((c) => [c.code, c]));

/** L'accord de la console est exigé : famille sensible, ou geste au-delà de R1. */
export const consoleRequise = (c: Pick<CapaciteMandat, "famille" | "operation">): boolean =>
  FAMILLES_SENSIBLES.has(c.famille) || niveauDe(c.operation) !== "R1";

/** Un geste au-delà de R2 ne se mandate jamais, même avec la console. */
export const mandatable = (c: Pick<CapaciteMandat, "operation">): boolean => ["R1", "R2"].includes(niveauDe(c.operation));

export const ECHEANCE_MAX_JOURS = 90;
export const GESTES_PAR_JOUR_MAX = 10;

export interface DemandeMandat {
  capacite: string;
  destinataires: string[];
  montantMax: number | null;
  gestesParJour: number;
  expireLe: Date;
}

/** Valider une demande de mandat — rend la demande ramenée à ses bornes, ou la raison du refus. */
export function validerDemandeMandat(e: { capacite?: unknown; destinataires?: unknown; montantMax?: unknown; gestesParJour?: unknown; jours?: unknown }, now: Date):
  { ok: true; demande: DemandeMandat; capacite: CapaciteMandat; console: boolean } | { ok: false; erreur: string } {
  const c = typeof e.capacite === "string" ? CAPACITE.get(e.capacite) : undefined;
  if (!c) return { ok: false, erreur: "Ce geste ne peut pas être confié par mandat." };
  if (!mandatable(c)) return { ok: false, erreur: "Ce geste engage trop (argent, signature, droits ou envoi externe) pour être fait sans votre confirmation." };
  const jours = Number(e.jours);
  if (!Number.isInteger(jours) || jours < 1 || jours > ECHEANCE_MAX_JOURS) return { ok: false, erreur: `Un mandat dure de 1 à ${ECHEANCE_MAX_JOURS} jours.` };
  const gestes = Number(e.gestesParJour ?? 3);
  if (!Number.isInteger(gestes) || gestes < 1 || gestes > GESTES_PAR_JOUR_MAX) return { ok: false, erreur: `De 1 à ${GESTES_PAR_JOUR_MAX} gestes par jour.` };
  const montant = e.montantMax === null || e.montantMax === undefined || e.montantMax === "" ? null : Number(e.montantMax);
  if (montant !== null && (!Number.isFinite(montant) || montant < 0)) return { ok: false, erreur: "Montant plafond illisible." };
  if (c.montant && montant === null) return { ok: false, erreur: "Ce geste porte un montant : fixez un plafond." };
  const destinataires = [...new Set((Array.isArray(e.destinataires) ? e.destinataires : []).filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, 20);
  return {
    ok: true, capacite: c, console: consoleRequise(c),
    demande: { capacite: c.code, destinataires, montantMax: c.montant ? montant : null, gestesParJour: gestes, expireLe: new Date(now.getTime() + jours * 86_400_000) },
  };
}

export interface MandatBorne {
  statut: string;
  capacite: string;
  destinataires: string[];
  montantMax: number | null;
  gestesParJour: number;
  expireLe: Date;
}

/** Le geste que le mandat est sur le point de faire. */
export interface GesteMandat {
  capacite: string;
  /** Les personnes que le geste touche (le validateur relancé). */
  destinataires: string[];
  montant: number | null;
}

/** LE CONTRÔLE AVANT CHAQUE GESTE — relu à chaque fois, jamais mis en cache. */
export function verifierGeste(m: MandatBorne, g: GesteMandat, faitsAujourdhui: number, now: Date): { ok: true } | { ok: false; raison: string } {
  if (m.statut !== "ACTIF") return { ok: false, raison: m.statut === "EN_ATTENTE_CONSOLE" ? "mandat en attente de l'accord de la console" : "mandat inactif" };
  if (m.expireLe.getTime() <= now.getTime()) return { ok: false, raison: "mandat échu" };
  if (g.capacite !== m.capacite) return { ok: false, raison: "geste hors du mandat" };
  if (faitsAujourdhui >= m.gestesParJour) return { ok: false, raison: `plafond de ${m.gestesParJour} geste(s) par jour atteint` };
  if (m.destinataires.length && g.destinataires.some((d) => !m.destinataires.includes(d))) return { ok: false, raison: "destinataire hors du mandat" };
  if (g.montant !== null && (m.montantMax === null || g.montant > m.montantMax)) return { ok: false, raison: "montant au-delà du plafond du mandat" };
  return { ok: true };
}
