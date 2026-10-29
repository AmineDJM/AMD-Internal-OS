/**
 * LES AIDES DES PROPOSITIONS — le contexte passé à chaque famille, les normalisations (priorité,
 * date, rôle), la carte d'approbation d'un courriel, le filtre partagé d'un rattachement en masse
 * et la liste blanche des outils groupables.
 */

import {
  type Priority, type RegulatoryCategory, prisma, userCan, scopeMedicalDoctors, scopeRegulatory,
  getCommunicationPolicy, type CurrentUser,
} from "@/lib/assistant/coeur/erp";
import { ROLE_LABELS, doctorDisplayName } from "@/lib/labels";
import { isoDate, normPriority } from "@/platform/ia/outils/arguments";
import type { ProposedAction } from "@/lib/assistant/coeur/contrat-actions";

/**
 * CE QUE `buildProposal` PASSE À CHAQUE FAMILLE — l'appel, la personne, et la fermeture qu'elles
 * partageaient quand elles n'étaient qu'une chaîne de `if` : la liste d'avertissements (mutée),
 * la résolution de personne qui l'alimente, et `buildProposal` lui-même pour les propositions
 * composées qui s'y rappellent.
 */
export interface ContexteProposition {
  toolName: string;
  input: Record<string, unknown>;
  user: CurrentUser;
  warnings: string[];
  resolve: (label: string, brut: unknown) => Promise<{ id: string | null; name: string | null }>;
  buildProposal: (toolName: string, input: Record<string, unknown>, user: CurrentUser) => Promise<ProposedAction | { error: string }>;
}


/**
 * Le filtre d'un rattachement en masse — **partagé** entre l'aperçu et l'exécution.
 *
 * C'est le cœur de la garantie : la confirmation montre le résultat de CE filtre, et
 * l'exécution le rejoue. Deux filtres écrits séparément finiraient par diverger, et on
 * modifierait autre chose que ce qui a été montré.
 *
 * `excludeCompanyId` retire ceux qui sont déjà dans l'entité visée : les compter reviendrait à
 * annoncer un travail déjà fait.
 */
export function productBulkWhere(
  user: CurrentUser,
  f: { query?: string | null; category?: string | null; onlyWithoutCompany?: boolean; excludeCompanyId?: string },
) {
  const q = (f.query ?? "").trim();
  const like = (field: string) => ({ [field]: { contains: q, mode: "insensitive" as const } });
  // `category` arrive du modèle en `string` : on ne le transmet à Prisma qu'après l'avoir
  // reconnu comme une valeur d'énumération réelle — sinon on filtre sur une valeur inventée.
  const cat: RegulatoryCategory | null =
    f.category === "MEDICINE" || f.category === "MEDICAL_DEVICE" ? f.category : null;
  return {
    AND: [
      scopeRegulatory(user),
      q
        ? {
            OR: [
              like("dci"), like("brandName"), like("reference"), like("therapeuticClass"),
              like("pharmaceuticalForm"), like("partnerLab"),
            ],
          }
        : {},
      cat ? { category: cat } : {},
      f.onlyWithoutCompany ? { companyId: null } : {},
      f.excludeCompanyId ? { NOT: { companyId: f.excludeCompanyId } } : {},
    ],
  };
}

// ───────────────────────────── Construction d'une action proposée ─────────────────────────────

// Les normalisations de priorité et de date vivent au socle (`platform/ia/outils/arguments.ts`) :
// les propositions partagées avec l'Assistant IA (`create_task`) en ont besoin.
export { normPriority, isoDate };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Ajoute un avertissement si une date ISO (AAAA-MM-JJ) est déjà passée. */
export function pastWarning(label: string, iso: string | null, warnings: string[]): void {
  if (iso && iso < todayIso()) warnings.push(`${label} (${iso}) est déjà passée — à confirmer ou corriger avant d'envoyer.`);
}

/** Résout un médecin unique dans le périmètre de l'utilisateur (jamais inventé). */
export async function findDoctor(query: string, user: CurrentUser): Promise<{ id: string; name: string } | null> {
  const q = query.trim();
  if (!q || !userCan(user, "MEDICAL", "VIEW")) return null;
  const d = await prisma.medicalDoctor.findFirst({
    where: { AND: [scopeMedicalDoctors(user), { name: { contains: q, mode: "insensitive" } }] },
    select: { id: true, name: true, title: true },
  });
  return d ? { id: d.id, name: doctorDisplayName(d) } : null;
}

/**
 * LA CARTE D'APPROBATION D'UN COURRIEL — construite depuis l'INTENTION, jamais depuis ce que le
 * modèle redit. C'est ce qui garantit que le PDG approuve exactement ce qui partira.
 *
 * ELLE EST UNIQUE, ET C'EST TOUT L'ENJEU. Il y avait deux façons d'arriver à un envoi : cette
 * carte-là, et une carte « Envoyer un e-mail » qui parlait à la messagerie IMAP historique. La
 * seconde affichait comme expéditeur la boîte du module Courrier — et c'est ainsi que le PDG
 * s'est vu écrire à lui-même. Il n'y a plus qu'un chemin ; `send_email` passe par ici.
 *
 * Le champ « De » vient de la CONNEXION de l'intention. Pas de l'utilisateur, pas du
 * destinataire, pas d'un argument d'outil : de la seule chose qui décide vraiment d'où le
 * message partira.
 */
