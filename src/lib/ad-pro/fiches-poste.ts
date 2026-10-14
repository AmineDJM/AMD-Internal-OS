import type { AdProItemKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fdStr } from "@/lib/actions/types";
import { validateAttachments } from "@/lib/attach-files";
import { persistUploadedDocument } from "@/lib/documents";
import { deleteFileByKey } from "@/lib/storage";
import { lireVoyageur, porteDesVoyageurs, type VoyageurLu } from "@/lib/ad-pro/voyageurs";
import { lireHebergement, porteDesHebergements, type HebergementLu } from "@/lib/ad-pro/hebergements";
import { CHAMP_FICHES, prefixesRecus, refusDeFiche, FICHES_MAX } from "@/lib/ad-pro/fiches-saisie";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES D'UN POSTE (voyageurs, personnes logées) — leurs pièces, et leur création AVEC le poste.
 *
 * Hors du fichier d'actions (§118.150 g) : créer le poste ET ses fiches écrit plusieurs modèles ; écrit
 * ici, l'`id` de l'action garde son modèle. Les règles de saisie restent celles d'une fiche seule
 * (`lireVoyageur`, `lireHebergement`, `validateAttachments`) — aucune seconde validation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type PieceFiche = { file: File; category: "ID_DOCUMENT" | "SUPPORTING_DOC" };

/** Ce que l'écriture d'un voyageur lu pose en base — les étapes en JSON. */
export const donneesVoyageur = (v: VoyageurLu) => ({ ...v, segments: v.segments as unknown as Prisma.InputJsonValue });

/** Les pièces d'une fiche dans un formulaire : la pièce d'identité (passeport) et les autres documents. */
export function piecesDeFiche(formData: FormData, prefixe: string, cleIdentite: "passeport" | "pieceIdentite"): PieceFiche[] {
  const fichiers = (cle: string) => formData.getAll(`${prefixe}${cle}`).filter((v): v is File => v instanceof File && v.size > 0);
  return [
    ...fichiers(cleIdentite).map((file) => ({ file, category: "ID_DOCUMENT" as const })),
    ...fichiers("documents").map((file) => ({ file, category: "SUPPORTING_DOC" as const })),
  ];
}

/**
 * JOINDRE LES PIÈCES D'UNE FICHE — des documents du poste, désignés par la fiche (`stepKey`), la pièce
 * d'identité en « pièce d'identité ». Un fichier qui échoue est DIT (`echecs`), les autres restent.
 */
export async function joindrePiecesDeFiche(
  userId: string, itemId: string, ficheId: string, pieces: readonly PieceFiche[],
): Promise<{ ids: string[]; identite: boolean; echecs: string[] }> {
  const ids: string[] = [];
  const echecs: string[] = [];
  let identite = false;
  for (const p of pieces) {
    const r = await persistUploadedDocument(userId, {
      entityType: "AD_PRO_ITEM", entityId: itemId, category: p.category, confidentiality: "INTERNAL", stepKey: ficheId, file: p.file,
    }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "dépôt impossible", documentId: undefined }));
    if (r.ok && r.documentId) { ids.push(r.documentId); identite ||= p.category === "ID_DOCUMENT"; }
    else echecs.push(`${p.file.name} : ${r.error ?? "dépôt impossible"}`);
  }
  return { ids, identite, echecs };
}

// ───────────────────────────── Les fiches saisies avec le poste ─────────────────────────────

export type FicheLue =
  | { nature: "VOYAGEUR"; nom: string; voyageur: VoyageurLu; pieces: PieceFiche[] }
  | { nature: "HEBERGEMENT"; nom: string; hebergement: HebergementLu; pieces: PieceFiche[] };

/**
 * LIRE LES FICHES DU FORMULAIRE D'AJOUT — toutes, AVANT d'écrire quoi que ce soit. Une fiche illisible
 * ou une pièce refusée (type, vide, taille) fait refuser le poste ENTIER, en nommant la fiche : rien de
 * partiel. Une nature qui ne porte pas de fiches n'en lit aucune.
 */
