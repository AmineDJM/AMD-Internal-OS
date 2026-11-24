"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { sansBloquer } from "@/lib/journal";
import { actionReversible } from "@/lib/effets/reversible";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { persistUploadedDocument } from "@/lib/documents";
import { validateAttachments } from "@/lib/attach-files";
import { deleteFileByKey } from "@/lib/storage";
import { clientIp } from "@/lib/device";
import { getBlob } from "@/lib/drive-storage";
import { CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { controleRenforce, REFUS_VUE_EXACTE } from "@/lib/signature-en-ligne/second-facteur";
import { apposerSignatureEnLigne } from "@/lib/signature-en-ligne/signer-bc";
import { createExpenseOrder } from "@/modules/finances/api";
import { lireMontant, montantLisible, deviseDuPoste, versDzd } from "./domaine/prise-en-charge/fiches";
import { refusAchatDeLaLigne, refusPaiementDuBc, totalAPayer, type LigneAchat } from "./domaine/prise-en-charge/achats";
import { type Scope, SPEC, isScope, revalidate, audit, loadRequest, tauxDe } from "./infra/prise-en-charge/actions-commun";
import { ecrirePrixDuPoste, lignesDesPostes } from "./infra/prise-en-charge/achats";
import { lancerLesAchats, libererVersLeCentre } from "./infra/prise-en-charge/bc-pec";
import { pilotePriseEnCharge, tientLesMontantsDe } from "./infra/requetes/achats-pec";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — LES ACHATS PAR BONS DE COMMANDE NUMÉROTÉS (Super Admin, 24/11/2026).
 *
 *   1. « Lancer les achats » (Direction Marketing) : le BC n°k de tout ce qui est validé et pas encore en BC ;
 *   2. la Direction Marketing le SIGNE en ligne (mot de passe + code) : il part au centre Ad & Pro, puis aux Finances
 *      (signature existante, `bc-signature-actions.ts`) — qui préviennent l'assistante (`apresSignatureFinancesPec`) ;
 *   3. l'assistante achète UNIQUEMENT les lignes de ce BC (billet, confirmation, pièce) ;
 *   4. elle demande le paiement en joignant OBLIGATOIREMENT la facture : UN ordre de dépense par BC → centre de paiement →
 *      Finances (`createExpenseOrder`, seul créateur d'ordre).
 * Morceau de la clé `care-actions` (voir `actions-prise-en-charge.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le BC de prise en charge (par son identifiant) et sa demande. */
async function chargerBc(bcId: string | null) {
  if (!bcId) return null;
  const bc = await prisma.carePecBc.findUnique({
    where: { id: bcId },
    select: { id: true, numero: true, legalDocumentId: true, congressNationalId: true, congressInternationalId: true, fournisseur: true, budgetCategoryId: true, expenseOrderId: true, paiementDemandeLe: true },
  });
  if (!bc?.legalDocumentId) return null;
  const scope: Scope = bc.congressNationalId ? "NATIONAL" : "INTERNATIONAL";
  const requestId = bc.congressNationalId ?? bc.congressInternationalId;
  return requestId ? { bc: { ...bc, legalDocumentId: bc.legalDocumentId }, scope, requestId } : null;
}

/** LANCER LES ACHATS — la Direction Marketing : le BC n°k de ce qui est validé et pas encore en BC. */
export async function lancerAchatsPec(formData: FormData): Promise<ActionResult> {
  return actionReversible("care-actions:lancerAchatsPec", "Achats de prise en charge lancés (BC numéroté)", async () => {
    const user = await requireUser();
    const scope = fdStr(formData, "scope") ?? "";
    const requestId = fdStr(formData, "requestId");
    if (!isScope(scope) || !requestId) return { ok: false, error: "Demande non précisée." };
    if (!(await pilotePriseEnCharge(user, scope, requestId))) return { ok: false, error: "Seule la Direction Marketing lance les achats d'une prise en charge." };
    const r = await lancerLesAchats(user, scope, requestId, { fournisseur: fdStr(formData, "fournisseur"), budgetCategoryId: fdStr(formData, "budgetCategoryId") });
    if (!r.ok) return r;
    revalidate(scope, requestId);
    return { ok: true, id: r.bcId, message: `BC n°${r.numero} (${r.reference}) lancé — ${r.lignes} poste(s), ${montantLisible(r.total)}. Signez-le pour l'envoyer au centre Ad & Pro.` };
  });
}

