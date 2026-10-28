"use server";

import { Prisma, type PromoMaterialStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser, requireUserAuNomDeLaVue } from "@/lib/session";
import { userCan, hasGlobalView, hasRole, type SessionUser } from "@/lib/rbac";
import { ecrireAuFil } from "@/lib/ad-pro/fil";
import { prisma } from "@/lib/prisma";
import { canAccessEntity } from "@/lib/entity-access";
import { recordAudit } from "@/lib/audit";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import { createExpenseOrder, annulerOrdreNonRegle } from "@/modules/finances/api";
import { persistUploadedDocument } from "@/lib/documents";
import { buildRef, createWithRetry, enSerie } from "@/lib/refs";
import { initialStep, libelleEtape } from "@/lib/promo-material/circuit";
import { promoManagerOf } from "@/lib/queries/promo-material";
import { validateursDeLaDemande } from "@/lib/queries/promo-circuit";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { parseQuantity } from "@/lib/promo/stock";
import { validerArticleDemande, type ArticleDemandeValide, type FamillePromo } from "@/lib/promo-material/achats";
import { lireLignesDemande, ligneVide, REFUS_SANS_LIGNE } from "@/lib/promo-material/lignes-demande";
import { lireDateBesoin } from "@/lib/promo-material/date-besoin";
import { aucunPromu, designeUnProduit, type PromusChoisis } from "@/lib/promo-material/promus";
import { resoudrePromus } from "@/lib/queries/promo-promus";
import { envoyerDemandeDeDevis, joindreLettreDeDevis } from "@/lib/promo-automatismes";
import { phraseDepotLettre } from "@/lib/demande-devis-depot";
import { siegeAuCentreAdPro, REFUS_BC_CENTRE_AD_PRO } from "@/lib/ad-pro/centre";
import { getAppSettings } from "@/lib/settings";
import { moneyEntityOf } from "@/lib/company";
import { validationRequiseBC, motifSousLeSeuil } from "@/lib/bons-de-commande/regle";
import { etatDeLOrdre, LIBELLE_ETAT_REGLEMENT, blockedReason, type CentralStatus } from "@/modules/finances/partage";
import { annulerDemandeSecretariat } from "@/lib/secretariat/annulation";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { mirrorDocumentsToDrive } from "@/lib/drive/document-mirror";
import { deleteFileByKey } from "@/lib/storage";
import { businessUnitDuDemandeur } from "@/lib/ad-pro/business-unit-auto";
import { sansBloquer } from "@/lib/journal";

const PATH = "/promo-material";

// ───────────────────────── Acteurs du circuit ─────────────────────────
// Marketing = l'initiateur (demandeur) ; Assistante de direction = détenteur de
// VALIDATE sur le module (attribué par l'admin) ; Finances / Information médicale
// = par rôle ; Direction = vue globale (peut débloquer n'importe quelle étape).

function isAssistant(user: SessionUser): boolean {
  // L'assistante de direction pilote ses étapes depuis les Demandes administratives
  // (elle n'a pas accès au module promo) ; la Direction/Super Admin peut suppléer.
  return hasRole(user, "DIRECTION_ASSISTANT") || hasGlobalView(user.role);
}
function isFinance(user: SessionUser): boolean {
  return user.role === "FINANCE_BUDGET_MANAGER" || hasGlobalView(user.role);
}
function isMedicalInfo(user: SessionUser): boolean {
  return user.role === "MEDICAL_INFO_PHARMACIST" || hasGlobalView(user.role);
}
function isDirection(user: SessionUser): boolean {
  return hasGlobalView(user.role);
}
function isMarketing(user: SessionUser, pm: { requesterId: string | null }): boolean {
  return pm.requesterId === user.id || hasGlobalView(user.role);
}

async function nextPromoRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.promoMaterial.findMany({ where: { reference: { startsWith: `MP-${year}-` } }, select: { reference: true } });
  return buildRef("MP", year, refs.map((r) => r.reference));
}

function revalidate(id: string) {
  revalidatePath(PATH);
  revalidatePath(`${PATH}/${id}`);
}

/** Notifie « l'assistante » : la personne assignée, sinon la Direction. */
async function notifyAssistant(pm: { id: string; reference: string; title: string; assistantId: string | null }, title: string) {
  const body = `${pm.reference} — ${pm.title}`;
  const link = `${PATH}/${pm.id}`;
  if (pm.assistantId) await notifyUser({ userId: pm.assistantId, type: "ASSIGNMENT", title, body, link });
  else await notifyRoles(["DIRECTION_ASSISTANT", "DIRECTION", "SUPER_ADMIN"], { type: "ASSIGNMENT", title, body, link });
}
async function notifyRequester(pm: { id: string; reference: string; title: string; requesterId: string | null }, title: string) {
  if (!pm.requesterId) return;
  await notifyUser({ userId: pm.requesterId, type: "GENERIC", title, body: `${pm.reference} — ${pm.title}`, link: `${PATH}/${pm.id}` });
}
async function notifyGroup(roles: ("FINANCE_BUDGET_MANAGER" | "MEDICAL_INFO_PHARMACIST" | "DIRECTION" | "SUPER_ADMIN")[], pm: { id: string; reference: string; title: string }, title: string) {
  await notifyRoles(roles, { type: "VALIDATION_REQUIRED", title, body: `${pm.reference} — ${pm.title}`, link: `${PATH}/${pm.id}` });
}

async function audit(user: SessionUser, id: string, action: "CREATE" | "UPDATE" | "VALIDATE" | "DELETE", summary: string) {
  await recordAudit({ actorId: user.id, action, module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: id, summary });
}

async function load(id: string) {
  return prisma.promoMaterial.findUnique({ where: { id } });
}

/**
 * L'ANCIEN PARCOURS NE PILOTE PAS UN DOSSIER DU CIRCUIT PAR DEVIS RETRANSCRITS (§118.152).
 *
 * Ces actions font avancer `status` — seize marches en file indienne, avec leur propre bon de
 * commande, leur propre bordereau, leur propre ordre de dépense. Un dossier du circuit 2 a déjà
 * tout cela, autrement : ses BC générés d'après les lignes validées, ses factures par BC, ses
 * paiements au centre. Les laisser courir côte à côte ferait deux vérités sur le même dossier —
 * et deux ordres de dépense pour la même commande. L'écran n'offre déjà plus ces gestes ; l'action
 * les REFUSE, parce qu'Adam et le chemin générique n'ont pas d'écran (§118.71).
 */
const REFUS_NOUVEAU_CIRCUIT = "Ce dossier suit le circuit par devis retranscrits : il se pilote depuis la carte « Suivi du circuit » de sa fiche (devis, choix des lignes, bons de commande générés, factures et paiements).";
function refusNouveauCircuit(pm: { circuitVersion: number }): string | null {
  return pm.circuitVersion === 2 ? REFUS_NOUVEAU_CIRCUIT : null;
}

/**
 * UNE MARCHE DE L'ANCIEN PARCOURS S'ÉCRIT SUR LA MARCHE LUE (§118.187 — vague « restes »).
 *
 * Ses quatorze écritures de statut disaient `update({ where: { id } })` : deux clics croisés
 * appliquaient deux fois la même marche (deux notifications, deux commentaires), et une marche lue
 * AVANT un geste concurrent s'écrivait par-dessus lui — un dossier annulé entre la lecture et
 * l'écriture repassait « devis déposés », sans un mot. La condition porte la marche ET la version du
 * circuit : un dossier basculé au nouveau circuit entre-temps (`startPromoCircuit`) ne reçoit pas une
 * marche de l'ancien. Écriture perdue → rien d'autre n'est écrit, et la phrase le dit.
 */
