"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { actionReversible } from "@/lib/effets/reversible";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { canAccessEntity } from "@/lib/entity-access";
import { persistUploadedDocument } from "@/lib/documents";
import { prevenirLeSecretariat } from "@/lib/secretariat/annulation";
import { reviserOrdreNonRegle } from "@/modules/finances/api";
import { cleDeNom } from "@/modules/referentiels/partage";
import { defaultCells } from "./domaine/prise-en-charge/regles";
import { deviseDuPoste, lireMontant, montantLisible, versDzd } from "./domaine/prise-en-charge/fiches";
import { prixAValider, totalAPayer } from "./domaine/prise-en-charge/achats";
import { type Scope, SPEC, isScope, revalidate, canEdit, audit, loadRequest, tauxDe, parentWhere, scopeOfBeneficiary, nameOf } from "./infra/prise-en-charge/actions-commun";
import { ecrirePrixDuPoste, lignesDesPostes, solliciterChiffrage } from "./infra/prise-en-charge/achats";
import { lancerLesAchats } from "./infra/prise-en-charge/bc-pec";
import { pilotePriseEnCharge, tientLesMontantsDe } from "./infra/requetes/achats-pec";
import { demandePrevalidee } from "./infra/prise-en-charge/engagement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — LE CHIFFRAGE ET LA VALIDATION DU CIRCUIT D'ACHAT (Super Admin, 24/11/2026).
 *
 *   • « Demander son devis » (un professionnel) / « Actualiser les prix » (tout ce qui n'est pas encore acheté) : une
 *     demande de chiffrage, ligne du bureau du secrétariat ;
 *   • l'assistante (gardienne des montants) saisit poste par poste, pièce facultative, puis « Envoyer les montants » ; elle
 *     et la Direction Marketing corrigent un montant à tout moment — HISTORISÉ, marge de 10 % après la mise en BC ;
 *   • la Direction Marketing valide PAR PROFESSIONNEL : « Valider seulement » ou « Valider et lancer les achats » ;
 *   • un professionnel se retire à tout moment : avant achat la ligne est barrée, après achat « Remboursé ? ».
 * Morceau de la clé `care-actions` (voir `actions-prise-en-charge.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La demande et son périmètre, lus du formulaire. */
async function demandeDuFormulaire(formData: FormData) {
  const scope = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scope) || !requestId) return null;
  const req = await loadRequest(scope, requestId);
  return req ? { scope: scope as Scope, requestId, req } : null;
}

/** Prévenir la Direction Marketing : le référent de la demande, sinon le rôle. */
async function prevenirLaDirectionMarketing(req: { productManagerId?: string | null }, avis: { title: string; body: string; link: string }, auteurId: string) {
  if (req.productManagerId && req.productManagerId !== auteurId) {
    await notifyUser({ userId: req.productManagerId, type: "VALIDATION_REQUIRED", ...avis }).catch(sansBloquer("pec-chiffrage.notifyUser"));
    return;
  }
  await notifyRoles(["PRODUCT_MANAGER"], { type: "VALIDATION_REQUIRED", ...avis }).catch(sansBloquer("pec-chiffrage.notifyRoles"));
}

/**
 * DEMANDER LE CHIFFRAGE — d'un professionnel (« Demander son devis », `beneficiaryId`) ou de tout ce qui n'est pas encore
 * acheté (« Actualiser les prix », `tous=on`). Le demandeur (par sa fiche) ou la Direction Marketing.
 */
export async function demanderChiffragePec(formData: FormData): Promise<ActionResult> {
  return actionReversible("care-actions:demanderChiffragePec", "Chiffrage demandé à l'assistante", async () => {
    const user = await requireUser();
    const d = await demandeDuFormulaire(formData);
    if (!d) return { ok: false, error: "Demande non précisée." };
    const parLaFiche = canEdit(user, d.scope) && (await canAccessEntity(user, SPEC[d.scope].module, d.requestId, "UPDATE"));
    if (!parLaFiche && !(await pilotePriseEnCharge(user, d.scope, d.requestId))) return { ok: false, error: "Non autorisé." };
    const tous = fdStr(formData, "tous") === "on";
    const beneficiaryId = fdStr(formData, "beneficiaryId");
    if (!tous && !beneficiaryId) return { ok: false, error: "Choisissez le professionnel à chiffrer." };
    if (beneficiaryId) {
      const b = await prisma.careBeneficiary.count({ where: { id: beneficiaryId, ...parentWhere(d.scope, d.requestId), status: { in: ["PROPOSED", "APPROVED"] } } });
      if (!b) return { ok: false, error: "Ce professionnel n'est pas (ou plus) sur cette prise en charge." };
    }
    const r = await solliciterChiffrage(user, d.scope, d.requestId, tous ? { tous: true } : { beneficiaryIds: [beneficiaryId!] });
    if (!r.ok) return r;
    await audit(user, d.scope, d.requestId, "UPDATE", tous ? "Prix à actualiser : tout ce qui n'est pas encore acheté part au chiffrage." : "Chiffrage demandé à l'assistante pour un professionnel.");
    revalidate(d.scope, d.requestId);
    revalidatePath("/demandes", "layout");
    return { ok: true, id: r.id, message: `${tous ? "Prix à actualiser" : "Chiffrage demandé"} — l'assistante de direction le voit dans son bureau (sujet ${r.reference}).` };
  });
}

