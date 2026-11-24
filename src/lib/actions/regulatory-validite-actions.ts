"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { persistUploadedDocument } from "@/lib/documents";
import { enregistrerPrixProduit } from "@/lib/actions/prix-produit-actions";
import { syncStatusFromWorkflow } from "@/lib/regulatory/sync-status";
import { lirePieceDuDossier } from "@/lib/regulatory/lecture-decision";
import {
  ETAPE_DECISION, PIECE_ENREGISTREMENT, estNaturePiece, lecturesDuDossier,
  type LecturesEnregistrement, type NaturePieceEnregistrement,
} from "@/lib/regulatory/decision-lue";
import { LIBELLE_SOURCE_DATE, validiteRetenue, ymd, type PropositionsDeDates } from "@/lib/regulatory/validite-enregistrement";
import { estTypePrix, LIBELLE_PRIX } from "@/lib/products/fiche-360";
import type { RegWorkflowState } from "@/lib/regulatory-workflow";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉCISION D'ENREGISTREMENT ET L'ATTESTATION DE PRIX D'UN DOSSIER (Super Admin, 24/11/2026).
 *
 * « Quand on obtient la décision d'enregistrement, on dépose la décision et l'attestation de prix dans
 * Regulatory. L'IA lit la date de début et de fin de validité, et devine la fin (5 ans). »
 *
 *   1. JOINDRE : la pièce typée passe par le dépôt de TOUTES les pièces (`persistUploadedDocument` :
 *      stockage, version, audit, bibliothèque, miroir Drive dans « 3-DE et attestation de prix »),
 *      rattachée à l'étape « Décision d'enregistrement + attestation de prix » ;
 *   2. LIRE : l'IA propose (numéro, dates, prix), avec la phrase qui le dit — gardé sur le dossier
 *      comme PROPOSITION, jamais comme fait ;
 *   3. CONFIRMER : un clic, valeurs modifiables ; chaque date garde sa source (lue, déduite, saisie).
 *
 * L'IA coupée ou en échec ne bloque rien : la proposition dit pourquoi, la saisie reste ouverte.
 * Portes : joindre = « Déposer » sur le dossier ; lire et confirmer = « Modifier » ; le prix passe en
 * plus par la porte des prix (`enregistrerPrixProduit`, Produits 360 ou Regulatory « Modifier »).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const REFUS_DEPOT = "Joindre une pièce au dossier demande « Déposer » sur Regulatory (Administration › Accès).";
const REFUS_MODIFIER = "Confirmer la décision d'enregistrement demande « Modifier » sur ce dossier (Administration › Accès).";
const ESSAIS = 4;

const chemin = (id: string) => `/regulatory/${id}`;

/** Écrit la proposition lue dans `registrationReading`, SOUS CONDITION de la version lue (une autre lecture concurrente n'est pas écrasée à l'aveugle). */
async function garderLaProposition(productId: string, maj: (l: LecturesEnregistrement) => LecturesEnregistrement): Promise<boolean> {
  for (let essai = 0; essai < ESSAIS; essai++) {
    const p = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { registrationReading: true, updatedAt: true } });
    if (!p) return false;
    const suivant = maj(lecturesDuDossier(p.registrationReading));
    const ecrit = await prisma.regulatoryProduct.updateMany({
      where: { id: productId, updatedAt: p.updatedAt },
      data: { registrationReading: suivant as unknown as Prisma.InputJsonValue },
    });
    if (ecrit.count === 1) return true;
  }
  return false;
}

/** Lit la pièce et garde la proposition ; rend la phrase pour la personne. */
async function lireEtGarder(userId: string, product: { id: string; isLocked: boolean; reference: string }, documentId: string, nature: NaturePieceEnregistrement): Promise<ActionResult> {
  const r = await lirePieceDuDossier({ userId, productId: product.id, documentId, nature, confidentielle: product.isLocked });
  if (!r.ok) return { ok: false, error: r.error };
  const garde = await garderLaProposition(product.id, (l) => (r.lue.nature === "DECISION" ? { ...l, decision: r.lue.proposition } : { ...l, prix: r.lue.proposition }));
  if (!garde) return { ok: false, error: "Le dossier a changé pendant la lecture : relancez la lecture de la pièce." };
  await recordAudit({
    actorId: userId, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: product.id, field: "registrationReading",
    summary: `${PIECE_ENREGISTREMENT[nature].libelle} du dossier ${product.reference} lue — ${r.lue.proposition.erreur ? "rien de proposé" : "valeurs proposées, à confirmer"}`,
  });
  return {
    ok: true,
    message: r.lue.proposition.erreur ?? (nature === "DECISION" ? "Dates proposées : vérifiez-les puis confirmez." : "Prix proposé : vérifiez-le puis confirmez."),
  };
}

