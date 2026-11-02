/**
 * REPRISE « adresses » — R3 `Adresse` depuis les fiches qui portent une adresse en texte libre (lot V2-D).
 *
 *   Personne      ← MedicalDoctor.address (+ code postal, wilaya)   type AUTRE (adresse professionnelle)
 *                 ← Employee.address                               type DOMICILE
 *   Organisation  ← MedicalInstitution.address (+ wilaya)          type SIEGE
 *                 ← CompanyContact.address (+ wilaya)              type SIEGE
 *                 ← Supplier.address (+ ville, pays)               type SIEGE
 *                 ← CompanyLegalIdentity.headOffice (de la société) type SIEGE
 *
 * Seulement pour les fiches DÉJÀ rattachées à une Personne / Organisation (`personneId`, `organisationId` — posés
 * par les lots V2-B / V2-C) : la reprise ne crée aucun titulaire. Une fiche sans titulaire est comptée et sera
 * reprise au passage suivant. La règle de traduction (clé, wilaya, refus) est dans `referentiels/coordonnees.ts`.
 */
import { prisma } from "@/lib/prisma";
import { adresseDepuisFiche, sourceImport, type AdresseCandidate, type ChampsAdresse, type Titulaire } from "../../domaine/coordonnees";
import { repriseParSources, type LigneSource, type SourceReprise } from "./par-sources";
import { page } from "../../domaine/reprises/pagination";

function ligne(id: string, titulaire: Titulaire | null, champs: Omit<ChampsAdresse, "titulaire"> | null): LigneSource<AdresseCandidate> {
  if (!titulaire || !champs) return { id, aTitulaire: Boolean(titulaire), candidats: [], notes: [] };
  const r = adresseDepuisFiche({ ...champs, titulaire });
  if (r.adresse) return { id, aTitulaire: true, candidats: [r.adresse], notes: [] };
  return { id, aTitulaire: true, candidats: [], notes: r.raison === "etranger" ? [`adresse à l'étranger (${r.detail}) non reprise — le code pays ne se déduit pas d'un texte`] : [] };
}

const personne = (id: string | null): Titulaire | null => (id ? { personneId: id } : null);
const organisation = (id: string | null): Titulaire | null => (id ? { organisationId: id } : null);

export const SOURCES_ADRESSES: readonly SourceReprise<AdresseCandidate>[] = [
  {
    table: "MedicalDoctor",
    lire: async (apres, taille) =>
      (await prisma.medicalDoctor.findMany({ ...page(apres, taille), select: { id: true, personneId: true, address: true, postalCode: true, city: true, wilaya: true, wilayaCode: true } }))
        .map((r) => ligne(r.id, personne(r.personneId), { type: "AUTRE", adresse: r.address, codePostal: r.postalCode, ville: r.city, wilaya: r.wilaya, wilayaCode: r.wilayaCode, source: sourceImport("MedicalDoctor", r.id) })),
  },
  {
    table: "Employee",
    lire: async (apres, taille) =>
      (await prisma.employee.findMany({ ...page(apres, taille), select: { id: true, personneId: true, address: true } }))
        .map((r) => ligne(r.id, personne(r.personneId), { type: "DOMICILE", adresse: r.address, source: sourceImport("Employee", r.id) })),
  },
  {
    table: "MedicalInstitution",
    lire: async (apres, taille) =>
      (await prisma.medicalInstitution.findMany({ ...page(apres, taille), select: { id: true, organisationId: true, address: true, city: true, wilaya: true, wilayaCode: true } }))
        .map((r) => ligne(r.id, organisation(r.organisationId), { type: "SIEGE", adresse: r.address, ville: r.city, wilaya: r.wilaya, wilayaCode: r.wilayaCode, source: sourceImport("MedicalInstitution", r.id) })),
  },
  {
    table: "CompanyContact",
    lire: async (apres, taille) =>
      (await prisma.companyContact.findMany({ ...page(apres, taille), select: { id: true, organisationId: true, address: true, city: true, wilaya: true, wilayaCode: true } }))
        .map((r) => ligne(r.id, organisation(r.organisationId), { type: "SIEGE", adresse: r.address, ville: r.city, wilaya: r.wilaya, wilayaCode: r.wilayaCode, source: sourceImport("CompanyContact", r.id) })),
  },
  {
    table: "Supplier",
    lire: async (apres, taille) =>
      (await prisma.supplier.findMany({ ...page(apres, taille), select: { id: true, organisationId: true, address: true, city: true, country: true, wilayaCode: true } }))
        .map((r) => ligne(r.id, organisation(r.organisationId), { type: "SIEGE", adresse: r.address, ville: r.city, pays: r.country, wilayaCode: r.wilayaCode, source: sourceImport("Supplier", r.id) })),
  },
  {
    table: "CompanyLegalIdentity",
    lire: async (apres, taille) =>
      (await prisma.companyLegalIdentity.findMany({ ...page(apres, taille), select: { id: true, headOffice: true, company: { select: { organisationId: true } } } }))
        .map((r) => ligne(r.id, organisation(r.company.organisationId), { type: "SIEGE", adresse: r.headOffice, source: sourceImport("CompanyLegalIdentity", r.id) })),
  },
];

export const repriseAdresses = repriseParSources<AdresseCandidate>({
  cle: "adresses",
  titre: "Coordonnées — adresses des personnes et organisations",
  description:
    "Recopie dans le référentiel `Adresse` les adresses saisies sur les praticiens, collaborateurs (domicile), "
    + "établissements, partenaires, fournisseurs et sociétés du groupe (siège) — pour les seules fiches déjà "
    + "rattachées à une Personne ou une Organisation. La wilaya suit celle de la fiche ; aucune commune n'est posée "
    + "(référentiel vide). Les fiches restent inchangées. Rejouable : une même adresse d'un même titulaire n'est "
    + "créée qu'une fois ; à relancer après les reprises des personnes et des organisations.",
  prefixe: "adr",
  sources: SOURCES_ADRESSES,
  ecrivain: {
    existants: async (ids) => new Set((await prisma.adresse.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((a) => a.id)),
    inserer: async (lignes) =>
      (await prisma.adresse.createMany({
        skipDuplicates: true,
        data: lignes.map(({ id, personneId, organisationId, type, ligne1, wilayaCode, codePostal, source }) => ({
          id, personneId, organisationId, type, ligne1, wilayaCode, codePostal, source,
        })),
      })).count,
  },
});