/**
 * ENREGISTRER LES MONTANTS (« Enregistrer » : la demande passe « en cours ») ou LES ENVOYER (`envoyer=oui` : terminée, la
 * Direction Marketing est prévenue). Un montant par poste (`cellIds` / `montants`, alignés), dans la devise du poste ; une pièce
 * facultative (`pieces` / `pieceCellIds`). Chaque montant changé est historisé ; après la mise en BC, la marge de 10 % s'applique.
 */
export async function enregistrerMontantsPec(formData: FormData): Promise<ActionResult> {
  return actionReversible("care-actions:enregistrerMontantsPec", "Montants de prise en charge saisis", async () => {
    const user = await requireUser();
    const d = await demandeDuFormulaire(formData);
    if (!d) return { ok: false, error: "Demande non précisée." };
    if (!(await tientLesMontantsDe(user, d.scope, d.requestId))) return { ok: false, error: "Les montants se saisissent par l'assistante de direction sollicitée ou la Direction Marketing." };
    const envoyer = fdStr(formData, "envoyer") === "oui";
    // DES LISTES ALIGNÉES (noms de champs fixes, lisibles par le contrat des actions) : `cellIds[i]` ↔ `montants[i]` ;
    // les pièces : `pieces[j]` ↔ `pieceCellIds[j]`.
    const ids = formData.getAll("cellIds").map(String);
    const montantsSaisis = formData.getAll("montants").map(String);
    if (ids.length === 0 || ids.some((x) => !x)) return { ok: false, error: "Aucun poste à chiffrer." };
    if (montantsSaisis.length !== ids.length) return { ok: false, error: "La grille envoyée est incomplète : rechargez la page." };
    const pieceDe = new Map<string, File>();
    const pieces = formData.getAll("pieces");
    const pieceCellIds = formData.getAll("pieceCellIds").map(String);
    pieces.forEach((f, j) => { if (f instanceof File && f.size > 0 && pieceCellIds[j]) pieceDe.set(pieceCellIds[j]!, f); });
    const cells = await prisma.careCell.findMany({
      where: { id: { in: ids }, kind: "SERVICE", beneficiary: parentWhere(d.scope, d.requestId) },
      select: { id: true, label: true, serviceKind: true, amount: true, amountDzd: true, currency: true },
    });
    if (cells.length !== new Set(ids).size) return { ok: false, error: "Certains postes n'appartiennent pas à cette prise en charge." };
    const taux = tauxDe(d.scope, d.req);

    // L'ÉTAT D'ABORD : tout se lit avant d'écrire — un montant illisible ne laisse pas la moitié de la grille enregistrée.
    const saisies: { id: string; label: string; montant: number | null; devise: "DZD" | "USD"; dzd: number | null; change: boolean; fichier: File | null }[] = [];
    for (const c of cells) {
      const lu = lireMontant(montantsSaisis[ids.indexOf(c.id)] ?? "");
      if (!lu.ok) return { ok: false, error: `Le montant de « ${c.label} » est illisible (ex. 46000 ou 1250,50).` };
      const devise = deviseDuPoste(d.scope, c.serviceKind);
      const dzd = versDzd(lu.montant, devise, taux);
      if (lu.montant != null && dzd == null) return { ok: false, error: "Le taux de conversion de cette demande est inconnu : un montant en dollars ne peut pas être converti." };
      const avant = c.amount != null ? toNumber(c.amount) : c.currency === "DZD" && c.amountDzd != null ? toNumber(c.amountDzd) : null;
      saisies.push({ id: c.id, label: c.label, montant: lu.montant, devise, dzd, change: lu.montant != null && lu.montant !== avant, fichier: pieceDe.get(c.id) ?? null });
    }
    const manquants = saisies.filter((s) => s.montant == null).length;
    if (envoyer && manquants > 0) return { ok: false, error: `${manquants} montant${manquants > 1 ? "s" : ""} manquant${manquants > 1 ? "s" : ""} : saisissez chaque poste (0 s'il ne coûte rien) avant d'envoyer.` };

    const phrases: string[] = [];
    for (const s of saisies) {
      let pieceId: string | null = null;
      if (s.fichier) {
        const p = await persistUploadedDocument(user.id, { entityType: SPEC[d.scope].module, entityId: d.requestId, category: "QUOTE", confidentiality: "INTERNAL", stepKey: s.id, file: s.fichier });
        if (!p.ok || !p.documentId) return { ok: false, error: p.error ?? `La pièce de « ${s.label} » n'a pas pu être enregistrée.` };
        pieceId = p.documentId;
      }
      if (!s.change && !pieceId) continue;
      if (!s.change) { await prisma.careCell.update({ where: { id: s.id }, data: { chiffragePieceId: pieceId } }); continue; }
      const w = await ecrirePrixDuPoste({ cellId: s.id, montant: s.montant!, devise: s.devise, amountDzd: s.dzd!, auteurId: user.id, motif: "Chiffrage", chiffrage: true, pieceId });
      if (!w.ok) return { ok: false, error: w.error };
      if (w.voie === "HORS_MARGE") phrases.push(`${s.label} : ${w.message}`);
    }

    const maintenant = new Date();
    const ouverte = await prisma.careChiffrage.findFirst({ where: { ...parentWhere(d.scope, d.requestId), etat: { in: ["A_PRENDRE", "EN_COURS"] } }, orderBy: { demandeLe: "asc" } });
    if (ouverte) {
      await prisma.careChiffrage.updateMany({
        where: { id: ouverte.id, etat: ouverte.etat },
        data: envoyer
          ? { etat: "TERMINEE", envoyeeLe: maintenant, envoyeeParId: user.id, priseParId: ouverte.priseParId ?? user.id, priseLe: ouverte.priseLe ?? maintenant }
          : { etat: "EN_COURS", priseParId: ouverte.priseParId ?? user.id, priseLe: ouverte.priseLe ?? maintenant },
      });
    }
    if (envoyer) {
      const total = saisies.reduce((t, s) => t + (s.dzd ?? 0), 0);
      await prevenirLaDirectionMarketing(await prisma.congressNational.findUnique({ where: { id: d.requestId }, select: { productManagerId: true } }) ?? await prisma.congressInternational.findUnique({ where: { id: d.requestId }, select: { productManagerId: true } }) ?? {}, {
        title: "Montants chiffrés à valider — prise en charge", body: `${d.req.name} : ${saisies.length} poste(s) chiffré(s), ${montantLisible(Math.round(total * 100) / 100)}.`, link: `${SPEC[d.scope].path}/${d.requestId}`,
      }, user.id);
      if (d.req.requesterId && d.req.requesterId !== user.id) {
        await notifyUser({ userId: d.req.requesterId, type: "GENERIC", title: "Montants chiffrés — prise en charge", body: `${d.req.name} : les montants sont saisis, la Direction Marketing les valide.`, link: `${SPEC[d.scope].path}/${d.requestId}` })
          .catch(sansBloquer("pec-chiffrage.enregistrerMontantsPec.notifyUser"));
      }
    }
    await audit(user, d.scope, d.requestId, "UPDATE", `${envoyer ? "Montants envoyés" : "Montants enregistrés"} : ${saisies.filter((s) => s.change).map((s) => `${s.label} = ${montantLisible(s.montant!, s.devise)}`).join(", ") || "aucun changement de prix"}.`);
    revalidate(d.scope, d.requestId);
    revalidatePath(`${SPEC[d.scope].path}/${d.requestId}/chiffrer`);
    revalidatePath("/demandes", "layout");
    const base = envoyer ? "Montants envoyés — la Direction Marketing est prévenue." : `Montants enregistrés${manquants ? ` (${manquants} manquant${manquants > 1 ? "s" : ""})` : ""}.`;
    return { ok: true, message: [base, ...phrases].join(" ") };
  });
}

