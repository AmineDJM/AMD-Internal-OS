"use server";

import { CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { getMyCompanies } from "@/lib/company";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { articleDansMonPerimetre, faitsStock, gestionnairesDuMagasin, peutRecevoirDuStock } from "@/lib/queries/promo-stock";
import { familleAValidite, familleQuantifiee, type PromoFamille } from "@/lib/promo/catalogue";
import {
  allouer, libelleArticleStock, lireDateJour, lireRepartition, natureDuTransfert, parseQuantity, NATURE_TRANSFERT_LABEL,
} from "@/lib/promo/stock";
import {
  REFUS, peutAnnulerDemande, peutAnnulerMouvement, peutAnnulerTransfert, peutConfirmerReception, peutCorriger, peutDeclarerPerte,
  peutDemander, peutDoter, peutEntrerAlaMain, peutGererArticles, peutPoserOuverture, peutServirDemande,
  peutTransfererVers, peutSortirDe,
} from "@/lib/promo/stock-acces";
import {
  annulerMouvementEcrit, confirmerArrivee, corrigerAuCompte, entrerLot, fairePartir, lotsDe, renvoyer,
  sortirSansContrepartie, sousVerrou, trouverOuCreerArticle,
} from "@/lib/promo/stock-ecriture";
import { trouverOuCreerAuCatalogue } from "@/lib/promo/catalogue-ecriture";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE STOCK DU MATÉRIEL PROMOTIONNEL — les gestes (§118.164).
 *
 * Chaque action relit les FAITS de la personne (`faitsStock`) et demande à la règle pure
 * (`promo/stock-acces.ts`) si le geste lui est ouvert — la même règle que l'écran lit pour
 * montrer ou cacher le bouton. Puis l'écriture passe par l'écrivain unique (`stock-ecriture.ts`),
 * sous le verrou de l'article : un solde ne change qu'à un seul endroit.
 *
 * Aucun de ces gestes n'est offert à Adam : chacun atteste un fait PHYSIQUE (« je l'ai reçu »,
 * « je l'ai compté », « je l'ai perdu », « je l'ai remis ») qu'un modèle ne voit pas — et Adam est
 * en pause. Le registre des actions les classe EXCLUDED avec cette raison, et le chemin générique
 * les refuse en la citant (§118.158).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PATH = CHEMIN_STOCK_PROMO;
const MODULE = "Stock promotionnel";

function reussi(id: string, message?: string): ActionResult {
  revalidatePath(PATH);
  return { ok: true, id, message };
}

function refus(r: unknown): r is { refus: string } {
  return typeof r === "object" && r !== null && "refus" in r;
}

async function prevenir(userIds: (string | null | undefined)[], title: string, body: string, sauf?: string) {
  const ids = [...new Set(userIds.filter((x): x is string => Boolean(x) && x !== sauf))];
  for (const userId of ids) await notifyUser({ userId, type: "GENERIC", title, body, link: PATH });
}

const nombre = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });

async function libelleDe(itemId: string): Promise<string> {
  const it = await prisma.promoStockItem.findUnique({
    where: { id: itemId },
    select: { catalogue: { select: { nom: true } }, produits: { select: { product: { select: { canonicalName: true } } } } },
  });
  return it ? libelleArticleStock(it.catalogue.nom, it.produits.map((p) => p.product.canonicalName)) : "Article";
}

/** L'article du catalogue, validé pour une ENTRÉE (quantifié, actif, produits exigés présents). */
async function articleCataloguePourEntree(catalogueId: string | null, produitIds: string[], attendu: "QUANTIFIE" | "NUMERIQUE") {
  if (!catalogueId) return { error: "Choisissez l'article du catalogue." } as const;
  const c = await prisma.promoCatalogueArticle.findUnique({
    where: { id: catalogueId },
    select: { id: true, reference: true, nom: true, famille: true, unite: true, materialType: true, exigeProduit: true, actif: true },
  });
  if (!c) return { error: "Article du catalogue introuvable." } as const;
  if (!c.actif) return { error: `${c.reference} est archivé : réactivez-le dans le catalogue avant de l'utiliser.` } as const;
  const quantifie = familleQuantifiee(c.famille as PromoFamille);
  if (attendu === "QUANTIFIE" && !quantifie) return { error: `${c.reference} est un support NUMÉRIQUE : il n'a pas de quantité. Déclarez-le comme support numérique.` } as const;
  if (attendu === "NUMERIQUE" && quantifie) return { error: `${c.reference} n'est pas un support numérique : entrez-le en stock avec une quantité.` } as const;
  if (c.exigeProduit && produitIds.length === 0) return { error: `${c.nom} n'existe que pour un produit : choisissez le ou les produits concernés.` } as const;
  if (produitIds.length) {
    const trouves = await prisma.product.count({ where: { id: { in: produitIds } } });
    if (trouves !== new Set(produitIds).size) return { error: "Un des produits choisis est introuvable." } as const;
  }
  return { catalogue: c } as const;
}

async function societeAutorisee(userId: string, companyId: string | null): Promise<boolean> {
  if (!companyId) return true;
  const miennes = await getMyCompanies(userId);
  return miennes.some((c) => c.id === companyId);
}

// ─────────────────────────────── ENTRER DU MATÉRIEL ───────────────────────────────

/**
 * ENTRER DU MATÉRIEL À LA MAIN au magasin central (don, retour fournisseur, stock trouvé…). C'est
 * la seule ligne, avec l'inventaire d'ouverture, qui crée du stock sans facture ni transfert :
 * celle qui tient le magasin et le Super Admin (Direction, 23/11/2026 — `peutEntrerAlaMain`).
 * Elle crée un LOT : la date, le coût et la fin de validité voyagent avec.
 *
 * UN SUPPORT ABSENT DU CATALOGUE (`catalogueId` = « AUTRE », avec son nom et sa famille) y est
 * ajouté — ou retrouvé sous le même nom — APRÈS que tout le reste de la saisie a été jugé : une
 * entrée refusée ne laisse pas une ligne de catalogue orpheline (`promo/catalogue-ecriture.ts`).
 */
