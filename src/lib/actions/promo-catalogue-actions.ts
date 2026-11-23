"use server";

import { CHEMIN_CATALOGUE_PROMO, CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { revalidatePath } from "next/cache";
import { MaterialType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { enSerie } from "@/lib/refs";
import { fdStr, fdCase, type ActionResult } from "@/lib/actions/types";
import { validerArticle, FAMILLE_LABEL } from "@/lib/promo/catalogue";
import { creerLigneCatalogue, SERIE_CATALOGUE } from "@/lib/promo/catalogue-ecriture";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CATALOGUE DU MATÉRIEL PROMOTIONNEL — créer, corriger, archiver (§118.164).
 *
 * Le droit est celui du module `PROMO_CATALOG` : au Super Admin par défaut, ouvert par lui
 * personne par personne dans Administration › Accès (« en édition ou en lecture, à qui il veut »).
 * SUPPRIMER un article passe par la corbeille canonique (`admin-delete-registry.ts`, Super Admin) ;
 * un article qui a servi ne se supprime pas — il s'ARCHIVE, et reste lisible là où il a servi.
 *
 * LE CATALOGUE SIMPLE (§118.173). « Ce sont les supports déjà créés qui sont le catalogue, triés en
 * trois familles ; on peut en ajouter par la suite. » L'écran ne demande plus que le NOM, la
 * FAMILLE et si le support existe PAR PRODUIT. La nature de support, l'unité et la description
 * restent des colonnes — les supports repris les portent, et le stock lit l'unité —, mais elles ne
 * se saisissent plus. D'où la règle de la correction : ce que le formulaire ne PORTE pas ne
 * s'écrit pas (§118.152c). Sans elle, corriger le nom d'un support effacerait la nature et la
 * description qu'il portait, et remettrait son unité à « pièce ». Les clés se lisent EN LITTÉRAL
 * (`formData.has("nom")`) : une clé passée par une variable rendrait l'action illisible à la
 * dérivation des contrats (§118.79b) — décrite nulle part, donc appelable par personne d'autre
 * que cet écran.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PATH = CHEMIN_CATALOGUE_PROMO;
const REFUS = "Le catalogue promotionnel ne vous est pas ouvert en écriture — un Super Admin l'ouvre dans Administration › Accès (module « Catalogue promotionnel »).";
const TYPES = new Set<string>(Object.values(MaterialType));

/** CRÉER UN ARTICLE — la référence CAT-NNNN est attribuée ici, une fois pour toutes. */
export async function creerArticleCatalogue(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN" && !userCan(user, "PROMO_CATALOG", "CREATE")) return { ok: false, error: REFUS };
  const v = validerArticle({
    nom: fdStr(formData, "nom"),
    famille: fdStr(formData, "famille"),
    materialType: fdStr(formData, "materialType"),
    unite: fdStr(formData, "unite"),
    description: fdStr(formData, "description"),
    // Une case qui peut dire « non » (§118.172) : le formulaire pose un témoin caché avant elle.
    exigeProduit: fdCase(formData, "exigeProduit") ?? false,
  }, TYPES);
  if (!v.ok) return { ok: false, error: v.error };
  const a = v.article;

  // Une série, une création à la fois (§118.148) ; l'unicité de la référence reste tenue par la base.
  const cree = await enSerie(SERIE_CATALOGUE, () => creerLigneCatalogue(user.id, a));
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Catalogue promotionnel", entityId: cree.id,
    summary: `Article ${cree.reference} ajouté au catalogue — ${a.nom} (${FAMILLE_LABEL[a.famille]})`,
  });
  revalidatePath(PATH);
  return { ok: true, id: cree.id, message: `${cree.reference} — ${a.nom} ajouté au catalogue.` };
}

/**
 * CORRIGER UN ARTICLE — tout sauf la référence, et seulement ce que le formulaire PORTE. La
 * FAMILLE ne change pas sous un stock qui la contredirait : un article dont des unités ont été
 * comptées ne devient pas « numérique » (il n'a pas de quantité), et un support numérique en
 * service ne devient pas une chose qu'on compte.
 */
