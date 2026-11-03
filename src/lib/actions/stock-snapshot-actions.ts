"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { canSeeStockScope, REFUS_DEMANDE_STOCK, type StockScope } from "@/lib/stocks/scopes";
import { etablissementDansPortee, produitDansPortee, releveDansPortee, refusHorsPortee } from "@/lib/stocks/portee";
import { chargerPorteeStock } from "@/lib/queries/stock-portee";
import { lecteurDeStocks, peutPiloterDemandesStocks } from "@/lib/queries/demande-stocks";
import { assurerLieuDeStock, rattacherLieuDeStock } from "@/lib/stocks/lieux";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import { creerDemandeEtatStock } from "@/lib/stocks/demande";
import { ecrireEtatDuJour } from "@/lib/stocks/etat-jour";

// Trois périmètres : la PCH (centrale), les HÔPITAUX et les ANNEXES PCH (sites de stockage
// secondaires). Hôpitaux et annexes sont des lieux nommés (StockAnnex, distingués par `kind`).
// Depuis §118.134, un HÔPITAL désigne un établissement de l'ANNUAIRE (`institutionId`) : c'est ce
// lien qui donne à un KAM les stocks de son secteur. Les annexes restent des noms libres du Super
// Admin.
const SCOPES = ["PCH", "HOSPITAL", "ANNEX"] as const;
const PATH = "/stocks";

/**
 * CE QUE CETTE PERSONNE VOIT DU STOCK — la même règle qu'à l'écran, appliquée ICI.
 *
 * Masquer les onglets « PCH » et « annexes PCH » à un délégué médical ne ferme rien : la portée
 * voyage dans un champ de formulaire, et une requête forgée écrit ou efface un état de stock de la
 * centrale d'achat aussi bien qu'un clic. La garde vit donc dans l'action, l'écran n'en est que le
 * reflet (§118-7 : ce que l'écran refuse ne se rattrape pas ailleurs).
 */
const stockViewer = lecteurDeStocks;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * AJOUTER UN HÔPITAL AUX LIEUX DE STOCK = choisir un établissement de l'ANNUAIRE (Super Admin).
 *
 * Il n'y a plus de nom libre : « CHU Mustapha » tapé ici et « C.H.U Mustapha » dans l'annuaire
 * faisaient deux hôpitaux pour le logiciel, et aucun secteur ne pouvait ouvrir le stock du second
 * à un KAM. On désigne l'établissement (`institutionId`), ou son nom EXACT dans l'annuaire — pour
 * Adam, qui parle en noms ; un nom absent de l'annuaire est refusé en nommant le geste : créer
 * l'établissement dans Annuaires › Établissements.
 *
 * Avec `annexId`, le geste RATTACHE un lieu hérité (créé à la main avant ce lien) à
 * l'établissement, au lieu d'en créer un second : c'est ainsi que l'historique d'un hôpital
 * rejoint l'annuaire — par un clic humain, jamais par ressemblance de nom.
 */
export async function createStockHospital(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Seul le Super Admin ajoute un hôpital aux lieux de stock." };
  let institutionId = fdStr(formData, "institutionId");
  const annexId = fdStr(formData, "annexId");
  const name = fdStr(formData, "name");

  if (!institutionId && name) {
    // Le nom se résout dans l'ANNUAIRE, exactement (casse et accents pliés), jamais « à peu près ».
    const candidats = await prisma.medicalInstitution.findMany({
      where: { name: { contains: name, mode: "insensitive" }, isActive: true },
      select: { id: true, name: true }, take: 10,
    });
    const exacts = candidats.filter((c) => fold(c.name) === fold(name));
    if (exacts.length === 1) institutionId = exacts[0].id;
    else if (exacts.length > 1) return { ok: false, error: `Plusieurs établissements s'appellent « ${name} » dans l'annuaire : désignez-le par son identifiant.` };
    else {
      return {
        ok: false,
        error: `« ${name} » n'est pas dans l'annuaire des établissements. Les hôpitaux du module Stocks sont ceux de l'annuaire : créez-le d'abord dans Annuaires › Établissements (ou Promotion médicale › Établissements), puis ajoutez-le ici.`,
      };
    }
  }
  if (!institutionId) return { ok: false, error: "Choisissez l'établissement de l'annuaire à ajouter aux lieux de stock." };

  const r = annexId ? await rattacherLieuDeStock(annexId, institutionId) : await assurerLieuDeStock(institutionId);
  if (!r.ok) return r;
  await recordAudit({
    actorId: user.id, action: annexId ? "UPDATE" : "CREATE", module: "Stocks",
    summary: annexId
      ? `Lieu de stock rattaché à l'annuaire — ${r.name}${r.renomme ? " (renommé)" : ""}`
      : `Hôpital ajouté aux lieux de stock — ${r.name}${r.cree ? "" : " (déjà présent)"}`,
  });
  revalidatePath(PATH);
  return { ok: true, id: r.annexId, ...(r.note ? { message: r.note } : {}) };
}

