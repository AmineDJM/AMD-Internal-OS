"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { moneyEntityOf } from "@/lib/company";
import { enSerie } from "@/lib/refs";
import { validateAttachments } from "@/lib/attach-files";
import { persistUploadedDocument } from "@/lib/documents";
import { resolveParties } from "@/lib/queries/company-contacts";
import { aiguillerBC } from "@/lib/bons-de-commande/aiguillage";
import { reserveDeLAiguillage } from "@/lib/bons-de-commande/regle";
import { notifierSignatairesBC } from "@/lib/bons-de-commande/signataires";
import { lienBonDeCommande } from "@/lib/chemins/bons-de-commande";
import { fdNum, fdStr, type ActionResult } from "@/lib/actions/types";
import { gereLaDemande, commandeLaDemande, REFUS_COMMANDE } from "@/lib/secretariat/droits";
import { prevenirLeSecretariat } from "@/lib/secretariat/annulation";
import { statutAffiche } from "@/lib/secretariat/traitement";
import {
  validerSaisie, appliquerSaisie, appliquerRetenue, refusEditionDevis, totauxDesLignes, etapeBCAttendue, type LigneSaisie,
} from "@/lib/secretariat/devis-natif";
import {
  devisDeLaDemande, devisNatifDe, ecrireDevisNatif, fileDuDevis, genererBCDuFournisseur, nouvelIdDeLigne,
} from "@/lib/secretariat/devis-natif-serveur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS NATIFS D'UNE DEMANDE AU SECRÉTARIAT → LE BON DE COMMANDE (« comme dans Ad & Pro »).
 *
 *   1. l'assistante DÉPOSE le devis du fournisseur (fichier exigé) et le RETRANSCRIT : désignation,
 *      référence, quantité, prix unitaire HT, TVA — `deposerDevisDemande`, `enregistrerLignesDevisDemande` ;
 *   2. le demandeur RETIENT les lignes qu'il veut, sur un ou plusieurs devis — `retenirLignesDevisDemande` ;
 *   3. il GÉNÈRE un BC par fournisseur (la fabrique, sous délégation de la demande) — ou DÉPOSE un BC
 *      déjà fait — `genererBonDeCommandeDemande`, `deposerBonDeCommandeDemande` ;
 *   4. le BC passe par le centre de validations (au-dessus de son seuil), puis la signature (module
 *      « Bons de commande ») ; la fiche relit son étape, jusqu'à « Signé et validé ».
 *
 * Et `relancerDemande` : la personne chez qui la demande attend reçoit un rappel, une fois par jour.
 * La règle est dans `secretariat/devis-natif.ts` ; les écritures sous verrou dans `devis-natif-serveur.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FERMEE = "Cette demande est terminée ou annulée : ses devis ne se traitent plus.";

async function chargerDemande(id: string | null) {
  if (!id) return null;
  return prisma.administrativeRequest.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, reference: true, title: true, status: true, requesterId: true, assignedToId: true, companyId: true, blockedReason: true },
  });
}
const ouverte = (status: string) => status !== "DONE" && status !== "CANCELLED";

function revalider(id: string) {
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes");
}

/** Le premier fichier non vide d'un champ — le devis ou le BC du fournisseur. */
function fichierDe(formData: FormData, champ = "attachment"): File | null {
  return formData.getAll(champ).find((v): v is File => v instanceof File && v.size > 0) ?? null;
}

/** Les lignes envoyées par l'éditeur (`lignes` = JSON d'un tableau de lignes saisies). */
function lignesDuFormulaire(formData: FormData): LigneSaisie[] | null {
  const brut = fdStr(formData, "lignes");
  if (!brut) return [];
  try {
    const v = JSON.parse(brut) as unknown;
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as LigneSaisie[]) : null;
  } catch {
    return null;
  }
}

/** Le fournisseur choisi dans l'annuaire — son nom affiché, ou le refus. */
async function fournisseurChoisi(userId: string, supplierId: string | null): Promise<{ ok: true; id: string | null; nom: string | null } | { ok: false; error: string }> {
  if (!supplierId) return { ok: true, id: null, nom: null };
  const p = await resolveParties(userId, [supplierId]);
  if (!p.ok) return { ok: false, error: p.error };
  return { ok: true, id: p.ids[0] ?? null, nom: p.text || null };
}

// ─────────────────────────── 1. Déposer et retranscrire un devis ───────────────────────────

/**
 * DÉPOSER UN DEVIS — par l'assistante (qui gère la demande). Le fichier est EXIGÉ : une
 * retranscription sans sa source ne se vérifie pas. Le devis entre au registre (nature « devis »,
 * source la demande) ; ses lignes peuvent être saisies dans le même geste, ou ensuite.
 */
export async function deposerDevisDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const req = await chargerDemande(fdStr(formData, "id"));
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!gereLaDemande(user, req)) return { ok: false, error: "Seule l'assistante qui gère la demande dépose et retranscrit les devis." };
  if (!ouverte(req.status)) return { ok: false, error: FERMEE };
  const fichier = fichierDe(formData);
  if (!fichier) return { ok: false, error: "Joignez le devis du fournisseur (PDF, image ou Word)." };
  const refusFichier = await validateAttachments([fichier]);
  if (refusFichier) return { ok: false, error: refusFichier };
  const f = await fournisseurChoisi(user.id, fdStr(formData, "supplierId"));
  if (!f.ok) return { ok: false, error: f.error };
  if (!f.id) return { ok: false, error: "Choisissez le fournisseur dans l'annuaire : c'est lui que le bon de commande nommera." };
  const saisies = lignesDuFormulaire(formData);
  if (saisies === null) return { ok: false, error: "Les lignes du devis sont illisibles : rechargez la fiche." };
  const lignes = saisies.length > 0 ? validerSaisie(saisies) : null;
  if (lignes && !lignes.ok) return { ok: false, error: lignes.error };
  const reference = fdStr(formData, "reference");
  const date = fdStr(formData, "quoteDate");
  const dateDevis = date && !Number.isNaN(Date.parse(date)) ? date.slice(0, 10) : null;

  const doc = await prisma.legalDocument.create({
    data: {
      title: `Devis ${f.nom}${reference ? ` n° ${reference}` : ""} — ${req.reference}`,
      kind: "QUOTE", reference, counterparty: f.nom, counterpartyIds: [f.id],
      companyId: req.companyId ?? (req.requesterId ? await moneyEntityOf(req.requesterId) : null),
      startDate: dateDevis ? new Date(`${dateDevis}T00:00:00.000Z`) : null,
      sourceType: "ADMIN_REQUEST", sourceId: req.id, createdById: user.id, updatedById: user.id,
      notes: `Devis déposé au bureau du secrétariat pour la demande ${req.reference}.`,
    },
    select: { id: true },
  });
  const depot = await persistUploadedDocument(user.id, { entityType: "LEGAL_DOCUMENT", entityId: doc.id, category: "QUOTE", confidentiality: "INTERNAL", stepKey: null, file: fichier });
  if (!depot.ok) {
    await prisma.legalDocument.delete({ where: { id: doc.id } }).catch(() => undefined);
    return { ok: false, error: `Le fichier du devis n'a pas pu être enregistré (${depot.error ?? "erreur"}) : rien n'est déposé.` };
  }
  let phraseLignes = " Retranscrivez maintenant ses lignes : le demandeur les retiendra.";
  if (lignes?.ok) {
    const natif = appliquerSaisie(null, { fournisseurId: f.id, fournisseur: f.nom ?? "", date: dateDevis, lignes: lignes.lignes }, { par: user.id, le: new Date().toISOString(), nouvelId: nouvelIdDeLigne }).devis;
    await ecrireDevisNatif(doc.id, 0, natif, { userId: user.id, montant: totauxDesLignes(natif.lignes).ttc });
    phraseLignes = ` ${natif.lignes.length} ligne${natif.lignes.length > 1 ? "s" : ""} retranscrite${natif.lignes.length > 1 ? "s" : ""} — le demandeur est prévenu.`;
    await prevenirDemandeur(req, user.id);
  }
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: req.id, summary: `Devis ${f.nom}${reference ? ` n° ${reference}` : ""} déposé` });
  revalider(req.id);
  return { ok: true, id: doc.id, message: `Devis déposé.${phraseLignes}` };
}

async function prevenirDemandeur(req: { id: string; reference: string; requesterId: string | null }, auteurId: string) {
  if (!req.requesterId || req.requesterId === auteurId) return;
  await notifyUser({
    userId: req.requesterId, type: "GENERIC", title: "Devis à retenir",
    body: `${req.reference} — un devis est retranscrit : cochez les lignes que vous retenez, puis générez le bon de commande.`,
    link: `/demandes/${req.id}`,
  }).catch(() => undefined);
}

/**
 * RETRANSCRIRE (ou corriger) LES LIGNES D'UN DEVIS — l'ensemble REMPLACE le précédent. Une ligne
 * corrigée perd sa retenue (le demandeur avait retenu l'ancien prix) ; une ligne déjà commandée
 * fige le devis (`refusEditionDevis`). La première retranscription prévient le demandeur.
 */
export async function enregistrerLignesDevisDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const req = await chargerDemande(fdStr(formData, "id"));
  const devisId = fdStr(formData, "devisId");
  if (!req || !devisId) return { ok: false, error: "Demande ou devis introuvable." };
  if (!gereLaDemande(user, req)) return { ok: false, error: "Seule l'assistante qui gère la demande retranscrit les devis." };
  if (!ouverte(req.status)) return { ok: false, error: FERMEE };
  const saisies = lignesDuFormulaire(formData);
  if (saisies === null) return { ok: false, error: "Les lignes du devis sont illisibles : rechargez la fiche." };
  const v = validerSaisie(saisies);
  if (!v.ok) return { ok: false, error: v.error };
  const supplierId = fdStr(formData, "supplierId");
  const f = await fournisseurChoisi(user.id, supplierId);
  if (!f.ok) return { ok: false, error: f.error };
  const date = fdStr(formData, "quoteDate");
  const dateDevis = date && !Number.isNaN(Date.parse(date)) ? date.slice(0, 10) : null;

  return enSerie(fileDuDevis(devisId), async () => {
    const d = await devisNatifDe(devisId, req.id);
    if (!d) return { ok: false, error: "Ce devis n'appartient pas à la demande : rechargez la fiche." };
    if (d.doc.status === "CANCELLED") return { ok: false, error: "Ce devis est annulé au registre : il ne se retranscrit plus." };
    const lu = await devisDeLaDemande(req.id);
    const refsBC = new Map(lu.bcs.map((b) => [b.id, b.reference]));
    const gel = refusEditionDevis(d.natif, lu.bcsActifs, refsBC);
    if (gel) return { ok: false, error: gel };
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: devisId }, select: { counterparty: true, counterpartyIds: true, startDate: true } });
    const fournisseurId = f.id ?? d.natif?.fournisseurId ?? doc.counterpartyIds[0] ?? null;
    const fournisseur = f.nom ?? d.natif?.fournisseur ?? doc.counterparty ?? "";
    if (!fournisseurId && !fournisseur.trim()) return { ok: false, error: "Choisissez le fournisseur dans l'annuaire : c'est lui que le bon de commande nommera." };
    const premiere = !d.natif || d.natif.lignes.length === 0;
    const { devis, retenuesPerdues } = appliquerSaisie(d.natif, {
      fournisseurId, fournisseur, date: dateDevis ?? d.natif?.date ?? (doc.startDate ? doc.startDate.toISOString().slice(0, 10) : null), lignes: v.lignes,
    }, { par: user.id, le: new Date().toISOString(), nouvelId: nouvelIdDeLigne });
    const ecrit = await ecrireDevisNatif(devisId, d.natif?.version ?? 0, devis, { userId: user.id, montant: totauxDesLignes(devis.lignes).ttc });
    if (!ecrit) return { ok: false, error: "Ce devis vient d'être modifié par quelqu'un d'autre : rechargez la fiche avant d'enregistrer." };
    if (f.id) await prisma.legalDocument.update({ where: { id: devisId }, data: { counterparty: f.nom, counterpartyIds: [f.id], updatedById: user.id } });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: req.id, summary: `Devis ${d.doc.reference ?? d.doc.title} retranscrit — ${devis.lignes.length} ligne${devis.lignes.length > 1 ? "s" : ""}` });
    if (premiere) await prevenirDemandeur(req, user.id);
    revalider(req.id);
    return {
      ok: true, id: devisId,
      message: `${devis.lignes.length} ligne${devis.lignes.length > 1 ? "s" : ""} enregistrée${devis.lignes.length > 1 ? "s" : ""}.`
        + (premiere && req.requesterId && req.requesterId !== user.id ? " Le demandeur est prévenu : il retient les lignes qu'il veut." : "")
        + (retenuesPerdues > 0 ? ` ${retenuesPerdues} ligne${retenuesPerdues > 1 ? "s" : ""} corrigée${retenuesPerdues > 1 ? "s ne sont" : " n'est"} plus retenue${retenuesPerdues > 1 ? "s" : ""} : le demandeur doit la revoir.` : ""),
    };
  });
}

// ─────────────────────────── 2. Le demandeur retient ───────────────────────────

/** RETENIR LES LIGNES D'UN DEVIS — par le demandeur (ou le Super Admin). L'ensemble envoyé remplace le précédent pour ce devis. */
export async function retenirLignesDevisDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const req = await chargerDemande(fdStr(formData, "id"));
  const devisId = fdStr(formData, "devisId");
  if (!req || !devisId) return { ok: false, error: "Demande ou devis introuvable." };
  if (!commandeLaDemande(user, req)) return { ok: false, error: REFUS_COMMANDE };
  if (!ouverte(req.status)) return { ok: false, error: FERMEE };
  const retenues = new Set(formData.getAll("ligneId").map((x) => String(x).trim()).filter(Boolean));
  return enSerie(fileDuDevis(devisId), async () => {
    const d = await devisNatifDe(devisId, req.id);
    if (!d) return { ok: false, error: "Ce devis n'appartient pas à la demande : rechargez la fiche." };
    if (d.doc.status === "CANCELLED") return { ok: false, error: "Ce devis est annulé au registre." };
    if (!d.natif || d.natif.lignes.length === 0) return { ok: false, error: "Ce devis n'est pas encore retranscrit : l'assistante doit d'abord en saisir les lignes." };
    const lu = await devisDeLaDemande(req.id);
    const r = appliquerRetenue(d.natif, retenues, lu.bcsActifs, { par: user.id, le: new Date().toISOString() });
    if (!r.ok) return { ok: false, error: r.error };
    if (r.changees === 0) return { ok: true, id: devisId, message: "Rien n'a changé : ce sont déjà les lignes retenues." };
    const ecrit = await ecrireDevisNatif(devisId, d.natif.version, r.devis, { userId: user.id, montant: totauxDesLignes(r.devis.lignes).ttc });
    if (!ecrit) return { ok: false, error: "Ce devis vient d'être modifié : rechargez la fiche avant de retenir des lignes." };
    const nb = r.devis.lignes.filter((l) => l.retenue).length;
    const ttc = totauxDesLignes(r.devis.lignes.filter((l) => l.retenue)).ttc;
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: req.id, summary: `Devis ${d.doc.reference ?? d.doc.title} : ${nb} ligne${nb > 1 ? "s" : ""} retenue${nb > 1 ? "s" : ""} (${Math.round(ttc).toLocaleString("fr-FR")} DZD TTC)` });
    revalider(req.id);
    return { ok: true, id: devisId, message: `${nb} ligne${nb > 1 ? "s" : ""} retenue${nb > 1 ? "s" : ""} — ${Math.round(ttc).toLocaleString("fr-FR")} DZD TTC. Générez le bon de commande quand votre choix est fait.` };
  });
}

// ─────────────────────────── 3. Le bon de commande ───────────────────────────

/** GÉNÉRER LE BC D'UN FOURNISSEUR (`fournisseur` = sa clé) d'après les lignes retenues — par le demandeur ou le Super Admin. */
export async function genererBonDeCommandeDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const req = await chargerDemande(fdStr(formData, "id"));
  const cle = fdStr(formData, "fournisseur");
  if (!req || !cle) return { ok: false, error: "Demande ou fournisseur introuvable." };
  if (!commandeLaDemande(user, req)) return { ok: false, error: REFUS_COMMANDE };
  if (!ouverte(req.status)) return { ok: false, error: FERMEE };
  const r = await genererBCDuFournisseur(user, req, cle);
  if (!r.ok) return { ok: false, error: r.error };
  revalider(req.id);
  revalidatePath("/bons-de-commande");
  revalidatePath("/centre-de-validations");
  return {
    ok: true, id: r.bcId,
    message: `Bon de commande ${r.reference} ${r.dejaEmis ? "déjà émis — retrouvé" : "généré"} (${Math.round(r.totalTtc).toLocaleString("fr-FR")} DZD TTC) — l'assistante le voit.${r.reserve ? ` ${r.reserve}` : ""}`,
  };
}

