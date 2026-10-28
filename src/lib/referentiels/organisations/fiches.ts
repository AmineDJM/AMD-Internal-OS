import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  candidatDeCompany, candidatDeCompanyContact, candidatDeMedicalInstitution, candidatDeSupplier, idOrganisationDeFiche,
  type CandidatOrganisation, type SourceOrganisation,
} from "./candidats";
import { assurerOrganisation } from "./ecriture";
import type { ResultatLigne, SourceDeReprise } from "@/lib/referentiels/reprises/lots";
import { bilanVide, type BilanReprise } from "@/lib/referentiels/reprises/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES QUATRE FICHES QUI PORTENT UNE ORGANISATION — `Company` (+ son identité légale), `CompanyContact`,
 * `Supplier`, `MedicalInstitution` — et leur rattachement au référentiel R2.
 *
 * Rattacher une fiche = assurer son organisation (`ecriture.ts`) et poser `organisationId` sur la fiche,
 * dans UNE transaction : jamais une organisation orpheline, jamais un lien vers rien. Une fiche déjà
 * rattachée n'est pas retouchée. C'est le même geste pour la reprise (par lots) et pour la double écriture
 * (une fiche à sa création).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Tx = Prisma.TransactionClient;

interface Fiche { id: string; organisationId: string | null }

interface DefinitionFiche<F extends Fiche> {
  source: SourceOrganisation;
  /** Le modèle Prisma, nom du curseur et du journal. */
  modele: string;
  lire(where: { id?: { gt?: string; in?: string[] }; organisationId?: null }, take?: number): Promise<F[]>;
  compter(where: { id?: { in: string[] }; organisationId?: null }): Promise<number>;
  candidat(f: F): CandidatOrganisation;
  lier(tx: Tx, id: string, organisationId: string): Promise<unknown>;
}

const company: DefinitionFiche<Fiche & Parameters<typeof candidatDeCompany>[0]> = {
  source: "COMPANY",
  modele: "Company",
  lire: (where, take) => prisma.company.findMany({
    where, take, orderBy: { id: "asc" },
    select: {
      id: true, organisationId: true, name: true, shortName: true,
      legalIdentity: { select: { legalName: true, legalForm: true, nif: true, nis: true, rcNumber: true, taxArticle: true, website: true } },
    },
  }),
  compter: (where) => prisma.company.count({ where }),
  candidat: candidatDeCompany,
  lier: (tx, id, organisationId) => tx.company.update({ where: { id }, data: { organisationId } }),
};

const companyContact: DefinitionFiche<Fiche & Parameters<typeof candidatDeCompanyContact>[0]> = {
  source: "COMPANY_CONTACT",
  modele: "CompanyContact",
  lire: (where, take) => prisma.companyContact.findMany({
    where, take, orderBy: { id: "asc" },
    select: { id: true, organisationId: true, name: true, kind: true, sphere: true, website: true, nif: true, rc: true },
  }),
  compter: (where) => prisma.companyContact.count({ where }),
  candidat: candidatDeCompanyContact,
  lier: (tx, id, organisationId) => tx.companyContact.update({ where: { id }, data: { organisationId } }),
};

const supplier: DefinitionFiche<Fiche & Parameters<typeof candidatDeSupplier>[0]> = {
  source: "SUPPLIER",
  modele: "Supplier",
  lire: (where, take) => prisma.supplier.findMany({
    where, take, orderBy: { id: "asc" }, select: { id: true, organisationId: true, name: true, country: true, website: true },
  }),
  compter: (where) => prisma.supplier.count({ where }),
  candidat: candidatDeSupplier,
  lier: (tx, id, organisationId) => tx.supplier.update({ where: { id }, data: { organisationId } }),
};

const medicalInstitution: DefinitionFiche<Fiche & Parameters<typeof candidatDeMedicalInstitution>[0]> = {
  source: "MEDICAL_INSTITUTION",
  modele: "MedicalInstitution",
  lire: (where, take) => prisma.medicalInstitution.findMany({
    where, take, orderBy: { id: "asc" }, select: { id: true, organisationId: true, name: true, type: true },
  }),
  compter: (where) => prisma.medicalInstitution.count({ where }),
  candidat: candidatDeMedicalInstitution,
  lier: (tx, id, organisationId) => tx.medicalInstitution.update({ where: { id }, data: { organisationId } }),
};

/** Dans l'ordre de la reprise : les sociétés du groupe d'abord (leurs identifiants font foi), puis les tiers. */
const DEFINITIONS = [company, companyContact, supplier, medicalInstitution] as const;
const PAR_SOURCE = new Map<SourceOrganisation, DefinitionFiche<Fiche>>(
  DEFINITIONS.map((d) => [d.source, d as unknown as DefinitionFiche<Fiche>]),
);