/** Supprime un lieu nommé et ses états de stock (Super Admin). */
async function deleteStockLocation(formData: FormData, kind: "HOSPITAL" | "ANNEX"): Promise<ActionResult> {
  const user = await requireUser();
  const un = kind === "HOSPITAL" ? "un hôpital" : "une annexe PCH";
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: `Seul le Super Admin peut supprimer ${un}.` };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const loc = await prisma.stockAnnex.findUnique({ where: { id }, select: { name: true } });
  if (!loc) return { ok: false, error: "Lieu introuvable." };
  await prisma.stockAnnex.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Stocks", summary: `${kind === "HOSPITAL" ? "Hôpital" : "Annexe PCH"} supprimé — ${loc.name}` });
  revalidatePath(PATH);
  return { ok: true };
}

/** Supprime un hôpital des lieux de stock, avec ses états (Super Admin). L'établissement reste dans l'annuaire. */
export async function deleteStockHospital(formData: FormData): Promise<ActionResult> {
  return deleteStockLocation(formData, "HOSPITAL");
}

/** Crée une ANNEXE PCH — un nom libre, réservé au Super Admin : une annexe n'est pas un établissement de l'annuaire. */
export async function createStockAnnex(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Seul le Super Admin peut créer une annexe PCH." };
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Indiquez le nom." };
  const existing = await prisma.stockAnnex.findUnique({ where: { name } });
  if (existing) return { ok: false, error: "Cette annexe PCH existe déjà." };
  const loc = await prisma.stockAnnex.create({ data: { name, kind: "ANNEX" } });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Stocks", summary: `Annexe PCH créée — ${name}` });
  revalidatePath(PATH);
  return { ok: true, id: loc.id };
}

/** Supprime une annexe PCH et ses états de stock (Super Admin). */
export async function deleteStockAnnex(formData: FormData): Promise<ActionResult> {
  return deleteStockLocation(formData, "ANNEX");
}

/**
 * Demande d'ÉTAT DE STOCK à un instant T (Direction / Super Admin) : on charge une personne
 * (délégué ou autre) d'aller relever et RENSEIGNER l'état actuel — pour UN OU PLUSIEURS
 * HÔPITAUX précis (ou en général si aucun n'est ciblé). Créé comme une tâche assignée
 * (visible dans « Mon espace ») + notification nominative ; la personne enregistre ensuite
 * l'état de chaque hôpital dans l'onglet « Stock hôpitaux » (réponse native du module).
 */
export async function requestStockState(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  // DEMANDER UN ÉTAT DE STOCK est une RÉQUISITION adressée à une personne nommée : elle
  // appartient à qui tient la chaîne d'approvisionnement, jamais à qui y contribue. Le droit de
  // SUPPRESSION sur le module ne l'ouvre plus — il pouvait être accordé pour de tout autres raisons.
  if (!peutPiloterDemandesStocks(user)) {
    return { ok: false, error: REFUS_DEMANDE_STOCK };
  }
  const assigneeId = fdStr(formData, "assigneeId");
  if (!assigneeId) return { ok: false, error: "Choisissez la personne à qui demander l'état de stock." };

  // L'EFFET VIT AILLEURS, et c'est ce qui garantit qu'une demande automatique est la MÊME chose
  // qu'une demande faite à la main : tâche assignée, notification nominative, audit. Deux
  // écritures séparées auraient divergé au premier correctif (§118.5).
  const r = await creerDemandeEtatStock({
    actorId: user.id,
    assigneeId,
    hospitalIds: formData.getAll("hospitalIds").map((v) => String(v)),
    note: fdStr(formData, "note"),
    origine: { genre: "MANUELLE" },
  });
  if (!r.ok) return r;
  revalidatePath(PATH);
  return { ok: true, id: r.taskId };
}

/**
 * Enregistre un ÉTAT de stock daté : « à cette date, il reste X unités » pour un
 * produit et un lieu (PCH / hôpital / annexe). S'il existe déjà un état pour le même
 * jour, il est remplacé (correction simple).
 *
 * Un HÔPITAL se désigne par son lieu (`annexId`) ou par l'établissement de l'annuaire
 * (`institutionId`) — la première fois qu'on relève un hôpital de son secteur, le lieu n'existe
 * pas encore : il est créé ici, rattaché à l'établissement. Et la PORTÉE (§118.134) garde
 * l'écriture comme elle garde la lecture : un KAM ne relève qu'un hôpital de son secteur et
 * qu'un produit de sa BU — sinon la portée ne serait qu'un filtre d'écran, et une requête forgée
 * écrirait le stock d'un hôpital qu'il ne voit pas (§118.71).
 */