/**
 * DÉPOSER UN BON DE COMMANDE DÉJÀ FAIT (« ou le télécharger ») — par le demandeur, le Super Admin ou
 * l'assistante qui gère la demande : déposer un BC existant ne choisit rien à la place du demandeur.
 * Il entre au registre (nature BC, source la demande), découle du devis choisi s'il y en a un — dont
 * les lignes retenues sont alors « portées » par lui — et passe par la MÊME porte que le BC généré
 * (`aiguillerBC`). Le montant TTC est demandé : sans lui, le centre le verrait d'office.
 */
export async function deposerBonDeCommandeDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const req = await chargerDemande(fdStr(formData, "id"));
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!(commandeLaDemande(user, req) || gereLaDemande(user, req))) return { ok: false, error: "Le bon de commande se dépose par le demandeur ou par l'assistante qui gère la demande." };
  if (!ouverte(req.status)) return { ok: false, error: FERMEE };
  const fichier = fichierDe(formData);
  if (!fichier) return { ok: false, error: "Joignez le bon de commande (PDF ou scan)." };
  const refusFichier = await validateAttachments([fichier]);
  if (refusFichier) return { ok: false, error: refusFichier };
  const montant = fdNum(formData, "amount");
  if (montant === null || !(montant > 0)) return { ok: false, error: "Indiquez le montant TTC du bon de commande : c'est lui qui dit s'il passe par le centre de validations." };
  const f = await fournisseurChoisi(user.id, fdStr(formData, "supplierId"));
  if (!f.ok) return { ok: false, error: f.error };
  const devisId = fdStr(formData, "devisId");
  const devis = devisId ? await devisNatifDe(devisId, req.id) : null;
  if (devisId && !devis) return { ok: false, error: "Ce devis n'appartient pas à la demande : rechargez la fiche." };
  const devisDoc = devisId ? await prisma.legalDocument.findUnique({ where: { id: devisId }, select: { counterparty: true, counterpartyIds: true } }) : null;
  const fournisseur = f.nom ?? devisDoc?.counterparty ?? null;
  if (!fournisseur) return { ok: false, error: "Choisissez le fournisseur dans l'annuaire, ou le devis dont ce bon de commande découle." };
  const reference = fdStr(formData, "reference");

  const bc = await prisma.legalDocument.create({
    data: {
      title: `Bon de commande ${fournisseur}${reference ? ` n° ${reference}` : ""} — ${req.reference}`,
      kind: "PURCHASE_ORDER", reference, amount: new Prisma.Decimal(montant),
      counterparty: fournisseur, counterpartyIds: f.id ? [f.id] : devisDoc?.counterpartyIds ?? [],
      companyId: req.companyId ?? (req.requesterId ? await moneyEntityOf(req.requesterId) : null),
      sourceType: "ADMIN_REQUEST", sourceId: req.id, chainFromId: devisId ?? null,
      createdById: user.id, updatedById: user.id, startDate: new Date(),
      notes: `Bon de commande déposé au bureau du secrétariat pour la demande ${req.reference}.`,
    },
    select: { id: true },
  });
  const depot = await persistUploadedDocument(user.id, { entityType: "LEGAL_DOCUMENT", entityId: bc.id, category: "PURCHASE_ORDER", confidentiality: "INTERNAL", stepKey: null, file: fichier });
  if (!depot.ok) {
    await prisma.legalDocument.delete({ where: { id: bc.id } }).catch(() => undefined);
    return { ok: false, error: `Le fichier du bon de commande n'a pas pu être enregistré (${depot.error ?? "erreur"}) : rien n'est déposé.` };
  }
  // LES LIGNES RETENUES DU DEVIS sont désormais portées par ce BC : elles ne se commandent pas deux fois.
  if (devisId && devis?.natif) {
    await enSerie(fileDuDevis(devisId), async () => {
      for (let essai = 0; essai < 3; essai += 1) {
        const d = await devisNatifDe(devisId, req.id);
        if (!d?.natif) return;
        const lu = await devisDeLaDemande(req.id);
        const apres = { ...d.natif, version: d.natif.version + 1, lignes: d.natif.lignes.map((l) => (l.retenue && !(l.bcId && lu.bcsActifs.has(l.bcId) && l.bcId !== bc.id) ? { ...l, bcId: bc.id } : l)) };
        if (await ecrireDevisNatif(devisId, d.natif.version, apres, { userId: user.id, montant: totauxDesLignes(apres.lignes).ttc })) return;
      }
    });
  }
  const a = await aiguillerBC(bc.id, { acteurId: user.id });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: req.id, summary: `Bon de commande ${reference ?? fournisseur} déposé — ${Math.round(montant).toLocaleString("fr-FR")} DZD TTC` });
  await prevenirLeSecretariat(req.assignedToId, { type: "GENERIC", title: "Bon de commande déposé", body: `${req.reference} — ${reference ?? fournisseur}`, link: `/demandes/${req.id}` }, user.id);
  revalider(req.id);
  revalidatePath("/bons-de-commande");
  revalidatePath("/centre-de-validations");
  const reserve = reserveDeLAiguillage(a);
  return { ok: true, id: bc.id, message: `Bon de commande déposé — l'assistante le voit.${reserve ? ` ${reserve}` : ""}` };
}

