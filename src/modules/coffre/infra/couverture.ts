import { prisma } from "@/lib/prisma";
import { CHAMPS_SENSIBLES, type ChampSensible } from "../domaine/champs";

/**
 * LA COUVERTURE DU COFFRE (refonte V2-E) — par colonne sensible : combien de lignes la portent en clair,
 * combien ont une copie COURANTE au coffre, combien de copies sont rattachées à leur fiche du référentiel.
 * C'est ce que le Super Admin regarde avant d'ouvrir la double lecture, et la condition d'entrée du
 * palier P5 (« en clair = copiées »). Compte seulement : aucune valeur n'est lue.
 */

export interface CouvertureChamp {
  champ: ChampSensible;
  enClair: number;
  copiees: number;
  rattachees: number;
}

function enClair(c: ChampSensible): Promise<number> {
  const salaire = c.natures.includes("SALAIRE");
  const where = { [c.champ]: salaire ? { gt: 0 } : { not: null } };
  if (c.modele === "Employee") return prisma.employee.count({ where });
  if (c.modele === "CompanyContact") return prisma.companyContact.count({ where });
  return prisma.companyLegalIdentity.count({ where });
}

export async function couvertureDuCoffre(): Promise<CouvertureChamp[]> {
  const groupes = await prisma.donneeSensible.groupBy({
    by: ["origineModele", "origineChamp"],
    where: { remplaceeLe: null, origineId: { not: null } },
    _count: { _all: true, titulaireId: true },
  });
  const cle = (m: string | null, c: string | null) => `${m}.${c}`;
  const parChamp = new Map(groupes.map((g) => [cle(g.origineModele, g.origineChamp), g._count]));
  return Promise.all(CHAMPS_SENSIBLES.map(async (c) => {
    const n = parChamp.get(cle(c.modele, c.champ));
    return { champ: c, enClair: await enClair(c), copiees: n?._all ?? 0, rattachees: n?.titulaireId ?? 0 };
  }));
}