export async function recordStockSnapshot(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "STOCKS", "CREATE") && !userCan(user, "STOCKS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const scope = fdStr(formData, "scope");
  const productId = fdStr(formData, "productId");
  const date = fdDate(formData, "date");
  const quantity = fdNum(formData, "quantity");
  let annexId = fdStr(formData, "annexId");
  const institutionId = fdStr(formData, "institutionId");
  const isLocationScope = scope === "HOSPITAL" || scope === "ANNEX";
  if (!scope || !(SCOPES as readonly string[]).includes(scope)) return { ok: false, error: "Lieu de stock invalide." };
  // ON N'ÉCRIT PAS DANS UN STOCK QU'ON N'A PAS LE DROIT DE VOIR. Sans cette ligne, la portée
  // n'était qu'un champ de formulaire : un compte terrain pouvait renseigner la position de la
  // centrale d'achat.
  if (!canSeeStockScope(stockViewer(user), scope as StockScope)) {
    return { ok: false, error: "Ce stock ne relève pas de votre périmètre : vous relevez les hôpitaux, la centrale d'achat et ses annexes appartiennent à la chaîne d'approvisionnement." };
  }
  if (isLocationScope && !annexId && !(scope === "HOSPITAL" && institutionId)) {
    return { ok: false, error: scope === "HOSPITAL" ? "Choisissez l'hôpital concerné." : "Choisissez l'annexe PCH concernée." };
  }
  if (!productId) return { ok: false, error: "Choisissez le produit." };
  if (!date) return { ok: false, error: "Indiquez la date de l'état de stock." };
  if (quantity === null || quantity < 0) return { ok: false, error: "Indiquez la quantité restante (≥ 0)." };

  const portee = await chargerPorteeStock(user);
  if (!produitDansPortee(portee, productId)) return { ok: false, error: refusHorsPortee(portee, "produit") };

  if (scope === "HOSPITAL") {
    if (annexId) {
      const lieu = await prisma.stockAnnex.findUnique({ where: { id: annexId }, select: { kind: true, institutionId: true } });
      if (!lieu || lieu.kind === "ANNEX") return { ok: false, error: "Hôpital introuvable dans les lieux de stock." };
      if (!etablissementDansPortee(portee, lieu.institutionId)) {
        return { ok: false, error: refusHorsPortee(portee, lieu.institutionId ? "etablissement" : "lieu-herite") };
      }
    } else {
      if (!institutionId || !etablissementDansPortee(portee, institutionId)) return { ok: false, error: refusHorsPortee(portee, "etablissement") };
      const lieu = await assurerLieuDeStock(institutionId);
      if (!lieu.ok) return lieu;
      annexId = lieu.annexId;
    }
  } else if (scope === "ANNEX") {
    const lieu = annexId ? await prisma.stockAnnex.findUnique({ where: { id: annexId }, select: { kind: true } }) : null;
    if (!lieu || lieu.kind !== "ANNEX") return { ok: false, error: "Annexe PCH introuvable." };
  }

  const product = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { dci: true, brandName: true, companyId: true } });
  if (!product) return { ok: false, error: "Produit introuvable." };

  // Un seul état par jour et par (produit, lieu) : on remplace s'il existe — la règle vit dans
  // `ecrireEtatDuJour`, partagée avec l'envoi d'une demande de stocks.
  // L'entité de l'état de stock suit celle du produit (référentiel Regulatory).
  const ecrit = await ecrireEtatDuJour({
    scope: scope as StockScope, annexId: isLocationScope ? annexId : null, productId, date,
    quantity, companyId: product.companyId, createdById: user.id,
  });
  await recordAudit({ actorId: user.id, action: ecrit.cree ? "CREATE" : "UPDATE", module: "Stocks", summary: `État de stock ${scope} — ${product.brandName ?? product.dci} : ${Math.round(quantity)} u.` });
  revalidatePath(PATH);
  return { ok: true, id: annexId || undefined };
}

/** Supprime un état de stock (correction). */
export async function deleteStockSnapshot(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const snap = await prisma.stockSnapshot.findUnique({
    where: { id },
    select: { createdById: true, scope: true, productId: true, annex: { select: { institutionId: true } } },
  });
  if (!snap) return { ok: false, error: "État introuvable." };
  if (!userCan(user, "STOCKS", "DELETE") && snap.createdById !== user.id) return { ok: false, error: "Non autorisé." };
  // Même barrière qu'à l'écriture : on n'efface pas un relevé d'un stock hors de son périmètre —
  // ni la chaîne d'approvisionnement, ni l'hôpital d'un autre secteur.
  if (!canSeeStockScope(stockViewer(user), snap.scope as StockScope)) {
    return { ok: false, error: "Ce stock ne relève pas de votre périmètre." };
  }
  const portee = await chargerPorteeStock(user);
  if (!releveDansPortee(portee, { scope: snap.scope, institutionId: snap.annex?.institutionId ?? null, productId: snap.productId })) {
    return { ok: false, error: "Ce relevé ne relève pas de votre périmètre : il porte sur un hôpital ou un produit hors de votre secteur." };
  }
  await prisma.stockSnapshot.delete({ where: { id } });
  revalidatePath(PATH);
  return { ok: true };
}
