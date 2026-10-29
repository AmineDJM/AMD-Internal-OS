/**
 * INFORMATION MÉDICALE — la QUITTANCE d'un bon de versement demandée au paiement : le montant lu, le bon PRIS par
 * une écriture conditionnelle, la demande de paiement canonique, puis le bon rattaché (ou rendu).
 *
 * Sorti de `actions/medical-info-actions.ts` (lot V4). L'action garde sa porte (le pharmacien, le lot validé, le bon
 * dont le paiement peut être demandé) et sa trace d'audit ; elle passe le FORMULAIRE à ce corps. Pour le contrat des
 * actions, ce corps est celui du fichier d'actions (`contrat/internes.ts`) : ses champs, ses écritures et ses
 * écrivains importés comptent pour elle.
 */
import { randomUUID } from "crypto";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { createPaymentRequest } from "@/modules/finances/actions-demandes";
import { PRISE_DU_BON } from "@/lib/medical-info/slips";
import { annulerOrdreNonRegle } from "@/modules/finances/api";
import { formulaireDeLaQuittance } from "@/lib/actions/internes/medical-info/dossier";

/** L'arrêt de l'action, avec ce qu'elle rend — un type nommé, pour que `"fini" in …` le distingue de la suite. */
const arret = (r: ActionResult): { fini: ActionResult } => ({ fini: r });

/** `requestSlipPayment`, après la porte. `fini` : l'action s'arrête là ; sinon la demande née et son montant. */
export async function demanderLaQuittance(
  formData: FormData,
  ctx: {
    user: SessionUser; slipId: string; courant: { requestId: string | null };
    slip: Parameters<typeof formulaireDeLaQuittance>[0];
    decl: Parameters<typeof formulaireDeLaQuittance>[1] & { reference: string };
  },
) {
  const { user, slipId, courant, slip, decl } = ctx;
  const raw = fdStr(formData, "amount");
  const amount = raw ? Number(raw.replace(",", ".")) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return arret({ ok: false, error: "Indiquez le montant de la quittance." });

  // On rejoue le formulaire de la demande de paiement : c'est la MÊME action canonique que depuis
  // les Demandes de validations, donc les mêmes contrôles et le même circuit.
  const fd = formulaireDeLaQuittance(slip, decl, amount, {
    payee: fdStr(formData, "payee"), note: fdStr(formData, "note"), dueDate: fdStr(formData, "dueDate"),
    files: formData.getAll("files"),
  });

  // UN SEUL ORDRE VIVANT PAR BON (audit 10/2026). Deux soumissions simultanées lisaient toutes deux
  // « quittance à demander » et créaient chacune leur demande — donc deux ordres au centre de paiement
  // pour une seule taxe. Le bon est d'abord PRIS, par une écriture conditionnelle à ce qu'on a lu ; le
  // second trouve la place prise et s'arrête avant d'avoir rien créé. Le jeton de prise voyage avec la
  // demande : c'est lui qui prouve, à la création, qu'elle vient bien d'un bon de CE dossier — la seule
  // porte de l'exemption de facture (`bonDeVersementRattache`).
  const jeton = `${PRISE_DU_BON}${randomUUID()}`;
  const pris = await prisma.medicalInfoSlip.updateMany({
    where: { id: slipId, requestId: courant.requestId, deliveredAt: null },
    data: { requestId: jeton },
  });
  if (pris.count === 0) return arret({ ok: false, error: "Le paiement de ce bon vient d'être demandé — rechargez la page." });
  fd.set("medicalInfoSlipClaim", jeton);

  let created: ActionResult;
  try {
    created = await createPaymentRequest(undefined, fd);
  } catch (err) {
    console.error("[medical-info] demande de paiement du bon non créée", err);
    created = { ok: false, error: "La demande de paiement n'a pas pu être créée." };
  }
  if (!created.ok || !created.id) {
    // Rien n'est parti : le bon retrouve son état d'avant la prise.
    await prisma.medicalInfoSlip.updateMany({ where: { id: slipId, requestId: jeton }, data: { requestId: courant.requestId } });
    return arret({ ok: false, error: created.error ?? "La demande de paiement a été refusée." });
  }

  const rattache = await prisma.medicalInfoSlip.updateMany({ where: { id: slipId, requestId: jeton }, data: { requestId: created.id } });
  if (rattache.count === 0) {
    // Le bon a changé pendant la création (retiré, remis) : la demande née n'a plus d'objet — elle et son
    // ordre sont annulés tant que rien n'est réglé, plutôt que de laisser un paiement orphelin au centre.
    const orpheline = await prisma.paymentRequest.findUnique({ where: { id: created.id }, select: { expenseOrderId: true } });
    await prisma.paymentRequest.updateMany({ where: { id: created.id, status: { notIn: ["APPROVED", "CANCELLED"] } }, data: { status: "CANCELLED" } });
    await annulerOrdreNonRegle(orpheline?.expenseOrderId, { acteurId: user.id, motif: `bon de versement « ${slip.label} » modifié pendant la demande (${decl.reference})` });
    return arret({ ok: false, error: "Ce bon vient de changer pendant la demande : elle a été annulée — rechargez la page." });
  }
  return { id: created.id, amount };
}
