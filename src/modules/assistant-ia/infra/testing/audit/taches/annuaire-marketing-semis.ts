/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT — LE SEMIS DU LOT T2 (annuaires, marketing, terrain), décision 0052.
 *
 * Un petit monde réaliste, étiqueté et retirable, posé APRÈS les personas (`semerAudit`) :
 *   • deux BU (Hépatologie, Oncologie), deux secteurs — Est (Constantine, Yanis HAMDI) et Ouest (Oran, Farid ZEROUAL) ;
 *   • un annuaire de praticiens (panels des deux délégués, homonymes « BENALI », fiches sans téléphone ni spécialité) ;
 *   • des pharmacies et établissements (Oran : trois paires de DOUBLONS ; Constantine : une pharmacie non couverte) ;
 *   • des visites (dates RELATIVES au jour du passage : « ces 30 derniers jours » reste vrai), dont un compte rendu
 *     portant un témoin privé (`TEMOIN_VISITE`) que le délégué d'un autre secteur ne doit jamais lire ;
 *   • des dépenses Ad & Pro (sponsorings et « autres ») ventilées par BU, produit et mois ;
 *   • un fabricant Regulatory et deux classeurs Excel dans le Drive de la responsable marketing.
 *
 * Les VÉRIFICATEURS des tâches (`annuaire-marketing.ts`) relisent la base, jamais la parole de l'assistant ; les
 * `preparer` remettent chaque fiche dans son état initial (le banc se rejoue).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { attendu } from "@/lib/journal";
import { deposerPiece, xlsx } from "./aides";
import type { PieceSemee, SemisDeDomaine } from "./types";
import { etiquetteT2, INITIAL, TEMOIN_VISITE } from "./annuaire-marketing-donnees";

/**
 * QUI SÈME LE MONDE T2 : le banc réel (étiquette « -q1 ») et la suite T2 (`annuaire-terrain.test.ts`, « -t2-… »). Les autres
 * suites, qui sèment les personas en parallèle dans la même base de test, ne le sèment pas : ses noms (« Pharmacie
 * Es-Salam », BU « Hépatologie ») deviendraient de vrais homonymes d'une suite à l'autre.
 */
export const semeLeMondeT2 = (etiquette: string) => etiquette === "-q1" || etiquette.startsWith("-t2-");


/** Les codes officiels des deux wilayas du banc (référentiel `Wilaya`) : posés avec le texte, comme la double écriture. */
const CODE_WILAYA: Record<string, string> = { Oran: "31", Constantine: "25" };
const ilYA = (jours: number) => new Date(Date.now() - jours * 86_400_000);
/** Le 10 du mois courant (ou d'un mois passé) : une date qui reste dans « ce mois-ci » / « le mois dernier ». */
const dansLeMois = (decalage: number, jour = 3) => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - decalage, Math.min(jour, Math.max(1, n.getUTCDate())), 9));
};


async function specialite(name: string): Promise<string> {
  return (await prisma.medicalSpecialty.upsert({ where: { name }, update: {}, create: { name }, select: { id: true } })).id;
}

