/**
 * REGULATORY — le CORPS de la demande de BV (`requestBV`), par le CENTRE DE VALIDATIONS (Super Admin, 24/11/2026).
 *
 * L'action garde sa porte (session, dossier), son audit et l'étape ; ce corps lit la nature et le montant, juge les
 * pièces AVANT toute écriture, choisit les validateurs (accès effectif au Centre de validations), puis pose la demande
 * SOUS UN VERROU propre au couple (dossier, nature) — le même que l'ancien circuit : un BV vivant dans l'un ou l'autre
 * circuit empêche d'en demander un second. Aucun ordre de dépense n'est émis : le BV ne passe plus par le centre de
 * paiement ni par les Finances (exception voulue), il consomme le budget Regulatory à son acceptation.
 */
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { createDirectValidation } from "@/lib/validation";
import { deposerPieceDeModule } from "@/lib/storage";
import { BV_REQUEST_STEPS } from "@/lib/regulatory-workflow";
import { ETAPES_BV, natureDuLibelle } from "@/lib/budget-regulatory/bv";
import { bloqueUneNouvelleDemande, etatDeLOrdreBv, ETAT_BV, LIBELLE_NATURE_BV } from "@/lib/regulatory/bv-circuit";
import { demandeBvBloquante, OBJET_BV_REGULATORY, paiementBvDeverrouille, refusPaiementVerrouille } from "@/lib/regulatory/bv-validation";
import { validateursDuCentre } from "@/lib/regulatory/bv-centre";
import { refusDesPieces } from "@/lib/actions/internes/regulatory/processus";

/** Le lecteur du fichier d'actions — même règle : une valeur vide vaut `null`. */
function str(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  return v ? String(v) : null;
}

type Refus = { ok: false; error: string };

/** Ce qui empêche une seconde demande : un ordre vivant de l'ancien circuit, ou une demande en attente / acceptée. */
type Bloquant = { reference: string; phrase: string };

/**
 * `requestBV`, après la porte : la demande d'autorisation du BV posée au Centre de validations, ses pièces rangées sur
 * l'étape « Demande du BV » du dossier. Rend la demande créée, ou le refus dit avec son remède.
 */
