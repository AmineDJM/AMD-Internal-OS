/**
 * REPRISE « points-de-contact » — R3 `PointDeContact` depuis les téléphones, e-mails et sites des fiches (lot V2-D).
 *
 *   Personne      ← MedicalDoctor (phone, email) · Employee (phone, email) · RecruitmentCandidate (phone, email)
 *                 ← User (phone, email) · SupplierUser (email) · DirectoryEntry → DirectoryEndpoint actifs
 *   Organisation  ← MedicalInstitution (phone, email) · CompanyContact (phone, phoneAlt, email, website)
 *                 ← Supplier (phone, contactEmail, website) · CompanyLegalIdentity (phone, email, website)
 *
 * Seulement pour les fiches DÉJÀ rattachées à une Personne / Organisation (lots V2-B / V2-C). Un même numéro vu
 * sur plusieurs fiches d'un même titulaire n'est créé qu'une fois (clé : titulaire + type + valeur normalisée,
 * `referentiels/coordonnees.ts`). Une valeur illisible n'est pas reprise : elle est listée.
 */
import { prisma } from "@/lib/prisma";
import { pointsDepuisFiche, sourceImport, type ChampsContact, type PointCandidat, type Titulaire } from "@/lib/referentiels/coordonnees";
import { repriseParSources, type LigneSource, type SourceReprise } from "./par-sources";
import { page } from "./pagination";

function ligne(id: string, titulaire: Titulaire | null, champs: Omit<ChampsContact, "titulaire">): LigneSource<PointCandidat> {
  if (!titulaire) return { id, aTitulaire: false, candidats: [], notes: [] };
  const { points, illisibles } = pointsDepuisFiche({ ...champs, titulaire });
  return { id, aTitulaire: true, candidats: points, notes: illisibles.map((v) => `${v} illisible, non repris`) };
}

const personne = (id: string | null): Titulaire | null => (id ? { personneId: id } : null);
const organisation = (id: string | null): Titulaire | null => (id ? { organisationId: id } : null);