const ETAT_CHANGE = "Ce dossier vient de changer d'état — rouvrez sa fiche.";
function surLaMarcheLue(pm: { id: string; status: PromoMaterialStatus; circuitVersion: number }) {
  return { id: pm.id, status: pm.status, circuitVersion: pm.circuitVersion };
}

/** Une pièce enregistrée par un geste, avant qu'il n'avance — de quoi la retirer, ou la copier au Drive. */
type PieceDeposee = { documentId: string; nom: string; contenu: Buffer; mime: string | null };

/**
 * LES PIÈCES D'UN GESTE S'ENREGISTRENT AVANT QU'IL N'AVANCE — sans leur miroir Drive, qui ne part qu'une
 * fois la marche écrite (le modèle de `retirerScanOrphelin`, §118.196e). Une pièce qui échoue n'avance pas
 * le dossier, et celles déjà enregistrées par CE geste sont retirées : relancé, le geste les doublerait
 * (« version 2 » du même fichier) sur un dossier qui ne les a jamais portées. L'appel à
 * `persistUploadedDocument` reste dans le corps de chaque action : c'est là que la dérivation des contrats
 * lit qu'elle écrit un document (un seul niveau de délégation suivi).
 */
async function refusDePiece(userId: string, pmId: string, deja: PieceDeposee[], nomFichier: string, erreur: string | undefined): Promise<string> {
  const retire = await retirerPieces(userId, pmId, deja, "le geste qu'elle accompagnait n'a pas abouti");
  return `Pièce « ${nomFichier} » : ${erreur ?? "téléversement impossible"}${retire ? "" : " — et une pièce déjà enregistrée par ce geste est restée au dossier : retirez-la."}`;
}

/** Retire les pièces d'un geste qui n'a pas été écrit — la ligne ET le binaire (§118.159). `false` si ce n'a pas été possible. */
async function retirerPieces(userId: string, pmId: string, pieces: PieceDeposee[], pourquoi: string): Promise<boolean> {
  let tout = true;
  for (const p of pieces) {
    try {
      const doc = await prisma.document.findUnique({ where: { id: p.documentId }, select: { name: true, fileKey: true } });
      if (!doc) continue;
      await prisma.document.delete({ where: { id: p.documentId } });
      if (doc.fileKey) await deleteFileByKey(doc.fileKey);
      await recordAudit({
        actorId: userId, action: "DELETE", module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: pmId,
        summary: `Document « ${doc.name} » retiré : ${pourquoi}`,
      }).catch(sansBloquer("promo-material-actions.retirerPieces.recordAudit"));
    } catch (err) {
      console.error("[promo] pièce orpheline non retirée", p.documentId, err);
      tout = false;
    }
  }
  return tout;
}

/** La marche écrite : la copie Drive des pièces part maintenant, en arrière-plan. */
function copierPiecesAuDrive(userId: string, pmId: string, pieces: PieceDeposee[]): void {
  if (pieces.length === 0) return;
  void mirrorDocumentsToDrive({ ownerId: userId, entityType: "PROMO_MATERIAL", entityId: pmId, files: pieces.map((p) => ({ name: p.nom, data: p.contenu, mime: p.mime })) })
    .catch((e) => console.error("[promo] miroir Drive échoué (non bloquant)", e));
}

/**
 * CET ORDRE EST-IL RÉGLÉ ? — et sinon, la phrase qui dit où il attend (§118.148).
 *
 * Un dossier ne se déclare « payé » que sur un ordre PAYÉ : le paiement se décide au centre de
 * paiement, puis se règle aux Finances depuis « Paiements à faire ». `null` = réglé.
 */
async function ordreNonRegle(orderId: string | null): Promise<string | null> {
  if (!orderId) return "Aucun ordre de dépense n'accompagne ce dossier : un paiement passe par le centre de paiement, et il faut un ordre pour y passer.";
  const o = await prisma.expenseOrder.findUnique({ where: { id: orderId }, select: { reference: true, status: true, centralStatus: true } });
  if (!o) return "L'ordre de dépense de ce dossier est introuvable.";
  const etat = etatDeLOrdre(o);
  if (etat === "REGLE") return null;
  const pourquoi = blockedReason(o.centralStatus as CentralStatus)
    ?? `L'ordre ${o.reference} est ${LIBELLE_ETAT_REGLEMENT[etat]} : il se règle depuis Finances › Paiements à faire.`;
  return `${pourquoi} Le dossier se déclare payé une fois l'ordre ${o.reference} réglé.`;
}

// ───────────────────────── 1. Marketing : création (prospection) ─────────────────────────

/**
 * CRÉER UNE DEMANDE DE MATÉRIEL PROMOTIONNEL — au circuit par devis retranscrits (§118.152).
 *
 * La demande naît au circuit 2. Son VALIDATEUR est figé maintenant, par la règle de la Direction
 * (`promo-material/validateurs.ts`) : la directrice marketing pour un membre de la Direction
 * Marketing, sinon le N+1 — jamais au-delà du directeur des opérations ; personne pour la
 * directrice marketing elle-même ni pour un demandeur au plafond. Figé pour la raison de
 * `managerId` : un organigramme qui change ne transfère pas une validation en attente à quelqu'un
 * qui n'a rien suivi.
 *
 * LA DEMANDE DE DEVIS PART D'ELLE-MÊME (§118.204) : ici quand la demande n'a pas de validation, sinon à
 * sa validation (`validatePromoStep`). Demander des devis sur une demande que personne n'a encore acceptée
 * ferait travailler le secrétariat et les agences pour rien — la règle reste, seul le clic disparaît.
 */