export async function demanderLeBvAuCentre(
  formData: FormData,
  ctx: { user: SessionUser; productId: string; product: { reference: string; dci: string; brandName: string | null }; etapeValide: string | null },
) {
  const { user, productId, product, etapeValide } = ctx;
  // LA NATURE EST CELLE DE L'ÉTAPE d'où l'on part ; sans étape (assistant), le libellé dit la part — sinon on refuse :
  // un BV sans part ne sait ni quelle étape il ouvre, ni quelle ligne du budget il engage.
  const bvType = (etapeValide && BV_REQUEST_STEPS[etapeValide]) || str(formData, "bvType") || "BV";
  const nature = natureDuLibelle(bvType);
  if (!nature) return { ok: false, error: "Précisez le BV demandé : « BV 25 % » ou « BV 75 % »." } as Refus;
  const amount = Number(str(formData, "amount"));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Saisissez le montant du BV (en DZD, supérieur à zéro)." } as Refus;
  const note = str(formData, "note");
  const dueRaw = str(formData, "dueDate");

  // LES PIÈCES SE JUGENT AVANT LA DEMANDE (§118.202) : un fichier refusé après coup laisserait une demande sans pièce,
  // qu'une seconde tentative doublerait.
  const files = [...formData.getAll("files"), formData.get("file")]
    .filter((f): f is File => f instanceof File && f.size > 0);
  const refusPiece = await refusDesPieces(files);
  if (refusPiece) return { ok: false, error: refusPiece } as Refus;

  const validateurs = await validateursDuCentre(user.id);
  if (validateurs.length === 0) {
    return { ok: false, error: "Personne d'autre que vous n'a accès au Centre de validations : le Super Admin doit ouvrir cet accès depuis la console avant que le BV puisse être autorisé." } as Refus;
  }

  const libelle = LIBELLE_NATURE_BV[nature];
  const produit = product.brandName ? `${product.reference} ${product.dci} (${product.brandName})` : `${product.reference} ${product.dci}`;
  const issue = await prisma.$transaction(async (tx): Promise<{ deja: Bloquant } | { cree: { requestId: string; reference: string } | { error: string } }> => {
    // LE MÊME VERROU QUE L'ANCIEN CIRCUIT (`bv-demande`, dossier:nature) : deux clics, deux personnes, ou une demande
    // pendant qu'un ancien ordre vit encore — la seconde attend la première, la relit, et s'arrête.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bv-demande'), hashtext(${`${productId}:${nature}`}))`;
    const [ordres, demandes] = await Promise.all([
      tx.expenseOrder.findMany({
        where: { sourceType: "REGULATORY_PRODUCT", sourceId: productId, status: { not: "CANCELLED" } },
        select: { reference: true, label: true, status: true, centralStatus: true },
      }),
      tx.validationRequest.findMany({
        where: { objectType: OBJET_BV_REGULATORY[nature], entityType: "REGULATORY_PRODUCT", entityId: productId },
        select: { reference: true, status: true },
      }),
    ]);
    const ordre = ordres.find((o) => natureDuLibelle(o.label) === nature && bloqueUneNouvelleDemande(o));
    if (ordre) {
      const e = ETAT_BV[etatDeLOrdreBv(ordre) ?? "DEMANDE"];
      return { deja: { reference: ordre.reference, phrase: `${e.label.toLowerCase()}, ${e.detail}` } };
    }
    const vivante = demandes.find(demandeBvBloquante);
    if (vivante) {
      return { deja: { reference: vivante.reference, phrase: vivante.status === "APPROVED" ? "déjà accepté au Centre de validations" : "en attente au Centre de validations" } };
    }
    const r = await createDirectValidation({
      requesterId: user.id,
      title: `${libelle} — ${produit} : ${amount.toLocaleString("fr-FR")} DZD`,
      description: [
        `Demande d'autorisation du ${libelle} du dossier ${produit}.`,
        `Montant : ${amount.toLocaleString("fr-FR")} DZD — accepté, il est engagé au budget Regulatory (ligne ${libelle}) ; le paiement se coche ensuite sur le dossier.`,
        dueRaw ? `Échéance souhaitée : ${new Date(dueRaw).toLocaleDateString("fr-FR")}.` : null,
        note,
      ].filter(Boolean).join("\n\n"),
      link: `/regulatory/${productId}`,
      module: "Regulatory",
      priority: "HIGH",
      validatorIds: validateurs,
      mode: "PARALLEL",
      objectType: OBJET_BV_REGULATORY[nature],
      entityType: "REGULATORY_PRODUCT",
      entityId: productId,
      amount,
    });
    return { cree: r.ok && r.requestId && r.reference ? { requestId: r.requestId, reference: r.reference } : { error: r.error ?? "La demande n'a pas pu être posée : réessayez." } };
  }, { maxWait: 10_000, timeout: 30_000 });

  if ("deja" in issue) {
    return { ok: false, error: `Le ${libelle} de ce dossier est déjà demandé (${issue.deja.reference} — ${issue.deja.phrase}). On ne redemande qu'un BV refusé.` } as Refus;
  }
  if ("error" in issue.cree) return { ok: false, error: issue.cree.error } as Refus;
  const demande = issue.cree;

  // LA REDEMANDE CLÔT LA DEMANDE « À CORRIGER » de la même nature : elle ne se resoumet pas sur place (son objet est le
  // dossier), et la laisser ouverte laisserait deux demandes du même BV dans l'historique du validateur.
  const closes = await prisma.validationRequest.updateMany({
    where: { objectType: OBJET_BV_REGULATORY[nature], entityType: "REGULATORY_PRODUCT", entityId: productId, status: "CHANGES_REQUESTED" },
    data: { status: "CANCELLED" },
  });
  if (closes.count > 0) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Validations", entityType: "REGULATORY_PRODUCT", entityId: productId,
      field: "status", newValue: "CANCELLED", summary: `Demande « à corriger » du ${libelle} close par la nouvelle demande ${demande.reference}`,
    });
  }

  // LES PIÈCES (proforma, courrier de l'ANPP…) se rangent sur l'étape « Demande du BV » : le dossier les garde, et le
  // validateur les voit sur sa carte de décision (`getPendingValidations`).
  for (const file of files) {
    await deposerPieceDeModule(file, {
      entityType: "REGULATORY_PRODUCT", entityId: productId, stepKey: ETAPES_BV[nature].demande,
      category: "PROFORMA", confidentiality: "INTERNAL", uploadedById: user.id, journal: "requestBV",
    });
  }
  return { ok: true as const, demande, nature, bvType: libelle, amount, pieces: files.length, validateurs: validateurs.length };
}

/**
 * LE VERROU DU PAIEMENT D'UN BV — `setRegulatoryStepState`, avant d'écrire : l'étape « Paiement du BV » ne bouge pas
 * tant que la demande n'est pas ACCEPTÉE au Centre de validations (ou, ancien circuit, son ordre AUTORISÉ ou payé).
 * Le retour à « à faire » reste libre : il ne paie rien. Rend le refus, ou `null`.
 */
export async function refusDuPaiementBv(productId: string, stepKey: string, status: string): Promise<string | null> {
  const nature = (["25", "75"] as const).find((n) => ETAPES_BV[n].paiement === stepKey);
  if (!nature || status === "TODO") return null;
  const [demandes, ordres] = await Promise.all([
    prisma.validationRequest.findMany({
      where: { objectType: OBJET_BV_REGULATORY[nature], entityType: "REGULATORY_PRODUCT", entityId: productId, status: "APPROVED" },
      select: { objectType: true, status: true },
    }),
    prisma.expenseOrder.findMany({
      where: { sourceType: "REGULATORY_PRODUCT", sourceId: productId, status: { not: "CANCELLED" } },
      select: { label: true, status: true, centralStatus: true },
    }),
  ]);
  return paiementBvDeverrouille(nature, { demandes, ordres }) ? null : refusPaiementVerrouille(nature);
}