/** JOINDRE la décision d'enregistrement ou l'attestation de prix — puis la faire lire. */
export async function joindrePieceEnregistrement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = fdStr(formData, "productId");
  const nature = fdStr(formData, "nature");
  const file = formData.get("file");
  if (!productId) return { ok: false, error: "Dossier introuvable." };
  if (!estNaturePiece(nature)) return { ok: false, error: "Pièce inconnue : décision d'enregistrement ou attestation de prix." };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choisissez le fichier de la pièce (PDF ou scan)." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPLOAD"))) return { ok: false, error: REFUS_DEPOT };
  const product = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { id: true, isLocked: true, reference: true } });
  if (!product) return { ok: false, error: "Dossier introuvable." };

  const depot = await persistUploadedDocument(user.id, {
    entityType: "REGULATORY_PRODUCT", entityId: productId, category: PIECE_ENREGISTREMENT[nature].categorie,
    confidentiality: "INTERNAL", stepKey: ETAPE_DECISION, file,
  });
  if (!depot.ok || !depot.documentId) return { ok: false, error: depot.error ?? "La pièce n'a pas été enregistrée : renvoyez le fichier." };

  // La pièce est acquise : une lecture qui échoue ne la retire pas, elle le dit.
  const lu = await lireEtGarder(user.id, product, depot.documentId, nature);
  revalidatePath(chemin(productId));
  return lu.ok ? { ...lu, id: depot.documentId } : { ok: true, id: depot.documentId, message: `Pièce jointe. ${lu.error}` };
}

/** RELIRE une pièce déjà jointe (déposée avant, ou après une lecture coupée). */
export async function relirePieceEnregistrement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = fdStr(formData, "productId");
  const documentId = fdStr(formData, "documentId");
  const nature = fdStr(formData, "nature");
  if (!productId || !documentId) return { ok: false, error: "Pièce introuvable." };
  if (!estNaturePiece(nature)) return { ok: false, error: "Pièce inconnue : décision d'enregistrement ou attestation de prix." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPDATE"))) return { ok: false, error: REFUS_MODIFIER };
  const product = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { id: true, isLocked: true, reference: true } });
  if (!product) return { ok: false, error: "Dossier introuvable." };
  const r = await lireEtGarder(user.id, product, documentId, nature);
  revalidatePath(chemin(productId));
  return r;
}

/**
 * CONFIRMER la décision : numéro, date, début et fin de validité — les valeurs de l'écran (proposées par
 * l'IA ou tapées). La fin manquante est déduite (+5 ans). L'étape « Décision d'enregistrement » se coche,
 * datée de la décision : le niveau de process suit, par son seul écrivain.
 */