export async function createPromoMaterial(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUserAuNomDeLaVue();
    // UN REFUS DIT LA VRAIE RAISON. Il disait « réservée au Marketing » — faux : délégués, KAM et
    // National Sales créent aussi (droit du module) ; celui qui est refusé n'a pas le droit du module.
    if (!userCan(user, "PROMO_MATERIAL", "CREATE")) return { ok: false, error: "Votre profil n'a pas le droit de créer une demande de matériel promotionnel (module Matériel promotionnel) : l'accès se règle en Administration › Comptes." };
    // Sous « Vue exacte », la demande se crée AU NOM de la personne visualisée (test de son parcours) : voir `vue-exacte.ts`.
    const title = fdStr(formData, "title");
    const description = fdStr(formData, "description");

    // LES LIGNES SE SAISISSENT À LA CRÉATION (§118.171) — l'article du catalogue (trois familles),
    // la quantité, ce qu'on attend du fournisseur. La demande naissait vide et se composait sur la
    // fiche après coup : le validateur, prévenu à la création, tranchait une demande qui ne disait
    // pas encore ce qu'elle demandait. Tout ce qui manque se dit EN UNE FOIS, ligne par ligne
    // (§118.18), avec la règle de la fiche (`validerArticleDemande`) et nulle autre (§118.5).
    const manques: string[] = [];
    if (!title) manques.push("Le titre / la campagne est obligatoire.");
    const lues = lireLignesDemande(fdStr(formData, "lignes"));
    if (!lues.ok) return { ok: false, error: lues.error };
    const saisies = lues.lignes.filter((l) => !ligneVide(l));
    if (saisies.length === 0) manques.push(REFUS_SANS_LIGNE);
    const idsCatalogue = [...new Set(saisies.map((l) => l.catalogueId).filter(Boolean))];
    const catalogue = idsCatalogue.length
      ? await prisma.promoCatalogueArticle.findMany({
          where: { id: { in: idsCatalogue } },
          select: { id: true, reference: true, nom: true, famille: true, exigeProduit: true, actif: true },
        })
      : [];
    const parId = new Map(catalogue.map((c) => [c.id, c]));
    const lignes: (ArticleDemandeValide & { catalogueId: string; promus: PromusChoisis; canoniques: string[] })[] = [];
    for (const [i, s] of saisies.entries()) {
      const c = parId.get(s.catalogueId) ?? null;
      const quantite = s.quantite ? parseQuantity(s.quantite) : null;
      // CE QUE LA LIGNE PROMEUT (§118.204) — la société, une gamme, des produits des BU, « Autre ».
      const promus = await resoudrePromus(s.produitIds, s.autre);
      if (!promus.ok) { manques.push(`Ligne ${i + 1} : ${promus.error}`); continue; }
      const v = validerArticleDemande({
        catalogue: c ? { ...c, famille: c.famille as FamillePromo } : null,
        // Un article « par produit » exige un PRODUIT désigné — d'une BU, ou écrit dans « Autre ».
        produitIds: designeUnProduit(promus.promus) ? ["produit"] : [],
        quantite,
        quantiteIllisible: Boolean(s.quantite) && quantite == null,
        actions: s.actions,
        commentaire: s.commentaire || null,
      });
      if (v.ok && c) lignes.push({ ...v.article, catalogueId: c.id, promus: promus.promus, canoniques: promus.canoniques });
      else if (!v.ok) manques.push(`Ligne ${i + 1} : ${v.error}`);
    }
    // LA DATE DE BESOIN (Direction, 10/2026) — facultative : « besoin pour le … », modifiable ensuite par le demandeur.
    const besoin = lireDateBesoin(fdStr(formData, "neededBy"));
    if (!besoin.ok) manques.push(besoin.error);
    if (manques.length || !title || !besoin.ok) return { ok: false, error: manques.join(" ") };

    // CE QUE LA DEMANDE NE PORTE PLUS (décision du 01/10). La GAMME : « pas du tout pertinent
    // ici » — le matériel se demande par article du catalogue, pas par Business Unit. Le BUDGET
    // ESTIMÉ : « on ne l'a pas au début » — il naît des devis retranscrits. L'ASSISTANTE : sans
    // choix, tout le secrétariat est prévenu quand les devis sont demandés (`retranscritLesDevis`
    // honore l'assistante nommée, et le secrétariat sinon), ce qui ôte aussi au demandeur le
    // moyen de nommer qui recopiera les prix qu'il retiendra ensuite (§118.152k). L'ENTITÉ est
    // celle où le demandeur TRAVAILLE (`moneyEntityOf`, la règle de l'argent) : le menu qui
    // permettait d'en choisir une autre laissait aussi forger une société qu'on ne voit pas, et
    // un dossier né sans entité disparaissait de la liste unifiée (§118.153).
    const companyId = await moneyEntityOf(user.id);

    const figes = await validateursDeLaDemande(user.id);
    const validation = figes.validateur.kind !== "AUCUNE";
    const circuitState = initialStep({ ctx: { version: 2, validationDemande: validation, demandeurEstDirectionMarketing: figes.demandeurEstCheffe, montant: null, seuilDg: null } });
    const managerId = await promoManagerOf(user.id);
    // LA GAMME DU DEMANDEUR, quand elle se lit à coup sûr (KAM, superviseur d'une seule gamme) — enfin écrite (point
    // 21, 27/10) : c'est elle qui borne les catégories budgétaires que la Direction Marketing pourra imputer. Le
    // formulaire ne la demande pas (décision du 01/10) ; on ne la devine pas quand elle ne se lit pas.
    const businessUnitId = (await businessUnitDuDemandeur(user))?.id ?? null;

    const pm = await createWithRetry(async () => prisma.promoMaterial.create({
      data: {
        reference: await nextPromoRef(),
        title,
        description,
        neededBy: besoin.date,
        companyId: companyId || null,
        businessUnitId,
        status: "PROSPECTION_REQUESTED",
        circuitState,
        circuitVersion: 2,
        requestValidation: validation,
        requestValidatorId: figes.validateur.kind === "PERSONNE" ? figes.validateur.userId : null,
        marketingValidatorId: figes.directriceId,
        managerId,
        requesterId: user.id,
        createdById: user.id,
        updatedById: user.id,
        // Les lignes naissent AVEC le dossier, dans la même écriture : un dossier sans ses lignes
        // — ou des lignes sans dossier — ne se voit jamais, même entre deux requêtes.
        articlesDemandes: {
          create: lignes.map((l, position) => ({
            catalogueId: l.catalogueId,
            position,
            quantite: l.quantite != null ? new Prisma.Decimal(l.quantite) : null,
            actions: l.actions,
            commentaire: l.commentaire,
            promus: aucunPromu(l.promus) ? Prisma.DbNull : (l.promus as unknown as Prisma.InputJsonValue),
            createdById: user.id,
            updatedById: user.id,
            produits: { create: l.canoniques.map((productId) => ({ productId })) },
          })),
        },
      },
    }));

    // PRÉVENIR CELUI QUI VALIDE LA DEMANDE — la personne figée, ou la Direction des opérations.
    const avis = { type: "VALIDATION_REQUIRED" as const, title: "Matériel promotionnel — demande à valider", body: `${pm.reference} — ${pm.title}`, link: `${PATH}/${pm.id}` };
    if (figes.validateur.kind === "PERSONNE") await notifyUser({ userId: figes.validateur.userId, ...avis });
    else if (figes.validateur.kind === "PLAFOND") await notifyRoles(["DIRECTION"], avis);
    await audit(user, pm.id, "CREATE", `Matériel promotionnel créé — ${pm.reference}, ${lignes.length} ligne(s) demandée(s). ${figes.validateur.motif} Étape : ${libelleEtape(circuitState, 2)}.`);
    // LA DEMANDE DE DEVIS PART D'ELLE-MÊME (§118.204) — tout de suite quand la demande n'a pas de validation,
    // sinon quand la validation tombe (`validatePromoStep`). Un envoi qui échoue ne défait pas la création :
    // le dossier reste sur « devis à demander », et la rubrique « Articles demandés » offre l'envoi.
    let suite = figes.validateur.kind !== "AUCUNE" ? " La demande de devis partira au secrétariat dès qu'elle sera validée." : "";
    if (circuitState === "QUOTE_TO_REQUEST") {
      const envoi = await envoyerDemandeDeDevis(user.id, pm.id);
      if (envoi.ok) {
        if (envoi.assistantId) await notifyUser({ userId: envoi.assistantId, ...envoi.avis });
        else await notifyRoles(["DIRECTION_ASSISTANT"], envoi.avis);
        const lettre = await joindreLettreDeDevis(user, pm.id, envoi.demande.id).catch(sansBloquer("promo-material-actions.createPromoMaterial.joindreLettreDeDevis", null));
        suite = ` Demande de devis envoyée au secrétariat (${envoi.demande.reference}).${lettre?.ok ? ` ${phraseDepotLettre(lettre)}` : ""}`;
      } else {
        suite = ` La demande de devis n'est pas partie : ${envoi.error} Envoyez-la depuis « Articles demandés ».`;
      }
    }
    revalidate(pm.id);
    return { ok: true, id: pm.id, message: `Demande ${pm.reference} enregistrée.${suite}` };
  } catch (err) {
    console.error("[promo] createPromoMaterial failed", err);
    return { ok: false, error: "La demande n'a pas pu être créée. Réessayez dans un instant." };
  }
}

