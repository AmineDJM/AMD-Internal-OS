import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { cleTexteOrganisation } from "./candidats";
import { resoudreFusion } from "./ecriture";
import type { ResultatLigne, SourceDeReprise } from "@/lib/referentiels/reprises/lots";
import { bilanVide, type BilanReprise } from "@/lib/referentiels/reprises/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES AFFILIATIONS PERSONNE ↔ ORGANISATION — posées seulement quand le lien est SÛR, c'est-à-dire porté
 * par l'ERP lui-même, jamais deviné :
 *
 *   Employee           sa société (`companyId`)                       fonction = poste, service = département
 *   MedicalDoctor      son établissement (`institutionId`), à défaut le texte `institution` s'il désigne une
 *                      SEULE organisation vivante (même clé)            service = son service dans l'établissement
 *   CareBeneficiary    le texte `institution`, même règle               fonction = `jobTitle`
 *   SupplierUser       son fournisseur                                   (compte du portail)
 *   DirectoryEntry     le partenaire dont elle est la fiche de contact
 *
 * Il faut les DEUX bouts : la Personne (`personneId`, posée par la reprise des personnes — lot V2-B) et
 * l'Organisation (`organisationId`, reprise `organisations`). Ce lot ne crée AUCUNE personne : une fiche
 * sans `personneId` attend, et la reprise rejouée plus tard la prendra.
 *
 * L'identifiant est déterministe (`aff-<source>-<id de la fiche>`) : rejouer ne double rien, et l'origine
 * d'une affiliation se lit dans son id (`origineAffiliation`) — c'est ce qui décide qui peut la voir.
 * Une affiliation existante n'est jamais réécrite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Tx = Prisma.TransactionClient;

export const ORIGINES_AFFILIATION = {
  emp: "Employee",
  md: "MedicalDoctor",
  cb: "CareBeneficiary",
  su: "SupplierUser",
  de: "DirectoryEntry",
} as const;
export type CodeOrigineAffiliation = keyof typeof ORIGINES_AFFILIATION;

export const idAffiliation = (code: CodeOrigineAffiliation, id: string) => `aff-${code}-${id}`;

/** L'origine d'une affiliation posée par cette reprise (nul : posée autrement). */
export function origineAffiliation(id: string): CodeOrigineAffiliation | null {
  const m = /^aff-([a-z]+)-/.exec(id);
  return m && m[1] in ORIGINES_AFFILIATION ? (m[1] as CodeOrigineAffiliation) : null;
}

/** Ce qu'une fiche dit du lien — `organisationId` nul : l'organisation n'est pas (encore) connue. */
interface Lien {
  id: string;
  personneId: string | null;
  organisationId: string | null;
  fonction?: string | null;
  service?: string | null;
  depuis?: Date | null;
  /** Une seule affiliation PRINCIPALE vivante par personne : seules ces origines y prétendent. */
  principale?: boolean;
}

interface DefinitionAffiliation {
  code: CodeOrigineAffiliation;
  /** Les fiches, par id croissant ; `avecPersonne` : seulement celles dont la personne est connue. */
  lire(apresId: string | null, taille: number | undefined, avecPersonne: boolean): Promise<Lien[]>;
}

const apres = (apresId: string | null) => (apresId ? { id: { gt: apresId } } : {});
const avec = (avecPersonne: boolean) => (avecPersonne ? { personneId: { not: null } } : {});

/** L'organisation d'un texte : la seule organisation vivante de même clé, sinon aucune (jamais créée ici). */
async function organisationDuTexte(texte: string | null): Promise<string | null> {
  const cle = cleTexteOrganisation(texte);
  if (!cle) return null;
  const porteurs = await prisma.organisation.findMany({ where: { nomReplie: cle, fusionneeDansId: null }, select: { id: true }, take: 2 });
  return porteurs.length === 1 ? porteurs[0].id : null;
}

