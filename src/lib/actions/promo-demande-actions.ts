"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { hasGlobalView, getAccess, userCan, anyRoleFilter, type SessionUser } from "@/lib/rbac";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { rouvrirDemandeAuSecretariat } from "@/lib/promo-material/demande-secretariat";
import { parseQuantity } from "@/lib/promo/stock";
import { demandeLesDevis } from "@/lib/promo-material/circuit";
import { libelleArticleDemande, validerArticleDemande, type FamillePromo } from "@/lib/promo-material/achats";
import { aucunPromu, designeUnProduit, libellesPromus, lirePromusStockes } from "@/lib/promo-material/promus";
import { resoudrePromus } from "@/lib/queries/promo-promus";
import { creerArticleHorsCatalogue, refusArticleLibre } from "@/lib/promo-material/article-hors-catalogue";
import { CHEMIN_CATALOGUE_PROMO } from "@/lib/chemins/stock-promo";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DEMANDE D'ACHAT OU DE LOCATION — des articles piochés dans le catalogue (§118.165).
 *
 * « Le demandeur pioche dans le catalogue : par article, le ou les produits liés et des
 * commentaires, autant d'articles qu'il veut sur les trois familles — pour que l'assistante de
 * direction sache clairement quels devis chercher. »
 *
 * QUI : le demandeur, la Direction en suppléance — la règle de `demandeLesDevis`, la même que
 * celle qui demande ensuite les devis (§118.5). QUAND : tant que les devis ne sont pas demandés
 * (validation de la demande, puis « devis à demander »). Après, la liste est ce que l'assistante
 * fait chiffrer ; la retoucher pendant qu'elle cherche les devis la ferait chiffrer autre chose
 * que ce qui est demandé, sans qu'elle le sache.
 *
 * Aucun de ces gestes n'est offert à Adam (EXCLUDED, raison écrite au registre des actions) :
 * Adam est en pause de développement, et la demande se compose en piochant dans le catalogue.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PATH = "/promo-material";
const chemin = (id: string) => `${PATH}/${id}`;

/**
 * Les étapes où la liste des articles se compose encore. Jusqu'à l'audit 360° (R06), la liste se
 * figeait dès les devis demandés — « dites-le sur la discussion » : l'article oublié n'était jamais
 * chiffré, ou l'était hors de la liste. Elle se modifie maintenant tant que le CHOIX n'est pas parti
 * en validation, et l'assistante est prévenue de chaque changement qui la concerne (§118.190).
 */
const ETATS_COMPOSABLES = new Set(["REVIEW_REQUEST", "QUOTE_TO_REQUEST", "QUOTE_REQUESTED", "REVIEW_REQUESTER"]);
/** Les étapes où l'assistante cherche ou a cherché les devis : un changement la concerne. */
const ETATS_ASSISTANTE = new Set(["QUOTE_REQUESTED", "REVIEW_REQUESTER"]);

type Dossier = { id: string; reference: string; title: string; circuitVersion: number; circuitState: string | null; requesterId: string | null; assistantId: string | null };

async function chargerDossier(id: string | null): Promise<Dossier | null> {
  if (!id) return null;
  return prisma.promoMaterial.findUnique({
    where: { id },
    select: { id: true, reference: true, title: true, circuitVersion: true, circuitState: true, requesterId: true, assistantId: true },
  });
}

class RefusComposition extends Error {}

/** Prévenir l'assistante d'un changement de la liste — la nommée, sinon le secrétariat. */
async function prevenirAssistante(pm: Dossier, title: string, body: string): Promise<void> {
  const avis = { type: "ASSIGNMENT" as const, title, body: `${pm.reference} — ${body.slice(0, 200)}`, link: chemin(pm.id) };
  if (pm.assistantId) await notifyUser({ userId: pm.assistantId, ...avis });
  else await notifyRoles(["DIRECTION_ASSISTANT"], avis);
}

