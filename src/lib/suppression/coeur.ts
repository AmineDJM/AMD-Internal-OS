import { revalidatePath } from "next/cache";
import type { DeletedRecord, Prisma } from "@prisma/client";
import { prisma, prismaBrut } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { DELETE_REGISTRY, deleteDelegateOf, isDeletableKind, modeleDuRegistre, refusDuLot, type DeletableKind } from "@/lib/admin-delete-registry";
import { dejaPresents, instantaneTete, inventorier, restaurerLot, supprimerLot, type InstantaneLot } from "./lot";
import { sansBloquer } from "@/lib/journal";
import { infoModele } from "@/lib/effets/modeles";
import { memeValeur, serialiserLigne } from "@/lib/effets/valeurs";
import { deserialiser, type DetailEffet } from "@/lib/effets/annulation";
import type { PolitiqueAnnulation, ResultatMetier } from "@/lib/effets/politiques";


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CŒUR DE LA SUPPRESSION RÉVERSIBLE — hors du fichier d'actions, et c'est voulu (§118.162).
 *
 * Il vivait dans `admin-delete-actions.ts`, donc derrière le Super Admin et nulle part ailleurs.
 * Le module Événements, lui, supprimait un événement par son propre chemin : `prisma.event.delete`,
 * sans instantané, sans audit, sans corbeille — et sans rien savoir de ses branches. Deux chemins
 * pour le même geste, dont un irréversible, ouvert à quatre rôles (§118.5, §118.71).
 *
 * Il ne peut pas vivre dans un fichier `"use server"` : tout ce qu'un tel fichier exporte devient
 * un point d'entrée public, et une fonction qui prend un TYPE et un IDENTIFIANT sans vérifier qui
 * appelle serait une porte ouverte sur les trente types du registre. Ici, il n'est appelé QUE par
 * des actions qui ont vérifié le droit — `superAdminDelete`, `deleteOwnRecord`, `deleteEvent`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DeleteResult {
  ok: boolean;
  error?: string;
  redirect?: string;
}

/**
 * SUPPRIME, de façon réversible. L'appelant a vérifié le DROIT ; ce cœur vérifie le RESTE — ce que
 * le type refuse, ce qui a quitté l'ERP, ce qui dépend encore de l'élément.
 */
export async function supprimerReversible(kind: DeletableKind, id: string, actorId: string, summary: string): Promise<DeleteResult> {
  const spec = DELETE_REGISTRY[kind];

  // 0) CE QUE CE TYPE REFUSE, avant tout instantané : le refus porte sa raison et le geste qui
  //    reste. Sans cette porte, un refus légitime sortait soit en « introuvable » (faux : l'objet
  //    est là), soit en « des éléments liés bloquent » (faux : rien ne se détache).
  if (spec.refuse) {
    const motif = await spec.refuse(id);
    if (motif) return { ok: false, error: motif };
  }

  const name = await spec.describe(id);
  if (name === null) return { ok: false, error: "Élément introuvable (déjà supprimé ?)." };

  if (spec.lot) return supprimerAvecBranches(kind, id, actorId, summary, name);

  // 1) Instantané de la ligne principale (tous les champs scalaires/Json).
  const payload = await deleteDelegateOf(spec).findUnique({ where: { id } });
  if (!payload) return { ok: false, error: "Élément introuvable (déjà supprimé ?)." };

  // 2) Instantané puis retrait des Documents/Commentaires polymorphes. Les FICHIERS
  //    restent dans le stockage : ils ne sont effacés qu'à la destruction réelle.
  let docsSnapshot: Record<string, unknown>[] = [];
  let commentsSnapshot: Record<string, unknown>[] = [];
  if (spec.entityType) {
    docsSnapshot = (await prisma.document.findMany({ where: { entityType: spec.entityType, entityId: id } })) as unknown as Record<string, unknown>[];
    commentsSnapshot = (await prisma.comment.findMany({ where: { entityType: spec.entityType, entityId: id } })) as unknown as Record<string, unknown>[];
    await prisma.document.deleteMany({ where: { entityType: spec.entityType, entityId: id } });
    await prisma.comment.deleteMany({ where: { entityType: spec.entityType, entityId: id } });
  }

  // 3) Suppression de la ligne principale (les enfants en cascade suivent).
  try {
    await spec.remove(id);
  } catch (err) {
    console.error("[softDelete] échec suppression", kind, id, err);
    // Remet les documents/commentaires retirés à l'étape 2 (la ligne principale existe encore).
    if (spec.entityType) {
      if (docsSnapshot.length) await prisma.document.createMany({ data: docsSnapshot as never[] }).catch(sansBloquer("suppression-coeur.supprimerReversible.document"));
      if (commentsSnapshot.length) await prisma.comment.createMany({ data: commentsSnapshot as never[] }).catch(sansBloquer("suppression-coeur.supprimerReversible.comment"));
    }
    return { ok: false, error: "Suppression impossible (des éléments liés bloquent). Détachez-les puis réessayez." };
  }

  // 4) Dépôt dans la corbeille (restaurable par le Super Admin).
  await prisma.deletedRecord.create({
    data: {
      kind, label: spec.label, name, sourceId: id,
      payload: payload as Prisma.InputJsonValue,
      documents: docsSnapshot.length ? (docsSnapshot as Prisma.InputJsonValue) : undefined,
      comments: commentsSnapshot.length ? (commentsSnapshot as Prisma.InputJsonValue) : undefined,
      deletedById: actorId,
    },
  });

  await recordAudit({
    actorId, action: "DELETE", module: spec.module, entityType: spec.entityType, entityId: id, summary,
  });

  revalidatePath(spec.redirect);
  return { ok: true, redirect: spec.redirect };
}