export async function entrerEnStock(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutEntrerAlaMain(f)) return { ok: false, error: REFUS.entree };
  const produitIds = formData.getAll("produitIds").map(String).filter(Boolean);
  const autre = fdStr(formData, "catalogueId") === "AUTRE";
  const companyId = fdStr(formData, "companyId");
  if (!(await societeAutorisee(user.id, companyId))) return { ok: false, error: "Cette société ne vous est pas ouverte." };
  const quantite = parseQuantity(fdStr(formData, "quantite"));
  if (quantite == null || quantite <= 0) return { ok: false, error: "Indiquez une quantité supérieure à zéro." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites d'où vient ce matériel (don, retour fournisseur, stock retrouvé…) : une entrée sans motif ne s'explique plus dans six mois." };
  const brutValidite = fdStr(formData, "valableJusquau");
  const valableJusquau = lireDateJour(brutValidite);
  if (brutValidite && !valableJusquau) return { ok: false, error: "Date de fin de validité illisible (format attendu : AAAA-MM-JJ)." };
  const brutCout = fdStr(formData, "coutUnitaire");
  const coutUnitaire = brutCout ? parseQuantity(brutCout) : null;
  if (brutCout && (coutUnitaire == null || coutUnitaire < 0)) return { ok: false, error: "Coût unitaire illisible." };
  if (autre && valableJusquau && fdStr(formData, "autreFamille") !== "CONSOMMABLE") return { ok: false, error: "Un article durable ne périme pas : laissez la fin de validité vide." };

  let catalogueId = autre ? null : fdStr(formData, "catalogueId");
  if (autre) {
    const c = await trouverOuCreerAuCatalogue(user.id, { nom: fdStr(formData, "autreNom"), famille: fdStr(formData, "autreFamille"), exigeProduit: produitIds.length > 0 });
    if (!c.ok) return { ok: false, error: c.error };
    catalogueId = c.id;
  }
  const v = await articleCataloguePourEntree(catalogueId, produitIds, "QUANTIFIE");
  if ("error" in v) return { ok: false, error: v.error };
  if (valableJusquau && !familleAValidite(v.catalogue.famille as PromoFamille)) return { ok: false, error: "Un article durable ne périme pas : laissez la fin de validité vide." };

  const nomsProduits = produitIds.length
    ? (await prisma.product.findMany({ where: { id: { in: produitIds } }, select: { canonicalName: true } })).map((p) => p.canonicalName)
    : [];
  const article = await trouverOuCreerArticle({
    companyId, catalogueId: v.catalogue.id, produitIds,
    nom: libelleArticleStock(v.catalogue.nom, nomsProduits), unite: v.catalogue.unite,
    materialType: v.catalogue.materialType, auteurId: user.id,
  });
  const r = await sousVerrou(article.id, (tx) => entrerLot(tx, article.id, {
    holderId: null, quantite, kind: "RECEIPT", origine: "SAISIE",
    coutUnitaire, valableJusquau, libelle: fdStr(formData, "libelleLot"), motif, auteurId: user.id,
  }));
  if (refus(r)) return { ok: false, error: r.refus };
  await recordAudit({
    actorId: user.id, action: "CREATE", module: MODULE, entityId: article.id,
    summary: `Entrée au magasin — ${libelleArticleStock(v.catalogue.nom, nomsProduits)} : +${nombre(quantite)} (lot ${r.numero}) — ${motif}`,
  });
  return reussi(article.id, `+${nombre(quantite)} au magasin central (lot ${r.numero}).`);
}

/**
 * L'INVENTAIRE D'OUVERTURE — une fois par article et par détenteur : le magasin, puis ce que
 * chaque délégué a déjà en main au démarrage du registre. Ensuite, un solde ne bouge plus que par
 * des mouvements ; un second « inventaire d'ouverture » serait une correction sans le nom.
 */
export async function poserInventaireOuverture(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutPoserOuverture(f)) return { ok: false, error: REFUS.entree };
  const produitIds = formData.getAll("produitIds").map(String).filter(Boolean);
  const v = await articleCataloguePourEntree(fdStr(formData, "catalogueId"), produitIds, "QUANTIFIE");
  if ("error" in v) return { ok: false, error: v.error };
  const companyId = fdStr(formData, "companyId");
  if (!(await societeAutorisee(user.id, companyId))) return { ok: false, error: "Cette société ne vous est pas ouverte." };
  const detenteurId = fdStr(formData, "detenteurId");
  if (detenteurId) {
    const ok = await peutRecevoirDuStock(detenteurId);
    if (!ok.ok) return { ok: false, error: ok.error };
  }
  const quantite = parseQuantity(fdStr(formData, "quantite"));
  if (quantite == null || quantite < 0) return { ok: false, error: "Indiquez la quantité comptée (zéro compris)." };
  const brutValidite = fdStr(formData, "valableJusquau");
  const valableJusquau = lireDateJour(brutValidite);
  if (brutValidite && !valableJusquau) return { ok: false, error: "Date de fin de validité illisible (format attendu : AAAA-MM-JJ)." };
  if (valableJusquau && !familleAValidite(v.catalogue.famille as PromoFamille)) return { ok: false, error: "Un article durable ne périme pas : laissez la fin de validité vide." };

  const nomsProduits = produitIds.length
    ? (await prisma.product.findMany({ where: { id: { in: produitIds } }, select: { canonicalName: true } })).map((p) => p.canonicalName)
    : [];
  const libelle = libelleArticleStock(v.catalogue.nom, nomsProduits);
  const article = await trouverOuCreerArticle({
    companyId, catalogueId: v.catalogue.id, produitIds, nom: libelle, unite: v.catalogue.unite,
    materialType: v.catalogue.materialType, auteurId: user.id,
  });
  const r = await sousVerrou(article.id, async (tx) => {
    const deja = await tx.promoStockMovement.count({ where: { itemId: article.id, holderId: detenteurId } });
    if (deja > 0) return { refus: "L'inventaire d'ouverture de ce stock est déjà posé : un écart se règle désormais par une correction d'inventaire." };
    return entrerLot(tx, article.id, {
      holderId: detenteurId, quantite, kind: "OPENING", origine: "OUVERTURE",
      valableJusquau, libelle: "Inventaire d'ouverture", motif: fdStr(formData, "motif") ?? "Inventaire d'ouverture", auteurId: user.id,
    });
  });
  if (refus(r)) return { ok: false, error: r.refus };
  await recordAudit({
    actorId: user.id, action: "CREATE", module: MODULE, entityId: article.id,
    summary: `Inventaire d'ouverture — ${libelle} : ${nombre(quantite)} (${detenteurId ? "chez un détenteur" : "magasin central"})`,
  });
  return reussi(article.id, `Inventaire d'ouverture posé : ${nombre(quantite)}.`);
}

