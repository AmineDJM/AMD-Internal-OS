import { prisma } from "@/lib/prisma";

/**
 * LE SEMIS DU LOT I4 (décision 0067) — un annuaire FICTIF pour la mission « chefs de service d'infectiologie en Algérie » :
 * des chefs de service d'infectiologie (complets, sans service, sans wilaya, ancien), un professeur et un maître-assistant
 * d'infectiologie, un chef de service d'une AUTRE spécialité, un chef ARCHIVÉ. Deux sont au panel du délégué (`delegateId`).
 * Partagé par le banc (`lire-tout-i4.test.ts`) et le rejeu au vrai modèle (`scripts/bench/i4-lire-tout/`).
 */
export interface SemisAnnuaireI4 {
  tag: string;
  /** Les chefs de service d'infectiologie VIVANTS — la réponse exacte pour le Super Admin. */
  attendus: string[];
  /** Ceux du panel du délégué. */
  duDelegue: string[];
  ids: string[];
}

/** La wilaya et son code officiel, écrits ENSEMBLE à la création (la double écriture des lieux, comme le semis T2). */
const CODES: Record<string, string> = { Alger: "16", Oran: "31", Constantine: "25" };

export async function semerAnnuaireI4(tag: string, delegueId: string | null): Promise<SemisAnnuaireI4> {
  const sp = async (name: string) => (await prisma.medicalSpecialty.create({ data: { name: `${name} ${tag}` } })).id;
  const [infectio, cardio] = [await sp("Infectiologie"), await sp("Cardiologie")];
  const etab = async (name: string, wilaya: string, service: string | null) => {
    const i = await prisma.medicalInstitution.create({ data: { name: `${name} ${tag}`, type: "CHU", sector: "PUBLIC", wilaya, wilayaCode: CODES[wilaya] ?? null, city: wilaya, isActive: true } as never });
    const s = service ? await prisma.medicalInstitutionService.create({ data: { institutionId: i.id, name: service } }) : null;
    return { id: i.id, serviceId: s?.id ?? null };
  };
  const mustapha = await etab("CHU Mustapha Pacha", "Alger", "Service des maladies infectieuses");
  const oran = await etab("CHU d'Oran", "Oran", "Service d'infectiologie");
  const kettar = await etab("EHS El Kettar", "Alger", null);
  const constantine = await etab("CHU de Constantine", "Constantine", "Maladies infectieuses");
  // Le cardiologue d'Oran a SON service (cardiologie), pas celui des maladies infectieuses.
  const cardioOran = { id: oran.id, serviceId: (await prisma.medicalInstitutionService.create({ data: { institutionId: oran.id, name: "Service de cardiologie" } })).id };
  type Fiche = { nom: string; titre: string; specialite: string; etab: { id: string; serviceId: string | null }; wilaya: string | null; tel?: string; email?: string; delegue?: boolean; archive?: boolean; ancienne?: boolean; sansService?: boolean };
  const fiches: Fiche[] = [
    { nom: "Pr Amel Benali", titre: "CHEF_DE_SERVICE", specialite: infectio, etab: mustapha, wilaya: "Alger", tel: "021 23 45 67", email: "a.benali@chu-mustapha.test", delegue: true },
    { nom: "Dr Karim Ziani", titre: "CHEF_DE_SERVICE", specialite: infectio, etab: oran, wilaya: "Oran", tel: "041 33 22 11", email: "k.ziani@chu-oran.test" },
    { nom: "Dr Nadia Ferhat", titre: "CHEF_DE_SERVICE", specialite: infectio, etab: kettar, wilaya: "Alger", tel: "021 99 88 77", delegue: true, sansService: true },
    { nom: "Dr Samir Bouzid", titre: "CHEF_DE_SERVICE", specialite: infectio, etab: constantine, wilaya: null, email: "s.bouzid@chu-constantine.test", ancienne: true },
    { nom: "Pr Lina Haddad", titre: "PROFESSEUR", specialite: infectio, etab: mustapha, wilaya: "Alger", tel: "021 11 22 33", delegue: true },
    { nom: "Dr Yacine Rahmani", titre: "MAITRE_ASSISTANT", specialite: infectio, etab: oran, wilaya: "Oran" },
    { nom: "Dr Farid Kaci", titre: "CHEF_DE_SERVICE", specialite: cardio, etab: cardioOran, wilaya: "Oran", tel: "041 00 11 22", delegue: true },
    { nom: "Dr Omar Saadi", titre: "CHEF_DE_SERVICE", specialite: infectio, etab: mustapha, wilaya: "Alger", archive: true },
  ];
  const ids: string[] = [];
  for (const f of fiches) {
    const d = await prisma.medicalDoctor.create({
      data: {
        name: `${f.nom} ${tag}`, title: f.titre as never, specialtyId: f.specialite, institutionId: f.etab.id, serviceId: f.sansService ? null : f.etab.serviceId,
        wilaya: f.wilaya, wilayaCode: f.wilaya ? CODES[f.wilaya] ?? null : null, city: f.wilaya, phone: f.tel ?? null, email: f.email ?? null, delegateId: f.delegue ? delegueId : null,
        sector: "HOSPITAL", ...(f.archive ? { archivedAt: new Date() } : {}),
      } as never,
    });
    if (f.ancienne) await prisma.medicalDoctor.update({ where: { id: d.id }, data: { updatedAt: new Date("2024-03-01T00:00:00Z") } });
    ids.push(d.id);
  }
  const vivantsChefsInfectio = fiches.filter((f) => f.titre === "CHEF_DE_SERVICE" && f.specialite === infectio && !f.archive);
  return {
    tag,
    attendus: vivantsChefsInfectio.map((f) => `${f.nom} ${tag}`).sort(),
    duDelegue: vivantsChefsInfectio.filter((f) => f.delegue).map((f) => `${f.nom} ${tag}`).sort(),
    ids,
  };
}

export async function effacerAnnuaireI4(tag: string): Promise<void> {
  await prisma.medicalDoctor.deleteMany({ where: { name: { endsWith: tag } } });
  await prisma.medicalInstitution.deleteMany({ where: { name: { endsWith: tag } } });
  await prisma.medicalSpecialty.deleteMany({ where: { name: { endsWith: tag } } });
}