/**
 * LA DEMANDE ET SES BRANCHES — un lot, une transaction, une entrée de corbeille (§118.162).
 * Ce qui part est RE-LU au moment de supprimer : l'aperçu montré à la personne peut dater de
 * quelques minutes, la base, elle, a pu recevoir une déclaration ou un paiement depuis.
 */
async function supprimerAvecBranches(kind: DeletableKind, id: string, actorId: string, summary: string, name: string): Promise<DeleteResult> {
  const spec = DELETE_REGISTRY[kind];
  const inv = await inventorier(modeleDuRegistre(spec), id);
  if (!inv) return { ok: false, error: "Élément introuvable (déjà supprimé ?)." };
  if (inv.bloquants.length) return { ok: false, error: refusDuLot(inv.bloquants) };

  const json = (x: unknown) => JSON.parse(JSON.stringify(x)) as Prisma.InputJsonValue;
  try {
    await supprimerLot(inv, async (tx, lot, tete) => {
      await tx.deletedRecord.create({
        data: {
          kind, label: spec.label, name, sourceId: id,
          payload: instantaneTete(tete) as Prisma.InputJsonValue,
          documents: inv.documents.length ? json(inv.documents) : undefined,
          comments: inv.commentaires.length ? json(inv.commentaires) : undefined,
          lot: lot as unknown as Prisma.InputJsonValue,
          deletedById: actorId,
        },
      });
    });
  } catch (err) {
    console.error("[softDelete] échec du lot", kind, id, err);
    // La transaction a TOUT annulé : rien n'est parti, et c'est ce qu'on dit.
    return { ok: false, error: "Suppression impossible : rien n'a été retiré. Un élément lié a refusé de partir — réessayez, ou signalez-le si cela se répète." };
  }

  await recordAudit({
    actorId, action: "DELETE", module: spec.module, entityType: spec.entityType, entityId: id,
    summary: inv.resume.length ? `${summary} — avec ${inv.resume.join(", ")}` : summary,
  });
  revalidatePath(spec.redirect);
  return { ok: true, redirect: spec.redirect };
}

/**
 * RESTAURE une entrée de la corbeille — la ligne principale, et, pour un lot, TOUTES ses
 * branches. Rend `null` quand l'entrée n'est pas un lot : l'appelant garde son chemin d'avant.
 */
export async function restaurerLotDeLaCorbeille(rec: DeletedRecord, kind: DeletableKind): Promise<DeleteResult | null> {
  const lot = rec.lot as unknown as InstantaneLot | null;
  if (!lot || lot.version !== 1) return null;
  const spec = DELETE_REGISTRY[kind];
  const modele = modeleDuRegistre(spec);
  if ((await dejaPresents(modele, rec.sourceId, lot)) > 0) {
    return { ok: false, error: "Des éléments de ce lot existent déjà (déjà restauré ?) — rien n'a été recréé." };
  }
  try {
    await restaurerLot(
      modele,
      rec.payload as Record<string, unknown>,
      lot,
      (rec.documents as Record<string, unknown>[] | null) ?? [],
      (rec.comments as Record<string, unknown>[] | null) ?? [],
    );
    await spec.restored?.(rec.sourceId);
  } catch (err) {
    console.error("[restoreDeletedRecord] échec du lot", rec.kind, rec.sourceId, err);
    return { ok: false, error: "Restauration impossible — rien n'a été recréé (un élément lié manque, ou une référence a été réutilisée depuis)." };
  }
  return { ok: true, redirect: spec.redirect };
}