export async function modifierArticleCatalogue(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN" && !userCan(user, "PROMO_CATALOG", "UPDATE")) return { ok: false, error: REFUS };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Article introuvable." };
  const avant = await prisma.promoCatalogueArticle.findUnique({
    where: { id },
    select: { reference: true, nom: true, famille: true, materialType: true, unite: true, description: true, exigeProduit: true },
  });
  if (!avant) return { ok: false, error: "Article introuvable." };
  // CE QUE LE FORMULAIRE NE PORTE PAS GARDE SA VALEUR : la saisie part de l'article tel qu'il est,
  // et chaque clé PRÉSENTE le remplace — vide comprise, qui efface une description. Une case
  // absente ne dit rien ; avec son témoin, elle dit oui ou non (`fdCase`).
  const v = validerArticle({
    nom: formData.has("nom") ? fdStr(formData, "nom") : avant.nom,
    famille: formData.has("famille") ? fdStr(formData, "famille") : avant.famille,
    materialType: formData.has("materialType") ? fdStr(formData, "materialType") : avant.materialType,
    unite: formData.has("unite") ? fdStr(formData, "unite") : avant.unite,
    description: formData.has("description") ? fdStr(formData, "description") : avant.description,
    exigeProduit: fdCase(formData, "exigeProduit") ?? avant.exigeProduit,
  }, TYPES);
  if (!v.ok) return { ok: false, error: v.error };
  const a = v.article;

  if (a.famille !== avant.famille) {
    if (a.famille === "NUMERIQUE" || avant.famille === "NUMERIQUE") {
      const enService = await prisma.promoStockItem.count({ where: { catalogueId: id } });
      if (enService > 0) {
        return {
          ok: false,
          error: avant.famille === "NUMERIQUE"
            ? `${avant.reference} a déjà des supports numériques en service : il ne devient pas un article qu'on compte. Créez un article distinct.`
            : `${avant.reference} a déjà du stock compté : il ne devient pas numérique (un support numérique n'a pas de quantité). Créez un article distinct.`,
        };
      }
    }
  }

  await prisma.promoCatalogueArticle.update({
    where: { id },
    data: {
      nom: a.nom, famille: a.famille, materialType: (a.materialType as MaterialType | null) ?? null,
      unite: a.unite, description: a.description, exigeProduit: a.exigeProduit, updatedById: user.id,
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Catalogue promotionnel", entityId: id,
    summary: `Article ${avant.reference} modifié${avant.nom !== a.nom ? ` — ${avant.nom} → ${a.nom}` : ""}${avant.famille !== a.famille ? ` — famille ${FAMILLE_LABEL[avant.famille as keyof typeof FAMILLE_LABEL] ?? avant.famille} → ${FAMILLE_LABEL[a.famille]}` : ""}`,
  });
  revalidatePath(PATH);
  revalidatePath(CHEMIN_STOCK_PROMO);
  return { ok: true, id };
}

/** ARCHIVER (ou réactiver) — l'article ne se propose plus, et reste lisible partout où il a servi. */
export async function archiverArticleCatalogue(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN" && !userCan(user, "PROMO_CATALOG", "UPDATE")) return { ok: false, error: REFUS };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Article introuvable." };
  const actif = fdStr(formData, "actif") === "true";
  const art = await prisma.promoCatalogueArticle.findUnique({ where: { id }, select: { reference: true, nom: true } });
  if (!art) return { ok: false, error: "Article introuvable." };
  await prisma.promoCatalogueArticle.update({ where: { id }, data: { actif, updatedById: user.id } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Catalogue promotionnel", entityId: id,
    summary: `Article ${art.reference} ${actif ? "réactivé" : "archivé"} — ${art.nom}`,
  });
  revalidatePath(PATH);
  return { ok: true, id };
}