/**
 * CORRIGER LE MONTANT D'UN POSTE — l'assistante ou la Direction Marketing, à tout moment. Historisé ; après la mise en BC :
 * jusqu'à +10 % le prix d'achat est corrigé sans nouveau BC (une baisse toujours), au-delà le BC ne bouge pas et le
 * complément attend la validation puis un BC complémentaire — la réponse le dit.
 */
export async function modifierMontantPec(formData: FormData): Promise<ActionResult> {
  return actionReversible("care-actions:modifierMontantPec", "Montant de prise en charge corrigé", async () => {
    const user = await requireUser();
    const cellId = fdStr(formData, "cellId");
    if (!cellId) return { ok: false, error: "Poste non précisé." };
    const cell = await prisma.careCell.findUnique({ where: { id: cellId }, select: { id: true, label: true, kind: true, serviceKind: true, beneficiaryId: true } });
    if (!cell || cell.kind !== "SERVICE") return { ok: false, error: "Poste introuvable." };
    const found = await scopeOfBeneficiary(cell.beneficiaryId);
    if (!found) return { ok: false, error: "Personne introuvable." };
    if (!(await tientLesMontantsDe(user, found.scope, found.requestId))) return { ok: false, error: "Les montants se corrigent par l'assistante de direction sollicitée ou la Direction Marketing." };
    const lu = lireMontant(fdStr(formData, "montant"));
    if (!lu.ok || lu.montant == null) return { ok: false, error: "Le montant est illisible (ex. 46000 ou 1250,50)." };
    const req = await loadRequest(found.scope, found.requestId);
    const devise = deviseDuPoste(found.scope, cell.serviceKind);
    const dzd = versDzd(lu.montant, devise, tauxDe(found.scope, req));
    if (dzd == null) return { ok: false, error: "Le taux de conversion de cette demande est inconnu : un montant en dollars ne peut pas être converti." };
    const w = await ecrirePrixDuPoste({ cellId, montant: lu.montant, devise, amountDzd: dzd, auteurId: user.id, motif: fdStr(formData, "motif") ?? "Correction", chiffrage: false });
    if (!w.ok) return w;
    await audit(user, found.scope, found.requestId, "UPDATE", `${await nameOf(found.beneficiary)} — « ${cell.label} » : ${montantLisible(lu.montant, devise)}. ${w.message}`);
    revalidate(found.scope, found.requestId);
    revalidatePath("/demandes", "layout");
    return { ok: true, id: cellId, message: w.message };
  });
}