export async function confirmerValiditeEnregistrement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = fdStr(formData, "productId");
  if (!productId) return { ok: false, error: "Dossier introuvable." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPDATE"))) return { ok: false, error: REFUS_MODIFIER };

  for (let essai = 0; essai < ESSAIS; essai++) {
    const p = await prisma.regulatoryProduct.findUnique({
      where: { id: productId },
      select: { reference: true, status: true, workflow: true, registrationReading: true, updatedAt: true, productId: true },
    });
    if (!p) return { ok: false, error: "Dossier introuvable." };
    const lectures = lecturesDuDossier(p.registrationReading);
    const prop = lectures.decision;
    const propositions: PropositionsDeDates = {
      numero: prop?.numero ? { valeur: prop.numero.valeur, source: prop.numero.source } : null,
      dateDecision: prop?.dateDecision ? { valeur: prop.dateDecision.valeur, source: prop.dateDecision.source } : null,
      debut: prop?.debut ? { valeur: prop.debut.valeur, source: prop.debut.source } : null,
      fin: prop?.fin ? { valeur: prop.fin.valeur, source: prop.fin.source } : null,
    };
    const v = validiteRetenue({
      numero: fdStr(formData, "numero"), dateDecision: fdStr(formData, "dateDecision"), debut: fdStr(formData, "debut"), fin: fdStr(formData, "fin"),
    }, propositions);
    if (!v.ok) return { ok: false, error: v.error };

    // L'ÉTAPE 19 SE COCHE, datée de la décision (ou du début de validité) — une étape déjà faite garde sa date si elle en a une.
    const wf: RegWorkflowState = { ...((p.workflow as RegWorkflowState | null) ?? {}) };
    const jour = v.dateDecision ?? v.debut;
    const avant = wf[ETAPE_DECISION];
    const coche = jour && (avant?.status !== "DONE" || !avant?.date);
    if (coche) wf[ETAPE_DECISION] = { ...avant, status: "DONE", date: avant?.status === "DONE" && avant.date ? avant.date : ymd(jour) };
    // La proposition confirmée quitte le dossier ; celle de l'attestation, si elle attend, reste.
    const reste: LecturesEnregistrement = { ...lectures };
    delete reste.decision;

    const ecrit = await prisma.regulatoryProduct.updateMany({
      where: { id: productId, updatedAt: p.updatedAt },
      data: {
        registrationDecisionNumber: v.numero, registrationDecisionDate: v.dateDecision, registrationDecisionSource: v.sourceDecision,
        registrationValidFrom: v.debut, registrationValidFromSource: v.sourceDebut,
        registrationValidUntil: v.fin, registrationValidUntilSource: v.sourceFin,
        registrationConfirmedAt: new Date(), registrationConfirmedById: user.id,
        registrationReading: reste as unknown as Prisma.InputJsonValue,
        ...(coche ? { workflow: wf as unknown as Prisma.InputJsonValue } : {}),
        updatedById: user.id,
      },
    });
    if (ecrit.count === 0) continue;

    const fin = v.fin ? `${ymd(v.fin)} (${LIBELLE_SOURCE_DATE[v.sourceFin!]})` : "non renseignée";
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: productId, field: "registrationValidUntil",
      newValue: v.fin ? ymd(v.fin) : null,
      summary: `Décision d'enregistrement ${v.numero ?? "sans numéro"} du dossier ${p.reference} confirmée — fin de validité ${fin}`,
    });
    if (coche) await syncStatusFromWorkflow(productId, wf, p.status, p.reference, user.id);
    revalidatePath(chemin(productId));
    if (p.productId) revalidatePath(`/produits/${p.productId}`);
    return { ok: true, message: v.sourceFin === "DEDUITE" ? "Décision enregistrée — fin de validité déduite : début + 5 ans." : "Décision enregistrée." };
  }
  return { ok: false, error: "Le dossier a été modifié en même temps : rechargez la page puis confirmez à nouveau." };
}

/**
 * CONFIRMER UN PRIX DE L'ATTESTATION : il entre au produit du dossier par la porte des prix (une ligne
 * datée, l'historique ne se réécrit pas), puis quitte la proposition.
 */
export async function confirmerPrixAttestation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = fdStr(formData, "productId");
  const kind = fdStr(formData, "kind");
  if (!productId) return { ok: false, error: "Dossier introuvable." };
  if (!estTypePrix(kind)) return { ok: false, error: "Type de prix inconnu." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "VIEW"))) return { ok: false, error: "Dossier introuvable." };
  const p = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { reference: true, productId: true, registrationReading: true } });
  if (!p) return { ok: false, error: "Dossier introuvable." };
  if (!p.productId) return { ok: false, error: "Ce dossier n'a pas encore de produit : créez-le depuis l'en-tête du dossier (« Créer le produit »), puis confirmez le prix." };

  const prop = lecturesDuDossier(p.registrationReading).prix;
  const fd = new FormData();
  fd.set("productId", p.productId);
  fd.set("kind", kind);
  fd.set("amountDzd", fdStr(formData, "amountDzd") ?? "");
  fd.set("validFrom", fdStr(formData, "validFrom") ?? prop?.date?.valeur ?? "");
  fd.set("note", `Attestation de prix${prop ? ` — ${prop.nomFichier}` : ""} (dossier ${p.reference})`.slice(0, 300));
  const r = await enregistrerPrixProduit(fd);
  if (!r.ok) return r;

  await garderLaProposition(productId, (l) => {
    if (!l.prix) return l;
    const prix = l.prix.prix.filter((x) => x.type !== kind);
    if (prix.length > 0) return { ...l, prix: { ...l.prix, prix } };
    const suivant: LecturesEnregistrement = { ...l };
    delete suivant.prix;
    return suivant;
  });
  revalidatePath(chemin(productId));
  return { ok: true, id: r.id, message: `${LIBELLE_PRIX[kind]} enregistré sur le produit.` };
}