const DEFINITIONS: DefinitionAffiliation[] = [
  {
    code: "emp",
    lire: async (apresId, take, avecPersonne) => (await prisma.employee.findMany({
      where: { ...apres(apresId), ...avec(avecPersonne), companyId: { not: null } }, take, orderBy: { id: "asc" },
      select: { id: true, personneId: true, position: true, department: true, hireDate: true, company: { select: { organisationId: true } } },
    })).map((e) => ({
      id: e.id, personneId: e.personneId, organisationId: e.company?.organisationId ?? null,
      fonction: e.position, service: e.department, depuis: e.hireDate, principale: true,
    })),
  },
  {
    code: "md",
    lire: async (apresId, take, avecPersonne) => {
      const lignes = await prisma.medicalDoctor.findMany({
        where: { ...apres(apresId), ...avec(avecPersonne), OR: [{ institutionId: { not: null } }, { institution: { not: null } }] },
        take, orderBy: { id: "asc" },
        select: {
          id: true, personneId: true, institution: true,
          institutionRef: { select: { organisationId: true } }, serviceRef: { select: { name: true } },
        },
      });
      return Promise.all(lignes.map(async (d) => ({
        id: d.id, personneId: d.personneId,
        organisationId: d.institutionRef ? d.institutionRef.organisationId : await organisationDuTexte(d.institution),
        service: d.serviceRef?.name ?? null, principale: true,
      })));
    },
  },
  {
    code: "cb",
    lire: async (apresId, take, avecPersonne) => {
      const lignes = await prisma.careBeneficiary.findMany({
        where: { ...apres(apresId), ...avec(avecPersonne), institution: { not: null } }, take, orderBy: { id: "asc" },
        select: { id: true, personneId: true, institution: true, jobTitle: true },
      });
      return Promise.all(lignes.map(async (b) => ({
        id: b.id, personneId: b.personneId, organisationId: await organisationDuTexte(b.institution), fonction: b.jobTitle,
      })));
    },
  },
  {
    code: "su",
    lire: async (apresId, take, avecPersonne) => (await prisma.supplierUser.findMany({
      where: { ...apres(apresId), ...avec(avecPersonne) }, take, orderBy: { id: "asc" },
      select: { id: true, personneId: true, supplier: { select: { organisationId: true } } },
    })).map((u) => ({ id: u.id, personneId: u.personneId, organisationId: u.supplier.organisationId })),
  },
  {
    code: "de",
    lire: async (apresId, take, avecPersonne) => (await prisma.directoryEntry.findMany({
      where: { ...apres(apresId), ...avec(avecPersonne), contactId: { not: null } }, take, orderBy: { id: "asc" },
      select: { id: true, personneId: true, jobTitle: true, contact: { select: { organisationId: true } } },
    })).map((e) => ({ id: e.id, personneId: e.personneId, organisationId: e.contact?.organisationId ?? null, fonction: e.jobTitle })),
  },
];

async function poser(tx: Tx, code: CodeOrigineAffiliation, l: Lien, acteurId: string | null): Promise<ResultatLigne> {
  if (!l.personneId || !l.organisationId) return { issue: "IGNOREE" };
  const id = idAffiliation(code, l.id);
  if (await tx.affiliation.findUnique({ where: { id }, select: { id: true } })) return { issue: "IGNOREE" };
  const organisationId = await resoudreFusion(tx, l.organisationId);
  const principale = !!l.principale
    && !(await tx.affiliation.findFirst({ where: { personneId: l.personneId, principale: true, jusquA: null }, select: { id: true } }));
  await tx.affiliation.create({
    data: {
      id, personneId: l.personneId, organisationId, fonction: l.fonction ?? null, service: l.service ?? null,
      depuis: l.depuis ?? null, principale, creeParId: acteurId,
    },
  });
  return { issue: "CREEE" };
}

export function sourcesDesAffiliations(acteurId: string | null): SourceDeReprise[] {
  return DEFINITIONS.map((def) => ({
    nom: ORIGINES_AFFILIATION[def.code],
    lire: (apresId: string | null, taille: number) => def.lire(apresId, taille, true),
    traiter: (l: Lien) => prisma.$transaction((tx) => poser(tx, def.code, l, acteurId)),
  }));
}

/**
 * L'APERÇU, À BLANC : les fiches qui portent un lien, et celles dont l'affiliation serait créée. Les autres
 * sont « ignorées » : déjà affiliées, ou en attente d'un des deux bouts (personne pas encore reprise,
 * organisation inconnue) — la reprise rejouée plus tard les prendra.
 */
export async function apercuDesAffiliations(): Promise<BilanReprise> {
  const bilan = bilanVide();
  for (const def of DEFINITIONS) {
    const liens = await def.lire(null, undefined, false);
    const ids = liens.map((l) => idAffiliation(def.code, l.id));
    const deja = new Set((await prisma.affiliation.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((a) => a.id));
    for (const l of liens) {
      bilan.lues++;
      if (deja.has(idAffiliation(def.code, l.id)) || !l.personneId || !l.organisationId) bilan.ignorees++;
      else bilan.creees++;
    }
  }
  return bilan;
}