/**
 * VALIDER LES PROFESSIONNELS CHIFFRÉS — la Direction Marketing, par professionnel (`beneficiaryIds`, sinon tous ceux qui
 * attendent) : la personne est accordée, ses postes chiffrés sont validés au montant LU (écriture conditionnelle : un prix
 * changé entre-temps n'est pas validé à l'aveugle). `lancer=oui` : « Valider et lancer les achats » dans le même geste.
 */
export async function validerProfessionnelsPec(formData: FormData): Promise<ActionResult> {
  return actionReversible("care-actions:validerProfessionnelsPec", "Professionnels chiffrés validés", async () => {
    const user = await requireUser();
    const d = await demandeDuFormulaire(formData);
    if (!d) return { ok: false, error: "Demande non précisée." };
    if (!(await pilotePriseEnCharge(user, d.scope, d.requestId))) return { ok: false, error: "Seule la Direction Marketing valide les montants d'une prise en charge." };
    const voulus = formData.getAll("beneficiaryIds").map(String).filter(Boolean);
    const personnes = await prisma.careBeneficiary.findMany({
      where: { ...parentWhere(d.scope, d.requestId), status: { in: ["PROPOSED", "APPROVED"] }, ...(voulus.length ? { id: { in: voulus } } : {}) },
      select: { id: true, status: true, doctorId: true, firstName: true, lastName: true, cells: { where: { kind: "SERVICE", status: { not: "WAIVED" } }, select: { id: true, amountDzd: true, montantValideDzd: true, chiffreLe: true } } },
    });
    const aValider = personnes.filter((p) => p.cells.some((c) => prixAValider({ chiffre: c.chiffreLe != null, prixDzd: c.amountDzd != null ? toNumber(c.amountDzd) : null, valideDzd: c.montantValideDzd != null ? toNumber(c.montantValideDzd) : null })));
    const lancer = fdStr(formData, "lancer") === "oui";
    if (aValider.length === 0 && !lancer) return { ok: false, error: "Aucun professionnel n'a de montant chiffré à valider." };

    const maintenant = new Date();
    const noms: string[] = [];
    for (const p of aValider) {
      if (p.status === "PROPOSED") {
        await prisma.careBeneficiary.updateMany({ where: { id: p.id, status: "PROPOSED" }, data: { status: "APPROVED", decidedById: user.id, decidedAt: maintenant, updatedById: user.id } });
        // Accorder une personne crée ses pièces à fournir (comme `decideCareBeneficiary`) — une seule fois.
        if ((await prisma.careCell.count({ where: { beneficiaryId: p.id, kind: "DOCUMENT" } })) === 0) {
          await prisma.careCell.createMany({ data: defaultCells(d.scope).map((c, i) => ({ beneficiaryId: p.id, kind: c.kind, serviceKind: c.serviceKind, label: c.label, requestedById: user.id, position: 100 + i })) });
        }
      }
      for (const c of p.cells) {
        if (c.chiffreLe == null || c.amountDzd == null) continue;
        await prisma.careCell.updateMany({ where: { id: c.id, amountDzd: c.amountDzd }, data: { montantValideDzd: c.amountDzd, valideLe: maintenant, valideParId: user.id } });
      }
      noms.push(await nameOf(p));
    }
    if (noms.length) await audit(user, d.scope, d.requestId, "UPDATE", `Montants validés par la Direction Marketing : ${noms.join(", ")}.`);
    let message = noms.length ? `${noms.length} professionnel${noms.length > 1 ? "s" : ""} validé${noms.length > 1 ? "s" : ""} (${noms.join(", ")}).` : "";
    if (lancer) {
      const r = await lancerLesAchats(user as never, d.scope, d.requestId, { fournisseur: fdStr(formData, "fournisseur"), budgetCategoryId: fdStr(formData, "budgetCategoryId") });
      revalidate(d.scope, d.requestId);
      if (!r.ok) return noms.length ? { ok: true, message: `${message} Les achats ne sont pas lancés : ${r.error}` } : { ok: false, error: r.error };
      message = `${message} BC n°${r.numero} (${r.reference}) lancé — ${r.lignes} poste(s), ${montantLisible(r.total)}. Signez-le pour l'envoyer au centre Ad & Pro.`.trim();
    }
    revalidate(d.scope, d.requestId);
    return { ok: true, message: message || "Rien à valider." };
  });
}

