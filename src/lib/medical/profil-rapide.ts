import type { MedicalSector } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";

/**
 * CRÉER UN PROFIL DE MÉDECIN DEPUIS UNE PRISE EN CHARGE — l'écrivain unique.
 *
 * Le bloc « Personnes prises en charge » le faisait déjà (« Nouveau médecin ») ; la décision du
 * 04/10/2026 le porte sur la liste des professionnels proposés, à la création de la demande comme sur
 * sa fiche. Deux copies du même geste finiraient par créer deux formes de fiche (§118.5) : celle-ci
 * est lue par les deux.
 *
 * La spécialité et l'établissement ne s'écrivent que s'ils EXISTENT au référentiel : un identifiant
 * forgé donnerait une fiche liée à rien. Le libellé dénormalisé SUIT le lien (§118.172).
 */
export interface ProfilRapide {
  name: string;
  specialtyId: string | null;
  institutionId: string | null;
  sector: string | null;
}

const SECTEURS: MedicalSector[] = ["HOSPITAL", "LIBERAL", "BOTH"];

export async function creerProfilMedecin(
  actorId: string,
  profil: ProfilRapide,
  origine: string,
): Promise<{ ok: true; id: string; name: string } | { ok: false; error: string }> {
  const name = profil.name.trim();
  if (!name) return { ok: false, error: "Le nom du médecin est obligatoire." };
  const [spec, inst] = await Promise.all([
    profil.specialtyId ? prisma.medicalSpecialty.findUnique({ where: { id: profil.specialtyId }, select: { id: true, name: true } }) : null,
    profil.institutionId ? prisma.medicalInstitution.findUnique({ where: { id: profil.institutionId }, select: { id: true, name: true, isActive: true } }) : null,
  ]);
  if (profil.specialtyId && !spec) return { ok: false, error: "Spécialité introuvable dans le référentiel." };
  if (profil.institutionId && (!inst || !inst.isActive)) return { ok: false, error: "Établissement introuvable ou désactivé." };

  const doctor = await prisma.medicalDoctor.create({
    data: {
      name,
      sector: profil.sector && SECTEURS.includes(profil.sector as MedicalSector) ? (profil.sector as MedicalSector) : undefined,
      specialtyId: spec?.id ?? null,
      specialty: spec?.name ?? null,
      institutionId: inst?.id ?? null,
      institution: inst?.name ?? null,
      createdById: actorId,
    },
    select: { id: true, name: true },
  });
  await recordAudit({
    actorId, action: "CREATE", module: "Promotion médicale", entityType: "DOCTOR", entityId: doctor.id,
    summary: `Médecin « ${doctor.name} » créé depuis ${origine}`,
  }).catch(sansBloquer("profil-rapide.creerProfilMedecin.recordAudit"));
  return { ok: true, id: doctor.id, name: doctor.name };
}