/**
 * CHANGER LA DATE DE BESOIN — le demandeur (ou la Direction), tant que le dossier n'est ni refusé, ni annulé, ni terminé.
 * Vide = retirer la date. Un geste de la fiche de la demande, devant « besoin pour le … ».
 */
export async function modifierDateBesoinPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  if (!isMarketing(user, pm)) return { ok: false, error: "Seul le demandeur modifie la date de besoin." };
  if (pm.status === "CANCELLED" || pm.circuitState === "REFUSED" || pm.circuitState === "COMPLETED") {
    return { ok: false, error: "Ce dossier est clos : la date de besoin ne change plus." };
  }
  const besoin = lireDateBesoin(fdStr(formData, "neededBy"));
  if (!besoin.ok) return { ok: false, error: besoin.error };
  const avant = pm.neededBy ? pm.neededBy.toISOString().slice(0, 10) : null;
  const apres = besoin.date ? besoin.date.toISOString().slice(0, 10) : null;
  if (avant === apres) return { ok: true };
  // ÉCRITE SUR CE QUI A ÉTÉ LU (§118 — règle de point d'appel) : un dossier annulé, refusé ou terminé entre la lecture et
  // l'écriture ne change plus de date, et une date déjà changée par un autre ne fait pas mentir l'« avant » de l'audit.
  const ecrite = await prisma.promoMaterial.updateMany({
    where: { ...surLaMarcheLue(pm), circuitState: pm.circuitState, neededBy: pm.neededBy },
    data: { neededBy: besoin.date, updatedById: user.id },
  });
  if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
  await audit(user, id, "UPDATE", apres ? `Date de besoin : ${apres}${avant ? ` (avant : ${avant})` : ""}` : `Date de besoin retirée (avant : ${avant})`);
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 2. Assistante : devis déposés ─────────────────────────

export async function submitQuotes(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isAssistant(user)) return { ok: false, error: "Réservé à l'assistante de direction." };
  if (pm.status !== "PROSPECTION_REQUESTED") return { ok: false, error: "Étape déjà passée." };

  const ecrite = await prisma.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "QUOTES_UPLOADED", updatedById: user.id } });
  if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
  await notifyRequester(pm, "Matériel promotionnel — devis disponibles, à arbitrer");
  await audit(user, id, "UPDATE", "Devis déposés (assistante)");
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 3. Marketing : choix de l'agence + demande de BC ─────────────────────────

export async function chooseAgency(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isMarketing(user, pm)) return { ok: false, error: "Réservé au Marketing (demandeur)." };
  if (pm.status !== "QUOTES_UPLOADED") return { ok: false, error: "Les devis doivent d'abord être déposés." };
  const agency = fdStr(formData, "chosenAgency");
  if (!agency) return { ok: false, error: "Indiquez l'agence retenue." };

  // Pièces jointes OPTIONNELLES au choix de l'agence (devis retenu, comparatif, contrat…) : une ou
  // plusieurs. Enregistrées AVANT d'avancer, pour que le dossier ne progresse pas si une pièce
  // échoue. Chaque fichier est isolé — une erreur affiche sa cause exacte sans corrompre le lot.
  const files = formData.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
  const pieces: PieceDeposee[] = [];
  for (const file of files) {
    const contenu = Buffer.from(await file.arrayBuffer());
    const r = await persistUploadedDocument(user.id, { entityType: "PROMO_MATERIAL", entityId: id, category: "QUOTE", confidentiality: "INTERNAL", stepKey: "agency_choice", file, buffer: contenu, mirrorToDrive: false });
    if (!r.ok || !r.documentId) return { ok: false, error: await refusDePiece(user.id, id, pieces, file.name, r.error) };
    pieces.push({ documentId: r.documentId, nom: file.name, contenu, mime: file.type || null });
  }
  const attached = pieces.length;

  // LA MARCHE ET SON COMMENTAIRE, ENSEMBLE ET SUR LA MARCHE LUE : un second choix croisé n'écrit ni
  // une seconde agence par-dessus la première, ni un second « Agence retenue » au fil — et ses pièces,
  // déjà enregistrées, sont retirées (personne ne les a vues à leur place).
  const note = fdStr(formData, "comment");
  const attachNote = attached > 0 ? ` (${attached} pièce${attached > 1 ? "s" : ""} jointe${attached > 1 ? "s" : ""})` : "";
  const ecrite = await prisma.$transaction(async (tx) => {
    const r = await tx.promoMaterial.updateMany({
      where: surLaMarcheLue(pm),
      data: { status: "AGENCY_CHOSEN", chosenAgency: agency, chosenAmount: fdNum(formData, "chosenAmount") ?? null, updatedById: user.id },
    });
    if (r.count === 0) return false;
    if (note || attached > 0) {
      await tx.comment.create({ data: { entityType: "PROMO_MATERIAL", entityId: id, body: `Agence retenue : ${agency}.${note ? ` ${note}` : ""}${attachNote}`, authorId: user.id } });
    }
    return true;
  });
  if (!ecrite) {
    const retire = await retirerPieces(user.id, id, pieces, "le choix d'agence qu'elle accompagnait n'a pas été écrit");
    return { ok: false, error: retire ? ETAT_CHANGE : `${ETAT_CHANGE} Une pièce jointe à ce choix est restée au dossier : retirez-la.` };
  }
  copierPiecesAuDrive(user.id, id, pieces);
  await notifyAssistant(pm, "Matériel promotionnel — création du bon de commande demandée");
  await audit(user, id, "UPDATE", `Agence retenue : ${agency}${attachNote} — création du BC demandée`);
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 4. Assistante : BC → validation finances ─────────────────────────