export const SEMIS_T2: SemisDeDomaine = async ({ etiquette, users, companyId }): Promise<Record<string, PieceSemee>> => {
  if (!semeLeMondeT2(etiquette)) return {};
  const tag = etiquetteT2(etiquette);
  const [hepato, onco] = [
    await prisma.businessUnit.create({ data: { name: "Hépatologie", code: `T2-HEP${etiquette}`, companyId }, select: { id: true } }),
    await prisma.businessUnit.create({ data: { name: "Oncologie", code: `T2-ONC${etiquette}`, companyId }, select: { id: true } }),
  ];
  for (const rep of [users.delegue, users.delegue_ouest]) {
    await prisma.salesRepProfile.upsert({ where: { repId: rep }, update: { businessUnitId: hepato.id }, create: { repId: rep, businessUnitId: hepato.id } });
  }
  const est = await prisma.salesSector.create({ data: { name: "Est — Constantine", businessUnitId: hepato.id, city: "Constantine", wilayaPivot: "Constantine", repId: users.delegue, reps: { create: { repId: users.delegue } } } as never, select: { id: true } });
  const ouest = await prisma.salesSector.create({ data: { name: "Ouest — Oran", businessUnitId: hepato.id, city: "Oran", wilayaPivot: "Oran", repId: users.delegue_ouest, reps: { create: { repId: users.delegue_ouest } } } as never, select: { id: true } });

  const etab = async (name: string, type: "CHU" | "CLINIQUE_PRIVEE" | "PHARMACIE", wilaya: string, extra: { phone?: string | null; address?: string | null } = {}, secteur?: string) => {
    const e = await prisma.medicalInstitution.create({ data: { name, type, sector: type === "CHU" ? "PUBLIC" : "PRIVE", wilaya, wilayaCode: CODE_WILAYA[wilaya] ?? null, city: wilaya, notes: tag, ...extra }, select: { id: true } });
    if (secteur) await prisma.salesSectorInstitution.create({ data: { sectorId: secteur, institutionId: e.id } });
    return e.id;
  };
  const etablissements = {
    chuConstantine: await etab("CHU Constantine", "CHU", "Constantine", { phone: "031 88 00 00" }, est.id),
    elHayat: await etab("Clinique El Hayat", "CLINIQUE_PRIVEE", "Constantine"),
    ibnSina: await etab("Pharmacie Ibn Sina", "PHARMACIE", "Constantine", { phone: "031 92 14 14", address: "12 rue Abane Ramdane, Constantine" }, est.id),
    cirta: await etab("Pharmacie Cirta", "PHARMACIE", "Constantine", { phone: "031 64 20 20" }),
    elAmel: await etab("Pharmacie El Amel", "PHARMACIE", "Oran", { ...INITIAL.elAmel }, ouest.id),
    esSalamA: await etab(INITIAL.esSalamA.name, "PHARMACIE", "Oran", { phone: INITIAL.esSalamA.phone }, ouest.id),
    esSalamB: await etab(INITIAL.esSalamB.name, "PHARMACIE", "Oran", { address: INITIAL.esSalamB.address }),
    ibnRochdA: await etab("Pharmacie Ibn Rochd", "PHARMACIE", "Oran", { phone: "041 51 10 10" }),
    ibnRochdB: await etab("Pharmacie Ibn-Rochd", "PHARMACIE", "Oran", { address: "3 place du 1er Novembre, Oran" }),
    belleVue: await etab("Pharmacie Belle Vue", "PHARMACIE", "Oran", { ...INITIAL.belleVue, address: "40 boulevard de la Soummam, Oran" }, ouest.id),
    portA: await etab("Pharmacie du Port", "PHARMACIE", "Oran", { phone: "041 33 90 90" }),
    portB: await etab("Pharmacie Du Port", "PHARMACIE", "Oran", { phone: "041 33 90 90", address: "1 rue du Port, Oran" }),
  };

  const directory = await prisma.medicalDirectory.create({ data: { name: `Annuaire banc T2${etiquette}`, description: tag, companyId }, select: { id: true } });
  const [hep, gastro, cardio] = [await specialite("Hépatologie"), await specialite("Gastro-entérologie"), await specialite("Cardiologie")];
  await specialite("Oncologie");
  const medecin = async (name: string, delegue: string, wilaya: string, o: { specialtyId?: string | null; institutionId?: string | null; institution?: string | null; phone?: string | null }) =>
    (await prisma.medicalDoctor.create({ data: {
      name, lastName: name.split(" ").slice(-1)[0], firstName: name.split(" ")[0], delegateId: delegue, wilaya, wilayaCode: CODE_WILAYA[wilaya] ?? null, city: wilaya, directoryId: directory.id, companyId,
      specialtyId: o.specialtyId ?? null, institutionId: o.institutionId ?? null, institution: o.institution ?? null, phone: o.phone ?? null, comments: tag,
    }, select: { id: true } })).id;
  const medecins = {
    bensalem: await medecin("Karima BENSALEM", users.delegue, "Constantine", { specialtyId: gastro, institutionId: etablissements.chuConstantine, institution: "CHU Constantine", phone: INITIAL.bensalem.phone }),
    mansouri: await medecin("Rachid MANSOURI", users.delegue, "Constantine", { specialtyId: hep, institutionId: etablissements.chuConstantine, institution: "CHU Constantine", phone: "0661 72 31 48" }),
    amelBenali: await medecin("Amel BENALI", users.delegue, "Constantine", { specialtyId: cardio, institutionId: etablissements.chuConstantine, institution: "CHU Constantine", phone: "0662 10 20 30" }),
    omarBenali: await medecin("Omar BENALI", users.delegue, "Constantine", { specialtyId: gastro, institutionId: etablissements.elHayat, institution: INITIAL.omarBenali.institution, phone: "0663 40 50 60" }),
    khelif: await medecin("Sami KHELIF", users.delegue, "Constantine", { specialtyId: gastro }),
    aissaoui: await medecin("Nora AISSAOUI", users.delegue, "Constantine", { phone: "0664 11 22 33" }),
    lamri: await medecin("Fares LAMRI", users.delegue, "Constantine", {}),
    belhadj: await medecin("Hakim BELHADJ", users.delegue_ouest, "Oran", { specialtyId: hep, phone: "0770 12 12 12" }),
    touati: await medecin("Leila TOUATI", users.delegue_ouest, "Oran", { specialtyId: gastro }),
  };

  // T2 bis (décision 0062) : un DOUBLON de fiche — « KHELIF Sami », hors de tout panel, avec le téléphone qui manque à la
  // première ; seul le Super Admin se le verra proposer (✓ / ✗), rien ne fusionne sans son clic.
  await medecin("KHELIF Sami", users.marketing, "Constantine", { specialtyId: gastro, phone: "0665 55 44 33" })
    .then((id) => prisma.medicalDoctor.update({ where: { id }, data: { delegateId: null } }));
  // Le produit de la BU Hépatologie, pour les stocks (relevé du délégué, demande formelle du marketing).
  const dac = await prisma.regulatoryProduct.create({ data: { reference: `REG-T2${etiquette}-DAC`, dci: "Daclatasvir", brandName: "Daclavir", status: "DECISION_OBTAINED" }, select: { id: true } });
  await prisma.promoProduct.create({ data: { name: "Daclavir", businessUnitId: hepato.id, regulatoryProductId: dac.id, isActive: true } as never });

  const visite = (doctorId: string, delegateId: string, jours: number, report: string, products = "Daclavir") => prisma.medicalVisit.create({ data: {
    date: ilYA(jours), doctorId, delegateId, status: "COMPLETED", presentedProducts: products, report, createdById: delegateId,
  } });
  await visite(medecins.mansouri, users.delegue, 4, `Présentation Daclavir, patient pilote évoqué — note confidentielle ${TEMOIN_VISITE}.`);
  await visite(medecins.mansouri, users.delegue, 40, "Première visite, intérêt pour les données de vie réelle.");
  await visite(medecins.bensalem, users.delegue, 2, "Daclavir présenté, demande d'échantillons.");
  await visite(medecins.amelBenali, users.delegue, 9, "Visite de courtoisie.");
  await visite(medecins.khelif, users.delegue, 12, "Intéressé par le congrès d'hépatologie.");
  await visite(medecins.belhadj, users.delegue_ouest, 3, "Daclavir : prescripteur régulier.");
  await visite(medecins.touati, users.delegue_ouest, 6, "Remise de brochures.");

  // ── Les dépenses Ad & Pro (montants demandés, aucun accordé : une seule base de calcul, dite) ──
  const depenses: [string, "hepato" | "onco", string, number, number][] = [
    // [titre, BU, produit, montant, mois en arrière]
    // Pas « SAHGE » : le domaine T3 sème déjà un sponsoring de ce congrès — deux homonymes rendaient ses cartes ambiguës.
    ["Journées d'hépatologie d'Oran — stand", "hepato", "Daclavir", 640_000, 0],
    ["Journée hépatologie Sétif", "hepato", "Daclavir", 215_000, 1],
    ["Symposium oncologie Alger", "onco", "Nivolumab", 480_000, 0],
    ["Atelier immunothérapie Oran", "onco", "Nivolumab", 330_000, 1],
  ];
  let n = 0;
  for (const [titre, bu, produit, montant, mois] of depenses) {
    n += 1;
    await prisma.sponsoringRequest.create({ data: {
      reference: `SP-T2${etiquette}-${n}`, institution: titre, type: "Congrès", product: produit, businessUnitId: bu === "hepato" ? hepato.id : onco.id,
      amountRequested: montant, status: "ACCEPTED", requesterId: users.marketing, companyId, createdAt: dansLeMois(mois), requestDate: dansLeMois(mois),
    } as never });
  }
  await prisma.adProOtherRequest.create({ data: {
    reference: `AUT-T2${etiquette}-1`, title: "Kakémonos Daclavir pour les pharmacies", product: "Daclavir", businessUnitId: hepato.id, amount: 95_000,
    status: "APPROVED", requesterId: users.marketing, companyId, createdAt: dansLeMois(0, 2),
  } as never });

  await prisma.supplier.create({ data: { name: "Hetero Labs", country: "Inde", website: INITIAL.fournisseur.website, contactEmail: "regulatory@hetero.example", notes: tag } });

  // ── Les classeurs que la responsable marketing joint (pièces du domaine, clés `ann_…`) ──
  return {
    ann_specialites: await deposerPiece(users.marketing, "Spécialités médecins Constantine.xlsx", await xlsx([
      ["Médecin", "Spécialité"], ["Nora AISSAOUI", "Hépatologie"], ["Fares LAMRI", "Oncologie"], ["Yacine HADJ", "Cardiologie"],
    ], "Spécialités")),
    ann_telephones: await deposerPiece(users.marketing, "Téléphones pharmacies Oran.xlsx", await xlsx([
      ["Pharmacie", "Téléphone"], ["Pharmacie El Amel", "041 33 22 11"], ["Pharmacie Belle Vue", "041 45 67 89"], ["Pharmacie Inconnue", "041 00 00 00"],
    ], "Pharmacies")),
  };
};