/** DÉCLARER UN SUPPORT NUMÉRIQUE — un lien et une période de validité, pas de quantité. */
export async function declarerSupportNumerique(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutGererArticles(f)) return { ok: false, error: REFUS.magasin };
  const produitIds = formData.getAll("produitIds").map(String).filter(Boolean);
  const v = await articleCataloguePourEntree(fdStr(formData, "catalogueId"), produitIds, "NUMERIQUE");
  if ("error" in v) return { ok: false, error: v.error };
  const companyId = fdStr(formData, "companyId");
  if (!(await societeAutorisee(user.id, companyId))) return { ok: false, error: "Cette société ne vous est pas ouverte." };
  const lien = fdStr(formData, "lien");
  const brutValidite = fdStr(formData, "valableJusquau");
  const valableJusquau = lireDateJour(brutValidite);
  if (brutValidite && !valableJusquau) return { ok: false, error: "Date de fin de validité illisible (format attendu : AAAA-MM-JJ)." };
  const nomsProduits = produitIds.length
    ? (await prisma.product.findMany({ where: { id: { in: produitIds } }, select: { canonicalName: true } })).map((p) => p.canonicalName)
    : [];
  const libelle = libelleArticleStock(v.catalogue.nom, nomsProduits);
  const article = await trouverOuCreerArticle({
    companyId, catalogueId: v.catalogue.id, produitIds, nom: libelle, unite: v.catalogue.unite,
    materialType: v.catalogue.materialType, auteurId: user.id,
  });
  if (!article.cree) return { ok: false, error: `${libelle} existe déjà : modifiez sa fiche (lien, validité) plutôt que de le déclarer deux fois.` };
  await prisma.promoStockItem.update({ where: { id: article.id }, data: { lien, valableJusquau, updatedById: user.id } });
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE, entityId: article.id, summary: `Support numérique déclaré — ${libelle}` });
  return reussi(article.id, `${libelle} déclaré.`);
}

// ─────────────────────────────── FICHES ───────────────────────────────

/**
 * LA FICHE d'un article de stock (seuil, emplacement, notes ; lien et validité d'un support
 * numérique ; archivage). La quantité ne se saisit JAMAIS ici. Un article ne s'archive qu'à
 * stock nul, sans rien en route ni demande ouverte : archivé, il disparaîtrait des écrans avec du
 * matériel encore réel dedans.
 *
 * UNE CLÉ OMISE GARDE SA VALEUR, une clé vide efface (§118.152c). La fiche d'un support numérique
 * ne montre ni seuil ni emplacement : écrire `null` dans les champs que le formulaire n'a pas
 * montrés effacerait en silence ce qu'un autre écran avait posé — l'empreinte réelle d'une
 * écriture ne dépasse jamais celle qu'on demande (§118.16).
 */
export async function modifierArticleStock(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutGererArticles(f)) return { ok: false, error: REFUS.magasin };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Article introuvable." };
  const it = await articleDansMonPerimetre(user.id, id);
  if (!it) return { ok: false, error: "Article introuvable." };
  const brutSeuil = fdStr(formData, "alertThreshold");
  const seuil = brutSeuil ? parseQuantity(brutSeuil) : null;
  if (brutSeuil && (seuil == null || seuil < 0)) return { ok: false, error: "Seuil d'alerte illisible." };
  const brutValidite = fdStr(formData, "valableJusquau");
  const valableJusquau = lireDateJour(brutValidite);
  if (brutValidite && !valableJusquau) return { ok: false, error: "Date de fin de validité illisible (format attendu : AAAA-MM-JJ)." };
  const isActive = formData.has("isActive") ? fdStr(formData, "isActive") !== "false" : it.isActive;
  if (!isActive && it.isActive && familleQuantifiee(it.catalogue.famille as PromoFamille)) {
    const [total, enRoute, ouvertes] = await Promise.all([
      prisma.promoStockMovement.aggregate({ where: { itemId: id }, _sum: { delta: true } }),
      prisma.promoStockTransfer.count({ where: { itemId: id, statut: "EN_ROUTE" } }),
      prisma.promoStockRequest.count({ where: { itemId: id, statut: "OUVERTE" } }),
    ]);
    const reste = Number(total._sum.delta ?? 0);
    if (reste !== 0 || enRoute > 0 || ouvertes > 0) {
      return { ok: false, error: `On n'archive pas un article qui a encore du matériel (${nombre(reste)} en stock, ${enRoute} transfert(s) en route, ${ouvertes} demande(s) ouverte(s)) : il disparaîtrait des écrans avec des unités bien réelles.` };
    }
  }
  const numerique = !familleQuantifiee(it.catalogue.famille as PromoFamille);
  // `undefined` dit à Prisma « ne touche pas à ce champ » : c'est exactement ce que veut dire une
  // clé que le formulaire n'a pas envoyée.
  await prisma.promoStockItem.update({
    where: { id },
    data: {
      alertThreshold: formData.has("alertThreshold") ? (seuil != null && seuil > 0 ? seuil : null) : undefined,
      location: formData.has("location") ? fdStr(formData, "location") : undefined,
      notes: formData.has("notes") ? fdStr(formData, "notes") : undefined,
      lien: numerique && formData.has("lien") ? fdStr(formData, "lien") : undefined,
      valableJusquau: numerique && formData.has("valableJusquau") ? valableJusquau : undefined,
      isActive,
      updatedById: user.id,
    },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: id, summary: `Fiche d'article modifiée — ${it.name}${!isActive && it.isActive ? " (archivé)" : ""}` });
  return reussi(id);
}

