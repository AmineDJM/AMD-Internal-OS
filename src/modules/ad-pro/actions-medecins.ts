"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { CHEMIN_DEMANDE, estTypeMedecinsConcernes } from "@/modules/ad-pro/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MÉDECINS CONCERNÉS PAR UNE DEMANDE AD & PRO (Direction, 08/10) — les choisir DANS L'ANNUAIRE.
 *
 * Le texte libre « Médecin concerné » ne se rapprochait d'aucune fiche : le cockpit marketing ne pouvait pas dire
 * ce qu'un leader d'opinion avait reçu en Ad & Pro, ni quelle lettre H·A·B avait chaque dépense. Ce lien désigne le praticien
 * de l'annuaire (un par demande et par praticien), avec son rôle et, si on le sait, le montant qui lui revient.
 *
 * Qui l'écrit : QUI PEUT MODIFIER LA DEMANDE — `canAccessEntity(…, "UPDATE")`, la règle de la fiche, pas celle d'un module
 * (§118.71). Lire l'annuaire pour choisir n'ouvre aucune fiche : on ne renvoie que nom, spécialité et établissement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les natures et les rôles admis — des listes LITTÉRALES (le contrat de l'action y lit les valeurs) ; un test les tient égales à `ad-pro/medecins-concernes`. */
const NATURES: readonly string[] = ["SPONSORING", "EVENT", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "PROMO_MATERIAL", "AD_PRO_OTHER"];
const ROLES: readonly string[] = ["BENEFICIAIRE", "ORATEUR", "INVITE", "AUTRE"];

function rafraichir(nature: string, entityId: string, doctorId: string) {
  if (estTypeMedecinsConcernes(nature)) {
    revalidatePath(CHEMIN_DEMANDE[nature]);
    revalidatePath(`${CHEMIN_DEMANDE[nature]}/${entityId}`);
  }
  revalidatePath(`/praticiens/${doctorId}`);
  revalidatePath("/marketing-cockpit");
}

export async function ajouterMedecinConcerne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const nature = fdStr(formData, "entityType");
  const entityId = fdStr(formData, "entityId");
  const doctorId = fdStr(formData, "doctorId");
  const role = fdStr(formData, "role") || "BENEFICIAIRE";
  if (!nature || !entityId || !doctorId) return { ok: false, error: "Choisissez le médecin dans l'annuaire." };
  if (!NATURES.includes(nature) || !estTypeMedecinsConcernes(nature)) return { ok: false, error: "Cette nature de demande ne porte pas de médecins concernés." };
  if (!ROLES.includes(role)) return { ok: false, error: "Rôle inconnu." };

  let montant: number | null = null;
  if (formData.has("montant")) {
    const brut = (fdStr(formData, "montant") ?? "").replace(/\s/g, "").replace(",", ".");
    if (brut) {
      montant = Number(brut);
      if (!Number.isFinite(montant) || montant < 0) return { ok: false, error: "Le montant doit être un nombre positif (DZD)." };
    }
  }

  if (!(await canAccessEntity(user, nature, entityId, "UPDATE"))) return { ok: false, error: "Vous ne pouvez pas modifier cette demande." };
  const medecin = await prisma.medicalDoctor.findUnique({ where: { id: doctorId }, select: { id: true, name: true } });
  if (!medecin) return { ok: false, error: "Ce praticien n'existe plus dans l'annuaire — rechargez l'écran." };

  const cle = { entityType_entityId_doctorId: { entityType: nature, entityId, doctorId } };
  const avant = await prisma.adProMedecin.findUnique({ where: cle, select: { id: true } });
  await prisma.adProMedecin.upsert({
    where: cle,
    create: { entityType: nature, entityId, doctorId, role, montant, createdById: user.id },
    // Un praticien déjà lié change de rôle ; le montant ne bouge que si le formulaire le dit.
    update: { role, ...(formData.has("montant") ? { montant } : {}) },
  });
  await recordAudit({
    actorId: user.id, action: avant ? "UPDATE" : "CREATE", module: "Ad & Pro", entityType: nature, entityId,
    summary: `Médecin concerné : ${medecin.name} (${role.toLowerCase()})${montant !== null ? ` — ${montant} DZD` : ""}`,
  });
  rafraichir(nature, entityId, doctorId);
  return { ok: true, message: `${medecin.name} est relié·e à la demande.` };
}

export async function retirerMedecinConcerne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const nature = fdStr(formData, "entityType");
  const entityId = fdStr(formData, "entityId");
  const doctorId = fdStr(formData, "doctorId");
  if (!nature || !entityId || !doctorId) return { ok: false, error: "Médecin non précisé." };
  if (!NATURES.includes(nature) || !estTypeMedecinsConcernes(nature)) return { ok: false, error: "Cette nature de demande ne porte pas de médecins concernés." };
  if (!(await canAccessEntity(user, nature, entityId, "UPDATE"))) return { ok: false, error: "Vous ne pouvez pas modifier cette demande." };

  const lien = await prisma.adProMedecin.findUnique({
    where: { entityType_entityId_doctorId: { entityType: nature, entityId, doctorId } },
    select: { id: true, doctor: { select: { name: true } } },
  });
  if (!lien) return { ok: true, message: "Ce médecin n'est plus relié à la demande." };
  await prisma.adProMedecin.delete({ where: { id: lien.id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Ad & Pro", entityType: nature, entityId,
    summary: `Médecin concerné retiré : ${lien.doctor.name}`,
  });
  rafraichir(nature, entityId, doctorId);
  return { ok: true, message: `${lien.doctor.name} est retiré·e de la demande.` };
}

/**
 * CHERCHER DANS L'ANNUAIRE — le sélecteur de la carte « Médecins concernés ». Une lecture : nom, spécialité, établissement
 * (rien de la fiche). Deux lettres au moins ; 15 résultats, les plus proches du début du nom d'abord.
 */
export async function chercherMedecinsAnnuaire(formData: FormData): Promise<{ id: string; nom: string; specialite: string | null; etablissement: string | null }[]> {
  await enLecture(requireUser);
  const q = (fdStr(formData, "q") ?? "").trim();
  if (q.length < 2) return [];
  const rows = await prisma.medicalDoctor.findMany({
    where: {
      archivedAt: null,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { specialty: { contains: q, mode: "insensitive" } },
        { specialtyRef: { name: { contains: q, mode: "insensitive" } } },
        { institution: { contains: q, mode: "insensitive" } },
        { institutionRef: { name: { contains: q, mode: "insensitive" } } },
      ],
    },
    orderBy: { name: "asc" }, take: 15,
    select: { id: true, name: true, specialty: true, institution: true, specialtyRef: { select: { name: true } }, institutionRef: { select: { name: true } } },
  });
  return rows.map((d) => ({ id: d.id, nom: d.name, specialite: d.specialtyRef?.name ?? d.specialty ?? null, etablissement: d.institutionRef?.name ?? d.institution ?? null }));
}