const acteur = (user: SessionUser) => ({ id: user.id, role: user.role, secondaryRole: user.secondaryRole, vueGlobale: hasGlobalView(user.role) });

/** Le refus commun ; `null` = la liste peut changer. */
function refusComposition(user: SessionUser, pm: Dossier | null): string | null {
  if (!pm) return "Dossier introuvable.";
  if (pm.circuitVersion !== 2) return "Ce dossier suit l'ancien circuit : sa demande ne se compose pas depuis le catalogue.";
  if (!demandeLesDevis(acteur(user), pm)) return "Seul le demandeur (ou la Direction) compose la liste des articles de ce dossier.";
  if (!ETATS_COMPOSABLES.has(pm.circuitState ?? "")) {
    return pm.circuitState === "REVIEW_MANAGER" || pm.circuitState === "REVIEW_DG"
      ? "Votre choix est en validation : la liste des articles se modifie si la validation vous le renvoie pour correction."
      : "Les validations sont obtenues : la liste des articles ne se modifie plus — les bons de commande en découlent.";
  }
  return null;
}

async function audit(user: SessionUser, id: string, summary: string) {
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: id, summary });
}

/**
 * AJOUTER OU CORRIGER UN ARTICLE DEMANDÉ — l'article du catalogue, ses produits, la quantité
 * souhaitée, les actions attendues du fournisseur, un commentaire.
 *
 * Les PRODUITS sont remplacés en bloc, dans la même transaction : un article corrigé à moitié
 * porterait des produits que personne n'a choisis.
 */