/** UN LOT : sa fin de validité, son coût, son libellé. Ce qui s'y trouve ne change pas ici. */
export async function modifierLot(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutGererArticles(f)) return { ok: false, error: REFUS.magasin };
  const lotId = fdStr(formData, "lotId");
  if (!lotId) return { ok: false, error: "Lot introuvable." };
  const lot = await prisma.promoStockLot.findUnique({
    where: { id: lotId }, select: { id: true, numero: true, itemId: true, item: { select: { catalogue: { select: { famille: true } } } } },
  });
  if (!lot || !(await articleDansMonPerimetre(user.id, lot.itemId))) return { ok: false, error: "Lot introuvable." };
  const brutValidite = fdStr(formData, "valableJusquau");
  const valableJusquau = lireDateJour(brutValidite);
  if (brutValidite && !valableJusquau) return { ok: false, error: "Date de fin de validité illisible (format attendu : AAAA-MM-JJ)." };
  if (valableJusquau && !familleAValidite(lot.item.catalogue.famille as PromoFamille)) return { ok: false, error: "Un article durable ne périme pas : laissez la fin de validité vide." };
  const brutCout = fdStr(formData, "coutUnitaire");
  const coutUnitaire = brutCout ? parseQuantity(brutCout) : null;
  if (brutCout && (coutUnitaire == null || coutUnitaire < 0)) return { ok: false, error: "Coût unitaire illisible." };
  // Une clé omise garde sa valeur (la fiche d'un lot DURABLE ne montre pas de fin de validité).
  await prisma.promoStockLot.update({
    where: { id: lotId },
    data: {
      valableJusquau: formData.has("valableJusquau") ? valableJusquau : undefined,
      coutUnitaire: formData.has("coutUnitaire") ? coutUnitaire : undefined,
      libelle: formData.has("libelle") ? fdStr(formData, "libelle") : undefined,
    },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: lot.itemId, summary: `Lot ${lot.numero} modifié` });
  return reussi(lot.itemId);
}

// ─────────────────────────────── TRANSFERTS ───────────────────────────────

/**
 * DOTER une personne depuis le magasin — elle le voit « en route » et CONFIRME la réception
 * (décision de la Direction, 01/10). Rien n'arrive dans son stock avant sa confirmation.
 */
export async function doter(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutDoter(f)) return { ok: false, error: REFUS.magasin };
  const itemId = fdStr(formData, "itemId");
  const versId = fdStr(formData, "versId");
  if (!itemId || !versId) return { ok: false, error: "Choisissez l'article et la personne dotée." };
  const it = await articleDansMonPerimetre(user.id, itemId);
  if (!it || !it.isActive) return { ok: false, error: "Article introuvable ou archivé." };
  if (!familleQuantifiee(it.catalogue.famille as PromoFamille)) return { ok: false, error: "Un support numérique ne se dote pas : il n'a pas de quantité." };
  const dest = await peutRecevoirDuStock(versId);
  if (!dest.ok) return { ok: false, error: dest.error };
  const quantite = parseQuantity(fdStr(formData, "quantite"));
  if (quantite == null || quantite <= 0) return { ok: false, error: "Indiquez une quantité supérieure à zéro." };
  const note = fdStr(formData, "note");
  const r = await sousVerrou(itemId, (tx) => fairePartir(tx, itemId, {
    nature: "DOTATION", deId: null, versId, quantite, note, initiateurId: user.id, maintenant: new Date(),
  }));
  // `refus` attrape les deux refus : l'article introuvable sous le verrou, et l'allocation impossible.
  if (refus(r)) return { ok: false, error: `Le magasin ne peut pas doter : ${r.refus}` };
  const libelle = await libelleDe(itemId);
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE, entityId: itemId, summary: `Dotation — ${libelle} : ${nombre(quantite)} vers ${dest.nom} (en route)` });
  await prevenirDotation(versId, quantite, libelle, user.id);
  return reussi(r.transfertId, `${nombre(quantite)} en route vers ${dest.nom} — il confirmera la réception.`);
}

/** La personne dotée l'apprend — la même phrase pour une dotation seule et pour chaque ligne d'une répartition. */
async function prevenirDotation(versId: string, quantite: number, libelle: string, auteurId: string) {
  await prevenir([versId], "Matériel promotionnel en route vers vous", `${nombre(quantite)} × ${libelle} vous ont été dotés. Confirmez la réception quand vous les avez en main.`, auteurId);
}

/** Le refus d'une ligne de répartition après le départ des précédentes — levé pour annuler la transaction ENTIÈRE. */
class RefusRepartition extends Error {}

/**
 * RÉPARTIR UN ARTICLE ENTRE PLUSIEURS PERSONNES (Direction, 23/11/2026 : « Assia décide à qui donner
 * chaque quantité de chaque matériel pour les délégués ») — à côté de « Doter », qui en sert une.
 *
 * Une DOTATION par personne, chacune « en route » jusqu'à la confirmation de celui qui la reçoit, et
 * annoncée comme une dotation seule : rien ne change pour le délégué. Mais TOUT OU RIEN : chaque
 * destinataire est jugé AVANT la transaction ; sous UN verrou de l'article, le total est comparé au
 * distribuable du magasin (hors lots périmés), puis chaque ligne part. Une ligne qui échouerait
 * encore annule la répartition entière — trois délégués dotés sur cinq, et deux qui attendent ce
 * qu'on croit leur avoir envoyé, serait pire qu'un refus. Les lignes à zéro sont ignorées.
 */