/**
 * RETIRER UN PROFESSIONNEL — à tout moment par la Direction Marketing, avant la prévalidation par le demandeur. Ses lignes
 * de BC non achetées sont BARRÉES (l'engagement est libéré) ; achetées, elles passent « Remboursé ? » (l'assistante ou la
 * Direction Marketing répondra). Rien ne s'efface : la personne reste, barrée, avec son motif.
 */
export async function retirerProfessionnelPec(formData: FormData): Promise<ActionResult> {
  return actionReversible("care-actions:retirerProfessionnelPec", "Professionnel retiré de la prise en charge", async () => {
    const user = await requireUser();
    const id = fdStr(formData, "beneficiaryId");
    if (!id) return { ok: false, error: "Professionnel non précisé." };
    const found = await scopeOfBeneficiary(id);
    if (!found) return { ok: false, error: "Professionnel introuvable." };
    const req = await loadRequest(found.scope, found.requestId);
    if (!req) return { ok: false, error: "Demande introuvable." };
    const dm = await pilotePriseEnCharge(user, found.scope, found.requestId);
    const demandeurAvant = req.requesterId === user.id && !(await demandePrevalidee(found.scope, found.requestId));
    if (!dm && !demandeurAvant) return { ok: false, error: "Après la prévalidation, seule la Direction Marketing retire un professionnel." };
    if (found.beneficiary.status === "WITHDRAWN") return { ok: false, error: "Ce professionnel est déjà retiré." };
    const motif = fdStr(formData, "motif");

    const cells = await prisma.careCell.findMany({ where: { beneficiaryId: id }, select: { id: true } });
    const lignes = [...(await lignesDesPostes(cells.map((c) => c.id))).values()].flat();
    const maintenant = new Date();
    const r = await prisma.$transaction(async (tx) => {
      const b = await tx.careBeneficiary.updateMany({ where: { id, status: { not: "WITHDRAWN" } }, data: { status: "WITHDRAWN", decisionNote: motif ?? "Retiré de la prise en charge", decidedById: user.id, decidedAt: maintenant, updatedById: user.id } });
      if (b.count === 0) return null;
      const barrees = await tx.carePecBcLigne.updateMany({ where: { id: { in: lignes.filter((l) => l.statut === "ACTIVE").map((l) => l.id) }, statut: "ACTIVE" }, data: { statut: "RETIREE_AVANT_ACHAT", retireLe: maintenant, retireParId: user.id, retraitMotif: motif } });
      const apres = await tx.carePecBcLigne.updateMany({ where: { id: { in: lignes.filter((l) => l.statut === "ACHETEE").map((l) => l.id) }, statut: "ACHETEE" }, data: { statut: "RETIREE_APRES_ACHAT", retireLe: maintenant, retireParId: user.id, retraitMotif: motif } });
      // Il sort de la demande de chiffrage ouverte : l'assistante n'a plus à le chiffrer.
      const ouverte = await tx.careChiffrage.findFirst({ where: { ...parentWhere(found.scope, found.requestId), etat: { in: ["A_PRENDRE", "EN_COURS"] } } });
      if (ouverte && ouverte.beneficiaryIds.includes(id)) await tx.careChiffrage.update({ where: { id: ouverte.id }, data: { beneficiaryIds: ouverte.beneficiaryIds.filter((x) => x !== id) } });
      return { barrees: barrees.count, apres: apres.count };
    });
    if (!r) return { ok: false, error: "Ce professionnel vient d'être retiré." };
    const nom = await nameOf(found.beneficiary);
    // L'ASSISTANTE QUI ACHÈTE EST PRÉVENUE : une ligne d'un BC signé ne s'achète plus ; une ligne achetée attend « Remboursé ? ».
    if (lignes.some((l) => l.bcSigneFinances)) {
      await prevenirLeSecretariat(null, {
        type: "GENERIC", title: `Professionnel retiré — ${req.name}`,
        body: `${nom} est retiré${r.barrees ? ` : ${r.barrees} ligne(s) barrée(s), ne les achetez pas` : ""}${r.apres ? `${r.barrees ? " ;" : " :"} ${r.apres} ligne(s) déjà achetée(s) — vérifiez si le coût est remboursé` : ""}.`,
        link: `${SPEC[found.scope].path}/${found.requestId}`,
      }, user.id).catch(sansBloquer("pec-chiffrage.retirerProfessionnelPec.prevenirLeSecretariat", 0));
    }
    await audit(user, found.scope, found.requestId, "UPDATE", `${nom} retiré de la prise en charge${motif ? ` — ${motif}` : ""}${r.barrees ? ` ; ${r.barrees} ligne(s) de BC barrée(s) avant achat` : ""}${r.apres ? ` ; ${r.apres} ligne(s) achetée(s) : remboursé ?` : ""}.`);
    revalidate(found.scope, found.requestId);
    revalidatePath("/demandes", "layout");
    return {
      ok: true, id,
      message: r.apres ? `${nom} est retiré. ${r.apres} achat(s) déjà fait(s) : répondez « Remboursé ? » quand vous le savez.` : `${nom} est retiré${r.barrees ? " — ses lignes de BC sont barrées, l'engagement est libéré" : ""}.`,
    };
  });
}