/**
 * ANNULER UNE SUPPRESSION RÉVERSIBLE (K10c) — le geste inverse d'une mise en corbeille : le LOT revient (la ligne et
 * ses branches, mêmes identifiants), l'entrée de la corbeille est marquée restaurée. Les suppressions du lot sont
 * alors « traitées » : l'annulation ligne à ligne ne les rejoue pas (elle refuserait, à raison, une ligne supprimée
 * avec des enfants en cascade). Écrit par `prisma` : sous le journal de l'annulation, « rétablir » remet en corbeille.
 */
export const restaurerDepuisLaCorbeille: NonNullable<PolitiqueAnnulation["metier"]> = async ({ geste, appliquer }): Promise<ResultatMetier> => {
  const details: DetailEffet[] = [];
  const traites = new Set<string>();
  const mises = geste.effets.filter((e) => e.type === "ECRITURE" && e.modele === "DeletedRecord" && e.operation === "CREATE" && e.enregistrementId);
  if (!mises.length) return { details, traites };
  let restaure = false;
  for (const e of mises) {
    traites.add(e.id);
    const rec = await prismaBrut.deletedRecord.findUnique({ where: { id: e.enregistrementId! } });
    const quoi = rec ? `« ${rec.name} » mis(e) en corbeille` : "une mise en corbeille";
    if (!rec || rec.restoredAt) { details.push({ effetId: e.id, issue: "SANS_OBJET", quoi, pourquoi: "déjà restauré(e) depuis la corbeille" }); continue; }
    if (rec.purgedAt) { details.push({ effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "détruit(e) définitivement depuis la corbeille", aLaPlace: "recréer l'élément à la main" }); continue; }
    if (!isDeletableKind(rec.kind)) { details.push({ effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "type de corbeille inconnu", aLaPlace: null }); continue; }
    if (appliquer) {
      const r = await restaurerLotDeLaCorbeille(rec, rec.kind);
      if (r && !r.ok) { details.push({ effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: r.error ?? "la restauration a échoué", aLaPlace: "restaurer depuis la corbeille (Administration)" }); continue; }
      if (!r) { details.push({ effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "cette entrée de corbeille n'est pas un lot : elle se restaure depuis l'écran de la corbeille", aLaPlace: "restaurer depuis la corbeille (Administration)" }); continue; }
      await prisma.deletedRecord.update({ where: { id: rec.id }, data: { restoredAt: new Date() } });
    }
    restaure = true;
    details.push({ effetId: e.id, issue: "ANNULE", quoi, pourquoi: "revenu(e) de la corbeille avec ses éléments liés, mêmes identifiants : les liens tiennent de nouveau" });
  }
  // Les lignes du lot, retirées par la mise en corbeille : revenues avec elle. L'instantané de la corbeille les a
  // prises TELLES QU'À LA SUPPRESSION : ce que le même geste leur avait changé juste avant (le poste détaché de son
  // ordre, l'étape remise) est repris sur la valeur d'AVANT le geste, que le journal porte.
  if (restaure) {
    for (const e of geste.effets) {
      if (e.type !== "ECRITURE" || e.operation !== "DELETE") continue;
      traites.add(e.id);
      if (appliquer && e.modele && e.enregistrementId) await reprendreLAvant(e.modele, e.enregistrementId, e.avant);
    }
  }
  return { details, traites };
};

async function reprendreLAvant(modele: string, id: string, avant: unknown): Promise<void> {
  const info = infoModele(modele);
  const a = avant && typeof avant === "object" ? (avant as Record<string, unknown>) : null;
  if (!info?.cle || !a) return;
  const d = (prisma as unknown as Record<string, { findUnique: (x: unknown) => Promise<Record<string, unknown> | null>; update: (x: unknown) => Promise<unknown> }>)[info.delegue];
  const actuelle = serialiserLigne(await d.findUnique({ where: { [info.cle]: id } }), new Set(info.scalaires));
  if (!actuelle) return;
  const data: Record<string, unknown> = {};
  for (const [c, v] of Object.entries(a)) {
    if (info.auto.has(c) || !info.types.has(c) || memeValeur(actuelle[c] ?? null, v ?? null)) continue;
    const x = deserialiser(info, c, v ?? null);
    if (x !== undefined) data[c] = x;
  }
  if (Object.keys(data).length) await d.update({ where: { [info.cle]: id }, data });
}