/** Retire le monde T2 (avant les comptes : les fiches portent leurs délégués). */
export async function retirerT2(etiquette: string, userIds: string[]): Promise<void> {
  const tag = etiquetteT2(etiquette);
  const sur = <T>(p: Promise<T>) => p.catch(attendu("banc T2 : ligne déjà retirée", null));
  const docs = await prisma.medicalDoctor.findMany({ where: { OR: [{ comments: tag }, { delegateId: { in: userIds } }, { directory: { name: `Annuaire banc T2${etiquette}` } }] }, select: { id: true } });
  const ids = docs.map((x) => x.id);
  await sur(prisma.medicalVisit.deleteMany({ where: { OR: [{ doctorId: { in: ids } }, { delegateId: { in: userIds } }] } }));
  await sur(prisma.medicalDoctor.deleteMany({ where: { id: { in: ids } } }));
  await sur(prisma.medicalDirectory.deleteMany({ where: { name: `Annuaire banc T2${etiquette}` } }));
  const etabs = await prisma.medicalInstitution.findMany({ where: { notes: { startsWith: tag } }, select: { id: true } });
  await sur(prisma.salesSectorInstitution.deleteMany({ where: { institutionId: { in: etabs.map((e) => e.id) } } }));
  // Les lieux de stock posés par un relevé (T2 bis) et leurs états.
  await sur(prisma.stockSnapshot.deleteMany({ where: { annex: { institutionId: { in: etabs.map((e) => e.id) } } } as never }));
  await sur(prisma.stockAnnex.deleteMany({ where: { institutionId: { in: etabs.map((e) => e.id) } } }));
  await sur(prisma.medicalInstitution.deleteMany({ where: { id: { in: etabs.map((e) => e.id) } } }));
  const bus = await prisma.businessUnit.findMany({ where: { code: { in: [`T2-HEP${etiquette}`, `T2-ONC${etiquette}`] } }, select: { id: true } });
  const buIds = bus.map((b) => b.id);
  await sur(prisma.sponsoringRequest.deleteMany({ where: { OR: [{ reference: { startsWith: `SP-T2${etiquette}-` } }, { requesterId: { in: userIds } }] } }));
  await sur(prisma.adProOtherRequest.deleteMany({ where: { OR: [{ reference: { startsWith: `AUT-T2${etiquette}-` } }, { requesterId: { in: userIds } }] } }));
  await sur(prisma.salesSectorRep.deleteMany({ where: { sector: { businessUnitId: { in: buIds } } } }));
  await sur(prisma.salesSector.deleteMany({ where: { businessUnitId: { in: buIds } } }));
  await sur(prisma.salesRepProfile.deleteMany({ where: { repId: { in: userIds } } }));
  await sur(prisma.stockSnapshot.deleteMany({ where: { product: { reference: { startsWith: `REG-T2${etiquette}-` } } } as never }));
  await sur(prisma.stockCountRequest.deleteMany({ where: { createdById: { in: userIds } } }));
  await sur(prisma.promoProduct.deleteMany({ where: { businessUnitId: { in: buIds } } }));
  await sur(prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: `REG-T2${etiquette}-` } } }));
  await sur(prisma.decisionFusionMedecin.deleteMany({ where: { OR: [{ medecinAId: { in: ids } }, { medecinBId: { in: ids } }] } }));
  await sur(prisma.businessUnit.deleteMany({ where: { id: { in: buIds } } }));
  await sur(prisma.supplier.deleteMany({ where: { notes: tag } }));
}
