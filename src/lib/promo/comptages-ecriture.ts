import { prisma } from "@/lib/prisma";
import { companyScopedWhere } from "@/lib/company";
import { corrigerAuCompte, soldeDe, sousVerrous } from "@/lib/promo/stock-ecriture";
import { partitionComptage, type ArticleAComptabiliser, type LigneSaisie } from "@/lib/promo/comptages";
import { libelleArticleStock } from "@/lib/promo/stock";
import type { PromoFamille } from "@/lib/promo/catalogue";
import { arrondirAuMillieme } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ENREGISTRER UN COMPTAGE — sous le verrou de chaque article compté (§118.168).
 *
 * Trois propriétés, et chacune a son cas dans le banc :
 *
 *   • L'ÉCART SE LIT SOUS LE VERROU, au moment de la saisie : une visite faite entre la demande et
 *     la saisie a déjà retiré ses fiches ; la compter comme un manquant les retirerait deux fois.
 *   • TOUT OU RIEN : la ligne d'un article dont la correction échoue annule la saisie entière. Un
 *     comptage à moitié appliqué dirait « compté » sur un registre resté à moitié faux.
 *   • UNE SEULE FOIS : le comptage passe SAISI par une écriture conditionnelle prise AVANT toute
 *     correction, dans la même transaction. Deux envois simultanés de la même saisie (double clic,
 *     deux onglets) verrouillent les mêmes articles dans le même ordre : le second attend, puis
 *     trouve le comptage déjà saisi, et n'écrit rien.
 *
 * Les mouvements passent par l'écrivain unique (`corrigerAuCompte`) : ce module n'en crée aucun.
 * Serveur seulement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

class RefusComptage extends Error {}

export interface LigneEnregistree {
  itemId: string;
  libelle: string;
  attendu: number;
  compte: number;
  ecart: number;
}

/**
 * LES ARTICLES QUE CE DÉTENTEUR DOIT COMPTER, et ceux qu'il peut ajouter — dans le périmètre
 * d'entité de celui qui SAISIT (le même que son écran), avec les soldes EN BASE. L'appelant les
 * passe à `lireSaisieComptage` ; la règle de partition est la même que celle du formulaire.
 */
export async function articlesDuComptage(saisieParId: string, holderId: string | null, famille: PromoFamille | null) {
  const items = await prisma.promoStockItem.findMany({
    where: await companyScopedWhere(saisieParId, {}),
    select: {
      id: true, isActive: true,
      catalogue: { select: { nom: true, famille: true } },
      produits: { select: { product: { select: { canonicalName: true } } } },
    },
  });
  const ids = items.map((i) => i.id);
  const sommes = ids.length
    ? await prisma.promoStockMovement.groupBy({ by: ["itemId"], where: { itemId: { in: ids }, holderId }, _sum: { delta: true } })
    : [];
  const solde = new Map(sommes.map((s) => [s.itemId, arrondirAuMillieme(Number(s._sum.delta ?? 0))]));
  const articles: ArticleAComptabiliser[] = items.map((i) => ({
    itemId: i.id, famille: i.catalogue.famille, actif: i.isActive, solde: solde.get(i.id) ?? 0,
  }));
  const libelles = new Map(items.map((i) => [i.id, libelleArticleStock(i.catalogue.nom, i.produits.map((p) => p.product.canonicalName))]));
  return { ...partitionComptage(articles, famille), libelles };
}

export async function enregistrerSaisieComptage(c: {
  comptageId: string;
  holderId: string | null;
  lignes: readonly LigneSaisie[];
  libelles: ReadonlyMap<string, string>;
  auteurId: string;
  motif: string;
  maintenant: Date;
}): Promise<{ ok: true; lignes: LigneEnregistree[] } | { ok: false; refus: string }> {
  try {
    const lignes = await sousVerrous(c.lignes.map((l) => l.itemId), async (tx, verrouilles) => {
      for (const l of c.lignes) {
        if (!verrouilles.has(l.itemId)) throw new RefusComptage("Un des articles comptés vient d'être supprimé : rechargez la page avant de saisir.");
      }
      // LA PRISE, AVANT TOUTE CORRECTION : c'est elle qui rend la saisie unique.
      const pris = await tx.promoStockComptage.updateMany({
        where: { id: c.comptageId, statut: "DEMANDE" },
        data: { statut: "SAISI", saisiLe: c.maintenant, saisiParId: c.auteurId },
      });
      if (pris.count === 0) throw new RefusComptage("Ce comptage n'est plus à faire : il vient d'être saisi ou annulé.");
      const resultat: LigneEnregistree[] = [];
      for (const l of c.lignes) {
        const attendu = await soldeDe(tx, l.itemId, c.holderId);
        const ecart = arrondirAuMillieme(l.compte - attendu);
        if (ecart !== 0) {
          const r = await corrigerAuCompte(tx, l.itemId, {
            holderId: c.holderId, compte: l.compte, motif: c.motif, auteurId: c.auteurId, maintenant: c.maintenant,
            comptageId: c.comptageId,
          });
          if (!r.ok) throw new RefusComptage(`« ${c.libelles.get(l.itemId) ?? "Article"} » : ${r.refus}`);
        }
        await tx.promoStockComptageLigne.create({
          data: { comptageId: c.comptageId, itemId: l.itemId, attendu, compte: l.compte, ecart },
        });
        resultat.push({ itemId: l.itemId, libelle: c.libelles.get(l.itemId) ?? "Article", attendu, compte: l.compte, ecart });
      }
      return resultat;
    });
    return { ok: true, lignes };
  } catch (e) {
    if (e instanceof RefusComptage) return { ok: false, refus: e.message };
    throw e;
  }
}