export async function enregistrerArticleDemandePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusComposition(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };

  const requestItemId = fdStr(formData, "requestItemId");
  const existant = requestItemId
    ? await prisma.promoRequestItem.findFirst({
        where: { id: requestItemId, promoMaterialId: pm.id },
        select: { id: true, promus: true, catalogueId: true, catalogue: { select: { horsCatalogue: true, actif: true } } },
      })
    : null;
  if (requestItemId && !existant) return { ok: false, error: "Cet article n'appartient pas à ce dossier." };

  // « AUTRE ARTICLE » (Direction, 10/2026) : un article absent du catalogue, saisi librement — son libellé et sa famille.
  // Il entre au catalogue ARCHIVÉ et marqué hors catalogue (il ne se propose à personne), le temps qu'un gestionnaire
  // l'y ajoute (« Proposer au catalogue »). Corrigé, l'article libre de la ligne est renommé plutôt que recréé.
  const libre = fdStr(formData, "catalogueId") === "AUTRE";
  let catalogueId = libre ? null : fdStr(formData, "catalogueId");
  if (libre) {
    const nom = fdStr(formData, "autreNom");
    const famille = fdStr(formData, "autreFamille");
    const invalide = refusArticleLibre({ nom: nom ?? "", famille: famille ?? "" });
    if (invalide || !nom || !famille) return { ok: false, error: invalide ?? "Article illisible." };
    const description = fdStr(formData, "autreDescription");
    if (existant?.catalogue.horsCatalogue && !existant.catalogue.actif) {
      await prisma.promoCatalogueArticle.updateMany({
        where: { id: existant.catalogueId, horsCatalogue: true, actif: false },
        data: { nom, famille: famille as FamillePromo, description, updatedById: user.id },
      });
      catalogueId = existant.catalogueId;
    } else {
      catalogueId = await creerArticleHorsCatalogue(user.id, { nom, famille, description });
    }
  }
  const lu = catalogueId
    ? await prisma.promoCatalogueArticle.findUnique({
        where: { id: catalogueId },
        select: { id: true, reference: true, nom: true, famille: true, unite: true, exigeProduit: true, actif: true, horsCatalogue: true },
      })
    : null;
  // Un article hors catalogue n'est « archivé » que pour la pioche : la ligne qui le porte se compose avec lui.
  const catalogue = lu ? { ...lu, actif: lu.actif || lu.horsCatalogue } : null;
  // CE QUE LA LIGNE PROMEUT (§118.204) — les codes du sélecteur, et « Autre » en clair. « Autre » que le
  // formulaire ne porte pas garde sa valeur (§118.152c) : une correction faite sans lui ne l'efface pas.
  const autre = formData.has("autre") ? fdStr(formData, "autre") : lirePromusStockes(existant?.promus ?? null)?.autre ?? null;
  const promus = await resoudrePromus(formData.getAll("produitIds").map(String).filter(Boolean), autre);
  if (!promus.ok) return { ok: false, error: promus.error };
  const brutQuantite = fdStr(formData, "quantite");
  const quantite = brutQuantite ? parseQuantity(brutQuantite) : null;
  const v = validerArticleDemande({
    catalogue: catalogue ? { ...catalogue, famille: catalogue.famille as FamillePromo } : null,
    // Un article « par produit » exige un PRODUIT désigné — d'une BU, ou écrit dans « Autre ».
    produitIds: designeUnProduit(promus.promus) ? ["produit"] : [],
    quantite,
    quantiteIllisible: Boolean(brutQuantite) && quantite == null,
    actions: formData.getAll("actions").map(String).filter(Boolean),
    commentaire: fdStr(formData, "commentaire"),
  });
  if (!v.ok) return { ok: false, error: v.error };

  const donnees = {
    catalogueId: catalogue!.id,
    quantite: v.article.quantite != null ? new Prisma.Decimal(v.article.quantite) : null,
    actions: v.article.actions,
    commentaire: v.article.commentaire,
    promus: aucunPromu(promus.promus) ? Prisma.DbNull : (promus.promus as unknown as Prisma.InputJsonValue),
    updatedById: user.id,
  };
  // Le lien CANONIQUE (le stock le lit à la réception) : celui des produits de BU qui en ont un.
  const produits = promus.canoniques.map((productId) => ({ productId }));
  // CONDITIONNELLE SUR L'ÉTAPE LUE : un article ajouté pendant que les devis partent, ou pendant que la
  // retranscription se termine, serait chiffré par personne. Au choix des lignes, un article ajouté ou
  // corrigé RENVOIE le dossier à la retranscription — il faut le faire chiffrer (§118.190).
  const versRetranscription = pm.circuitState === "REVIEW_REQUESTER";
  // Le LIBELLÉ avant la transaction : la raison de la réouverture s'y écrit (lot D1b).
  const libelle = libelleArticleDemande({ reference: catalogue!.reference, nom: catalogue!.nom, produits: [], promus: libellesPromus(promus.promus), quantite: v.article.quantite, unite: catalogue!.unite });
  const raison = `Article ${existant ? "corrigé" : "ajouté"} par le demandeur : ${libelle} — à faire chiffrer.`;
  let article: { id: string };
  try {
    article = await prisma.$transaction(async (tx) => {
      const pris = await tx.promoMaterial.updateMany({
        where: { id: pm.id, circuitState: pm.circuitState },
        data: { updatedById: user.id, ...(versRetranscription ? { circuitState: "QUOTE_REQUESTED" } : {}) },
      });
      if (pris.count === 0) throw new RefusComposition("Ce dossier vient de changer d'étape — rechargez la fiche.");
      let ecrit: { id: string };
      if (existant) {
        await tx.promoRequestItemProduct.deleteMany({ where: { itemId: existant.id } });
        ecrit = await tx.promoRequestItem.update({ where: { id: existant.id }, data: { ...donnees, produits: { create: produits } }, select: { id: true } });
      } else {
        const rang = await tx.promoRequestItem.count({ where: { promoMaterialId: pm.id } });
        ecrit = await tx.promoRequestItem.create({
          data: { ...donnees, promoMaterialId: pm.id, position: rang, createdById: user.id, produits: { create: produits } },
          select: { id: true },
        });
      }
      // RENVOYÉ À LA RETRANSCRIPTION, le dossier rouvre sa demande au secrétariat DANS la même transaction
      // (lot D1b) : rouverte après coup, une fin de retranscription passée entre les deux la laissait « à
      // traiter » sur un dossier revenu au choix — et une panne entre les deux, close sur un dossier revenu
      // chez l'assistante.
      if (versRetranscription) await rouvrirDemandeAuSecretariat(tx, user.id, pm.id, raison);
      return ecrit;
    }, { timeout: 15_000, maxWait: 15_000 });
  } catch (e) {
    if (e instanceof RefusComposition) return { ok: false, error: e.message };
    throw e;
  }

  await audit(user, pm.id, `Article demandé ${existant ? "corrigé" : "ajouté"} — ${libelle}${versRetranscription ? " (retour à la retranscription)" : ""}`);
  if (ETATS_ASSISTANTE.has(pm.circuitState ?? "")) {
    await prevenirAssistante(pm, "Matériel promotionnel — un article demandé a changé", raison);
  }
  revalidatePath(chemin(pm.id));
  const suite = versRetranscription ? " Le dossier revient à l'assistante pour le faire chiffrer." : ETATS_ASSISTANTE.has(pm.circuitState ?? "") ? " L'assistante en est prévenue." : "";
  return { ok: true, id: article.id, message: `${existant ? "Article corrigé" : "Article ajouté à la demande"} : ${libelle}.${suite}` };
}

