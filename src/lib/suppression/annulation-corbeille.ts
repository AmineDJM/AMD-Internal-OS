import { prisma, prismaBrut } from "@/lib/prisma";
import { infoModele } from "@/lib/effets/modeles";
import { memeValeur, serialiserLigne } from "@/lib/effets/valeurs";
import { isDeletableKind } from "@/lib/admin-delete-registry";
import { deserialiser, type DetailEffet } from "@/lib/effets/annulation";
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
  // Les lignes du lot, retirées par la mise en corbeille : revenues avec elle. L'instantané de la corbeille les a
  // prises TELLES QU'À LA SUPPRESSION : ce que le même geste leur avait changé juste avant (le poste détaché de son
  // ordre, l'étape remise) est repris sur la valeur d'AVANT le geste, que le journal porte.
  if (restaure) {
    for (const e of geste.effets) {
      if (e.type !== "ECRITURE" || e.operation !== "DELETE") continue;
      traites.add(e.id);
      if (appliquer && e.modele && e.enregistrementId) await reprendreLAvant(e.modele, e.enregistrementId, e.avant);
    }
  }
  return { details, traites };
};

async function reprendreLAvant(modele: string, id: string, avant: unknown): Promise<void> {
  const info = infoModele(modele);
  const a = avant && typeof avant === "object" ? (avant as Record<string, unknown>) : null;
  if (!info?.cle || !a) return;
  const d = (prisma as unknown as Record<string, { findUnique: (x: unknown) => Promise<Record<string, unknown> | null>; update: (x: unknown) => Promise<unknown> }>)[info.delegue];
  const actuelle = serialiserLigne(await d.findUnique({ where: { [info.cle]: id } }), new Set(info.scalaires));
  if (!actuelle) return;
  const data: Record<string, unknown> = {};
  for (const [c, v] of Object.entries(a)) {
    if (info.auto.has(c) || !info.types.has(c) || memeValeur(actuelle[c] ?? null, v ?? null)) continue;
    const x = deserialiser(info, c, v ?? null);
    if (x !== undefined) data[c] = x;
  }
  if (Object.keys(data).length) await d.update({ where: { [info.cle]: id }, data });
}