/**
 * « REMBOURSÉ ? » — après le retrait d'un professionnel déjà acheté : l'assistante ou la Direction Marketing répond. Oui :
 * le montant (tout, ou `montant`) est déduit de l'achat — l'ordre de dépense non réglé du BC est révisé, le budget suit ; un
 * ordre déjà réglé garde sa trace et les Finances sont prévenues du remboursement à encaisser. Écriture conditionnelle.
 */
export async function repondreRemboursementPec(formData: FormData): Promise<ActionResult> {
  return actionReversible("care-actions:repondreRemboursementPec", "Remboursement d'un achat de prise en charge", async () => {
    const user = await requireUser();
    const ligneId = fdStr(formData, "ligneId");
    const rep = fdStr(formData, "rembourse");
    if (!ligneId || (rep !== "oui" && rep !== "non")) return { ok: false, error: "Répondez oui ou non." };
    const ligne = await prisma.carePecBcLigne.findUnique({
      where: { id: ligneId },
      select: { id: true, cellId: true, libelle: true, statut: true, rembourse: true, montantDzd: true, montantAchatDzd: true, bcId: true, bc: { select: { numero: true, expenseOrderId: true } } },
    });
    if (!ligne) return { ok: false, error: "Ligne introuvable." };
    const cell = await prisma.careCell.findUnique({ where: { id: ligne.cellId }, select: { beneficiaryId: true } });
    const found = cell ? await scopeOfBeneficiary(cell.beneficiaryId) : null;
    if (!found) return { ok: false, error: "Professionnel introuvable." };
    if (!(await tientLesMontantsDe(user, found.scope, found.requestId))) return { ok: false, error: "L'assistante de direction ou la Direction Marketing répond « Remboursé ? »." };
    if (ligne.statut !== "RETIREE_APRES_ACHAT") return { ok: false, error: "Cette ligne n'est pas un achat retiré : rien à rembourser." };
    if (ligne.rembourse != null) return { ok: false, error: "La réponse est déjà donnée pour cette ligne." };
    const achat = toNumber(ligne.montantAchatDzd ?? ligne.montantDzd);
    let rembourseDzd: number | null = null;
    if (rep === "oui") {
      const lu = lireMontant(fdStr(formData, "montant"));
      if (!lu.ok) return { ok: false, error: "Le montant remboursé est illisible." };
      rembourseDzd = lu.montant ?? achat;
      if (rembourseDzd > achat) return { ok: false, error: `Le remboursement ne peut pas dépasser l'achat (${montantLisible(achat)}).` };
    }
    const w = await prisma.carePecBcLigne.updateMany({
      where: { id: ligneId, rembourse: null, statut: "RETIREE_APRES_ACHAT" },
      data: { rembourse: rep === "oui", rembourseDzd, rembourseRepondLe: new Date(), rembourseRepondParId: user.id },
    });
    if (w.count === 0) return { ok: false, error: "La réponse vient d'être donnée par quelqu'un d'autre : rechargez la page." };

    let suite = "";
    if (rep === "oui" && ligne.bc.expenseOrderId) {
      // LE BUDGET SUIT : l'ordre non réglé du BC est révisé au nouveau total (la seule écriture d'un ordre né, §118.191).
      const toutes = await prisma.carePecBcLigne.findMany({ where: { bcId: ligne.bcId }, select: { statut: true, montantDzd: true, montantAchatDzd: true, rembourse: true, rembourseDzd: true } });
      const total = totalAPayer(toutes.map((l) => ({ bcNumero: ligne.bc.numero, statut: l.statut, montantDzd: toNumber(l.montantDzd), montantAchatDzd: l.montantAchatDzd != null ? toNumber(l.montantAchatDzd) : null, rembourse: l.rembourse, rembourseDzd: l.rembourseDzd != null ? toNumber(l.rembourseDzd) : null, bcSigneFinances: true })));
      const rev = await reviserOrdreNonRegle(prisma, ligne.bc.expenseOrderId, { montant: total }, { acteurId: user.id, raison: `Remboursement de ${montantLisible(rembourseDzd!)} — ${ligne.libelle}` });
      if (rev.ok) suite = rev.revise ? ` L'ordre de dépense ${rev.reference} est ramené à ${montantLisible(total)}.` : "";
      else {
        suite = " L'ordre de dépense est déjà réglé : le remboursement est tracé, les Finances sont prévenues de l'encaisser.";
        await notifyRoles(["FINANCE_BUDGET_MANAGER"], { type: "GENERIC", title: "Remboursement à encaisser — prise en charge", body: `${ligne.libelle} : ${montantLisible(rembourseDzd!)} remboursé (BC n°${ligne.bc.numero}).`, link: `${SPEC[found.scope].path}/${found.requestId}` })
          .catch(sansBloquer("pec-chiffrage.repondreRemboursementPec.notifyRoles"));
      }
    }
    await audit(user, found.scope, found.requestId, "UPDATE", `« Remboursé ? » — ${ligne.libelle} : ${rep === "oui" ? `oui, ${montantLisible(rembourseDzd!)} déduit de l'achat et du budget` : "non"}.${suite}`);
    revalidate(found.scope, found.requestId);
    revalidatePath("/demandes", "layout");
    return { ok: true, message: rep === "oui" ? `Remboursement de ${montantLisible(rembourseDzd!)} enregistré — déduit de l'achat.${suite}` : "Non remboursé : l'achat reste dû." };
  });
}

/**
 * LES HOMONYMES DANS L'ANNUAIRE — avant « Ajouter à l'annuaire ? » : les fiches dont le nom, mots triés, est le même
 * (`cleDeNom`). Une lecture ; les archivées ne comptent pas.
 */
export async function homonymesAnnuairePec(formData: FormData): Promise<{ id: string; nom: string; specialite: string | null; etablissement: string | null }[]> {
  await requireUser();
  const nom = (fdStr(formData, "nom") ?? "").trim();
  const cle = cleDeNom(nom);
  if (!cle) return [];
  // Les mots TELS QUE TAPÉS (accents compris) cherchent les candidats ; la clé pliée tranche ensuite.
  const mots = nom.split(/[^\p{L}\p{N}]+/u).filter((m) => m.length > 2).slice(0, 4);
  if (mots.length === 0) return [];
  const rows = await prisma.medicalDoctor.findMany({
    where: { archivedAt: null, OR: mots.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) },
    take: 100, orderBy: { name: "asc" },
    select: { id: true, name: true, specialty: true, institution: true },
  });
  return rows.filter((r) => cleDeNom(r.name) === cle).map((r) => ({ id: r.id, nom: r.name, specialite: r.specialty, etablissement: r.institution }));
}