export async function mailApprovalCard(
  intentId: string,
  user: CurrentUser,
  warnings: string[],
): Promise<ProposedAction | { error: string }> {
  if (!intentId) return { error: "Aucune intention d'envoi à approuver (champ « intentId »)." };
  const intent = await prisma.outboundMailIntent.findFirst({
    where: { id: intentId, userId: user.id },
    include: { mission: { select: { title: true } }, connection: { select: { address: true, displayName: true } } },
  });
  if (!intent) return { error: "Intention d'envoi introuvable (ou elle n'est pas à vous)." };
  if (intent.status === "SENT") return { error: `Ce message est DÉJÀ parti${intent.sentAt ? ` (${intent.sentAt.toLocaleString("fr-FR")})` : ""} — il ne se renvoie pas.` };
  if (intent.status === "CANCELLED") return { error: "Cette intention d'envoi a été annulée." };

  const policyState = await getCommunicationPolicy();
  const attachments = (intent.attachments as unknown as { filename: string }[]) ?? [];
  const from = intent.connection.displayName
    ? `${intent.connection.displayName} <${intent.connection.address}>`
    : intent.connection.address;
  const fields = [
    { label: "De", value: from },
    { label: "À", value: intent.recipients.join(", ") },
    ...(intent.cc.length ? [{ label: "Copie", value: intent.cc.join(", ") }] : []),
    ...(intent.bcc.length ? [{ label: "Copie cachée", value: intent.bcc.join(", ") }] : []),
    { label: "Objet", value: intent.subject || "(sans objet)" },
    { label: "Message", value: intent.bodyText.length > 1500 ? `${intent.bodyText.slice(0, 1500)}…` : intent.bodyText },
    ...(attachments.length ? [{ label: "Pièces jointes", value: attachments.map((a) => a.filename).join(", ") }] : []),
    { label: "Pourquoi", value: intent.reason ?? (intent.mission ? `Mission « ${intent.mission.title} »` : "Demandé par vous") },
    ...(intent.threadId ? [{ label: "Fil", value: "Réponse DANS la conversation existante" }] : []),
  ];
  if (policyState.outboundPaused) {
    warnings.push("COUPE-CIRCUIT SORTANT levé : même approuvé, rien ne partira tant qu'il n'est pas relevé.");
  }
  if (policyState.mailSendPolicy === "DRAFT_ONLY") {
    warnings.push("Politique « brouillons seulement » : le message est prêt, mais l'envoi est bloqué.");
  }
  warnings.push(`En confirmant, ce message part RÉELLEMENT depuis ${intent.connection.address}. Toute modification du contenu invaliderait cette approbation.`);
  return {
    kind: "send_prepared_mail", module: "WORKSPACE", title: `Envoyer : ${intent.subject || "(sans objet)"}`,
    fields, warnings, level: "SENSITIVE",
    payload: {
      kind: "send_prepared_mail", intentId: intent.id, subject: intent.subject,
      recipients: intent.recipients, missionId: intent.missionId,
    },
  };
}

/**
 * OUTILS GROUPABLES par `bulk_action` : l'outil interne + le CHAMP QUI VARIE d'une cible à
 * l'autre. Liste blanche volontaire — un outil s'y ajoute quand son champ-cible est net.
 */
export const BULKABLE: Record<string, { targetKey: string; label: string }> = {
  delete_record: { targetKey: "reference", label: "Suppression définitive" },
  update_regulatory_product: { targetKey: "reference", label: "Modification de dossiers Regulatory" },
  assign_regulatory_responsible: { targetKey: "reference", label: "Assignation de dossiers Regulatory" },
  set_regulatory_step: { targetKey: "reference", label: "Étapes ANPP" },
  request_regulatory_status_update: { targetKey: "reference", label: "Relances Regulatory" },
  create_task: { targetKey: "assigneeName", label: "Demandes de tâches" },
  drive_operation: { targetKey: "name", label: "Opérations Drive" },
  task_operation: { targetKey: "title", label: "Opérations sur mes tâches" },
  regulatory_operation: { targetKey: "reference", label: "Opérations Regulatory" },
};

/** Normalise un rôle (libellé FR ou code) vers un code de rôle interne, ou null. */
export function normalizeRole(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const codes = Object.keys(ROLE_LABELS);
  const upper = s.toUpperCase().replace(/[\s-]+/g, "_");
  const byCode = codes.find((k) => k.toUpperCase() === upper);
  if (byCode) return byCode;
  const lower = s.toLowerCase();
  const byLabel = codes.find((k) => (ROLE_LABELS[k as keyof typeof ROLE_LABELS] ?? "").toLowerCase() === lower);
  if (byLabel) return byLabel;
  return codes.find((k) => (ROLE_LABELS[k as keyof typeof ROLE_LABELS] ?? "").toLowerCase().includes(lower)) ?? null;
}
