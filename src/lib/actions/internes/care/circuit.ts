/**
 * PRISE EN CHARGE — les CORPS du circuit des devis : retenir une proposition, trancher un devis (et émettre son
 * ordre de dépense), demander le bon de commande à l'assistante de direction.
 *
 * Sortis de `actions/care-actions.ts` (lot V4). Chaque action garde sa porte (session, droits, fiche) et passe
 * ensuite le FORMULAIRE à son corps : pour le contrat des actions, ce corps est celui du fichier d'actions
 * (`contrat/internes.ts`) — ses champs, ses écritures et ses écrivains importés comptent pour l'action.
 */
import { revalidatePath } from "next/cache";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { notifyRoles } from "@/lib/notify";
import { createExpenseOrder } from "@/lib/expense-orders";
import { montantLisible } from "@/lib/care-fiches";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { refusEngagementPriseEnCharge } from "@/lib/care-engagement";
import { refusSiPorteDgFermee, signalerPorteDgSiBesoin } from "@/lib/ad-pro/porte-dg";
import { sansBloquer } from "@/lib/journal";
import { SPEC, loadRequest, revalidate, type Scope } from "@/lib/actions/internes/care/demande";
import {
  conflitDeCouverture, demandeDeBc, devisRetenus, devisRivaux, marquerBcDemande, rattacherLOrdre, refuserLeDevis,
  rendreLaReserveDuDevis, reserverLeDevis, retenirALaPlace, type devisATrancher,
} from "@/lib/actions/internes/care/devis";
import { ecrireAuSujetDeLAssistante, journaliser as audit } from "./journal";

/** `retenirDevisPriseEnCharge`, après la porte : retirer le choix, ou retenir à la place des rivaux. */
export async function retenirOuAnnuler(
  formData: FormData,
  ctx: { user: SessionUser; id: string; quote: { supplier: string; cells: { cellId: string }[] }; scope: Scope; requestId: string },
): Promise<ActionResult> {
  const { user, id, quote, scope, requestId } = ctx;
  const annuler = fdStr(formData, "annuler") === "on";

  if (annuler) {
    await prisma.careQuote.updateMany({ where: { id, bcRequestedAt: null }, data: { retainedAt: null, retainedById: null } });
    await audit(user, scope, requestId, "UPDATE", `Devis ${quote.supplier} : n'est plus la proposition retenue.`);
    revalidate(scope, requestId);
    return { ok: true, id, message: "Le devis n'est plus retenu." };
  }

  const cellIds = quote.cells.map((c) => c.cellId);
  const rivaux = await devisRivaux(scope, requestId, id, cellIds);
  const engage = rivaux.find((r) => r.bcRequestedAt);
  if (engage) return { ok: false, error: `Le devis ${engage.supplier}, déjà retenu pour ces postes, a son BC demandé : il reste le choix.` };
  await retenirALaPlace(id, rivaux, user.id);
  await audit(user, scope, requestId, "UPDATE", `Devis ${quote.supplier} RETENU${rivaux.length ? ` (à la place de ${rivaux.map((r) => r.supplier).join(", ")})` : ""}.`);
  await signalerPorteDgSiBesoin(SPEC[scope].module, requestId);
  revalidate(scope, requestId);
  return { ok: true, id, message: `Devis ${quote.supplier} retenu${rivaux.length ? " — l'autre proposition est écartée" : ""}. Demandez le BC quand tout est prêt.` };
}