/**
 * LES GESTIONNAIRES DU CATALOGUE — le Super Admin, et qui il a désigné (module « Catalogue promotionnel », création ou
 * modification) : l'accès se relit par `getAccess`, la seule résolution du dépôt, comme pour les signataires des BC.
 */
async function gestionnairesDuCatalogue(): Promise<string[]> {
  const [admins, designes] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(["SUPER_ADMIN"]) }, select: { id: true } }),
    prisma.userAccess.findMany({
      where: { module: "PROMO_CATALOG", OR: [{ canCreate: true }, { canUpdate: true }], user: { isActive: true } },
      select: { user: { select: { id: true, role: true, secondaryRole: true } } },
    }),
  ]);
  const ids = new Set(admins.map((a) => a.id));
  for (const { user: u } of designes) {
    const acces = await getAccess(u.id, u.role);
    if (userCan({ id: u.id, role: u.role, secondaryRole: u.secondaryRole, access: acces }, "PROMO_CATALOG", "UPDATE")) ids.add(u.id);
  }
  return [...ids];
}

/**
 * PROPOSER AU CATALOGUE un « autre article » saisi librement (Direction, 10/2026). Qui tient le catalogue l'y ajoute
 * d'un clic (l'article devient actif, et se propose à tous) ; les autres préviennent les gestionnaires du catalogue, qui
 * le retrouvent ARCHIVÉ dans « Catalogue promotionnel » et le réactivent. Le demandeur ou la Direction — à toute étape.
 */
export async function proposerArticleAuCataloguePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  if (!demandeLesDevis(acteur(user), pm)) return { ok: false, error: "Seul le demandeur (ou la Direction) propose un article de sa demande au catalogue." };
  const requestItemId = fdStr(formData, "requestItemId");
  const article = requestItemId
    ? await prisma.promoRequestItem.findFirst({
        where: { id: requestItemId, promoMaterialId: pm.id },
        select: { catalogue: { select: { id: true, reference: true, nom: true, horsCatalogue: true, actif: true } } },
      })
    : null;
  if (!article) return { ok: false, error: "Cet article n'appartient pas à ce dossier." };
  const c = article.catalogue;
  if (!c.horsCatalogue) return { ok: true, message: `${c.reference} ${c.nom} est déjà au catalogue.` };
  const tientLeCatalogue = user.role === "SUPER_ADMIN" || userCan(user, "PROMO_CATALOG", "CREATE") || userCan(user, "PROMO_CATALOG", "UPDATE");
  if (tientLeCatalogue) {
    const ajoute = await prisma.promoCatalogueArticle.updateMany({ where: { id: c.id, horsCatalogue: true }, data: { actif: true, horsCatalogue: false, updatedById: user.id } });
    if (ajoute.count === 0) return { ok: true, message: `${c.reference} ${c.nom} vient d'être ajouté au catalogue.` };
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Catalogue promotionnel", entityId: c.id,
      summary: `Article ${c.reference} ajouté au catalogue depuis la demande ${pm.reference} — ${c.nom}`,
    });
    revalidatePath(chemin(pm.id));
    revalidatePath(CHEMIN_CATALOGUE_PROMO);
    return { ok: true, message: `${c.reference} ${c.nom} ajouté au catalogue : il se propose désormais à tous.` };
  }
  const ids = (await gestionnairesDuCatalogue()).filter((x) => x !== user.id);
  if (ids.length === 0) return { ok: false, error: "Aucun gestionnaire du catalogue n'est désigné : demandez au Super Admin." };
  for (const userId of ids) {
    await notifyUser({
      userId, type: "ASSIGNMENT", title: "Article proposé au catalogue promotionnel",
      body: `${c.reference} ${c.nom} — proposé depuis ${pm.reference} (archivé dans le catalogue : réactivez-le pour l'ajouter).`,
      link: CHEMIN_CATALOGUE_PROMO,
    });
  }
  await audit(user, pm.id, `Article ${c.reference} ${c.nom} proposé au catalogue — ${ids.length} gestionnaire${ids.length > 1 ? "s" : ""} prévenu${ids.length > 1 ? "s" : ""}`);
  return { ok: true, message: `Proposé : ${ids.length > 1 ? "les gestionnaires du catalogue sont prévenus" : "le gestionnaire du catalogue est prévenu"}.` };
}

/** RETIRER UN ARTICLE DEMANDÉ — tant que le choix n'est pas parti en validation (§118.190). */
export async function retirerArticleDemandePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusComposition(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const requestItemId = fdStr(formData, "requestItemId");
  const article = requestItemId
    ? await prisma.promoRequestItem.findFirst({
        where: { id: requestItemId, promoMaterialId: pm.id },
        select: { id: true, catalogue: { select: { reference: true, nom: true } } },
      })
    : null;
  if (!article) return { ok: false, error: "Cet article n'appartient pas à ce dossier." };
  try {
    await prisma.$transaction(async (tx) => {
      const pris = await tx.promoMaterial.updateMany({ where: { id: pm.id, circuitState: pm.circuitState }, data: { updatedById: user.id } });
      if (pris.count === 0) throw new RefusComposition("Ce dossier vient de changer d'étape — rechargez la fiche.");
      await tx.promoRequestItem.delete({ where: { id: article.id } });
    });
  } catch (e) {
    if (e instanceof RefusComposition) return { ok: false, error: e.message };
    throw e;
  }
  const nom = `${article.catalogue.reference} ${article.catalogue.nom}`;
  await audit(user, pm.id, `Article demandé retiré — ${nom}`);
  if (pm.circuitState === "QUOTE_REQUESTED") await prevenirAssistante(pm, "Matériel promotionnel — un article demandé a été retiré", `${nom} retiré par le demandeur : ne plus le faire chiffrer.`);
  revalidatePath(chemin(pm.id));
  // Au choix des lignes, les lignes de devis qui chiffraient l'article RESTENT (rattachées à rien) :
  // les décocher à sa place serait deviner ce qu'il veut retenir (§118.34) — on le lui dit.
  return {
    ok: true,
    message: pm.circuitState === "REVIEW_REQUESTER"
      ? `${nom} retiré de la demande. Les lignes de devis qui le chiffraient restent : ne les retenez pas si vous n'en voulez plus.`
      : `${nom} retiré de la demande.`,
  };
}