// ─────────────────────────── Relancer ───────────────────────────

const DELAI_RELANCE_MS = 24 * 60 * 60 * 1000;

/**
 * RELANCER — la personne chez qui la demande attend reçoit un rappel nommé, avec le lien de la
 * demande. Une fois par jour au plus (une notification qui revient sans cesse cesse d'être lue,
 * §118.32). Par le demandeur, ou par qui gère la demande. Le destinataire se lit sur l'état :
 * un BC en route (son centre, ses signataires, son émetteur), une validation (ses validateurs), un
 * paiement (les Finances), des devis à retenir (le demandeur), sinon le secrétariat.
 */
export async function relancerDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const req = await chargerDemande(fdStr(formData, "id"));
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!(req.requesterId === user.id || gereLaDemande(user, req))) return { ok: false, error: "Seuls le demandeur et le secrétariat relancent cette demande." };
  const statut = statutAffiche(req.status, req.blockedReason);
  if (!ouverte(statut)) return { ok: false, error: "Cette demande n'attend plus personne." };

  return enSerie(`relance-demande:${req.id}`, async () => {
    const recente = await prisma.auditLog.count({
      where: { entityType: "ADMIN_REQUEST", entityId: req.id, summary: { startsWith: "Relance envoyée" }, createdAt: { gte: new Date(Date.now() - DELAI_RELANCE_MS) } },
    });
    if (recente > 0) return { ok: false, error: "Cette demande a déjà été relancée aujourd'hui." };

    const lu = await devisDeLaDemande(req.id);
    const attendue = etapeBCAttendue(lu.bcs);
    const bc = attendue ? lu.bcs.find((b) => !b.annule && b.etape === attendue) ?? null : null;
    let ids: string[] = [];
    let qui = "";
    let signataires = false;
    let finances = false;
    let secretariat = false;
    if (statut === "AWAITING_PAYMENT") { finances = true; qui = "les Finances"; }
    else if (statut === "AWAITING_VALIDATION") {
      const [appros, vals] = await Promise.all([
        prisma.adminApproval.findMany({ where: { requestId: req.id, status: "PENDING" }, select: { validatorId: true } }),
        prisma.validationRequest.findMany({ where: { entityType: "ADMIN_REQUEST", entityId: req.id, status: "PENDING" }, select: { currentOrder: true, mode: true, steps: { where: { status: "PENDING" }, select: { validatorId: true, order: true } } } }),
      ]);
      ids = [...appros.map((a) => a.validatorId).filter((x): x is string => Boolean(x)), ...vals.flatMap((v) => v.steps.filter((s) => v.mode === "PARALLEL" || s.order === v.currentOrder).map((s) => s.validatorId))];
      qui = "le validateur";
    } else if (bc && (attendue === "A_VALIDER" || attendue === "SANS_PORTE")) {
      const v = await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: bc.id, status: "PENDING" }, select: { steps: { where: { status: "PENDING" }, select: { validatorId: true } } } });
      ids = v.flatMap((x) => x.steps.map((s) => s.validatorId));
      qui = "le centre de validations";
    } else if (bc && attendue === "A_SIGNER") { signataires = true; qui = "les signataires des bons de commande"; }
    else if (bc && (attendue === "A_REVOIR" || attendue === "A_CORRIGER")) { ids = bc.createdById ? [bc.createdById] : []; qui = "l'émetteur du bon de commande"; }
    else if (lu.devis.some((d) => !d.annule && d.natif.lignes.length > 0) && !lu.devis.some((d) => d.natif.lignes.some((l) => l.retenue)) && lu.bcs.length === 0) {
      ids = req.requesterId ? [req.requesterId] : []; qui = "le demandeur (devis à retenir)";
    } else { secretariat = true; qui = "l'assistante de direction"; }

    ids = [...new Set(ids)].filter((x) => x !== user.id);
    if (secretariat && req.assignedToId === user.id) return { ok: false, error: "C'est chez vous que la demande attend : personne d'autre à relancer." };
    if (!secretariat && !signataires && !finances && ids.length === 0) return { ok: false, error: "Personne d'autre à relancer : c'est à vous d'agir." };

    const avis = { type: "LATE" as const, title: `Relance — ${req.reference}`, body: `${user.name ?? "Quelqu'un"} relance : ${req.title}`, link: `/demandes/${req.id}` };
    for (const userId of ids) await notifyUser({ userId, ...avis }).catch(() => undefined);
    if (finances) await notifyRoles(["FINANCE_BUDGET_MANAGER"], avis).catch(() => undefined);
    if (signataires && bc) await notifierSignatairesBC({ ...avis, link: lienBonDeCommande(bc.id) }).catch(() => 0);
    if (secretariat) await prevenirLeSecretariat(req.assignedToId, avis, user.id);
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: req.id, summary: `Relance envoyée à ${qui}` });
    revalider(req.id);
    return { ok: true, message: `Relance envoyée à ${qui}.` };
  });
}