/** `decideCareQuote`, après la porte : l'engagement, le DG, la couverture, puis l'ordre ou le refus. */
export async function trancherLeDevis(
  formData: FormData,
  ctx: {
    user: SessionUser; id: string; decision: "ACCEPTED" | "REJECTED";
    quote: NonNullable<Awaited<ReturnType<typeof devisATrancher>>>; scope: Scope; requestId: string;
  },
): Promise<ActionResult> {
  const { user, id, decision, quote, scope, requestId } = ctx;
  const cellIds = quote.cells.map((c) => c.cellId);

  // ACCEPTER ENGAGE LA DÉPENSE (27/10/2026) : la demande prévalidée, chaque personne couverte accordée, et une
  // catégorie budgétaire — l'ordre né du devis la porte, il n'échappe plus aux enveloppes.
  let budgetCategoryId: string | null = null;
  if (decision === "ACCEPTED") {
    const refusEngagement = await refusEngagementPriseEnCharge(scope, requestId, cellIds);
    if (refusEngagement) return { ok: false, error: refusEngagement };
    // LE DG SUR LE TOTAL (27/10/2026) : au-dessus du seuil, aucun ordre sans sa validation. Un devis
    // accepté sans avoir été retenu n'est pas encore dans le total : il y entre ici.
    const refusDg = await refusSiPorteDgFermee(SPEC[scope].module, requestId, quote.status === "PENDING" && !quote.retainedAt ? toNumber(quote.amountDzd) : 0);
    if (refusDg) {
      await signalerPorteDgSiBesoin(SPEC[scope].module, requestId);
      return { ok: false, error: refusDg };
    }
    budgetCategoryId = fdStr(formData, "budgetCategoryId");
    if (!budgetCategoryId) return { ok: false, error: "Choisissez la catégorie budgétaire du devis : l'ordre de dépense qu'il émet l'impute à son enveloppe." };
    const cat = await prisma.budgetCategoryLine.count({ where: { id: budgetCategoryId } });
    if (cat === 0) return { ok: false, error: "La catégorie budgétaire choisie est introuvable." };
  }

  if (decision === "ACCEPTED") {
    const conflit = await conflitDeCouverture(scope, requestId, id, quote.amountDzd, cellIds);
    if (conflit) return { ok: false, error: conflit };
  }

  const req = await loadRequest(scope, requestId);

  // UN DEVIS N'ÉMET QU'UN ORDRE, MÊME À DEUX CLICS (audit argent 2026-10-27, ARGENT-02). Le garde « déjà engagé »
  // était lu en tête, l'ordre créé ensuite, et le devis écrit par son seul id : deux acceptations simultanées
  // passaient toutes deux la lecture et émettaient DEUX ordres au centre de paiement — le second écrasait le
  // lien du premier, qui restait payable sans que rien ne le rattache plus au devis. Le devis se RÉSERVE donc
  // d'abord, sur l'état lu (§118.151) : seul le gagnant émet l'ordre ; un échec de l'émission rend la réserve.
  if (decision === "ACCEPTED" && !(await reserverLeDevis(quote, user.id))) {
    return { ok: false, error: "Ce devis vient d'être tranché (ou engagé) par quelqu'un d'autre : rechargez la page." };
  }
  const rendreLaReserve = () => rendreLaReserveDuDevis(quote);

  let ordreNe = false;
  try {
    if (decision === "ACCEPTED") {
      const amount = toNumber(quote.amountDzd);
      const order = await createExpenseOrder({
        label: `${req?.name ?? "Prise en charge"} — devis ${quote.supplier}`,
        amount,
        category: "EVENEMENT",
        beneficiary: quote.supplier,
        sourceType: SPEC[scope].module,
        sourceId: requestId,
        requestedById: user.id,
        budgetCategoryId,
        // LE BUDGET EST EN DZD : un devis saisi en dollars entre à son équivalent au taux figé de la demande.
        notes: `Devis couvrant ${cellIds.length} élément(s) de la prise en charge.${quote.currency === "USD" && quote.amount != null ? ` Saisi : ${montantLisible(toNumber(quote.amount), "USD")} (converti au taux de la demande).` : ""}`,
      });
      ordreNe = true;
      await rattacherLOrdre(id, cellIds, order.id, user.id);
      await audit(user, scope, requestId, "UPDATE",
        `Devis ${quote.supplier} ACCEPTÉ (${amount.toLocaleString("fr-FR")} DZD) — ordre de dépense ${order.reference}.`);
    } else {
      await refuserLeDevis(id, cellIds, user.id, fdStr(formData, "note"));
      await audit(user, scope, requestId, "UPDATE", `Devis ${quote.supplier} REFUSÉ — les éléments couverts repassent en attente.`);
    }

    revalidate(scope, requestId);
    revalidatePath("/finances/paiements-a-faire");
    return { ok: true, id };
  } catch (err) {
    console.error("[care] décision de devis impossible", err);
    // L'ordre n'est pas né : la réserve se rend. Né mais non rattaché, le devis RESTE réservé — le rendre
    // laisserait accepter une seconde fois, donc émettre un second ordre.
    if (decision === "ACCEPTED" && !ordreNe) await rendreLaReserve();
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

/** `demanderBCPriseEnCharge`, après la porte : les devis retenus, l'engagement, le DG, puis le sujet et la marque. */
export async function demanderLeBc(
  formData: FormData,
  ctx: { user: SessionUser; scope: Scope; requestId: string; req: NonNullable<Awaited<ReturnType<typeof loadRequest>>> },
): Promise<ActionResult> {
  const { user, scope: scopeRaw, requestId, req } = ctx;
  const voulus = formData.getAll("quoteIds").map(String).filter(Boolean);
  const retenus = await devisRetenus(scopeRaw, requestId, voulus);
  if (retenus.length === 0) return { ok: false, error: "Retenez d'abord un devis : le bon de commande s'établit d'après les propositions retenues." };
  // Pas de BC avant la prévalidation de la demande ni l'accord de chaque personne couverte (27/10/2026).
  const refusEngagement = await refusEngagementPriseEnCharge(scopeRaw, requestId, retenus.flatMap((q) => q.cells.map((c) => c.cellId)));
  if (refusEngagement) return { ok: false, error: refusEngagement };
  // Ni BC au-dessus du seuil sans la validation du TOTAL par le DG (27/10/2026) — les devis retenus y sont.
  const refusDg = await refusSiPorteDgFermee(SPEC[scopeRaw].module, requestId);
  if (refusDg) {
    await signalerPorteDgSiBesoin(SPEC[scopeRaw].module, requestId);
    return { ok: false, error: refusDg };
  }

  const { total, corps } = await demandeDeBc(scopeRaw, requestId, retenus, fdStr(formData, "note"));

  const sujet = await ecrireAuSujetDeLAssistante(scopeRaw, req, user, "Demande de bon de commande.", corps);
  if (!sujet.ok) return { ok: false, error: sujet.error };
  const marques = await marquerBcDemande(retenus, user.id);
  await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED",
    title: "Prise en charge — devis retenus à accepter",
    body: `${req.name} — ${marques.count} devis retenu(s), BC demandé à l'assistante de direction.`,
    link: `${SPEC[scopeRaw].path}/${requestId}`,
  }).catch(sansBloquer("care-actions.demanderBCPriseEnCharge.notifyRoles"));
  await audit(user, scopeRaw, requestId, "UPDATE", `BC demandé pour ${marques.count} devis retenu(s) — sujet ${sujet.reference}.`);
  revalidate(scopeRaw, requestId);
  revalidatePath("/dossiers");
  const depasse = req.finalAmount != null && total > toNumber(req.finalAmount)
    ? ` Les devis retenus (${montantLisible(Math.round(total * 100) / 100)}) dépassent l'enveloppe accordée : la Direction le verra.`
    : "";
  return { ok: true, id: sujet.id, message: `BC demandé pour ${marques.count} devis — sujet ${sujet.reference}, l'assistante de direction est prévenue.${depasse}` };
}