export async function repartirArticle(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutDoter(f)) return { ok: false, error: REFUS.magasin };
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Choisissez l'article à répartir." };
  const versIds = formData.getAll("versId").map(String);
  const quantites = formData.getAll("quantite").map(String);
  if (versIds.length !== quantites.length) return { ok: false, error: "Saisie incomplète : chaque personne doit avoir sa quantité. Rechargez la page." };
  const lecture = lireRepartition(versIds.map((versId, i) => ({ versId, quantite: quantites[i] })));
  if (!lecture.ok) return { ok: false, error: lecture.error };
  const it = await articleDansMonPerimetre(user.id, itemId);
  if (!it || !it.isActive) return { ok: false, error: "Article introuvable ou archivé." };
  if (!familleQuantifiee(it.catalogue.famille as PromoFamille)) return { ok: false, error: "Un support numérique ne se répartit pas : il n'a pas de quantité." };
  const noms = new Map<string, string>();
  for (const [i, d] of (await Promise.all(lecture.lignes.map((l) => peutRecevoirDuStock(l.versId)))).entries()) {
    if (!d.ok) return { ok: false, error: `${d.error} Rien n'est parti.` };
    noms.set(lecture.lignes[i]!.versId, d.nom);
  }
  const note = fdStr(formData, "note");
  const maintenant = new Date();
  const r = await sousVerrou(itemId, async (tx) => {
    const place = allouer(await lotsDe(tx, itemId, null), lecture.total, { maintenant, inclurePerimes: false });
    if (!place.ok) return { refus: `${nombre(lecture.total)} demandées au total. ${place.raison} Rien n'est parti.` };
    const transferts: string[] = [];
    for (const l of lecture.lignes) {
      const p = await fairePartir(tx, itemId, { nature: "DOTATION", deId: null, versId: l.versId, quantite: l.quantite, note, initiateurId: user.id, maintenant });
      if (!p.ok) throw new RefusRepartition(`${noms.get(l.versId)} : ${p.refus} Rien n'est parti.`);
      transferts.push(p.transfertId);
    }
    return { transferts };
  }).catch((e: unknown) => {
    if (e instanceof RefusRepartition) return { refus: e.message };
    throw e;
  });
  if (refus(r)) return { ok: false, error: `Le magasin ne peut pas répartir : ${r.refus}` };
  const libelle = await libelleDe(itemId);
  for (const l of lecture.lignes) {
    await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE, entityId: itemId, summary: `Dotation (répartition) — ${libelle} : ${nombre(l.quantite)} vers ${noms.get(l.versId)} (en route)` });
    await prevenirDotation(l.versId, l.quantite, libelle, user.id);
  }
  return reussi(itemId, `${nombre(lecture.total)} en route, réparties entre ${lecture.lignes.length} personne(s) — chacune confirmera la réception.`);
}

/**
 * TRANSFÉRER à un collègue, ou RENDRE au magasin (`versId` vide). Depuis son propre stock — ou,
 * pour le directeur des opérations, depuis le stock d'un membre de ses équipes, qui est prévenu.
 */
export async function transferer(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Choisissez l'article." };
  const deId = fdStr(formData, "deId") ?? user.id;
  const versId = fdStr(formData, "versId");
  const nature = natureDuTransfert(deId, versId);
  if (!nature || nature === "DOTATION") return { ok: false, error: "Un transfert part d'une personne vers une autre, ou vers le magasin." };
  if (!peutSortirDe(f, deId)) return { ok: false, error: f.module.voir ? REFUS.sortie : REFUS.module };
  if (!peutTransfererVers(f, deId, versId)) return { ok: false, error: REFUS.hors_equipe };
  const it = await articleDansMonPerimetre(user.id, itemId);
  if (!it || !it.isActive) return { ok: false, error: "Article introuvable ou archivé." };
  if (!familleQuantifiee(it.catalogue.famille as PromoFamille)) return { ok: false, error: "Un support numérique ne se transfère pas : il n'a pas de quantité." };
  let nomDest = "le magasin central";
  if (versId) {
    const dest = await peutRecevoirDuStock(versId);
    if (!dest.ok) return { ok: false, error: dest.error };
    nomDest = dest.nom;
  }
  const quantite = parseQuantity(fdStr(formData, "quantite"));
  if (quantite == null || quantite <= 0) return { ok: false, error: "Indiquez une quantité supérieure à zéro." };
  const note = fdStr(formData, "note");
  const r = await sousVerrou(itemId, (tx) => fairePartir(tx, itemId, {
    nature, deId, versId, quantite, note, initiateurId: user.id, maintenant: new Date(),
  }));
  if (refus(r)) return { ok: false, error: r.refus };
  const libelle = await libelleDe(itemId);
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE, entityId: itemId, summary: `${NATURE_TRANSFERT_LABEL[nature]} — ${libelle} : ${nombre(quantite)} vers ${nomDest} (en route)` });
  if (versId) {
    await prevenir([versId], "Matériel promotionnel en route vers vous", `${nombre(quantite)} × ${libelle} vous sont transférés. Confirmez la réception quand vous les avez en main.`, user.id);
  } else {
    await prevenir(await gestionnairesDuMagasin(), "Retour de matériel au magasin", `${nombre(quantite)} × ${libelle} reviennent au magasin central. Confirmez la réception à leur arrivée.`, user.id);
  }
  if (deId !== user.id) {
    await prevenir([deId], "Matériel retiré de votre stock", `${nombre(quantite)} × ${libelle} partent de votre stock vers ${nomDest}, à la demande de la direction des opérations. Remettez-les au destinataire.`, user.id);
  }
  return reussi(r.transfertId, `${nombre(quantite)} en route vers ${nomDest}.`);
}

/**
 * CONFIRMER UNE RÉCEPTION — en tout ou en partie. Celui qui reçoit atteste ce qu'il a entre les
 * mains ; ce qui manque est déclaré manquant sur le transfert, et l'envoyeur en est prévenu.
 */
export async function confirmerReception(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  const transfertId = fdStr(formData, "transfertId");
  if (!transfertId) return { ok: false, error: "Transfert introuvable." };
  const t0 = await prisma.promoStockTransfer.findUnique({ where: { id: transfertId }, select: { itemId: true } });
  if (!t0 || !(await articleDansMonPerimetre(user.id, t0.itemId))) return { ok: false, error: "Transfert introuvable." };
  const brut = fdStr(formData, "quantiteRecue");
  const note = fdStr(formData, "note");
  const r = await sousVerrou(t0.itemId, async (tx) => {
    const t = await tx.promoStockTransfer.findUnique({ where: { id: transfertId } });
    if (!t || t.statut !== "EN_ROUTE") return { refus: "Ce transfert n'est plus en route : il a déjà été confirmé, refusé ou annulé." };
    if (!peutConfirmerReception(f, t.versId)) return { refus: REFUS.confirmation };
    const envoyee = Number(t.quantite);
    const recue = brut == null ? envoyee : parseQuantity(brut);
    if (recue == null || recue < 0 || recue > envoyee) return { refus: `Indiquez la quantité réellement reçue, entre 0 et ${nombre(envoyee)}.` };
    if (recue < envoyee && !note) return { refus: "Dites ce qui manque (casse, carton absent…) : l'écart est signalé à l'envoyeur." };
    const res = await confirmerArrivee(tx, transfertId, { versId: t.versId, quantiteRecue: recue, auteurId: user.id, note });
    return { ...res, t };
  });
  if (refus(r)) return { ok: false, error: r.refus };
  const libelle = await libelleDe(r.t.itemId);
  await recordAudit({
    actorId: user.id, action: "VALIDATE", module: MODULE, entityId: r.t.itemId,
    summary: `Réception confirmée — ${libelle} : ${nombre(r.recue)} reçues${r.manquante > 0 ? `, ${nombre(r.manquante)} manquantes` : ""}`,
  });
  if (r.manquante > 0) {
    const cote = r.t.deId ? [r.t.deId, r.t.initiateurId] : [...(await gestionnairesDuMagasin()), r.t.initiateurId];
    await prevenir(cote, "Écart à la réception du matériel", `${nombre(r.manquante)} × ${libelle} déclarées non reçues sur ${nombre(Number(r.t.quantite))} (${note ?? "sans motif"}).`, user.id);
  }
  return reussi(transfertId, r.manquante > 0 ? `${nombre(r.recue)} reçues, ${nombre(r.manquante)} déclarées manquantes.` : `${nombre(r.recue)} reçues.`);
}