export async function submitBcForFinance(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isAssistant(user)) return { ok: false, error: "Réservé à l'assistante de direction." };
  if (pm.status !== "AGENCY_CHOSEN") return { ok: false, error: "Étape déjà passée." };

  // Bon(s) de commande joints (un ou plusieurs) pour transmission aux Finances : enregistrés
  // comme documents du dossier AVANT d'avancer — si une pièce échoue, on n'avance pas (isolation
  // par fichier, cause exacte affichée). Catégorie « bon de commande ».
  const files = formData.getAll("bcFiles").filter((f): f is File => f instanceof File && f.size > 0);
  const pieces: PieceDeposee[] = [];
  for (const file of files) {
    const contenu = Buffer.from(await file.arrayBuffer());
    const r = await persistUploadedDocument(user.id, { entityType: "PROMO_MATERIAL", entityId: id, category: "PURCHASE_ORDER", confidentiality: "INTERNAL", stepKey: "bc_finance", file, buffer: contenu, mirrorToDrive: false });
    if (!r.ok || !r.documentId) return { ok: false, error: await refusDePiece(user.id, id, pieces, file.name, r.error) };
    pieces.push({ documentId: r.documentId, nom: file.name, contenu, mime: file.type || null });
  }
  const attached = pieces.length;

  // LE SEUIL DES BONS DE COMMANDE (§118.149) : au-dessus, le centre de validation Ad & Pro ; en
  // deçà, aucun centre n'a à le voir. Le montant du BC est celui du devis RETENU ; inconnu, le BC
  // passe au centre — on ne franchit pas une porte de contrôle sur une absence de donnée.
  const montantBC = pm.chosenAmount != null ? Number(pm.chosenAmount) : pm.amount != null ? Number(pm.amount) : null;
  const seuilBC = (await getAppSettings()).bcValidationThreshold;
  const sousLeSeuil = !validationRequiseBC(montantBC, seuilBC);
  const ecrite = await prisma.promoMaterial.updateMany({
    where: surLaMarcheLue(pm),
    data: sousLeSeuil
      ? { status: "BC_VALIDATED", bcValidatedAt: new Date(), bcReference: fdStr(formData, "bcReference"), financeReminderAt: null, updatedById: user.id }
      : { status: "BC_FINANCE_REVIEW", bcReference: fdStr(formData, "bcReference"), financeReminderAt: null, updatedById: user.id },
  });
  if (ecrite.count === 0) {
    const retire = await retirerPieces(user.id, id, pieces, "le bon de commande qu'elle accompagnait n'a pas été transmis");
    return { ok: false, error: retire ? ETAT_CHANGE : `${ETAT_CHANGE} Un fichier joint à ce bon de commande est resté au dossier : retirez-le.` };
  }
  copierPiecesAuDrive(user.id, id, pieces);
  const attachNote = attached > 0 ? ` (${attached} fichier${attached > 1 ? "s" : ""})` : "";
  if (sousLeSeuil) {
    await audit(user, id, "UPDATE", `Bon de commande enregistré${attachNote} — ${motifSousLeSeuil(seuilBC)}`);
    revalidate(id);
    return { ok: true, message: motifSousLeSeuil(seuilBC) };
  }
  // TOUT BC NÉ D'AD & PRO AU-DESSUS DU SEUIL PASSE PAR LE CENTRE DE VALIDATION AD & PRO
  // (§118.148) : ce sont ses sièges qui sont prévenus, et le centre liste le dossier tant qu'il
  // attend.
  await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED", title: "Matériel promotionnel — bon de commande à valider",
    body: `${pm.reference} — ${pm.title}`, link: lienLigneCentreAdPro(id),
  });
  await audit(user, id, "UPDATE", `Bon de commande transmis au centre de validation Ad & Pro${attachNote}`);
  revalidate(id);
  return { ok: true };
}

/** Relance du centre de validation Ad & Pro sur un BC en attente (système d'alerte). */
export async function remindFinance(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!(isAssistant(user) || isMarketing(user, pm))) return { ok: false, error: "Non autorisé." };
  if (pm.status !== "BC_FINANCE_REVIEW") return { ok: false, error: "Aucune validation de bon de commande en attente." };

  // Pas une marche, mais une relance sur un BC que le centre vient de trancher serait une fausse alerte :
  // elle s'écrit, elle aussi, sur la marche lue.
  const relance = await prisma.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { financeReminderAt: new Date(), financeReminderCount: { increment: 1 } } });
  if (relance.count === 0) return { ok: false, error: ETAT_CHANGE };
  await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED", title: "⏰ Relance — bon de commande à valider (matériel promotionnel)",
    body: `${pm.reference} — ${pm.title}`, link: lienLigneCentreAdPro(id),
  });
  await audit(user, id, "UPDATE", "Relance du centre de validation Ad & Pro");
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 5. Centre de validation Ad & Pro : validation du BC ─────────────────────────
//
// Les FINANCES validaient ce BC. Depuis la décision de la Direction (09/2026, §118.148) — « les BC
// doivent tous passer par le centre de validation Ad&Pro si la demande est depuis Ad&Pro » —, c'est
// le CENTRE qui le valide : la Direction Générale ou le Super Admin. Le statut garde son nom
// historique (`BC_FINANCE_REVIEW`) : le renommer demanderait une migration d'énumération pour un
// mot que seul le code lit, et l'écran affiche le libellé, qui, lui, dit la vérité.

export async function validateBc(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!siegeAuCentreAdPro(user)) return { ok: false, error: REFUS_BC_CENTRE_AD_PRO };
  if (pm.status !== "BC_FINANCE_REVIEW") return { ok: false, error: "Aucun bon de commande à valider." };

  const ecrite = await prisma.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "BC_VALIDATED", bcValidatedAt: new Date(), updatedById: user.id } });
  if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
  await notifyAssistant(pm, "Matériel promotionnel — bon de commande validé par le centre de validation Ad & Pro");
  await audit(user, id, "VALIDATE", "Bon de commande validé (centre de validation Ad & Pro)");
  revalidatePath("/centre-ad-pro");
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 6. Assistante : BC validé → envoyé à l'agence ─────────────────────────

export async function confirmBcSent(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isAssistant(user)) return { ok: false, error: "Réservé à l'assistante de direction." };
  if (pm.status !== "BC_VALIDATED") return { ok: false, error: "Le bon de commande doit d'abord être validé par le centre de validation Ad & Pro." };

  const ecrite = await prisma.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "BC_SENT", updatedById: user.id } });
  if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
  await notifyGroup(["MEDICAL_INFO_PHARMACIST", "SUPER_ADMIN"], pm, "Matériel promotionnel — initier le bordereau de paiement");
  await notifyRequester(pm, "Matériel promotionnel — bon de commande transmis à l'agence");
  await audit(user, id, "UPDATE", "Bon de commande validé et transmis à l'agence");
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 7. Information médicale : bordereau de paiement ─────────────────────────

