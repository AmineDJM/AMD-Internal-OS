"use server";

import { CHEMIN_STOCK_PROMO, lienStockPromo } from "@/lib/chemins/stock-promo";
import { revalidatePath } from "next/cache";
import type { AdProItemStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { notifyUser } from "@/lib/notify";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { rendreAuMagasin, sousVerrous } from "@/lib/promo/stock-ecriture";
import { lireConfirmation, peutConfirmerMateriel, REFUS_CONFIRMATION_MATERIEL, type Confirmation } from "@/lib/promo/reservations";
import { libelleArticleStock } from "@/lib/promo/stock";
import { familleQuantifiee, type PromoFamille } from "@/lib/promo/catalogue";
import { articleDansMonPerimetre, gestionnairesDuMagasin } from "@/lib/queries/promo-stock";
import { sansBloquer } from "@/lib/journal";
import { PARENTS, revalidate, canEditItems, canAllocate, audit, refusPostesClos, loadItem, REFUS_HISTORIQUE, libellesArticles } from "./infra/postes/commun";

/**
 * POSTES AD & PRO — LE MATÉRIEL DU STOCK D'UN ÉVÉNEMENT (§118.167) : ajouter un article du magasin au
 * poste, confirmer le matériel (réservation au stock promotionnel).
 * Morceau de la clé `ad-pro-item-actions` (voir `actions-postes.ts`).
 */

// ─────────────────────── Le matériel du stock d'un événement (§118.167) ───────────────────────

/** Un poste « Matériel du stock » se compose tant qu'il n'est ni soumis ni accordé. */
const POSTE_STOCK_EDITABLE = new Set<AdProItemStatus>(["DRAFT", "REVISION", "REJECTED"]);

/**
 * AJOUTER (OU REQUANTIFIER) UN ARTICLE DU STOCK SUR LE POSTE. Le demandeur pioche dans le MAGASIN
 * de la société de l'opération ; rien ne bouge au magasin avant l'accord. Une quantité à zéro
 * retire l'article. Un support numérique n'a pas de quantité : il ne se réserve pas.
 */
export async function ajouterArticleStockAuPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemId = fdStr(formData, "itemId");
  const stockItemId = fdStr(formData, "stockItemId");
  if (!itemId || !stockItemId) return { ok: false, error: "Choisissez l'article du stock." };
  const quantite = fdNum(formData, "quantite");
  if (quantite == null || !Number.isFinite(quantite) || quantite < 0) return { ok: false, error: "Indiquez une quantité (0 pour retirer l'article)." };
  const found = await loadItem(itemId, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const clos = refusPostesClos(info);
  if (clos) return { ok: false, error: clos };
  if (item.kind !== "STOCK_MATERIAL") return { ok: false, error: "Ce poste n'est pas un poste « Matériel du stock »." };
  if (!POSTE_STOCK_EDITABLE.has(item.status)) {
    return { ok: false, error: item.status === "APPROVED"
      ? "Ce poste est accordé et son matériel réservé : sa liste ne change plus (la Direction peut le remettre « à revoir »)."
      : "Ce poste attend la décision de la Direction : sa liste ne change pas pendant ce temps." };
  }
  const article = await articleDansMonPerimetre(user.id, stockItemId);
  if (!article || !article.isActive) return { ok: false, error: "Article du stock introuvable ou archivé." };
  if (!familleQuantifiee(article.catalogue.famille as PromoFamille)) return { ok: false, error: "Un support numérique se présente, il ne se réserve pas." };
  if (info.companyId && article.companyId && article.companyId !== info.companyId) {
    return { ok: false, error: "Cet article appartient au magasin d'une autre société que celle de l'opération." };
  }
  const libelle = libelleArticleStock(article.catalogue.nom, article.produits.map((p) => p.product.canonicalName));
  if (quantite === 0) {
    await prisma.adProStockLine.deleteMany({ where: { itemId, stockItemId, statut: "DEMANDEE" } });
  } else {
    await prisma.adProStockLine.upsert({
      where: { itemId_stockItemId: { itemId, stockItemId } },
      create: { itemId, stockItemId, quantite, createdById: user.id },
      update: { quantite },
    });
  }
  await audit(user, owner.parent, owner.id, "UPDATE", quantite === 0
    ? `Poste « ${item.label} » : « ${libelle} » retiré du matériel demandé.`
    : `Poste « ${item.label} » : ${quantite.toLocaleString("fr-FR")} « ${libelle} » demandé(s) au magasin.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id: itemId };
}

/**
 * CONFIRMER LE MATÉRIEL APRÈS L'ÉVÉNEMENT (§118.167). Un consommable : combien ont été remis (le
 * reste revient). Un durable PRÊTÉ : combien sont rendus, abîmés, perdus — la somme doit faire le
 * compte réservé. Tout ce qui ne va pas est dit en une fois ; sinon le reste revient au magasin par
 * la même écriture, dans les lots d'où il était sorti, et la magasinière en est prévenue.
 *
 * Confirmer « 0 remis » avant l'événement est aussi la façon d'annuler une réservation.
 * Qui confirme : le demandeur (il a tenu l'événement), la gestionnaire du magasin (elle reçoit le
 * retour), la Direction qui décide des postes, ou le Super Admin.
 */
export async function confirmerMaterielStock(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(itemId, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (item.kind !== "STOCK_MATERIAL") return { ok: false, error: "Ce poste n'est pas un poste « Matériel du stock »." };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const gestionnaires = await gestionnairesDuMagasin();
  const peut = peutConfirmerMateriel({
    superAdmin: user.role === "SUPER_ADMIN",
    estLeDemandeur: info.requesterId === user.id,
    gereLeMagasin: gestionnaires.includes(user.id),
    decideLesPostes: canAllocate(user, owner.parent),
  });
  if (!peut) return { ok: false, error: REFUS_CONFIRMATION_MATERIEL };

  const lignes = await prisma.adProStockLine.findMany({ where: { itemId, statut: "RESERVEE" }, select: { id: true, stockItemId: true, quantite: true } });
  if (lignes.length === 0) return { ok: false, error: "Aucun matériel réservé n'attend de confirmation sur ce poste." };
  const libelles = await libellesArticles(lignes.map((l) => l.stockItemId));
  const ids = formData.getAll("ligneId").map(String);
  const champ = (nom: string, i: number) => formData.getAll(nom)[i];
  const fautes: string[] = [];
  const decisions = new Map<string, Confirmation>();
  for (const l of lignes) {
    const i = ids.indexOf(l.id);
    const meta = libelles.get(l.stockItemId);
    const libelle = meta?.libelle ?? "Article";
    if (i < 0) { fautes.push(`« ${libelle} » : rien n'est déclaré`); continue; }
    const r = lireConfirmation(meta?.famille ?? "CONSOMMABLE", toNumber(l.quantite), {
      utilisee: champ("utilisee", i), rendue: champ("rendue", i), abimee: champ("abimee", i), perdue: champ("perdue", i),
    }, libelle);
    if (!r.ok) fautes.push(r.faute);
    else decisions.set(l.id, r.confirmation);
  }
  if (fautes.length) return { ok: false, error: `Confirmation à revoir : ${fautes.join(" ; ")}.` };

  const note = fdStr(formData, "note");
  let revenu = 0;
  const fait = await sousVerrous(lignes.map((l) => l.stockItemId), async (tx) => {
    // CONDITIONNEL : deux confirmations simultanées ne font revenir le reste qu'une fois.
    let n = 0;
    for (const l of lignes) {
      const c = decisions.get(l.id)!;
      const maj = await tx.adProStockLine.updateMany({
        where: { id: l.id, statut: "RESERVEE" },
        data: {
          statut: "CONFIRMEE", utilisee: c.utilisee, rendue: c.rendue, abimee: c.abimee, perdue: c.perdue,
          confirmeeLe: new Date(), confirmeeParId: user.id, note,
        },
      });
      if (maj.count === 0) continue;
      n += 1;
      revenu += await rendreAuMagasin(tx, l.stockItemId, { ligneId: l.id, quantite: c.retour, motif: `Retour de l'événement — ${info.ref}`, auteurId: user.id });
    }
    return n;
  });
  if (fait === 0) return { ok: false, error: "Ce matériel a déjà été confirmé entre-temps : rechargez la fiche." };

  if (revenu > 0) {
    for (const g of gestionnaires.filter((g) => g !== user.id)) {
      await notifyUser({
        userId: g, type: "GENERIC", title: "Matériel revenu d'un événement",
        body: `${info.ref} — ${revenu.toLocaleString("fr-FR")} unité(s) reviennent au magasin.`,
        link: lienStockPromo("magasin"),
      }).catch(sansBloquer("ad-pro-item-actions.confirmerMaterielStock.notifyUser"));
    }
  }
  const resume = [...decisions].map(([id, c]) => {
    const l = lignes.find((x) => x.id === id)!;
    const lib = libelles.get(l.stockItemId)?.libelle ?? "Article";
    return c.utilisee != null
      ? `${lib} : ${c.utilisee.toLocaleString("fr-FR")} remis, ${c.retour.toLocaleString("fr-FR")} revenu(s)`
      : `${lib} : ${c.rendue.toLocaleString("fr-FR")} rendu(s), ${(c.abimee ?? 0).toLocaleString("fr-FR")} abîmé(s), ${(c.perdue ?? 0).toLocaleString("fr-FR")} perdu(s)`;
  }).join(" ; ");
  await audit(user, owner.parent, owner.id, "UPDATE", `Matériel du stock confirmé — poste « ${item.label} » : ${resume}${note ? ` (${note})` : ""}.`);
  revalidate(owner.parent, owner.id);
  revalidatePath(CHEMIN_STOCK_PROMO);
  return { ok: true, id: itemId, message: revenu > 0 ? `Matériel confirmé : ${revenu.toLocaleString("fr-FR")} unité(s) reviennent au magasin.` : "Matériel confirmé : rien ne revient au magasin." };
}