/** REFUSER une réception : tout revient à l'envoyeur, au même lot. Le motif est obligatoire. */
export async function refuserReception(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  const transfertId = fdStr(formData, "transfertId");
  const note = fdStr(formData, "note");
  if (!transfertId) return { ok: false, error: "Transfert introuvable." };
  if (!note) return { ok: false, error: "Dites pourquoi vous refusez : l'envoyeur récupère le matériel et doit savoir quoi faire." };
  const t0 = await prisma.promoStockTransfer.findUnique({ where: { id: transfertId }, select: { itemId: true } });
  if (!t0 || !(await articleDansMonPerimetre(user.id, t0.itemId))) return { ok: false, error: "Transfert introuvable." };
  const r = await sousVerrou(t0.itemId, async (tx) => {
    const t = await tx.promoStockTransfer.findUnique({ where: { id: transfertId } });
    if (!t || t.statut !== "EN_ROUTE") return { refus: "Ce transfert n'est plus en route." };
    if (!peutConfirmerReception(f, t.versId)) return { refus: REFUS.confirmation };
    await renvoyer(tx, transfertId, { statut: "REFUSE", deId: t.deId, auteurId: user.id, note });
    return { t };
  });
  if (refus(r)) return { ok: false, error: r.refus };
  const libelle = await libelleDe(r.t.itemId);
  await recordAudit({ actorId: user.id, action: "REFUSE", module: MODULE, entityId: r.t.itemId, summary: `Réception refusée — ${libelle} : ${nombre(Number(r.t.quantite))} reviennent à l'envoyeur (${note})` });
  const envoyeur = r.t.deId ? [r.t.deId, r.t.initiateurId] : [r.t.initiateurId];
  await prevenir(envoyeur, "Matériel refusé à la réception", `${nombre(Number(r.t.quantite))} × ${libelle} ont été refusées (${note}) : elles reviennent dans votre stock.`, user.id);
  return reussi(transfertId, "Refusé : le matériel revient à l'envoyeur.");
}

/** ANNULER un transfert encore en route : tout revient à l'envoyeur. */
export async function annulerTransfert(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  const transfertId = fdStr(formData, "transfertId");
  if (!transfertId) return { ok: false, error: "Transfert introuvable." };
  const note = fdStr(formData, "note");
  const t0 = await prisma.promoStockTransfer.findUnique({ where: { id: transfertId }, select: { itemId: true } });
  if (!t0 || !(await articleDansMonPerimetre(user.id, t0.itemId))) return { ok: false, error: "Transfert introuvable." };
  const r = await sousVerrou(t0.itemId, async (tx) => {
    const t = await tx.promoStockTransfer.findUnique({ where: { id: transfertId } });
    if (!t || t.statut !== "EN_ROUTE") return { refus: "Ce transfert n'est plus en route : on ne l'annule plus — faites rendre le matériel." };
    if (!peutAnnulerTransfert(f, t)) return { refus: "Seul celui qui a lancé ce transfert l'annule (ou le Super Admin, ou le magasin pour ses dotations)." };
    await renvoyer(tx, transfertId, { statut: "ANNULE", deId: t.deId, auteurId: user.id, note });
    return { t };
  });
  if (refus(r)) return { ok: false, error: r.refus };
  const libelle = await libelleDe(r.t.itemId);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: r.t.itemId, summary: `Transfert annulé — ${libelle} : ${nombre(Number(r.t.quantite))} reviennent à l'envoyeur` });
  await prevenir([r.t.versId, r.t.deId], "Transfert de matériel annulé", `Le transfert de ${nombre(Number(r.t.quantite))} × ${libelle} est annulé${note ? ` (${note})` : ""}.`, user.id);
  if (r.t.demandeId) {
    await prisma.promoStockRequest.updateMany({ where: { id: r.t.demandeId, statut: "SERVIE" }, data: { statut: "OUVERTE", decideParId: null, decideLe: null } });
  }
  return reussi(transfertId, "Annulé : le matériel revient à l'envoyeur.");
}

// ─────────────────────────────── SORTIES ET CORRECTIONS ───────────────────────────────

/** DÉCLARER UNE PERTE (casse, perte, lot périmé détruit). Le motif est obligatoire. */
export async function declarerPerte(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Choisissez l'article." };
  const detenteurId = fdStr(formData, "detenteurId");
  if (!peutDeclarerPerte(f, detenteurId)) return { ok: false, error: detenteurId === null ? REFUS.magasin : REFUS.sortie };
  const it = await articleDansMonPerimetre(user.id, itemId);
  if (!it) return { ok: false, error: "Article introuvable." };
  const quantite = parseQuantity(fdStr(formData, "quantite"));
  if (quantite == null || quantite <= 0) return { ok: false, error: "Indiquez une quantité supérieure à zéro." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites ce qui s'est passé (casse, perte, lot périmé détruit…) : une perte sans motif ne se distingue pas d'une erreur." };
  const r = await sousVerrou(itemId, (tx) => sortirSansContrepartie(tx, itemId, {
    holderId: detenteurId, quantite, kind: "LOSS", motif, auteurId: user.id, maintenant: new Date(), lotId: fdStr(formData, "lotId"),
  }));
  if (refus(r)) return { ok: false, error: r.refus };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: itemId, summary: `Perte déclarée — ${it.name} : −${nombre(quantite)} (${motif})` });
  return reussi(itemId, `Perte de ${nombre(quantite)} enregistrée.`);
}