/** Restreindre la reprise à des fiches nommées (bancs d'essai) ; absent : toutes. */
export type PorteeFiches = Partial<Record<SourceOrganisation, string[]>>;

const clauseIds = (portee: PorteeFiches | undefined, source: SourceOrganisation) =>
  portee ? { in: portee[source] ?? [] } : undefined;

async function rattacher<F extends Fiche>(def: DefinitionFiche<F>, fiche: F, acteurId: string | null): Promise<ResultatLigne> {
  if (fiche.organisationId) return { issue: "IGNOREE" };
  const r = await prisma.$transaction(async (tx) => {
    const assuree = await assurerOrganisation(tx, idOrganisationDeFiche(def.source, fiche.id), def.candidat(fiche), acteurId);
    await def.lier(tx, fiche.id, assuree.organisationId);
    return assuree;
  });
  return { issue: r.creee ? "CREEE" : "LIEE", doublons: r.doublons };
}

/** RATTACHER UNE FICHE (double écriture) : sans effet si elle l'est déjà ou n'existe pas. */
export async function rattacherFiche(source: SourceOrganisation, id: string, acteurId: string | null): Promise<ResultatLigne> {
  const def = PAR_SOURCE.get(source)!;
  const [fiche] = await def.lire({ id: { in: [id] } }, 1);
  return fiche ? rattacher(def, fiche, acteurId) : { issue: "IGNOREE" };
}

/** Les sources de la reprise, pour `executerParLots`. */
export function sourcesDesFiches(acteurId: string | null, portee?: PorteeFiches): SourceDeReprise[] {
  return DEFINITIONS.map((d) => {
    const def = d as unknown as DefinitionFiche<Fiche>;
    return {
      nom: def.modele,
      lire: (apresId: string | null, taille: number) => {
        const ids = clauseIds(portee, def.source);
        return def.lire({ id: { ...(apresId ? { gt: apresId } : {}), ...(ids ?? {}) }, organisationId: null }, taille);
      },
      traiter: (fiche: Fiche) => rattacher(def, fiche, acteurId),
    };
  });
}

/**
 * L'APERÇU, À BLANC : par source, combien de fiches seraient rattachées, combien d'organisations naîtraient
 * (celles dont l'organisation déterministe existe déjà sont « liées »), et combien d'identifiants seraient
 * déjà portés par une autre organisation — autant de doublons proposés.
 */
export async function apercuDesFiches(portee?: PorteeFiches): Promise<BilanReprise> {
  const bilan = bilanVide();
  const vus = new Map<string, string>();
  const paires = new Set<string>();
  const duGroupe = new Set((await prisma.organisationRole.findMany({ where: { role: "SOCIETE_DU_GROUPE" }, select: { organisationId: true } })).map((r) => r.organisationId));
  for (const ident of await prisma.organisationIdentifiant.findMany({ select: { type: true, valeurNormalisee: true, organisationId: true } })) {
    vus.set(`${ident.type}:${ident.valeurNormalisee}`, ident.organisationId);
  }
  for (const d of DEFINITIONS) {
    const def = d as unknown as DefinitionFiche<Fiche>;
    const ids = clauseIds(portee, def.source);
    const where = ids ? { id: ids } : {};
    const [total, fiches] = await Promise.all([def.compter(where), def.lire({ ...where, organisationId: null })]);
    bilan.lues += total;
    bilan.ignorees += total - fiches.length;
    const existantes = new Set((await prisma.organisation.findMany({
      where: { id: { in: fiches.map((f) => idOrganisationDeFiche(def.source, f.id)) } }, select: { id: true },
    })).map((o) => o.id));
    for (const f of fiches) {
      const orgId = idOrganisationDeFiche(def.source, f.id);
      if (existantes.has(orgId)) bilan.liees++;
      else bilan.creees++;
      const candidat = def.candidat(f);
      const estDuGroupe = candidat.roles.includes("SOCIETE_DU_GROUPE");
      if (estDuGroupe) duGroupe.add(orgId);
      for (const ident of candidat.identifiants) {
        const cle = `${ident.type}:${ident.valeurNormalisee}`;
        const porteur = vus.get(cle);
        // Même règle que l'exécution (`ecriture.ts`) : l'identifiant du groupe recopié sur un tiers ne propose rien.
        if (porteur && porteur !== orgId && (estDuGroupe || !duGroupe.has(porteur))) paires.add([porteur, orgId].sort().join("|"));
        else if (!porteur) vus.set(cle, orgId);
      }
    }
  }
  bilan.doublonsProposes = paires.size;
  return bilan;
}
