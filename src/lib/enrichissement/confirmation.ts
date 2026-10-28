import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { plier } from "@/modules/referentiels/partage";
import { colonnesOrganisation, colonnesPersonne, typeIdentifiantOrganisation } from "./a-confirmer";
import { compacterIdentifiant } from "./fiches";
import { conflitIdDe, faitConfirmeIdDe } from "./file";
import { ATTRIBUT_PAR_CLE } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONFIRMER, REJETER, TRANCHER — les écritures qu'une décision sur un fait proposé entraîne.
 *
 * Une seule écriture pour la confirmation d'office (le passage) et la confirmation humaine (l'écran
 * « À confirmer ») : elles ne peuvent pas diverger. Tout se fait dans UNE transaction — le fait
 * confirmé, la valeur précédente close (jamais effacée : `actif = false`, `valideAu`), la colonne de
 * la fiche, la décision du fait proposé. Un identifiant d'organisation confirmé entre à
 * `OrganisationIdentifiant` (unique par type et valeur) : c'est ce qui fera qu'un NIF identifie un tiers.
 *
 * Les droits ne sont PAS vérifiés ici : c'est la porte de l'action serveur (`peutTrancher`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type IssueDecision = { ok: true; message: string } | { ok: false; message: string };

type Tx = Prisma.TransactionClient;

async function ecrireConfirmation(
  tx: Tx,
  faitId: string,
  o: { parId: string | null; decision: "CONFIRME" | "CONFIRME_D_OFFICE"; raison: string; maintenant: Date },
): Promise<IssueDecision> {
  const f = await tx.faitPropose.findUnique({
    where: { id: faitId },
    select: { id: true, sujetType: true, sujetId: true, attribut: true, valeur: true, valeurNormalisee: true, sensible: true, decision: true, extraction: { select: { pieceId: true } } },
  });
  if (!f) return { ok: false, message: "Fait introuvable." };
  if (!f.sujetId) return { ok: false, message: "Ce fait n'est rattaché à aucune fiche : il ne peut pas être confirmé." };
  if (f.sensible) return { ok: false, message: "Une donnée sensible ne se confirme pas sur la fiche : elle est au coffre." };
  if (f.decision !== "EN_ATTENTE" && f.decision !== "CONFLIT") return { ok: false, message: "Ce fait a déjà été tranché." };
  const attribut = ATTRIBUT_PAR_CLE.get(f.attribut);
  if (!attribut) return { ok: false, message: "Attribut hors catalogue." };

  // Une valeur UNIQUE remplace la précédente — qui reste, close, dans l'historique.
  if (!attribut.multiple) {
    await tx.faitConfirme.updateMany({
      where: { sujetType: f.sujetType, sujetId: f.sujetId, attribut: f.attribut, actif: true },
      data: { actif: false, valideAu: o.maintenant },
    });
  }
  await tx.faitConfirme.upsert({
    where: { id: faitConfirmeIdDe(f.id) },
    create: {
      id: faitConfirmeIdDe(f.id), sujetType: f.sujetType, sujetId: f.sujetId, attribut: f.attribut, valeur: f.valeur, valeurNormalisee: f.valeurNormalisee,
      source: "PIECE", pieceId: f.extraction.pieceId, faitProposeId: f.id, confirmeParId: o.parId, confirmeLe: o.maintenant, valideDu: o.maintenant,
    },
    update: { actif: true, valideAu: null },
  });
  await tx.faitPropose.update({ where: { id: f.id }, data: { decision: o.decision, raisonDecision: o.raison, decideeParId: o.parId, decideeLe: o.maintenant } });

  const valeur = f.valeur ?? "";
  if (f.sujetType === "PERSONNE") {
    const colonnes = colonnesPersonne(f.attribut, valeur);
    if (colonnes) {
      const p = await tx.personne.update({ where: { id: f.sujetId }, data: colonnes, select: { nom: true, prenoms: true } });
      await tx.personne.update({ where: { id: f.sujetId }, data: { nomReplie: plier(`${p.nom} ${p.prenoms ?? ""}`) } });
    }
  } else if (f.sujetType === "ORGANISATION") {
    const colonnes = colonnesOrganisation(f.attribut, valeur);
    if (colonnes) await tx.organisation.update({ where: { id: f.sujetId }, data: { ...colonnes, ...(colonnes.raisonSociale ? { nomReplie: plier(colonnes.raisonSociale) } : {}) } });
    const type = typeIdentifiantOrganisation(f.attribut);
    const normalisee = compacterIdentifiant(f.valeurNormalisee ?? "");
    if (type && normalisee) {
      await tx.organisationIdentifiant.createMany({
        data: [{ organisationId: f.sujetId, type, valeur, valeurNormalisee: normalisee, pieceId: f.extraction.pieceId, verifieLe: o.maintenant, creeParId: o.parId }],
        skipDuplicates: true,
      });
    }
  }
  return { ok: true, message: `« ${attribut.libelle} » confirmé.` };
}

/** Confirme un fait proposé (d'office ou par une personne). */
export function confirmerFaitPropose(faitId: string, o: { parId: string | null; decision: "CONFIRME" | "CONFIRME_D_OFFICE"; raison: string; maintenant?: Date }): Promise<IssueDecision> {
  const maintenant = o.maintenant ?? new Date();
  return prisma.$transaction((tx) => ecrireConfirmation(tx, faitId, { ...o, maintenant }));
}

/** Rejette un fait proposé : il reste, avec qui l'a rejeté et quand — rien n'est écrit sur la fiche. */
export async function rejeterFaitPropose(faitId: string, o: { parId: string; motif: string | null; maintenant?: Date }): Promise<IssueDecision> {
  const r = await prisma.faitPropose.updateMany({
    where: { id: faitId, decision: "EN_ATTENTE" },
    data: { decision: "REJETE", raisonDecision: o.motif?.trim() || "Rejeté à la confirmation.", decideeParId: o.parId, decideeLe: o.maintenant ?? new Date() },
  });
  return r.count === 1 ? { ok: true, message: "Fait rejeté." } : { ok: false, message: "Ce fait a déjà été tranché." };
}

/** Pose le conflit d'un fait proposé contre la valeur confirmée qu'il contredit (idempotent). */
export async function ouvrirConflit(faitId: string, o: { valeurActuelle: string; raison: string; maintenant?: Date }): Promise<void> {
  const f = await prisma.faitPropose.findUnique({ where: { id: faitId }, select: { sujetType: true, sujetId: true, attribut: true, valeur: true } });
  if (!f?.sujetId) return;
  const actuel = await prisma.faitConfirme.findFirst({
    where: { sujetType: f.sujetType, sujetId: f.sujetId, attribut: f.attribut, actif: true, valeurNormalisee: o.valeurActuelle },
    select: { id: true, valeur: true },
  });
  await prisma.$transaction([
    prisma.conflitDeFait.createMany({
      data: [{ id: conflitIdDe(faitId), sujetType: f.sujetType, sujetId: f.sujetId, attribut: f.attribut, faitConfirmeId: actuel?.id ?? null, faitProposeId: faitId, valeurActuelle: actuel?.valeur ?? o.valeurActuelle, valeurProposee: f.valeur }],
      skipDuplicates: true,
    }),
    prisma.faitPropose.update({ where: { id: faitId }, data: { decision: "CONFLIT", raisonDecision: o.raison, decideeLe: o.maintenant ?? new Date() } }),
  ]);
}

/**
 * TRANCHE un conflit : GARDER la valeur de la fiche (le fait proposé est rejeté) ou la REMPLACER par
 * celle de la pièce (l'ancienne est close, jamais effacée).
 */
export async function trancherConflitDeFait(conflitId: string, o: { parId: string; choix: "GARDER" | "REMPLACER"; commentaire: string | null; maintenant?: Date }): Promise<IssueDecision> {
  const maintenant = o.maintenant ?? new Date();
  return prisma.$transaction(async (tx) => {
    const c = await tx.conflitDeFait.findUnique({ where: { id: conflitId }, select: { statut: true, faitProposeId: true } });
    if (!c) return { ok: false, message: "Conflit introuvable." };
    if (c.statut !== "OUVERT") return { ok: false, message: "Ce conflit a déjà été tranché." };
    if (o.choix === "REMPLACER") {
      const r = await ecrireConfirmation(tx, c.faitProposeId, { parId: o.parId, decision: "CONFIRME", raison: "Conflit tranché : la valeur de la pièce remplace celle de la fiche.", maintenant });
      if (!r.ok) return r;
    } else {
      await tx.faitPropose.update({ where: { id: c.faitProposeId }, data: { decision: "REJETE", raisonDecision: "Conflit tranché : la valeur de la fiche est gardée.", decideeParId: o.parId, decideeLe: maintenant } });
    }
    await tx.conflitDeFait.update({
      where: { id: conflitId },
      data: { statut: o.choix === "REMPLACER" ? "REMPLACEE" : "GARDE_ACTUELLE", resoluParId: o.parId, resoluLe: maintenant, commentaire: o.commentaire?.trim() || null },
    });
    return { ok: true, message: o.choix === "REMPLACER" ? "Valeur remplacée — l'ancienne reste dans l'historique." : "Valeur de la fiche gardée." };
  });
}
