import type { Prisma } from "@prisma/client";
import type { CandidatOrganisation } from "./candidats";
import type { ComparaisonDoublon, NiveauDoublon } from "../doublons";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ÉCRIRE UNE ORGANISATION — le seul endroit où la reprise ET la double écriture créent une ligne du
 * référentiel R2 (`docs/architecture/refonte-p3-inventaire.md` §5.1 : « la double écriture et la reprise
 * partagent le même code de rapprochement »).
 *
 *   • L'organisation a un identifiant DÉTERMINISTE : rejouer ne crée rien de plus. Une ligne qui existe déjà
 *     n'est pas réécrite — une correction humaine faite depuis sur la fiche Organisation n'est jamais écrasée.
 *   • Ses identifiants (NIF, NIS, RC, AI) sont UNIQUES par (type, valeur normalisée). Si l'identifiant est
 *     déjà porté par une AUTRE organisation, il n'est pas recopié : une PROPOSITION de doublon « certain »
 *     relie les deux, et une personne tranche. Rien n'est fusionné d'office. Exception : l'identifiant d'une
 *     société du groupe recopié sur un tiers n'est ni recopié ni proposé — il ne désigne pas ce tiers.
 *   • Une organisation fusionnée désigne sa survivante (`fusionneeDansId`) : on suit la chaîne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Tx = Prisma.TransactionClient;

export interface OrganisationAssuree {
  /** L'organisation à rattacher (la survivante, si celle de la fiche a été fusionnée). */
  organisationId: string;
  creee: boolean;
  doublons: number;
}

/** La survivante d'une organisation fusionnée (chaîne suivie, boucle impossible mais bornée). */
export async function resoudreFusion(tx: Tx, id: string): Promise<string> {
  let courant = id;
  for (let i = 0; i < 20; i++) {
    const o = await tx.organisation.findUnique({ where: { id: courant }, select: { fusionneeDansId: true } });
    if (!o?.fusionneeDansId) return courant;
    courant = o.fusionneeDansId;
  }
  return courant;
}

/**
 * PROPOSER QUE DEUX ORGANISATIONS SOIENT LA MÊME. Paire ordonnée, une seule ligne par paire ; une proposition
 * déjà TRANCHÉE (écartée, fusionnée) n'est pas rouverte. Rend vrai si une proposition nouvelle est née.
 */
export async function proposerDoublon(
  tx: Tx, x: string, y: string, c: Pick<ComparaisonDoublon, "score" | "raisons" | "reserves"> & { niveau: NiveauDoublon },
): Promise<boolean> {
  if (x === y) return false;
  const [a, b] = x < y ? [x, y] : [y, x];
  const cle = { organisationAId_organisationBId: { organisationAId: a, organisationBId: b } };
  const existante = await tx.propositionDoublonOrganisation.findUnique({ where: cle, select: { statut: true } });
  const donnees = { niveau: c.niveau, score: c.score, raisons: c.raisons, reserves: c.reserves };
  if (existante) {
    if (existante.statut === "PROPOSEE") await tx.propositionDoublonOrganisation.update({ where: cle, data: donnees });
    return false;
  }
  await tx.propositionDoublonOrganisation.create({ data: { organisationAId: a, organisationBId: b, ...donnees } });
  return true;
}

/** ASSURER L'ORGANISATION `id` décrite par `candidat` : la créer si elle manque, poser ses rôles et ses identifiants. */
export async function assurerOrganisation(
  tx: Tx, id: string, candidat: CandidatOrganisation, acteurId: string | null,
): Promise<OrganisationAssuree> {
  const existante = await tx.organisation.findUnique({ where: { id }, select: { id: true } });
  if (!existante) {
    await tx.organisation.create({
      data: {
        id,
        raisonSociale: candidat.raisonSociale,
        nomCourt: candidat.nomCourt,
        nomReplie: candidat.nomReplie,
        formeJuridique: candidat.formeJuridique,
        siteWeb: candidat.siteWeb,
        pays: candidat.pays,
        creeParId: acteurId,
      },
    });
  }
  const organisationId = await resoudreFusion(tx, id);

  if (candidat.roles.length) {
    await tx.organisationRole.createMany({
      data: candidat.roles.map((role) => ({ organisationId, role, creeParId: acteurId })),
      skipDuplicates: true,
    });
  }

  let doublons = 0;
  for (const ident of candidat.identifiants) {
    const cle = { type_valeurNormalisee: { type: ident.type, valeurNormalisee: ident.valeurNormalisee } };
    // Lu puis écrit dans la même transaction. Deux écritures concurrentes du même identifiant : la seconde viole
    // l'unicité, sa transaction est annulée et la ligne est dite en erreur — le lot suivant la reprend proprement.
    const porteur = await tx.organisationIdentifiant.findUnique({ where: cle, select: { organisationId: true } });
    if (!porteur) {
      await tx.organisationIdentifiant.create({ data: { organisationId, ...ident, creeParId: acteurId } });
      continue;
    }
    const autre = await resoudreFusion(tx, porteur.organisationId);
    if (autre === organisationId) continue;
    // L'identifiant d'une société du GROUPE recopié sur un tiers (le client d'une pièce pris pour son émetteur) ne
    // désigne pas ce tiers : il n'est ni recopié ni proposé (`referentiels/doublons.ts`, faux positifs connus).
    if (!candidat.roles.includes("SOCIETE_DU_GROUPE")
      && await tx.organisationRole.findUnique({ where: { organisationId_role: { organisationId: autre, role: "SOCIETE_DU_GROUPE" } }, select: { id: true } })) continue;
    const nouvelle = await proposerDoublon(tx, organisationId, autre, {
      niveau: "CERTAIN", score: 95, raisons: [`même ${ident.type} (${ident.valeur})`],
      reserves: ["l'identifiant reste sur la première fiche tant qu'une personne n'a pas tranché"],
    });
    if (nouvelle) doublons++;
  }

  return { organisationId, creee: !existante, doublons };
}