export const SOURCES_POINTS: readonly SourceReprise<PointCandidat>[] = [
  {
    table: "MedicalDoctor",
    lire: async (apres, taille) =>
      (await prisma.medicalDoctor.findMany({ ...page(apres, taille), select: { id: true, personneId: true, phone: true, email: true } }))
        .map((r) => ligne(r.id, personne(r.personneId), { telephones: [{ valeur: r.phone }], emails: [{ valeur: r.email }], source: sourceImport("MedicalDoctor", r.id) })),
  },
  {
    table: "Employee",
    lire: async (apres, taille) =>
      (await prisma.employee.findMany({ ...page(apres, taille), select: { id: true, personneId: true, phone: true, email: true } }))
        .map((r) => ligne(r.id, personne(r.personneId), { telephones: [{ valeur: r.phone }], emails: [{ valeur: r.email }], source: sourceImport("Employee", r.id) })),
  },
  {
    table: "RecruitmentCandidate",
    lire: async (apres, taille) =>
      (await prisma.recruitmentCandidate.findMany({ ...page(apres, taille), select: { id: true, personneId: true, phone: true, email: true } }))
        .map((r) => ligne(r.id, personne(r.personneId), { telephones: [{ valeur: r.phone }], emails: [{ valeur: r.email }], source: sourceImport("RecruitmentCandidate", r.id) })),
  },
  {
    table: "User",
    lire: async (apres, taille) =>
      (await prisma.user.findMany({ ...page(apres, taille), select: { id: true, personneId: true, phone: true, email: true } }))
        .map((r) => ligne(r.id, personne(r.personneId), { telephones: [{ valeur: r.phone }], emails: [{ valeur: r.email, libelle: "Compte ERP" }], source: sourceImport("User", r.id) })),
  },
  {
    table: "SupplierUser",
    lire: async (apres, taille) =>
      (await prisma.supplierUser.findMany({ ...page(apres, taille), select: { id: true, personneId: true, email: true } }))
        .map((r) => ligne(r.id, personne(r.personneId), { emails: [{ valeur: r.email, libelle: "Portail fournisseur" }], source: sourceImport("SupplierUser", r.id) })),
  },
  {
    table: "DirectoryEntry",
    lire: async (apres, taille) =>
      (await prisma.directoryEntry.findMany({
        ...page(apres, taille),
        select: { id: true, personneId: true, endpoints: { where: { isActive: true }, select: { channel: true, value: true, label: true } } },
      })).map((r) => ligne(r.id, personne(r.personneId), {
        telephones: r.endpoints.filter((e) => e.channel !== "EMAIL").map((e) => ({ valeur: e.value, libelle: e.label ?? (e.channel === "WHATSAPP" ? "WhatsApp" : null) })),
        emails: r.endpoints.filter((e) => e.channel === "EMAIL").map((e) => ({ valeur: e.value, libelle: e.label })),
        source: sourceImport("DirectoryEntry", r.id),
      })),
  },
  {
    table: "MedicalInstitution",
    lire: async (apres, taille) =>
      (await prisma.medicalInstitution.findMany({ ...page(apres, taille), select: { id: true, organisationId: true, phone: true, email: true } }))
        .map((r) => ligne(r.id, organisation(r.organisationId), { telephones: [{ valeur: r.phone }], emails: [{ valeur: r.email }], source: sourceImport("MedicalInstitution", r.id) })),
  },
  {
    table: "CompanyContact",
    lire: async (apres, taille) =>
      (await prisma.companyContact.findMany({ ...page(apres, taille), select: { id: true, organisationId: true, phone: true, phoneAlt: true, email: true, website: true } }))
        .map((r) => ligne(r.id, organisation(r.organisationId), {
          telephones: [{ valeur: r.phone }, { valeur: r.phoneAlt, libelle: "Secondaire" }],
          emails: [{ valeur: r.email }],
          sites: [{ valeur: r.website }],
          source: sourceImport("CompanyContact", r.id),
        })),
  },
  {
    table: "Supplier",
    lire: async (apres, taille) =>
      (await prisma.supplier.findMany({ ...page(apres, taille), select: { id: true, organisationId: true, phone: true, contactEmail: true, contactName: true, website: true } }))
        .map((r) => ligne(r.id, organisation(r.organisationId), {
          telephones: [{ valeur: r.phone }],
          emails: [{ valeur: r.contactEmail, libelle: r.contactName?.trim() ? `Contact : ${r.contactName.trim()}` : "Contact" }],
          sites: [{ valeur: r.website }],
          source: sourceImport("Supplier", r.id),
        })),
  },
  {
    table: "CompanyLegalIdentity",
    lire: async (apres, taille) =>
      (await prisma.companyLegalIdentity.findMany({ ...page(apres, taille), select: { id: true, phone: true, email: true, website: true, company: { select: { organisationId: true } } } }))
        .map((r) => ligne(r.id, organisation(r.company.organisationId), {
          telephones: [{ valeur: r.phone }], emails: [{ valeur: r.email }], sites: [{ valeur: r.website }], source: sourceImport("CompanyLegalIdentity", r.id),
        })),
  },
];

export const reprisePointsDeContact = repriseParSources<PointCandidat>({
  cle: "points-de-contact",
  titre: "Coordonnées — téléphones, e-mails et sites",
  description:
    "Recopie dans le référentiel `PointDeContact` les téléphones (en E.164), e-mails et sites saisis sur les "
    + "praticiens, collaborateurs, candidats, comptes, contacts fournisseurs, entrées d'annuaire, établissements, "
    + "partenaires, fournisseurs et sociétés du groupe — pour les seules fiches déjà rattachées à une Personne ou "
    + "une Organisation. Une valeur illisible n'est pas reprise, elle est listée. Aucun numéro n'est déclaré principal. "
    + "Rejouable ; à relancer après les reprises des personnes et des organisations.",
  prefixe: "pdc",
  sources: SOURCES_POINTS,
  ecrivain: {
    existants: async (ids) => new Set((await prisma.pointDeContact.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((p) => p.id)),
    inserer: async (lignes) =>
      (await prisma.pointDeContact.createMany({
        skipDuplicates: true,
        data: lignes.map(({ id, personneId, organisationId, type, valeur, valeurNormalisee, libelle, source }) => ({
          id, personneId, organisationId, type, valeur, valeurNormalisee, libelle, source,
        })),
      })).count,
  },
});
