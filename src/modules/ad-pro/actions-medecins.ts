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

/**
 * LE PLAFOND DE LA LISTE DÉROULANTE (recette 24/11/2026) — l'annuaire s'ouvre en entier sous ce seuil ; au-delà, la liste
 * le dit et la recherche affine. C'est aussi le plus grand lot qu'un seul geste relie.
 */
const PLAFOND_ANNUAIRE = 200;

function rafraichir(nature: string, entityId: string, ...doctorIds: string[]) {
  if (estTypeMedecinsConcernes(nature)) {
    revalidatePath(CHEMIN_DEMANDE[nature]);
    revalidatePath(`${CHEMIN_DEMANDE[nature]}/${entityId}`);
  }
  for (const doctorId of doctorIds) revalidatePath(`/praticiens/${doctorId}`);
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

/**
 * RELIER PLUSIEURS MÉDECINS D'UN GESTE (recette 24/11/2026) — la liste déroulante de la carte coche plusieurs praticiens de
 * l'annuaire ; un bouton les relie tous, avec le même rôle.
 *
 * LA MÊME PORTE que `ajouterMedecinConcerne`, contrôle pour contrôle et dans le même ordre — écrite ICI et non dans une aide :
 * le contrat de l'action lit ses gardes dans son corps, une garde déplacée disparaîtrait de sa fiche. Un praticien DÉJÀ relié
 * est laissé tel quel (son rôle et son montant ne bougent pas : les changer reste le geste unitaire). Un seul journal pour le lot.
 */
export async function ajouterMedecinsConcernes(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const nature = fdStr(formData, "entityType");
  const entityId = fdStr(formData, "entityId");
  const role = fdStr(formData, "role") || "BENEFICIAIRE";
  const doctorIds = [...new Set(formData.getAll("doctorIds").map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean))];
  if (!nature || !entityId || doctorIds.length === 0) return { ok: false, error: "Cochez au moins un médecin dans l'annuaire." };
  if (!NATURES.includes(nature) || !estTypeMedecinsConcernes(nature)) return { ok: false, error: "Cette nature de demande ne porte pas de médecins concernés." };
  if (!ROLES.includes(role)) return { ok: false, error: "Rôle inconnu." };
  if (doctorIds.length > PLAFOND_ANNUAIRE) return { ok: false, error: `Au plus ${PLAFOND_ANNUAIRE} médecins d'un coup.` };

  if (!(await canAccessEntity(user, nature, entityId, "UPDATE"))) return { ok: false, error: "Vous ne pouvez pas modifier cette demande." };
  const medecins = await prisma.medicalDoctor.findMany({ where: { id: { in: doctorIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  if (medecins.length < doctorIds.length) return { ok: false, error: "Un praticien coché n'existe plus dans l'annuaire — rechargez l'écran." };

  const dejaLies = new Set((await prisma.adProMedecin.findMany({
    where: { entityType: nature, entityId, doctorId: { in: doctorIds } }, select: { doctorId: true },
  })).map((l) => l.doctorId));
  const nouveaux = medecins.filter((m) => !dejaLies.has(m.id));
  if (nouveaux.length === 0) return { ok: true, message: "Ces médecins étaient déjà reliés à la demande." };

  // `skipDuplicates` : un second onglet qui relie le même praticien entre-temps ne fait pas échouer le lot.
  await prisma.adProMedecin.createMany({
    data: nouveaux.map((m) => ({ entityType: nature, entityId, doctorId: m.id, role, createdById: user.id })),
    skipDuplicates: true,
  });
  const noms = nouveaux.slice(0, 20).map((m) => m.name).join(", ") + (nouveaux.length > 20 ? ` et ${nouveaux.length - 20} autre(s)` : "");
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Ad & Pro", entityType: nature, entityId,
    summary: `Médecins concernés (${role.toLowerCase()}) : ${noms}`,
  });
  rafraichir(nature, entityId, ...nouveaux.map((m) => m.id));
  const n = nouveaux.length;
  const sauf = dejaLies.size > 0 ? ` (${dejaLies.size} l'étai${dejaLies.size > 1 ? "en" : ""}t déjà)` : "";
  return { ok: true, message: `${n} médecin${n > 1 ? "s" : ""} relié${n > 1 ? "s" : ""} à la demande${sauf}.` };
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
 * CHERCHER DANS L'ANNUAIRE — la liste déroulante de la carte « Médecins concernés ». Une lecture : nom, spécialité,
 * établissement (rien de la fiche).
 *
 * LA LISTE S'OUVRE SANS RIEN TAPER (recette 24/11/2026) : sans `q`, l'annuaire entier par ordre alphabétique ; avec `q`, ce qui
 * le contient (nom, spécialité, établissement). Au plus `PLAFOND_ANNUAIRE` lignes — `tronque` dit qu'il y en a d'autres, et
 * l'écran l'écrit au lieu de laisser croire que la liste est complète.
 */
export async function chercherMedecinsAnnuaire(formData: FormData): Promise<{
  medecins: { id: string; nom: string; specialite: string | null; etablissement: string | null }[];
  tronque: boolean;
}> {
  await enLecture(requireUser);
  const q = (fdStr(formData, "q") ?? "").trim();
  const rows = await prisma.medicalDoctor.findMany({
    where: {
      archivedAt: null,
      ...(q ? {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { specialty: { contains: q, mode: "insensitive" as const } },
          { specialtyRef: { name: { contains: q, mode: "insensitive" as const } } },
          { institution: { contains: q, mode: "insensitive" as const } },
          { institutionRef: { name: { contains: q, mode: "insensitive" as const } } },
        ],
      } : {}),
    },
    // Un de plus que le plafond : c'est lui qui dit que la liste est tronquée, sans compter tout l'annuaire.
    orderBy: { name: "asc" }, take: PLAFOND_ANNUAIRE + 1,
    select: { id: true, name: true, specialty: true, institution: true, specialtyRef: { select: { name: true } }, institutionRef: { select: { name: true } } },
  });
  return {
    medecins: rows.slice(0, PLAFOND_ANNUAIRE).map((d) => ({
      id: d.id, nom: d.name, specialite: d.specialtyRef?.name ?? d.specialty ?? null, etablissement: d.institutionRef?.name ?? d.institution ?? null,
    })),
    tronque: rows.length > PLAFOND_ANNUAIRE,
  };
}