export async function lireFichesDuFormulaire(
  formData: FormData, kind: AdProItemKind,
): Promise<{ ok: true; fiches: FicheLue[] } | { ok: false; error: string }> {
  const voyageurs = porteDesVoyageurs(kind);
  const hebergements = porteDesHebergements(kind);
  if (!voyageurs && !hebergements) return { ok: true, fiches: [] };
  const prefixes = prefixesRecus(formData.getAll(CHAMP_FICHES));
  if (!prefixes) return { ok: false, error: `Trop de fiches d'un coup (au plus ${FICHES_MAX}) : ajoutez les autres depuis le poste.` };

  const fiches: FicheLue[] = [];
  for (const [i, prefixe] of prefixes.entries()) {
    const g = (k: string) => fdStr(formData, `${prefixe}${k}`);
    if (voyageurs) {
      const lu = lireVoyageur({
        nom: g("nom"), prenom: g("prenom"), segments: g("segments"), villeDepart: g("villeDepart"), villeArrivee: g("villeArrivee"),
        dateDepart: g("dateDepart"), dateRetour: g("dateRetour"), notes: g("notes"), trajet: g("trajet"), transport: g("transport"),
      });
      if (!lu.ok) return { ok: false, error: refusDeFiche(i + 1, g("nom"), lu.error) };
      fiches.push({ nature: "VOYAGEUR", nom: lu.voyageur.nom, voyageur: lu.voyageur, pieces: piecesDeFiche(formData, prefixe, "passeport") });
    } else {
      const lu = lireHebergement({
        nom: g("nom"), prenom: g("prenom"), hotel: g("hotel"), ville: g("ville"),
        dateArrivee: g("dateArrivee"), dateDepart: g("dateDepart"), typeChambre: g("typeChambre"), notes: g("notes"),
      });
      if (!lu.ok) return { ok: false, error: refusDeFiche(i + 1, g("nom"), lu.error) };
      fiches.push({ nature: "HEBERGEMENT", nom: lu.hebergement.nom, hebergement: lu.hebergement, pieces: piecesDeFiche(formData, prefixe, "pieceIdentite") });
    }
  }
  for (const [i, f] of fiches.entries()) {
    const refus = await validateAttachments(f.pieces.map((p) => p.file));
    if (refus) return { ok: false, error: refusDeFiche(i + 1, f.nom, refus) };
  }
  return { ok: true, fiches };
}

/**
 * CRÉER LE POSTE ET SES FICHES, ENSEMBLE. Les lignes en UNE transaction ; puis les pièces. Une pièce qui
 * ne s'enregistre pas (stockage indisponible) fait tout défaire — les pièces déjà posées, le poste et ses
 * fiches : la personne retrouve son formulaire, pas un poste à moitié saisi.
 */
export async function creerPosteEtFiches(
  data: Prisma.AdProItemUncheckedCreateInput, fiches: readonly FicheLue[], userId: string,
): Promise<{ ok: true; itemId: string; pieces: number; identites: number } | { ok: false; error: string }> {
  const { itemId, ficheIds } = await prisma.$transaction(async (tx) => {
    const item = await tx.adProItem.create({ data, select: { id: true } });
    const ids: string[] = [];
    for (const [i, f] of fiches.entries()) {
      const base = { itemId: item.id, position: i + 1, createdById: userId, updatedById: userId };
      ids.push(f.nature === "VOYAGEUR"
        ? (await tx.adProVoyageur.create({ data: { ...base, ...donneesVoyageur(f.voyageur) }, select: { id: true } })).id
        : (await tx.adProHebergement.create({ data: { ...base, ...f.hebergement }, select: { id: true } })).id);
    }
    return { itemId: item.id, ficheIds: ids };
  });

  const poses: string[] = [];
  const echecs: string[] = [];
  let identites = 0;
  for (const [i, f] of fiches.entries()) {
    if (f.pieces.length === 0) continue;
    const r = await joindrePiecesDeFiche(userId, itemId, ficheIds[i]!, f.pieces);
    poses.push(...r.ids);
    if (r.identite) identites += 1;
    if (r.echecs.length > 0) echecs.push(`Fiche ${i + 1} (${f.nom}) : ${r.echecs.join(" ; ")}.`);
  }
  if (echecs.length > 0) {
    const docs = await prisma.document.findMany({ where: { id: { in: poses } }, select: { fileKey: true } });
    await prisma.document.deleteMany({ where: { id: { in: poses } } }).catch(() => undefined);
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => undefined);
    // Les fiches partent avec le poste (suppression en cascade).
    await prisma.adProItem.delete({ where: { id: itemId } }).catch(() => undefined);
    return { ok: false, error: `${echecs.join(" ")} Le poste n'a pas été créé : renvoyez le formulaire.` };
  }
  return { ok: true, itemId, pieces: poses.length, identites };
}