/** CORRIGER UN INVENTAIRE au nombre compté. Au magasin : sa gestionnaire. Chez une personne : le Super Admin. */
export async function corrigerInventaire(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Choisissez l'article." };
  const detenteurId = fdStr(formData, "detenteurId");
  if (!peutCorriger(f, detenteurId)) return { ok: false, error: REFUS.correction };
  const it = await articleDansMonPerimetre(user.id, itemId);
  if (!it) return { ok: false, error: "Article introuvable." };
  const compte = parseQuantity(fdStr(formData, "compte"));
  if (compte == null || compte < 0) return { ok: false, error: "Indiquez la quantité comptée (zéro compris)." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites d'où vient l'écart (comptage du jour, carton retrouvé…) : une correction sans motif ressemble à une erreur." };
  const r = await sousVerrou(itemId, (tx) => corrigerAuCompte(tx, itemId, { holderId: detenteurId, compte, motif, auteurId: user.id, maintenant: new Date() }));
  if (refus(r)) return { ok: false, error: r.refus };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: itemId, summary: `Inventaire corrigé — ${it.name} : ${nombre(r.avant)} → ${nombre(r.apres)} (${motif})` });
  return reussi(itemId, `Solde corrigé : ${nombre(r.avant)} → ${nombre(r.apres)}.`);
}

/**
 * ANNULER UN MOUVEMENT (le « supprimer », pour le registre) — Super Admin. Rien ne disparaît :
 * l'exact inverse s'écrit, et le mouvement d'origine reste lisible, marqué annulé.
 */
export async function annulerMouvement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutAnnulerMouvement(f)) return { ok: false, error: REFUS.superAdmin };
  const mouvementId = fdStr(formData, "mouvementId");
  if (!mouvementId) return { ok: false, error: "Mouvement introuvable." };
  const m = await prisma.promoStockMovement.findUnique({ where: { id: mouvementId }, select: { itemId: true } });
  if (!m || !(await articleDansMonPerimetre(user.id, m.itemId))) return { ok: false, error: "Mouvement introuvable." };
  // Le motif est exigé par l'ÉCRIVAIN, après ses refus structurels (déjà annulé, réservation, remise
  // de visite, lot creusé) : on ne demande pas pourquoi annuler ce qui ne s'annule pas d'ici (§118.18).
  const motif = fdStr(formData, "motif");
  const r = await sousVerrou(m.itemId, (tx) => annulerMouvementEcrit(tx, mouvementId, user.id, motif));
  if (refus(r)) return { ok: false, error: r.refus };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: m.itemId, summary: `Mouvement annulé (${r.delta > 0 ? "+" : ""}${nombre(r.delta)})${motif ? ` — ${motif}` : ""}` });
  return reussi(m.itemId, "Mouvement annulé : son inverse est écrit, l'historique reste entier.");
}

// ─────────────────────────────── DEMANDES ───────────────────────────────

/** DEMANDER du matériel au magasin — la gestionnaire la sert en une dotation pré-remplie. */
export async function demanderMateriel(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutDemander(f)) return { ok: false, error: REFUS.module };
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Choisissez l'article demandé." };
  const it = await articleDansMonPerimetre(user.id, itemId);
  if (!it || !it.isActive || !familleQuantifiee(it.catalogue.famille as PromoFamille)) return { ok: false, error: "Article introuvable, archivé ou numérique." };
  const quantite = parseQuantity(fdStr(formData, "quantite"));
  if (quantite == null || quantite <= 0) return { ok: false, error: "Indiquez une quantité supérieure à zéro." };
  const d = await prisma.promoStockRequest.create({
    data: { itemId, demandeurId: user.id, quantite, note: fdStr(formData, "note") },
    select: { id: true },
  });
  const libelle = await libelleDe(itemId);
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE, entityId: itemId, summary: `Demande de matériel — ${libelle} : ${nombre(quantite)}` });
  await prevenir(await gestionnairesDuMagasin(), "Demande de matériel promotionnel", `${nombre(quantite)} × ${libelle} demandées. Servez la demande depuis le magasin.`, user.id);
  return reussi(d.id, "Demande envoyée au magasin.");
}

/**
 * La demande n'est plus ouverte — dite selon ce qu'elle est devenue, avec le geste qui reste (§118.30).
 * Rien n'est parti : ce refus passe AVANT tout mouvement de stock (lot D1b).
 */
function refusDemandeFermee(statut: string | null | undefined): string {
  const parti = " Rien n'est parti du magasin. Si le matériel a déjà été remis à la personne, enregistrez-le par « Doter » sur la ligne de l'article : le stock le dira.";
  if (statut === "ANNULEE") return `Cette demande vient d'être annulée par son auteur.${parti}`;
  if (statut === "REFUSEE") return `Cette demande vient d'être refusée.${parti}`;
  if (statut === "SERVIE") return "Cette demande vient d'être servie : la dotation est déjà en route — rechargez la page.";
  return "Cette demande n'existe plus — rechargez la page.";
}

/** Le refus d'un service qui a déjà pris la demande — levé pour annuler la transaction ENTIÈRE, rattrapé à sa sortie. */
class RefusService extends Error {}

/**
 * SERVIR une demande : une dotation pré-remplie, que le demandeur confirmera à réception.
 *
 * LA DEMANDE SE PREND AVANT QUE RIEN NE PARTE (lot D1b). Elle était relue « ouverte », puis le matériel
 * partait, puis elle passait « servie » SANS condition : une demande annulée par son auteur entre la lecture
 * et l'écriture était servie quand même — la dotation partait, et l'annulation était écrasée sans un mot,
 * son auteur la croyant annulée. L'annulation et le refus ne prennent pas le verrou de l'article : seule une
 * écriture CONDITIONNELLE sur la demande les voit. Elle est donc la PREMIÈRE écriture, avant tout
 * mouvement ; perdue, rien n'est écrit, et le refus dit le geste qui reste. Gagnée, elle tient la ligne de
 * la demande jusqu'au bout : une annulation lancée pendant qu'on sert attend, puis trouve la demande
 * servie. Si le magasin refuse ensuite (stock insuffisant), la transaction s'annule entière — la demande
 * redevient ouverte, rien n'est parti.
 */
