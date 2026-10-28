"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { addCareBeneficiary, removeCareBeneficiary } from "@/modules/ad-pro/actions-prise-en-charge";
import { demanderPiecesPriseEnCharge } from "@/modules/ad-pro/actions-prise-en-charge-logistique";

/**
 * PERSONNES PRISES EN CHARGE D'UN CONGRÈS — trois gestes que des appelants nomment encore (les ops
 * d'Adam), RAMENÉS sur la source unique.
 *
 * Jusqu'au 04/10/2026, ces actions écrivaient une liste JSON sur le congrès (`beneficiaries`) pendant
 * que le dossier de prise en charge tenait SA liste (`CareBeneficiary`) : deux blocs « Personnes prises
 * en charge » sur la même fiche, qui ne se voyaient pas (§118.5). La Direction en a fait UNE liste,
 * « Professionnels proposés pour la prise en charge » : ces trois actions écrivent désormais là, par
 * l'écrivain du dossier — mêmes portes, même audit. Le JSON reste en base, plus écrit ; la migration
 * `20270107090000` a repris ce qu'il portait.
 */
type Kind = "INTERNATIONAL" | "NATIONAL";
const estKind = (v: string | null): v is Kind => v === "INTERNATIONAL" || v === "NATIONAL";

export async function addCongressBeneficiary(formData: FormData): Promise<ActionResult> {
  await requireUser();
  const kind = fdStr(formData, "kind");
  const id = fdStr(formData, "id");
  if (!estKind(kind) || !id) return { ok: false, error: "Identifiant manquant." };
  const fd = new FormData();
  fd.set("scope", kind);
  fd.set("requestId", id);
  const role = fdStr(formData, "role");
  if (role) fd.set("jobTitle", role);
  const doctorId = fdStr(formData, "doctorId");
  const name = fdStr(formData, "name");
  if (fdStr(formData, "createDoctor") === "on") {
    fd.set("createDoctor", "on");
    if (name) fd.set("doctorName", name);
    for (const k of ["specialtyId", "sector", "institutionId"] as const) {
      const v = fdStr(formData, k);
      if (v) fd.set(k, v);
    }
  } else if (doctorId) {
    fd.set("doctorId", doctorId);
  } else if (name) {
    fd.set("lastName", name);
  }
  return addCareBeneficiary(undefined, fd);
}

/** Référentiel pour le sélecteur de praticiens / la création inline (annuaire, spécialités, établissements). */
export async function listBeneficiaryRefs(): Promise<{
  doctors: { id: string; name: string; institution: string | null; specialty: string | null }[];
  specialties: { id: string; name: string }[];
  institutions: { id: string; name: string; wilaya: string | null }[];
}> {
  await enLecture(requireUser);
  const [doctors, specialties, institutions] = await Promise.all([
    prisma.medicalDoctor.findMany({ select: { id: true, name: true, institution: true, specialty: true }, orderBy: { name: "asc" }, take: 2000 }),
    prisma.medicalSpecialty.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.medicalInstitution.findMany({ where: { isActive: true }, select: { id: true, name: true, wilaya: true }, orderBy: { name: "asc" } }),
  ]);
  return { doctors, specialties, institutions };
}

export async function removeCongressBeneficiary(formData: FormData): Promise<ActionResult> {
  await requireUser();
  const kind = fdStr(formData, "kind");
  const id = fdStr(formData, "id");
  const benefId = fdStr(formData, "benefId");
  if (!estKind(kind) || !id || !benefId) return { ok: false, error: "Identifiant manquant." };
  // La personne doit appartenir à CE congrès : un identifiant d'une autre demande ne se retire pas d'ici.
  const appartient = await prisma.careBeneficiary.count({
    where: { id: benefId, ...(kind === "NATIONAL" ? { congressNationalId: id } : { congressInternationalId: id }) },
  });
  if (!appartient) return { ok: false, error: "Personne introuvable sur cette demande." };
  const fd = new FormData();
  fd.set("id", benefId);
  return removeCareBeneficiary(undefined, fd);
}

/** Demande les pièces des professionnels proposés — par personne et suivies (`demanderPiecesPriseEnCharge`). */
export async function requestBeneficiaryIds(formData: FormData): Promise<ActionResult> {
  await requireUser();
  const kind = fdStr(formData, "kind");
  const id = fdStr(formData, "id");
  if (!estKind(kind) || !id) return { ok: false, error: "Identifiant manquant." };
  const fd = new FormData();
  fd.set("scope", kind);
  fd.set("requestId", id);
  return demanderPiecesPriseEnCharge(undefined, fd);
}