export async function initiatePayment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  // UN BORDEREAU À LA FOIS (vague « restes »). Ce geste CRÉE un ordre de dépense, puis écrivait la
  // marche sans condition : deux clics faisaient deux ordres au centre de paiement, et le second
  // écrasait le premier dans le dossier — un ordre payable qu'aucun dossier ne désignait plus. Dans le
  // processus, la file le sérialise et le second relit le dossier ; entre deux processus, l'écriture
  // exige la marche ET l'absence d'ordre lues, et le perdant annule l'ordre qu'il vient de préparer
  // (la porte unique, §118.185) : personne ne l'a encore autorisé.
  return enSerie(`promo-bordereau:${id}`, async (): Promise<ActionResult> => {
    const pm = await load(id);
    if (!pm) return { ok: false, error: "Dossier introuvable." };
    const nouveau = refusNouveauCircuit(pm);
    if (nouveau) return { ok: false, error: nouveau };
    if (!isMedicalInfo(user)) return { ok: false, error: "Réservé à l'information médicale." };
    if (pm.status === "PAYMENT_INITIATED" && pm.paymentOrderId) {
      return { ok: false, error: "Le bordereau de paiement de ce dossier est déjà initié : son ordre attend le centre de paiement." };
    }
    // RATTRAPAGE : un bordereau initié SANS ordre (montant alors inconnu) se réinitie — sans quoi le
    // dossier resterait bloqué, puisque « Paiement effectué » exige désormais un ordre réglé.
    const rattrapage = pm.status === "PAYMENT_INITIATED" && !pm.paymentOrderId;
    if (pm.status !== "BC_SENT" && !rattrapage) return { ok: false, error: "Le bon de commande doit d'abord être transmis à l'agence." };

    // UN BORDEREAU SANS MONTANT NE PASSE PAS PAR LE CENTRE (§118.148) : il ne créait aucun ordre, et
    // le paiement se déclarait ensuite « effectué » sans que le centre de paiement ait rien vu.
    const amount = fdNum(formData, "amount") ?? Number(pm.chosenAmount ?? pm.amount ?? 0);
    if (!(amount > 0)) {
      return { ok: false, error: "Renseignez le montant du bordereau : un paiement passe par le centre de paiement, qui autorise un montant." };
    }
    const order = await createExpenseOrder({
      label: `Matériel promotionnel — ${pm.title}${pm.chosenAgency ? ` (${pm.chosenAgency})` : ""}`,
      amount, category: "FOURNISSEUR", beneficiary: pm.chosenAgency, sourceType: "PROMO_MATERIAL", sourceId: pm.id, requestedById: user.id,
      budgetCategoryId: pm.budgetCategoryId,
    });

    const ecrite = await prisma.promoMaterial.updateMany({
      where: { ...surLaMarcheLue(pm), paymentOrderId: null },
      data: { status: "PAYMENT_INITIATED", paymentInitiatedAt: new Date(), paymentOrderId: order.id, updatedById: user.id },
    });
    if (ecrite.count === 0) {
      const a = await annulerOrdreNonRegle(order.id, { acteurId: user.id, motif: `dossier ${pm.reference} : un autre bordereau a été initié au même moment` });
      return { ok: false, error: `${ETAT_CHANGE} L'ordre ${order.reference} préparé à l'instant ${a.ok && a.annule ? "est annulé" : "n'a pas pu être annulé : signalez-le au centre de paiement"}.` };
    }
    await notifyGroup(["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"], pm, "Matériel promotionnel — bordereau de paiement au centre de paiement");
    await audit(user, id, "UPDATE", `Bordereau de paiement initié (ordre ${order.reference}, en attente du centre de paiement)`);
    revalidate(id);
    return { ok: true };
  });
}

// ───────────────────────── 8. Finances : paiement effectué ─────────────────────────

export async function confirmPayment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isFinance(user)) return { ok: false, error: "Réservé aux finances." };
  if (pm.status !== "PAYMENT_INITIATED") return { ok: false, error: "Aucun bordereau de paiement en attente." };
  // « PAIEMENT EFFECTUÉ » SE CONSTATE SUR L'ORDRE, il ne se déclare pas (§118.148). Le dossier
  // passait à PAYMENT_DONE pendant que son ordre attendait encore le centre de paiement.
  const nonRegle = await ordreNonRegle(pm.paymentOrderId);
  if (nonRegle) return { ok: false, error: nonRegle };

  const note = fdStr(formData, "comment");
  const ecrite = await prisma.$transaction(async (tx) => {
    const r = await tx.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "PAYMENT_DONE", paymentDoneAt: new Date(), updatedById: user.id } });
    if (r.count === 0) return false;
    if (note) await tx.comment.create({ data: { entityType: "PROMO_MATERIAL", entityId: id, body: `Paiement effectué. ${note}`, authorId: user.id } });
    return true;
  });
  if (!ecrite) return { ok: false, error: ETAT_CHANGE };
  await notifyGroup(["MEDICAL_INFO_PHARMACIST", "SUPER_ADMIN"], pm, "Matériel promotionnel — paiement effectué (déposer la quittance)");
  await audit(user, id, "VALIDATE", "Paiement effectué (finances)");
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 9. Marketing : matériel réalisé par l'agence ─────────────────────────

export async function submitMaterial(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isMarketing(user, pm)) return { ok: false, error: "Réservé au Marketing." };
  if (pm.status !== "PAYMENT_DONE") return { ok: false, error: "Le paiement doit d'abord être effectué." };

  const ecrite = await prisma.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "MATERIAL_PRODUCED", updatedById: user.id } });
  if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
  await notifyGroup(["DIRECTION", "SUPER_ADMIN"], pm, "Matériel promotionnel — matériel réalisé à valider");
  await audit(user, id, "UPDATE", "Matériel réalisé par l'agence, déposé par le Marketing");
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 10. Direction → 11. Information médicale (conformité) ─────────────────────────

export async function directionReview(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isDirection(user)) return { ok: false, error: "Réservé à la Direction." };
  if (pm.status !== "MATERIAL_PRODUCED") return { ok: false, error: "Aucun matériel à examiner." };

  const note = fdStr(formData, "comment");
  const ecrite = await prisma.$transaction(async (tx) => {
    const r = await tx.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "CONFORMITY_REVIEW", updatedById: user.id } });
    if (r.count === 0) return false;
    if (note) await tx.comment.create({ data: { entityType: "PROMO_MATERIAL", entityId: id, body: `Direction : ${note}`, authorId: user.id } });
    return true;
  });
  if (!ecrite) return { ok: false, error: ETAT_CHANGE };
  await notifyGroup(["MEDICAL_INFO_PHARMACIST", "SUPER_ADMIN"], pm, "Matériel promotionnel — vérification de conformité / dépôt");
  await audit(user, id, "VALIDATE", "Matériel examiné par la Direction");
  revalidate(id);
  return { ok: true };
}

/** Information médicale : conformité OK + dépôt → référence & visa publicitaire. */
export async function confirmConformity(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isMedicalInfo(user)) return { ok: false, error: "Réservé à l'information médicale." };
  if (pm.status !== "CONFORMITY_REVIEW") return { ok: false, error: "Aucune vérification en attente." };

  const ecrite = await prisma.promoMaterial.updateMany({
    where: surLaMarcheLue(pm),
    data: { status: "VISA_OBTAINED", visaReference: fdStr(formData, "visaReference"), authorityRef: fdStr(formData, "authorityRef"), updatedById: user.id },
  });
  if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
  await notifyRequester(pm, "Matériel promotionnel — visa publicitaire obtenu, BAT/impression à lancer");
  await audit(user, id, "VALIDATE", "Conformité validée — visa publicitaire obtenu");
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 12. Marketing : BAT / impression → matériel final ─────────────────────────

export async function startBat(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isMarketing(user, pm)) return { ok: false, error: "Réservé au Marketing." };
  if (pm.status !== "VISA_OBTAINED") return { ok: false, error: "Le visa publicitaire doit d'abord être obtenu." };

  const ecrite = await prisma.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "BAT_PRINTING", updatedById: user.id } });
  if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
  await audit(user, id, "UPDATE", "BAT / impression lancés");
  revalidate(id);
  return { ok: true };
}

export async function submitFinalMaterial(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!isMarketing(user, pm)) return { ok: false, error: "Réservé au Marketing." };
  if (pm.status !== "BAT_PRINTING") return { ok: false, error: "Lancez d'abord le BAT / l'impression." };

  const ecrite = await prisma.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "FINAL_MATERIAL", updatedById: user.id } });
  if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
  await notifyAssistant(pm, "Matériel promotionnel — matériel final livré (facture agence attendue)");
  await audit(user, id, "UPDATE", "Matériel final déposé par le Marketing");
  revalidate(id);
  return { ok: true };
}