export interface LigneCorrigee {
  itemId: string;
  libelle: string;
  avant: number;
  apres: number;
}

/**
 * CORRIGER UN COMPTAGE SAISI (audit 360°, lot C4b, R19) — par contre-correction, jamais en réécrivant
 * l'histoire.
 *
 * « 40 » tapé pour « 14 » : la seule issue était d'annuler le comptage puis d'en redemander un, et
 * l'écart faux restait au registre entre les deux. La correction porte sur ce qui a été COMPTÉ, pas
 * sur le solde : l'écart entre le nouveau compte et l'ancien s'applique au solde ACTUEL — des sorties
 * ont pu avoir lieu depuis la saisie, et elles restent vraies. Chaque mouvement porte le comptage et
 * le motif ; la ligne du comptage dit le nouveau compte et son écart.
 *
 * Un comptage PLUS RÉCENT du même détenteur qui a recompté l'article fait foi : corriger l'ancien
 * effacerait une vérité constatée après lui. Refusé, en le nommant — et lu SOUS le verrou des
 * articles, que la saisie d'un comptage prend aussi : une saisie qui passerait entre la question et
 * la correction serait sinon effacée par elle.
 *
 * Tout ou rien, sous le verrou de chaque article. La ligne est relue sous ce verrou, donc deux
 * corrections croisées s'appliquent l'une APRÈS l'autre, la seconde à partir de ce que la première a
 * écrit — jamais deux fois le même écart.
 */
export async function corrigerSaisieComptage(c: {
  comptageId: string;
  holderId: string | null;
  saisiLe: Date;
  corrections: readonly { itemId: string; compte: number }[];
  libelles: ReadonlyMap<string, string>;
  auteurId: string;
  /** La raison telle que la personne l'a écrite : la fiche la montre, le registre la préfixe. */
  motif: string;
  maintenant: Date;
}): Promise<{ ok: true; lignes: LigneCorrigee[] } | { ok: false; refus: string }> {
  const ids = c.corrections.map((l) => l.itemId);
  try {
    const lignes = await sousVerrous(ids, async (tx, verrouilles) => {
      const plusRecent = await tx.promoStockComptageLigne.findFirst({
        where: { itemId: { in: ids }, comptageId: { not: c.comptageId }, comptage: { holderId: c.holderId, statut: "SAISI", saisiLe: { gt: c.saisiLe } } },
        select: { itemId: true, comptage: { select: { saisiLe: true } } },
        orderBy: { comptage: { saisiLe: "desc" } },
      });
      if (plusRecent) {
        const jour = plusRecent.comptage.saisiLe ? plusRecent.comptage.saisiLe.toLocaleDateString("fr-FR") : "depuis";
        throw new RefusComptage(`« ${c.libelles.get(plusRecent.itemId) ?? "Article"} » a été recompté le ${jour} : c'est ce comptage plus récent qui fait foi — corrigez-le plutôt que celui-ci.`);
      }
      const resultat: LigneCorrigee[] = [];
      for (const l of c.corrections) {
        const libelle = c.libelles.get(l.itemId) ?? "Article";
        if (!verrouilles.has(l.itemId)) throw new RefusComptage(`« ${libelle} » vient d'être supprimé : rechargez la page.`);
        const ligne = await tx.promoStockComptageLigne.findUnique({
          where: { comptageId_itemId: { comptageId: c.comptageId, itemId: l.itemId } },
          select: { id: true, compte: true, ecart: true },
        });
        if (!ligne) throw new RefusComptage(`« ${libelle} » ne faisait pas partie de ce comptage.`);
        const avant = arrondirAuMillieme(Number(ligne.compte));
        const delta = arrondirAuMillieme(l.compte - avant);
        if (delta === 0) continue;
        const solde = await soldeDe(tx, l.itemId, c.holderId);
        const cible = arrondirAuMillieme(solde + delta);
        if (cible < 0) {
          throw new RefusComptage(`« ${libelle} » : la correction ferait passer le solde sous zéro (${solde} en main aujourd'hui, ${-delta} à retirer) — des sorties ont eu lieu depuis le comptage.`);
        }
        const r = await corrigerAuCompte(tx, l.itemId, {
          holderId: c.holderId, compte: cible, motif: `Correction du comptage — ${c.motif}`, auteurId: c.auteurId, maintenant: c.maintenant, comptageId: c.comptageId,
        });
        if (!r.ok) throw new RefusComptage(`« ${libelle} » : ${r.refus}`);
        await tx.promoStockComptageLigne.update({
          where: { id: ligne.id },
          data: { compte: l.compte, ecart: arrondirAuMillieme(Number(ligne.ecart) + delta) },
        });
        resultat.push({ itemId: l.itemId, libelle, avant, apres: l.compte });
      }
      if (resultat.length === 0) throw new RefusComptage("Rien à corriger : les nombres saisis sont ceux du comptage.");
      await tx.promoStockComptage.update({
        where: { id: c.comptageId },
        data: { corrigeLe: c.maintenant, corrigeParId: c.auteurId, corrigeMotif: c.motif },
      });
      return resultat;
    });
    return { ok: true, lignes };
  } catch (e) {
    if (e instanceof RefusComptage) return { ok: false, refus: e.message };
    throw e;
  }
}