/**
 * SIGNER ET CACHETER LE BC n°k — la Direction Marketing, en ligne (mot de passe + code de l'application). La signature
 * posée, la retenue du BC est levée : l'aiguillage l'adresse au centre Ad & Pro (au-dessus du seuil), sinon aux Finances.
 * Signataires distincts : la personne qui signe ici ne signera pas pour les Finances (règle tenue sous verrou au sceau).
 */
export async function signerBcPec(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.impersonatedBy) return { ok: false, error: REFUS_VUE_EXACTE };
  const c = await chargerBc(fdStr(formData, "bcId"));
  if (!c) return { ok: false, error: "Bon de commande introuvable." };
  if (!(await pilotePriseEnCharge(user, c.scope, c.requestId))) return { ok: false, error: "Ce bon de commande se signe par la Direction Marketing." };
  if (fdStr(formData, "lu") !== "oui") return { ok: false, error: "Cochez « J'ai relu ce bon de commande » : on ne signe que ce qu'on a relu." };
  const deja = await prisma.signatureBC.count({ where: { legalDocumentId: c.bc.legalDocumentId, qualite: "DIRECTION_MARKETING" } });
  if (deja) return { ok: false, error: `Le BC n°${c.bc.numero} est déjà signé par la Direction Marketing.` };
  const doc = await prisma.legalDocument.findUnique({ where: { id: c.bc.legalDocumentId }, select: { reference: true, status: true } });
  if (!doc || doc.status === "CANCELLED") return { ok: false, error: "Ce bon de commande est annulé : il ne se signe pas." };
  const h = await headers();
  const ip = clientIp(h);
  const refus = await controleRenforce(user.id, String(formData.get("motDePasse") ?? ""), fdStr(formData, "code") ?? "", ip);
  if (refus) return { ok: false, error: refus };
  const r = await apposerSignatureEnLigne({
    legalDocumentId: c.bc.legalDocumentId, reference: doc.reference ?? c.bc.legalDocumentId, qualite: "DIRECTION_MARKETING",
    user: { id: user.id, name: user.name ?? null }, ip, agent: h.get("user-agent"), lireBlob: getBlob,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const reserve = await libererVersLeCentre(c.bc.legalDocumentId, user.id);
  await audit(user, c.scope, c.requestId, "UPDATE", `BC n°${c.bc.numero} (${doc.reference ?? "—"}) signé et cacheté en ligne par ${r.suppleance ? `${user.name ?? "le Super Admin"} (${r.titre})` : "la Direction Marketing"} — adressé au circuit (centre Ad & Pro, puis Finances).`);
  revalidate(c.scope, c.requestId);
  revalidatePath(CHEMIN_BC_A_SIGNER);
  return { ok: true, id: c.bc.id, message: `BC n°${c.bc.numero} signé et cacheté.${reserve ? ` ${reserve}` : ""}` };
}

/**
 * ACHETER UNE LIGNE DU BC — l'assistante (ou la Direction Marketing) : seulement une ligne d'un BC SIGNÉ PAR LES FINANCES.
 * Billet / hôtel : le billet émis ou la confirmation (fichier exigé) et sa référence ; autre poste : la pièce, facultative.
 * Un `montant` d'achat différent passe par la marge de 10 % (au-delà : le BC ne bouge pas, le complément est mis de côté).
 */
export async function acheterLignePec(formData: FormData): Promise<ActionResult> {
  return actionReversible("care-actions:acheterLignePec", "Ligne de BC de prise en charge achetée", async () => {
    const user = await requireUser();
    const ligneId = fdStr(formData, "ligneId");
    if (!ligneId) return { ok: false, error: "Ligne non précisée." };
    const ligne = await prisma.carePecBcLigne.findUnique({ where: { id: ligneId }, select: { id: true, cellId: true, bcId: true, libelle: true, statut: true, cell: { select: { serviceKind: true, issuedDocumentId: true } } } });
    if (!ligne) return { ok: false, error: "Ligne introuvable." };
    const c = await chargerBc(ligne.bcId);
    if (!c) return { ok: false, error: "Bon de commande introuvable." };
    if (!(await tientLesMontantsDe(user, c.scope, c.requestId))) return { ok: false, error: "L'achat se fait par l'assistante de direction sollicitée (ou la Direction Marketing)." };
    const lue = ((await lignesDesPostes([ligne.cellId])).get(ligne.cellId) ?? []).find((l) => l.id === ligneId);
    if (!lue) return { ok: false, error: "Ligne introuvable." };
    const refus = refusAchatDeLaLigne(lue);
    if (refus) return { ok: false, error: refus };
    const billet = ligne.cell.serviceKind === "TICKET" || ligne.cell.serviceKind === "HOTEL";
    const fichiers = formData.getAll("pieces").filter((v): v is File => v instanceof File && v.size > 0);
    if (billet && fichiers.length === 0 && !ligne.cell.issuedDocumentId) {
      return { ok: false, error: ligne.cell.serviceKind === "TICKET" ? "Joignez le billet émis (e-billet, PDF ou scan)." : "Joignez la confirmation de l'hôtel (voucher, PDF ou scan)." };
    }
    if (fichiers.length) {
      const refusFichier = await validateAttachments(fichiers);
      if (refusFichier) return { ok: false, error: refusFichier };
    }
    const lu = lireMontant(fdStr(formData, "montant"));
    if (!lu.ok) return { ok: false, error: "Le montant d'achat est illisible (ex. 46000 ou 1250,50)." };

    let phrasePrix = "";
    if (lu.montant != null) {
      const req = await loadRequest(c.scope, c.requestId);
      const devise = deviseDuPoste(c.scope, ligne.cell.serviceKind);
      const dzd = versDzd(lu.montant, devise, tauxDe(c.scope, req));
      if (dzd == null) return { ok: false, error: "Le taux de conversion de cette demande est inconnu : un montant en dollars ne peut pas être converti." };
      const w = await ecrirePrixDuPoste({ cellId: ligne.cellId, montant: lu.montant, devise, amountDzd: dzd, auteurId: user.id, motif: "Prix d'achat", chiffrage: false });
      if (!w.ok) return w;
      if (w.voie !== "LIBRE") phrasePrix = ` ${w.message}`;
    }
    // L'ÉTAT D'ABORD (§118.18) : la ligne se déclare achetée, puis les fichiers partent ; rien ne passe → elle redevient active.
    const pris = await prisma.carePecBcLigne.updateMany({ where: { id: ligneId, statut: "ACTIVE" }, data: { statut: "ACHETEE", acheteLe: new Date(), acheteParId: user.id } });
    if (pris.count === 0) return { ok: false, error: "Cette ligne vient de changer (achetée ou retirée) : rechargez la page." };
    const deposes: string[] = [];
    const echecs: string[] = [];
    for (const file of fichiers) {
      const r = await persistUploadedDocument(user.id, { entityType: SPEC[c.scope].module, entityId: c.requestId, category: "SUPPORTING_DOC", confidentiality: "INTERNAL", stepKey: ligne.cellId, file })
        .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "dépôt impossible", documentId: undefined }));
      if (r.ok && r.documentId) deposes.push(r.documentId); else echecs.push(`${file.name} : ${r.error ?? "dépôt impossible"}`);
    }
    if (fichiers.length > 0 && deposes.length === 0) {
      await prisma.carePecBcLigne.updateMany({ where: { id: ligneId, statut: "ACHETEE" }, data: { statut: "ACTIVE", acheteLe: null, acheteParId: null } });
      return { ok: false, error: `Aucune pièce n'a pu être déposée — ${echecs.join(" ; ")}.` };
    }
    const reference = fdStr(formData, "reference")?.slice(0, 60) ?? null;
    if (deposes.length || reference) {
      await prisma.careCell.update({
        where: { id: ligne.cellId },
        data: { ...(deposes.length && !ligne.cell.issuedDocumentId ? { issuedDocumentId: deposes[0] } : {}), ...(reference ? { bookingRef: reference } : {}) },
      });
    }
    await audit(user, c.scope, c.requestId, "UPDATE", `BC n°${c.bc.numero} — acheté : ${ligne.libelle}${reference ? ` (réf. ${reference})` : ""}${deposes.length ? `, ${deposes.length} pièce(s)` : ""}.${phrasePrix}`);
    revalidate(c.scope, c.requestId);
    revalidatePath(`${SPEC[c.scope].path}/${c.requestId}/achat/${c.bc.numero}`);
    revalidatePath("/demandes", "layout");
    return { ok: true, id: ligneId, message: `Acheté — ${ligne.libelle}.${phrasePrix}${echecs.length ? ` Non déposé : ${echecs.join(" ; ")}.` : ""}` };
  });
}

