import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { entitePermisePourFiche } from "@/lib/company";
import { canAccessEntity } from "@/lib/entity-access";
import { userCan, type Module, type SessionUser } from "@/lib/rbac";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE SEULE PORTE D'ÉCRITURE PAR OBJET (audit 27/10/2026, rapport 01 §3.1).
 *
 * L'audit sécurité a mesuré la même faute neuf fois sur dix : une action relit le droit du MODULE
 * (`userCan(user, "FINANCES", "UPDATE")`), puis écrit `where: { id }`. Le droit du module dit « vous
 * pouvez régler des ordres » ; il ne dit pas « vous pouvez régler CET ordre ». Un comptable cloisonné
 * sur Pharmagène qui reçoit l'identifiant d'un ordre d'Adventum (lien partagé, Adam, appel direct de
 * l'action) le réglait.
 *
 * `ouvrirPourEcrire` pose les trois questions dans l'ordre, et une seule réponse :
 *   1. le droit du module pour ce geste (`userCan`) ;
 *   2. la règle de la ligne quand le type en a une (`canAccessEntity` : portée, parties prenantes) ;
 *   3. la société de l'objet, que la personne doit avoir le droit de voir (`entitePermisePourFiche`,
 *      la même règle qu'une fiche ouverte par son lien, §118.184).
 *
 * Hors de la porte, l'objet est INTROUVABLE — on ne dit pas à un curieux qu'il existe.
 *
 *   const porte = await ouvrirPourEcrire(user, "EXPENSE_ORDER", id, "UPDATE");
 *   if (!porte.ok) return porte;
 *
 * Un geste qui a SA PROPRE règle de droit (un siège du centre de paiement n'a pas forcément le
 * module Finances) passe `{ droitDuModule: false }` après l'avoir vérifiée : la ligne et la
 * société restent contrôlées ici.
 *
 * Ajouter un type : une entrée dans `OBJETS` — le module, la phrase « introuvable », et la lecture
 * de la société (avec, s'il existe, l'objet dont la règle de ligne s'applique).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type GesteDEcriture = "UPDATE" | "DELETE" | "VALIDATE";

export type PorteEcriture =
  | { ok: true; companyId: string | null }
  | { ok: false; error: string };

type LigneLue = {
  companyId: string | null;
  /** L'objet dont la règle de ligne (`canAccessEntity`) s'applique — l'objet lui-même, ou son parent. */
  entite?: { type: EntityType; id: string };
} | null;

type Fiche = {
  module: Module;
  introuvable: string;
  /** La phrase quand le droit du module manque — par défaut « Non autorisé. ». */
  nonAutorise?: string;
  lire: (id: string) => Promise<LigneLue>;
};

const OBJETS = {
  EXPENSE_ORDER: {
    module: "FINANCES",
    introuvable: "Ordre introuvable.",
    nonAutorise: "Réservé à la comptabilité (Finances).",
    lire: (id) => prisma.expenseOrder.findUnique({ where: { id }, select: { companyId: true } }),
  },
  FINANCE_TRANSACTION: {
    module: "FINANCES",
    introuvable: "Écriture introuvable.",
    lire: (id) => prisma.financeTransaction.findUnique({ where: { id }, select: { companyId: true } }),
  },
  EVENT: {
    module: "EVENTS",
    introuvable: "Événement introuvable.",
    lire: async (id) => {
      const e = await prisma.event.findUnique({ where: { id }, select: { companyId: true } });
      return e && { companyId: e.companyId, entite: { type: "EVENT", id } };
    },
  },
  // Un participant appartient à SON événement : la règle de l'événement s'applique.
  EVENT_REGISTRATION: {
    module: "EVENTS",
    introuvable: "Participant introuvable.",
    lire: async (id) => {
      const r = await prisma.eventRegistration.findUnique({ where: { id }, select: { eventId: true, event: { select: { companyId: true } } } });
      return r && { companyId: r.event.companyId, entite: { type: "EVENT", id: r.eventId } };
    },
  },
  FIELD_REPORT: {
    module: "FIELD_REPORTS",
    introuvable: "Rapport introuvable.",
    lire: (id) => prisma.fieldReport.findUnique({ where: { id }, select: { companyId: true } }),
  },
  LEGAL_FOLDER: {
    module: "LEGAL",
    introuvable: "Dossier introuvable.",
    lire: (id) => prisma.legalFolder.findUnique({ where: { id }, select: { companyId: true } }),
  },
  MAIL_FOLDER: {
    module: "MAIL_REGISTER",
    introuvable: "Dossier introuvable.",
    lire: (id) => prisma.mailEntryFolder.findUnique({ where: { id }, select: { companyId: true } }),
  },
} satisfies Record<string, Fiche>;

export type ObjetEcrit = keyof typeof OBJETS;

export async function ouvrirPourEcrire(
  user: SessionUser,
  type: ObjetEcrit,
  id: string,
  geste: GesteDEcriture,
  options: { droitDuModule?: boolean } = {},
): Promise<PorteEcriture> {
  const fiche: Fiche = OBJETS[type];
  if (options.droitDuModule !== false && !userCan(user, fiche.module, geste)) return { ok: false, error: fiche.nonAutorise ?? "Non autorisé." };
  const ligne = await fiche.lire(id);
  if (!ligne) return { ok: false, error: fiche.introuvable };
  if (ligne.entite && !(await canAccessEntity(user, ligne.entite.type, ligne.entite.id, geste))) return { ok: false, error: fiche.introuvable };
  if (!(await entitePermisePourFiche(user.id, ligne.companyId))) return { ok: false, error: fiche.introuvable };
  return { ok: true, companyId: ligne.companyId };
}