// ───────────────────────── 13. Facture agence → 14. règlement finances ─────────────────────────

export async function recordInvoice(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const nouveau = refusNouveauCircuit(pm);
  if (nouveau) return { ok: false, error: nouveau };
  if (!(isAssistant(user) || isMarketing(user, pm))) return { ok: false, error: "Non autorisé." };
  if (pm.status !== "FINAL_MATERIAL") return { ok: false, error: "Le matériel final doit d'abord être déposé." };

  const ecrite = await prisma.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "INVOICED", updatedById: user.id } });
  if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
  await notifyGroup(["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"], pm, "Matériel promotionnel — facture finale à régler");
  await audit(user, id, "UPDATE", "Facture finale + bon de livraison enregistrés (agence)");
  revalidate(id);
  return { ok: true };
}

export async function settle(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  // UN RÈGLEMENT À LA FOIS (vague « restes ») — pour la raison de `initiatePayment` : le premier temps
  // CRÉE un ordre, et deux clics en faisaient deux, le second écrasant le premier dans le dossier. La
  // file sérialise et le second relit (il trouve l'ordre, donc le second temps) ; entre deux processus,
  // l'écriture exige l'absence d'ordre lue, et le perdant annule le sien.
  return enSerie(`promo-reglement:${id}`, async (): Promise<ActionResult> => {
    const pm = await load(id);
    if (!pm) return { ok: false, error: "Dossier introuvable." };
    const nouveau = refusNouveauCircuit(pm);
    if (nouveau) return { ok: false, error: nouveau };
    if (!isFinance(user)) return { ok: false, error: "Réservé aux finances." };
    if (pm.status !== "INVOICED") return { ok: false, error: "Aucune facture à régler." };

    // DEUX TEMPS, PARCE QUE CE SONT DEUX FAITS (§118.148). Ce geste créait l'ordre de dépense ET,
    // dans le même clic, déclarait le dossier « réglé et clôturé » — un ordre que le centre de
    // paiement pouvait encore refuser, sur un dossier que plus personne ne rouvrirait.
    //   1. sans ordre de règlement : on le CRÉE, il part au centre, le dossier reste « facturé » ;
    //   2. avec un ordre : le dossier se clôt une fois cet ordre RÉGLÉ, et pas avant.
    if (!pm.settlementOrderId) {
      const amount = fdNum(formData, "amount") ?? Number(pm.chosenAmount ?? pm.amount ?? 0);
      if (!(amount > 0)) {
        return { ok: false, error: "Renseignez le montant à régler : un paiement passe par le centre de paiement, qui autorise un montant." };
      }
      const order = await createExpenseOrder({
        label: `Règlement matériel promotionnel — ${pm.title}${pm.chosenAgency ? ` (${pm.chosenAgency})` : ""}`,
        amount, category: "FOURNISSEUR", beneficiary: pm.chosenAgency, sourceType: "PROMO_MATERIAL", sourceId: pm.id, requestedById: user.id,
        budgetCategoryId: pm.budgetCategoryId,
      });
      const lie = await prisma.promoMaterial.updateMany({
        where: { ...surLaMarcheLue(pm), settlementOrderId: null },
        data: { settlementOrderId: order.id, updatedById: user.id },
      });
      if (lie.count === 0) {
        const a = await annulerOrdreNonRegle(order.id, { acteurId: user.id, motif: `dossier ${pm.reference} : un autre règlement a été envoyé au même moment` });
        return { ok: false, error: `${ETAT_CHANGE} L'ordre ${order.reference} préparé à l'instant ${a.ok && a.annule ? "est annulé" : "n'a pas pu être annulé : signalez-le au centre de paiement"}.` };
      }
      await audit(user, id, "UPDATE", `Règlement final envoyé au centre de paiement (ordre ${order.reference})`);
      revalidate(id);
      return { ok: true, message: `Ordre ${order.reference} créé — il attend le centre de paiement. Le dossier se clôturera une fois l'ordre réglé.` };
    }

    const nonRegle = await ordreNonRegle(pm.settlementOrderId);
    if (nonRegle) return { ok: false, error: nonRegle };

    // LA CLÔTURE ET LA FIN DE LA DEMANDE AU SECRÉTARIAT, ENSEMBLE : la demande ne passe « terminée »
    // que si elle se traite encore — une demande annulée ne repasse pas « terminée » (la condition de
    // `fermerDemandeAuSecretariat`), et la date de fin part avec la fin.
    const clos = await prisma.$transaction(async (tx) => {
      const r = await tx.promoMaterial.updateMany({ where: surLaMarcheLue(pm), data: { status: "SETTLED", updatedById: user.id } });
      if (r.count === 0) return false;
      if (pm.adminRequestId) {
        await tx.administrativeRequest.updateMany({
          where: { id: pm.adminRequestId, deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] } },
          data: { status: "DONE", completedAt: new Date() },
        });
      }
      return true;
    });
    if (!clos) return { ok: false, error: ETAT_CHANGE };
    await notifyRequester(pm, "Matériel promotionnel — dossier réglé et clôturé");
    await audit(user, id, "VALIDATE", "Règlement final constaté — dossier clôturé");
    revalidate(id);
    return { ok: true };
  });
}

// ───────────────────────── Divers : commentaire, annulation ─────────────────────────

export async function addPromoComment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "promoId");
  const body = fdStr(formData, "body");
  if (!id || !body) return { ok: false, error: "Commentaire vide." };
  /*
   * LA PORTE EST CELLE DE L'ENREGISTREMENT, PLUS CELLE DU MODULE.
   *
   * Elle gardait sur `userCan(user, "PROMO_MATERIAL", "VIEW")`. Depuis que le fil du dossier est
   * le fil CANONIQUE du pôle Ad & Pro (`ad-pro-discussion-actions.ts`), deux écrivains visent la
   * même table avec deux portes différentes — et le symptôme d'une divergence de porte est le
   * pire qui soit : l'écran refuse, la conversation accepte (§118.71).
   *
   * `canAccessEntity` répond par ENREGISTREMENT et n'est pas simplement « plus strict » : il
   * ouvre AUSSI le dossier à l'Assistante de Direction, qui pilote ce circuit depuis les demandes
   * administratives SANS avoir le module. Mesuré avant d'écrire — et c'est ce qui rend ce
   * remplacement juste dans les deux sens, pas seulement plus sévère.
   */
  if (!(await canAccessEntity(user, "PROMO_MATERIAL", id, "VIEW"))) {
    return { ok: false, error: "Ce dossier ne vous est pas ouvert." };
  }
  await prisma.comment.create({ data: { entityType: "PROMO_MATERIAL", entityId: id, body, authorId: user.id } });
  revalidate(id);
  return { ok: true };
}

/**
 * LES BONS DE COMMANDE ACTIFS D'UN DOSSIER — la lecture de la génération (`etatsDesBC`, non annulés).
 * Compter tout devis qui garde un `purchaseOrderId` comptait aussi un BC annulé depuis sa fiche Legal :
 * le dossier ne s'annulait plus jamais, sur un refus qui renvoyait à une suppression que la carte
 * « Exécution » n'offre pas pour un BC déjà annulé (§118.63).
 */
