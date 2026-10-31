import { prisma, prismaBrut } from "@/lib/prisma";
import type { DetailEffet } from "@/lib/effets/annulation";
import type { PolitiqueAnnulation, ResultatMetier } from "@/lib/effets/politiques";

type Metier = NonNullable<PolitiqueAnnulation["metier"]>;

/**
 * L'INDEX DE LA BIBLIOTHÈQUE, DÉFAIT AVEC LE DÉPÔT (K10c) — une pièce déposée sur un endroit (le poste d'une fiche de
 * voyage) y gagne une CLÉ d'accès (`BibliothequeFiche.cles`, « AD_PRO_ITEM:<id> »), posée par une écriture SQL
 * (`bibliotheque/infra/inscription.ts`, `ajouterCleALaFiche`) que le journal ne détaille pas. Les octets étant
 * partagés par empreinte, la fiche de la pièce existe souvent déjà : la retirer serait faux. Le geste inverse retire
 * la CLÉ que le geste a ajoutée — celle de chaque lien `PieceLien` né du même geste (et retiré par l'annulation) —,
 * sauf si un autre lien désigne encore la pièce à cet endroit. Écrit par `prisma` : « rétablir » la remet.
 */
export const indexBibliotheque: Metier = async ({ geste, appliquer }): Promise<ResultatMetier> => {
  const details: DetailEffet[] = [];
  const traites = new Set<string>();
  const sqls = geste.effets.filter((e) => e.type === "ECRITURE" && e.operation === "SQL" && e.modele === "BibliothequeFiche");
  if (!sqls.length) return { details, traites };
  const nes = geste.effets.filter((e) => e.type === "ECRITURE" && e.operation === "CREATE" && e.modele === "PieceLien" && e.apres && e.enregistrementId);
  const idsNes = new Set(nes.map((e) => e.enregistrementId!));
  const aRetirer = new Map<string, Set<string>>();
  for (const e of nes) {
    const l = e.apres as Record<string, unknown>;
    if (l.sujetType !== "ENTITE" || typeof l.entityType !== "string" || typeof l.pieceId !== "string") continue;
    const autres = await prismaBrut.pieceLien.count({ where: { pieceId: l.pieceId, sujetType: "ENTITE", sujetId: String(l.sujetId), entityType: l.entityType, id: { notIn: [...idsNes] } } });
    if (!autres) (aRetirer.get(l.pieceId) ?? aRetirer.set(l.pieceId, new Set()).get(l.pieceId)!).add(`${l.entityType}:${String(l.sujetId)}`);
  }
  const retirees: string[] = [];
  for (const [pieceId, cles] of aRetirer) {
    const f = await prismaBrut.bibliothequeFiche.findUnique({ where: { pieceId }, select: { cles: true } });
    const restantes = (f?.cles ?? []).filter((c) => !cles.has(c));
    if (!f || restantes.length === f.cles.length) continue;
    if (appliquer) {
      const familles = [...new Set(restantes.map((c) => c.slice(0, c.indexOf(":"))))].sort();
      await prisma.bibliothequeFiche.update({ where: { pieceId }, data: { cles: restantes, familles } });
    }
    retirees.push(...[...cles].filter((c) => f.cles.includes(c)));
  }
  sqls.forEach((e, i) => {
    traites.add(e.id);
    details.push(i === 0 && retirees.length
      ? { effetId: e.id, issue: "ANNULE", quoi: "l'index de la bibliothèque", pourquoi: `la pièce n'est plus désignée à cet endroit (${retirees.join(", ")}) : sa clé d'accès est retirée de l'index ; la pièce elle-même reste dans la bibliothèque si d'autres endroits la désignent` }
      : { effetId: e.id, issue: "SANS_OBJET", quoi: "l'index de la bibliothèque", pourquoi: retirees.length ? "même index, défait ci-dessus" : "la pièce était déjà indexée à cet endroit avant le geste : rien à retirer" });
  });
  return { details, traites };
};
