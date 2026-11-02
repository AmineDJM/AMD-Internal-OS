import { prisma } from "@/lib/prisma";
import { ordreDeRevue } from "../domaine/revue";

/**
 * LES LECTURES DES ÉCRANS DU RÉFÉRENTIEL — une page lit par la porte du module, jamais par Prisma
 * (rapport d'audit 08, ARCH-02 : « une page lit par `api.ts` »). La page garde les droits et rend ;
 * ce fichier sait quelles lignes elle montre.
 */

const vivantesPersonnes = { personneA: { fusionneeDansId: null }, personneB: { fusionneeDansId: null } };
const vivantesOrganisations = { organisationA: { fusionneeDansId: null }, organisationB: { fusionneeDansId: null } };

const SELECTION_PERSONNE = {
  id: true, nom: true, prenoms: true, civilite: true, fusionneeDansId: true,
  roles: { where: { jusquA: null }, select: { role: true } },
  _count: { select: { users: true, employees: true, medicalDoctors: true, careBeneficiaries: true, adProVoyageurs: true, adProHebergements: true, recruitmentCandidates: true, directoryEntries: true, supplierUsers: true } },
} as const;

/** `/personnes/doublons` : les paires proposées (dans l'ordre de revue) et les dernières fusions, à défaire au besoin. */
export async function doublonsPersonnesARevoir() {
  const [proposes, fusions] = await Promise.all([
    prisma.doublonPersonne.findMany({
      where: { statut: "PROPOSE", ...vivantesPersonnes },
      orderBy: { score: "desc" }, take: 300,
      select: { id: true, niveau: true, score: true, raisons: true, reserves: true, personneA: { select: SELECTION_PERSONNE }, personneB: { select: SELECTION_PERSONNE } },
    }),
    prisma.doublonPersonne.findMany({
      where: { statut: "FUSIONNE" }, orderBy: { decideLe: "desc" }, take: 20,
      select: { id: true, gardeeId: true, decideLe: true, deplacees: true, personneA: { select: { id: true, nom: true, prenoms: true } }, personneB: { select: { id: true, nom: true, prenoms: true } } },
    }),
  ]);
  return { proposes: ordreDeRevue(proposes), fusions };
}

const SELECTION_ORGANISATION = {
  select: { id: true, raisonSociale: true, roles: { select: { role: true } }, identifiants: { select: { type: true, valeur: true } } },
} as const;

/** `/admin/refonte-donnees/organisations` : les `affichees` premières paires dans l'ordre de revue, leur total, les fusions récentes. */
export async function doublonsOrganisationsARevoir(affichees: number) {
  const [propositions, total, fusions] = await Promise.all([
    prisma.propositionDoublonOrganisation.findMany({
      where: { statut: "PROPOSEE", ...vivantesOrganisations }, take: 2000,
      select: { id: true, niveau: true, score: true, raisons: true, reserves: true, organisationA: SELECTION_ORGANISATION, organisationB: SELECTION_ORGANISATION },
    }),
    prisma.propositionDoublonOrganisation.count({ where: { statut: "PROPOSEE", ...vivantesOrganisations } }),
    prisma.organisation.findMany({
      where: { fusionneeDansId: { not: null } }, orderBy: { updatedAt: "desc" }, take: 30,
      select: { id: true, raisonSociale: true, fusionneeDans: { select: { id: true, raisonSociale: true } } },
    }),
  ]);
  return { propositions: ordreDeRevue(propositions).slice(0, affichees), total, fusions };
}

/** `/admin/refonte-donnees` : l'état du référentiel en quatre chiffres. */
export async function etatDuReferentiel() {
  const [doublonsOrganisations, reglages, personnes, doublonsPersonnes] = await Promise.all([
    prisma.propositionDoublonOrganisation.count({ where: { statut: "PROPOSEE", ...vivantesOrganisations } }),
    prisma.appSetting.findUnique({ where: { id: "global" }, select: { refontePersonnesDoubleEcriture: true } }),
    prisma.personne.count({ where: { fusionneeDansId: null } }),
    prisma.doublonPersonne.count({ where: { statut: "PROPOSE" } }),
  ]);
  return { doublonsOrganisations, doubleEcriturePersonnes: reglages?.refontePersonnesDoubleEcriture === true, personnes, doublonsPersonnes };
}
