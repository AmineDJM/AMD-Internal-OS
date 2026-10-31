import { prisma, prismaBrut } from "@/lib/prisma";
import { isDeletableKind } from "@/lib/admin-delete-registry";
import type { DetailEffet } from "@/lib/effets/annulation";
import type { PolitiqueAnnulation, ResultatMetier } from "@/lib/effets/politiques";
import { restaurerLotDeLaCorbeille } from "./coeur";

/**
 * ANNULER UNE SUPPRESSION RÉVERSIBLE (K10c) — le geste inverse d'une mise en corbeille : le LOT revient (la ligne et
 * ses branches, mêmes identifiants), l'entrée de la corbeille est marquée restaurée. Les suppressions du lot sont
 * alors « traitées » : l'annulation ligne à ligne ne les rejoue pas (elle refuserait, à raison, une ligne supprimée
 * avec des enfants en cascade). Écrit par `prisma` : sous le journal de l'annulation, « rétablir » remet en corbeille.
 */
export const restaurerDepuisLaCorbeille: NonNullable<PolitiqueAnnulation["metier"]> = async ({ geste, appliquer }): Promise<ResultatMetier> => {
  const details: DetailEffet[] = [];
  const traites = new Set<string>();
  const mises = geste.effets.filter((e) => e.type === "ECRITURE" && e.modele === "DeletedRecord" && e.operation === "CREATE" && e.enregistrementId);
  if (!mises.length) return { details, traites };
  let restaure = false;
  for (const e of mises) {
    traites.add(e.id);
    const rec = await prismaBrut.deletedRecord.findUnique({ where: { id: e.enregistrementId! } });
    const quoi = rec ? `« ${rec.name} » mis(e) en corbeille` : "une mise en corbeille";
    if (!rec || rec.restoredAt) { details.push({ effetId: e.id, issue: "SANS_OBJET", quoi, pourquoi: "déjà restauré(e) depuis la corbeille" }); continue; }
    if (rec.purgedAt) { details.push({ effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "détruit(e) définitivement depuis la corbeille", aLaPlace: "recréer l'élément à la main" }); continue; }
    if (!isDeletableKind(rec.kind)) { details.push({ effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "type de corbeille inconnu", aLaPlace: null }); continue; }
    if (appliquer) {
      const r = await restaurerLotDeLaCorbeille(rec, rec.kind);
      if (r && !r.ok) { details.push({ effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: r.error ?? "la restauration a échoué", aLaPlace: "restaurer depuis la corbeille (Administration)" }); continue; }
      if (!r) { details.push({ effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "cette entrée de corbeille n'est pas un lot : elle se restaure depuis l'écran de la corbeille", aLaPlace: "restaurer depuis la corbeille (Administration)" }); continue; }
      await prisma.deletedRecord.update({ where: { id: rec.id }, data: { restoredAt: new Date() } });
    }
    restaure = true;
    details.push({ effetId: e.id, issue: "ANNULE", quoi, pourquoi: "revenu(e) de la corbeille avec ses éléments liés, mêmes identifiants : les liens tiennent de nouveau" });
  }
  // Les lignes du lot, retirées par la mise en corbeille : revenues avec elle.
  if (restaure) for (const e of geste.effets) if (e.type === "ECRITURE" && e.operation === "DELETE") traites.add(e.id);
  return { details, traites };
};