async function bcsActifsDuDossier(id: string): Promise<number> {
  const devis = await prisma.promoQuote.findMany({ where: { promoMaterialId: id, purchaseOrderId: { not: null } }, select: { purchaseOrderId: true } });
  const ids = devis.map((d) => d.purchaseOrderId).filter((x): x is string => Boolean(x));
  if (ids.length === 0) return 0;
  const etats = await etatsDesBC(ids);
  return ids.filter((bcId) => { const e = etats.get(bcId); return Boolean(e && !e.annule); }).length;
}

export async function cancelPromoMaterial(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const pm = await load(id);
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  if (!(isMarketing(user, pm) || isAssistant(user) || isDirection(user))) return { ok: false, error: "Non autorisé." };
  if (pm.status === "SETTLED" || pm.status === "CANCELLED" || pm.circuitState === "COMPLETED") return { ok: false, error: "Dossier déjà clôturé." };
  // UNE ANNULATION EST DÉFINITIVE ET DIT POURQUOI (audit 360°, R17/R18) : sans motif, le dossier affichait
  // « Refusé » sans qu'on sache ni qui ni pourquoi — le demandeur croyait à un refus de la Direction.
  // Lu ici, EXIGÉ plus bas, APRÈS les refus structurels : on ne demande pas pourquoi annuler ce qui ne
  // s'annule pas (§118.18).
  const motifSaisi = fdStr(formData, "motif");

  // UN DOSSIER EN EXÉCUTION S'ANNULE DANS LA FILE DE SES BONS DE COMMANDE (vague « restes »). Le compte
  // des BC se lisait HORS de la file de `genererBonsDeCommandePromo` : un BC naissait entre le compte et
  // l'annulation, et le dossier partait annulé avec une commande vivante. Le compte ET l'écriture se font
  // dans la MÊME file, que la génération relit à son tour — l'une passe, l'autre refuse, jamais les deux.
  // La file n'a d'objet que là où une génération peut courir : ailleurs, deux annulations simultanées se
  // départagent en base, sur l'écriture conditionnelle.
  const enExecution = pm.circuitVersion === 2 && pm.circuitState === "IN_EXECUTION";
  const dansLaFile = <T>(fn: () => Promise<T>): Promise<T> => (enExecution ? enSerie(`promo-bc:${id}`, fn) : fn());
  const issue = await dansLaFile(async (): Promise<{ ok: true; motif: string } | { ok: false; error: string }> => {
    // UN BC GÉNÉRÉ ENGAGE LA SOCIÉTÉ (§118.152) : annuler le dossier en le laissant vivant laisserait
    // une commande sans dossier. On le dit, avec le geste qui le permet.
    if (pm.circuitVersion === 2) {
      const bcs = await bcsActifsDuDossier(id);
      if (bcs > 0) return { ok: false, error: `${bcs} bon${bcs > 1 ? "s" : ""} de commande ${bcs > 1 ? "ont été générés" : "a été généré"} pour ce dossier : supprimez-${bcs > 1 ? "les" : "le"} d'abord depuis la carte « Exécution », sans quoi une commande resterait engagée sur un dossier annulé.` };
    }
    if (!motifSaisi) return { ok: false, error: "Dites pourquoi ce dossier est annulé : l'annulation est définitive." };
    // L'ANNULATION ARRÊTE AUSSI LE CIRCUIT. Sans cette ligne, un dossier annulé restait sur son étape
    // de circuit — la fiche l'affichait en attente d'un validateur, et ce validateur pouvait encore
    // le faire avancer. L'état terminal du circuit est le seul que toutes ses actions refusent.
    // CONDITIONNELLE sur l'état LU : deux annulations à la même seconde n'écrivent pas deux motifs au fil ni
    // deux notifications, et un dossier que le circuit vient de clore ne se rouvre pas en « annulé ».
    const ecrite = await prisma.promoMaterial.updateMany({
      where: { id, status: pm.status, circuitState: pm.circuitState },
      data: { status: "CANCELLED", ...(pm.circuitState ? { circuitState: "REFUSED" } : {}), updatedById: user.id },
    });
    if (ecrite.count === 0) return { ok: false, error: ETAT_CHANGE };
    return { ok: true, motif: motifSaisi };
  });
  if (!issue.ok) return issue;
  const { motif } = issue;

  // CE QUI DÉPEND DU DOSSIER PART AVEC LUI — APRÈS son écriture, jamais avant : un dossier qui n'a pas
  // été annulé garde tout. Sa demande au secrétariat (et toute autre demande encore ouverte sur lui)
  // passe par l'annulation COMMUNE (`annulerDemandeSecretariat`) : un simple changement de statut
  // laissait ses approbations EN ATTENTE — approuver l'une émettait un paiement pour un dossier annulé —,
  // ses validations et son paiement non réglé. Une demande dont le paiement est déjà réglé reste
  // ouverte : elle se termine, comme au retrait d'un poste Ad & Pro, et la phrase le dit.
  const demandes = await prisma.administrativeRequest.findMany({
    where: {
      deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] },
      OR: [...(pm.adminRequestId ? [{ id: pm.adminRequestId }] : []), { linkedEntityType: "PROMO_MATERIAL" as const, linkedEntityId: id }],
    },
    select: { id: true },
  });
  const suites: string[] = [];
  for (const d of demandes) {
    const a = await annulerDemandeSecretariat(d.id, { acteurId: user.id, motif, cause: "avec son dossier de matériel promotionnel" });
    if (!a.ok) { suites.push(`La demande au secrétariat reste ouverte. ${a.error}`); continue; }
    if (a.annulee) {
      suites.push(`La demande au secrétariat ${a.reference} est annulée avec lui${a.ordresAnnules.length ? ` (paiement annulé : ${a.ordresAnnules.join(", ")})` : ""}, l'assistante prévenue.`);
    }
    if (a.reserve) suites.push(a.reserve);
  }
  // SES PROPRES ORDRES NON RÉGLÉS (ancien parcours : bordereau, règlement final) — par la porte unique :
  // un ordre qui attendait le centre aurait payé l'agence d'un dossier annulé. Un ordre réglé reste
  // réglé, et la phrase le dit.
  for (const ordreId of [pm.paymentOrderId, pm.settlementOrderId]) {
    const a = await annulerOrdreNonRegle(ordreId, { acteurId: user.id, motif: `dossier ${pm.reference} annulé — ${motif}` });
    if (!a.ok) suites.push(a.error);
    else if (a.annule && a.reference) suites.push(`L'ordre ${a.reference}, qui attendait le centre de paiement, est annulé.`);
  }
  if (demandes.length) revalidatePath("/demandes");

  await ecrireAuFil({ entityType: "PROMO_MATERIAL", entityId: id, authorId: user.id, body: `Dossier annulé — ${motif}` });
  if (pm.requesterId && pm.requesterId !== user.id) await notifyRequester(pm, `Dossier annulé : ${motif.slice(0, 120)}`);
  await audit(user, id, "UPDATE", `Dossier annulé — ${motif.slice(0, 200)}`);
  revalidate(id);
  return { ok: true, message: ["Dossier annulé.", ...suites].join(" ") };
}