export async function servirDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutServirDemande(f)) return { ok: false, error: REFUS.magasin };
  const demandeId = fdStr(formData, "demandeId");
  if (!demandeId) return { ok: false, error: "Demande introuvable." };
  const d0 = await prisma.promoStockRequest.findUnique({ where: { id: demandeId }, select: { itemId: true } });
  if (!d0 || !(await articleDansMonPerimetre(user.id, d0.itemId))) return { ok: false, error: "Demande introuvable." };
  const brut = fdStr(formData, "quantite");
  const note = fdStr(formData, "note");
  const r = await sousVerrou(d0.itemId, async (tx) => {
    const d = await tx.promoStockRequest.findUnique({ where: { id: demandeId } });
    if (!d || d.statut !== "OUVERTE") return { refus: refusDemandeFermee(d?.statut) };
    const quantite = brut == null ? Number(d.quantite) : parseQuantity(brut);
    if (quantite == null || quantite <= 0) return { refus: "Indiquez une quantité supérieure à zéro." };
    const dest = await peutRecevoirDuStock(d.demandeurId);
    if (!dest.ok) return { refus: dest.error };
    // LA DEMANDE EST-ELLE ENCORE OUVERTE ? La PREMIÈRE écriture, conditionnelle sur l'état lu, AVANT tout
    // mouvement : une annulation ou un refus passés depuis la lecture la font perdre, et rien n'est écrit.
    const prise = await tx.promoStockRequest.updateMany({
      where: { id: demandeId, statut: "OUVERTE" },
      data: { statut: "SERVIE", decideParId: user.id, decideLe: new Date(), noteDecision: note },
    });
    if (prise.count === 0) {
      const devenue = await tx.promoStockRequest.findUnique({ where: { id: demandeId }, select: { statut: true } });
      return { refus: refusDemandeFermee(devenue?.statut) };
    }
    const p = await fairePartir(tx, d.itemId, {
      nature: "DOTATION", deId: null, versId: d.demandeurId, quantite, note, initiateurId: user.id, demandeId, maintenant: new Date(),
    });
    // Le magasin ne peut pas servir : la demande, prise plus haut, ne doit pas rester « servie » sans
    // dotation — la transaction s'annule entière, et la demande redevient ouverte.
    if (!p.ok) throw new RefusService(`Le magasin ne peut pas servir : ${p.refus}`);
    return { d, quantite, transfertId: p.transfertId };
  }).catch((e: unknown) => {
    if (e instanceof RefusService) return { refus: e.message };
    throw e;
  });
  if (refus(r)) return { ok: false, error: r.refus };
  const libelle = await libelleDe(r.d.itemId);
  await recordAudit({ actorId: user.id, action: "VALIDATE", module: MODULE, entityId: r.d.itemId, summary: `Demande servie — ${libelle} : ${nombre(r.quantite)} en route` });
  await prevenir([r.d.demandeurId], "Votre demande de matériel est servie", `${nombre(r.quantite)} × ${libelle} sont en route vers vous. Confirmez la réception quand vous les avez en main.`, user.id);
  return reussi(r.transfertId, `Servie : ${nombre(r.quantite)} en route.`);
}

/** REFUSER une demande — le motif est obligatoire : le demandeur doit savoir quoi faire. */
export async function refuserDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  if (!peutServirDemande(f)) return { ok: false, error: REFUS.magasin };
  const demandeId = fdStr(formData, "demandeId");
  const note = fdStr(formData, "note");
  if (!demandeId) return { ok: false, error: "Demande introuvable." };
  if (!note) return { ok: false, error: "Dites pourquoi la demande est refusée." };
  const d = await prisma.promoStockRequest.findUnique({ where: { id: demandeId }, select: { itemId: true, demandeurId: true, quantite: true, statut: true } });
  if (!d || !(await articleDansMonPerimetre(user.id, d.itemId))) return { ok: false, error: "Demande introuvable." };
  const maj = await prisma.promoStockRequest.updateMany({ where: { id: demandeId, statut: "OUVERTE" }, data: { statut: "REFUSEE", decideParId: user.id, decideLe: new Date(), noteDecision: note } });
  if (maj.count === 0) return { ok: false, error: "Cette demande n'est plus ouverte." };
  const libelle = await libelleDe(d.itemId);
  await recordAudit({ actorId: user.id, action: "REFUSE", module: MODULE, entityId: d.itemId, summary: `Demande refusée — ${libelle} (${note})` });
  await prevenir([d.demandeurId], "Votre demande de matériel est refusée", `${nombre(Number(d.quantite))} × ${libelle} : ${note}`, user.id);
  return reussi(demandeId);
}

/** ANNULER sa propre demande tant qu'elle est ouverte. */
export async function annulerDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await faitsStock(user);
  const demandeId = fdStr(formData, "demandeId");
  if (!demandeId) return { ok: false, error: "Demande introuvable." };
  const d = await prisma.promoStockRequest.findUnique({ where: { id: demandeId }, select: { demandeurId: true, itemId: true } });
  if (!d) return { ok: false, error: "Demande introuvable." };
  if (!peutAnnulerDemande(f, d.demandeurId)) return { ok: false, error: "Seul son auteur annule une demande ; le magasin, lui, la refuse avec un motif." };
  const maj = await prisma.promoStockRequest.updateMany({ where: { id: demandeId, statut: "OUVERTE" }, data: { statut: "ANNULEE", decideParId: user.id, decideLe: new Date() } });
  if (maj.count === 0) return { ok: false, error: "Cette demande n'est plus ouverte." };
  // LE MAGASIN EST PRÉVENU (décision du 04/10) : c'est lui qui l'aurait servie — sans un mot, il
  // préparerait une dotation pour une demande retirée.
  await prevenir(await gestionnairesDuMagasin(), "Demande de matériel annulée", `${user.name} a annulé sa demande de matériel promotionnel : il n'y a plus rien à servir.`, user.id);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: d.itemId, summary: "Demande de matériel annulée" });
  return reussi(demandeId);
}