/**
 * DEMANDER LE PAIEMENT DU BC n°k — la facture est OBLIGATOIRE. Une seule source : le BC se RÉSERVE d'abord (écriture
 * conditionnelle), puis la facture rejoint la demande, puis UN ordre de dépense naît (`createExpenseOrder`) au total à payer
 * (achats réels, remboursements déduits) — centre de paiement, puis Finances. Deux clics n'émettent jamais deux ordres.
 */
export async function demanderPaiementBcPec(formData: FormData): Promise<ActionResult> {
  return actionReversible("care-actions:demanderPaiementBcPec", "Paiement d'un BC de prise en charge demandé", async () => {
    const user = await requireUser();
    const c = await chargerBc(fdStr(formData, "bcId"));
    if (!c) return { ok: false, error: "Bon de commande introuvable." };
    if (!(await tientLesMontantsDe(user, c.scope, c.requestId))) return { ok: false, error: "Le paiement se demande par l'assistante de direction sollicitée (ou la Direction Marketing)." };
    const facture = formData.getAll("facture").find((v): v is File => v instanceof File && v.size > 0) ?? null;
    const [rows, doc] = await Promise.all([
      prisma.carePecBcLigne.findMany({ where: { bcId: c.bc.id }, select: { cellId: true, statut: true, montantDzd: true, montantAchatDzd: true, rembourse: true, rembourseDzd: true } }),
      prisma.legalDocument.findUnique({ where: { id: c.bc.legalDocumentId }, select: { signedAt: true, status: true, reference: true } }),
    ]);
    const signe = Boolean(doc?.signedAt) && doc?.status !== "CANCELLED";
    const lignes: LigneAchat[] = rows.map((l) => ({
      bcNumero: c.bc.numero, statut: l.statut, montantDzd: toNumber(l.montantDzd), montantAchatDzd: l.montantAchatDzd != null ? toNumber(l.montantAchatDzd) : null,
      rembourse: l.rembourse, rembourseDzd: l.rembourseDzd != null ? toNumber(l.rembourseDzd) : null, bcSigneFinances: signe,
    }));
    const refus = refusPaiementDuBc({ signeFinances: signe, paiementDemande: c.bc.expenseOrderId != null || c.bc.paiementDemandeLe != null, facture: Boolean(facture), lignes });
    if (refus) return { ok: false, error: refus };
    const refusFichier = await validateAttachments([facture!]);
    if (refusFichier) return { ok: false, error: refusFichier };
    const montant = totalAPayer(lignes);

    // LA RÉSERVE D'ABORD (§118.151) : seul le gagnant émet l'ordre.
    const reserve = await prisma.carePecBc.updateMany({ where: { id: c.bc.id, paiementDemandeLe: null, expenseOrderId: null }, data: { paiementDemandeLe: new Date(), paiementDemandeParId: user.id } });
    if (reserve.count === 0) return { ok: false, error: "Le paiement de ce BC vient d'être demandé : un seul ordre de dépense par BC." };
    const rendre = () => prisma.carePecBc.updateMany({ where: { id: c.bc.id, expenseOrderId: null }, data: { paiementDemandeLe: null, paiementDemandeParId: null } }).catch(sansBloquer("pec-achats.demanderPaiementBcPec.rendre"));
    const depot = await persistUploadedDocument(user.id, { entityType: SPEC[c.scope].module, entityId: c.requestId, category: "INVOICE", confidentiality: "INTERNAL", stepKey: `BC_PEC:${c.bc.id}`, file: facture! })
      .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "dépôt impossible", documentId: undefined }));
    if (!depot.ok || !depot.documentId) { await rendre(); return { ok: false, error: `La facture n'a pas pu être enregistrée (${depot.error ?? "erreur"}) : rien n'est demandé, réessayez.` }; }

    const req = await loadRequest(c.scope, c.requestId);
    let ordre: { id: string; reference: string };
    try {
      ordre = await createExpenseOrder({
        label: `${req?.name ?? "Prise en charge"} — BC n°${c.bc.numero}${doc?.reference ? ` (${doc.reference})` : ""}`,
        amount: montant, category: "EVENEMENT", beneficiary: c.bc.fournisseur,
        sourceType: SPEC[c.scope].module, sourceId: c.requestId, requestedById: user.id, budgetCategoryId: c.bc.budgetCategoryId,
        requiresInvoice: true,
        notes: `Paiement du BC n°${c.bc.numero} de la prise en charge — achats réels, remboursements déduits. Facture jointe.`,
      });
    } catch (err) {
      console.error("[pec-achats] ordre de dépense impossible", err);
      const d = await prisma.document.delete({ where: { id: depot.documentId } }).catch(sansBloquer("pec-achats.demanderPaiementBcPec.document", null));
      if (d?.fileKey) await deleteFileByKey(d.fileKey).catch(sansBloquer("pec-achats.demanderPaiementBcPec.deleteFileByKey"));
      await rendre();
      return { ok: false, error: "L'ordre de dépense n'a pas pu être créé : rien n'est demandé, réessayez." };
    }
    await prisma.carePecBc.update({ where: { id: c.bc.id }, data: { expenseOrderId: ordre.id, factureDocumentId: depot.documentId } });
    // Les postes achetés portent l'ordre qui les paie (le rapport budgétaire les lit) — sans écraser un ordre d'avant.
    const achetes = rows.filter((l) => l.statut === "ACHETEE" || l.statut === "RETIREE_APRES_ACHAT").map((l) => l.cellId);
    if (achetes.length) await prisma.careCell.updateMany({ where: { id: { in: achetes }, expenseOrderId: null }, data: { expenseOrderId: ordre.id } });
    await audit(user, c.scope, c.requestId, "UPDATE", `Paiement du BC n°${c.bc.numero} demandé — facture jointe, ordre de dépense ${ordre.reference} (${montantLisible(montant)}) au centre de paiement.`);
    revalidate(c.scope, c.requestId);
    revalidatePath(`${SPEC[c.scope].path}/${c.requestId}/achat/${c.bc.numero}`);
    revalidatePath("/demandes", "layout");
    revalidatePath("/finances/paiements-a-faire");
    return { ok: true, id: ordre.id, message: `Paiement demandé : ordre de dépense ${ordre.reference} — ${montantLisible(montant)}, facture jointe. Il passe au centre de paiement, puis aux Finances.` };
  });
}
