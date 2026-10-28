import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { candidatDeTexte, cleTexteOrganisation, idOrganisationDeTexte } from "./candidats";
import { assurerOrganisation } from "./ecriture";
import type { ResultatLigne, SourceDeReprise } from "@/lib/referentiels/reprises/lots";
import { bilanVide, type BilanReprise } from "@/lib/referentiels/reprises/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES TEXTES « INSTITUTION » DES DEMANDES — `SponsoringRequest.institution` (« institution / service /
 * association ») et `CongressNational.hostInstitution` (« hôpital / association ») —, rattachés à une
 * Organisation (`docs/architecture/refonte-p3-inventaire.md` §2.6).
 *
 * Le texte RESTE tel qu'il a été saisi : on pose seulement `organisationId` à côté. La règle :
 *   • un texte qui ne désigne personne (vide, « néant », « CHU » seul) → laissé sans lien ;
 *   • une seule organisation vivante porte la même clé (`cleOrganisation`) → rattaché à elle ;
 *   • plusieurs → laissé sans lien : on ne choisit pas entre deux homonymes ;
 *   • aucune → une organisation naît du texte (identifiant déterministe par clé : deux demandes qui écrivent
 *     « Sté Algérienne de Cardiologie » et « Société algérienne de cardiologie » partagent la même).
 * Les ressemblances moins sûres (« SAC » / « Société algérienne de cardiologie ») ne lient rien : elles
 * deviennent des PROPOSITIONS de doublons (reprise `organisations-doublons`).
 *
 * `MedicalDoctor.institution` et `CareBeneficiary.institution` ne portent pas d'`organisationId` : leur
 * lien est l'`Affiliation` de la personne (reprise `organisations-affiliations`). `CongressInternational`
 * n'a pas de texte d'organisation, `Event.organizer` pas de colonne de lien : hors de ce lot.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Tx = Prisma.TransactionClient;

interface LigneTexte { id: string; texte: string | null }

interface DefinitionTexte {
  modele: "SponsoringRequest" | "CongressNational";
  lire(where: { id?: { gt?: string; in?: string[] }; organisationId: null }, take?: number): Promise<LigneTexte[]>;
  compter(where: { id?: { in: string[] } }): Promise<number>;
  lier(tx: Tx, id: string, organisationId: string): Promise<unknown>;
}

const sponsoring: DefinitionTexte = {
  modele: "SponsoringRequest",
  lire: async (where, take) => (await prisma.sponsoringRequest.findMany({
    where, take, orderBy: { id: "asc" }, select: { id: true, institution: true },
  })).map((r) => ({ id: r.id, texte: r.institution })),
  compter: (where) => prisma.sponsoringRequest.count({ where }),
  lier: (tx, id, organisationId) => tx.sponsoringRequest.update({ where: { id }, data: { organisationId } }),
};

const congresNational: DefinitionTexte = {
  modele: "CongressNational",
  lire: async (where, take) => (await prisma.congressNational.findMany({
    where, take, orderBy: { id: "asc" }, select: { id: true, hostInstitution: true },
  })).map((r) => ({ id: r.id, texte: r.hostInstitution })),
  compter: (where) => prisma.congressNational.count({ where }),
  lier: (tx, id, organisationId) => tx.congressNational.update({ where: { id }, data: { organisationId } }),
};

const DEFINITIONS = [sponsoring, congresNational] as const;

/** Restreindre aux demandes nommées, par modèle (bancs d'essai) ; absent : toutes. */
export type PorteeTextes = Partial<Record<"SponsoringRequest" | "CongressNational", string[]>>;

/** Les organisations VIVANTES (non fusionnées) qui portent une clé — au plus deux : au-delà, c'est ambigu de toute façon. */
async function porteursDeCle(tx: Tx, cle: string): Promise<string[]> {
  return (await tx.organisation.findMany({
    where: { nomReplie: cle, fusionneeDansId: null }, select: { id: true }, take: 2, orderBy: { createdAt: "asc" },
  })).map((o) => o.id);
}

/** LE RATTACHEMENT D'UN TEXTE : l'issue, et l'organisation à poser sur la demande (nulle : la demande reste sans lien). */
export async function rattacherTexte(
  tx: Tx, texte: string | null, acteurId: string | null,
): Promise<{ issue: ResultatLigne["issue"]; organisationId: string | null }> {
  const cle = cleTexteOrganisation(texte);
  if (!cle || !texte) return { issue: "IGNOREE", organisationId: null };
  const porteurs = await porteursDeCle(tx, cle);
  if (porteurs.length > 1) return { issue: "IGNOREE", organisationId: null };
  if (porteurs.length === 1) return { issue: "LIEE", organisationId: porteurs[0] };
  const r = await assurerOrganisation(tx, idOrganisationDeTexte(cle), candidatDeTexte(texte), acteurId);
  return { issue: r.creee ? "CREEE" : "LIEE", organisationId: r.organisationId };
}

export function sourcesDesTextes(acteurId: string | null, portee?: PorteeTextes): SourceDeReprise[] {
  return DEFINITIONS.map((def) => ({
    nom: def.modele,
    lire: (apresId: string | null, taille: number) => {
      const ids = portee ? { in: portee[def.modele] ?? [] } : {};
      return def.lire({ id: { ...(apresId ? { gt: apresId } : {}), ...ids }, organisationId: null }, taille);
    },
    traiter: async (ligne: LigneTexte): Promise<ResultatLigne> => prisma.$transaction(async (tx) => {
      const r = await rattacherTexte(tx, ligne.texte, acteurId);
      if (r.organisationId) await def.lier(tx, ligne.id, r.organisationId);
      return { issue: r.issue };
    }),
  }));
}

/**
 * L'APERÇU, À BLANC : les demandes sans lien, et pour chacune ce qui arriverait — rattachée à une organisation
 * existante, rattachée à une organisation née de son texte (une par clé distincte), ou laissée sans lien.
 */
export async function apercuDesTextes(portee?: PorteeTextes): Promise<BilanReprise> {
  const bilan = bilanVide();
  const cles = new Map<string, number>();
  for (const def of DEFINITIONS) {
    const where = portee ? { id: { in: portee[def.modele] ?? [] } } : {};
    const [total, lignes] = await Promise.all([def.compter(where), def.lire({ ...where, organisationId: null })]);
    bilan.lues += total;
    bilan.ignorees += total - lignes.length;
    for (const l of lignes) {
      const cle = cleTexteOrganisation(l.texte);
      if (!cle) { bilan.ignorees++; continue; }
      cles.set(cle, (cles.get(cle) ?? 0) + 1);
    }
  }
  const connues = await prisma.organisation.groupBy({
    by: ["nomReplie"], where: { nomReplie: { in: [...cles.keys()] }, fusionneeDansId: null }, _count: { _all: true },
  });
  const porteurs = new Map(connues.map((c) => [c.nomReplie, c._count._all]));
  for (const [cle, n] of cles) {
    const p = porteurs.get(cle) ?? 0;
    if (p > 1) bilan.ignorees += n;
    else if (p === 1) bilan.liees += n;
    else { bilan.creees++; bilan.liees += n - 1; }
  }
  return bilan;
}
