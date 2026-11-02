"use server";

import type { AdProItemOrderStage } from "@prisma/client";
import { requireUser } from "@/lib/session";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { lireVoyageur, lireEtapes, nomComplet, ligneVoyageur, changementsVoyageur, porteDesVoyageurs, type SaisieVoyageur, type VoyageurLu, lireHebergement, changementsHebergement, porteDesHebergements, type HebergementLu } from "@/modules/ad-pro/partage";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { donneesVoyageur } from "@/modules/ad-pro/api";
import { validateAttachments } from "@/lib/attach-files";
import { persistUploadedDocument } from "@/lib/documents";
import { noterModificationFiche } from "@/lib/reservation-fiche/serveur";
import { relierALaPersonne } from "@/modules/referentiels/api";
import { revalidate, canEditItems, audit, loadItem, REFUS_HISTORIQUE, chargerVoyageur, signalerAuSujet, depassementDuPoste } from "./infra/postes/commun";

/**
 * POSTES AD & PRO — LA BILLETTERIE ET L'HÔTELLERIE (§118.175, §118.205) : les voyageurs, les fiches
 * d'hébergement, la réservation, la validation du devis de chaque voyageur (son dépôt et le BC de la billetterie
 * vivent à côté des actions auxquelles ils passent leur formulaire : `actions-postes-paiement`, `actions-postes`).
 * Morceau de la clé `ad-pro-item-actions` (voir `actions-postes.ts`).
 */

/** Les étapes telles qu'elles sont en base — illisibles ou absentes, il n'y en a pas (jamais une étape devinée). */
function etapesEnBase(json: unknown) {
  const lues = lireEtapes(json);
  return lues.ok ? lues.etapes : [];
}

/** Ce que l'écriture d'un voyageur lu pose en base — les étapes en JSON. */
// `donneesVoyageur` : ce que l'écriture d'un voyageur lu pose en base — UNE définition, dans `ad-pro/fiches-poste`.

/** La ligne d'un voyageur telle qu'il est en base — ce que `changementsVoyageur` compare. */
const voyageurLu = (v: Omit<VoyageurLu, "segments" | "prenom"> & { prenom?: string | null; segments?: unknown }): VoyageurLu => ({
  nom: v.nom, prenom: v.prenom ?? null, segments: etapesEnBase(v.segments), villeDepart: v.villeDepart, villeArrivee: v.villeArrivee, dateDepart: v.dateDepart, dateRetour: v.dateRetour, notes: v.notes,
  trajet: v.trajet, transport: v.transport,
});

/**
 * AJOUTER UN VOYAGEUR à un poste « billetterie ». Un NOM suffit : on prend en charge un médecin
 * avant de savoir quand il part. Ce n'est pas un arbitrage, c'est une précision d'exécution —
 * donc offert aussi sur une demande clôturée, comme le bon de commande.
 */
export async function ajouterVoyageur(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(itemId, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesVoyageurs(item.kind)) return { ok: false, error: "Seul un poste « billetterie » porte des voyageurs." };

  const lu = lireVoyageur({
    nom: fdStr(formData, "nom"), prenom: fdStr(formData, "prenom"), segments: fdStr(formData, "segments"), villeDepart: fdStr(formData, "villeDepart"), villeArrivee: fdStr(formData, "villeArrivee"),
    dateDepart: fdStr(formData, "dateDepart"), dateRetour: fdStr(formData, "dateRetour"), notes: fdStr(formData, "notes"),
    trajet: fdStr(formData, "trajet"), transport: fdStr(formData, "transport"),
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const last = await prisma.adProVoyageur.findFirst({ where: { itemId }, orderBy: { position: "desc" }, select: { position: true } });
  // DOUBLE ÉCRITURE (refonte, lot V2-B) : la Personne dans la même transaction, derrière son interrupteur.
  const cree = await prisma.$transaction(async (tx) => {
    const ligne = await tx.adProVoyageur.create({
      data: { itemId, ...donneesVoyageur(lu.voyageur), position: (last?.position ?? 0) + 1, createdById: user.id, updatedById: user.id },
      select: { id: true },
    });
    await relierALaPersonne(tx, "AdProVoyageur", ligne.id, user.id);
    return ligne;
  });
  // LE PASSEPORT ET LES AUTRES DOCUMENTS, JOINTS DÈS LA CRÉATION (Direction, 06/10) — rangés comme ceux qu'on joint
  // ensuite : des documents du poste, à l'étape du voyageur (`stepKey`), le passeport en pièce d'identité.
  const pieces: { file: File; category: "ID_DOCUMENT" | "SUPPORTING_DOC" }[] = [
    ...formData.getAll("passeport").filter((v): v is File => v instanceof File && v.size > 0).map((file) => ({ file, category: "ID_DOCUMENT" as const })),
    ...formData.getAll("documents").filter((v): v is File => v instanceof File && v.size > 0).map((file) => ({ file, category: "SUPPORTING_DOC" as const })),
  ];
  const echecs: string[] = [];
  let passeport = false;
  if (pieces.length > 0) {
    const refus = await validateAttachments(pieces.map((p) => p.file));
    if (refus) echecs.push(refus);
    else {
      for (const p of pieces) {
        const r = await persistUploadedDocument(user.id, {
          entityType: "AD_PRO_ITEM", entityId: itemId, category: p.category, confidentiality: "INTERNAL", stepKey: cree.id, file: p.file,
        }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "dépôt impossible", documentId: undefined }));
        if (r.ok) passeport ||= p.category === "ID_DOCUMENT";
        else echecs.push(`${p.file.name} : ${r.error ?? "dépôt impossible"}`);
      }
    }
  }
  const sujet = await signalerAuSujet(item, user.id, `voyageur ajouté :\n${ligneVoyageur({ ...lu.voyageur, passeport })}`);
  await audit(user, owner.parent, owner.id, "UPDATE", `Voyageur « ${nomComplet(lu.voyageur)} » ajouté au poste « ${item.label} »${pieces.length > 0 ? ` — ${pieces.length - echecs.length} document(s) joint(s)` : ""}.`);
  revalidate(owner.parent, owner.id);
  const joints = pieces.length - echecs.length;
  return {
    ok: true, id: cree.id,
    message: `Voyageur ajouté${joints > 0 ? ` avec ${joints} document${joints > 1 ? "s" : ""}${passeport ? " (passeport compris)" : ""}` : ""}.${echecs.length > 0 ? ` Non joint : ${echecs.join(" ; ")} — joignez-le depuis la ligne du voyageur.` : ""}${sujet}`,
  };
}

/**
 * MODIFIER UN VOYAGEUR — seules les clés PRÉSENTES s'écrivent (§118.152c) : corriger une date ne
 * doit pas effacer le trajet qu'un formulaire partiel n'a pas renvoyé.
 */
export async function modifierVoyageur(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Voyageur non précisé." };
  const found = await chargerVoyageur(id, user);
  if (!found) return { ok: false, error: "Voyageur introuvable." };
  const { voyageur: v, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };

  const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const saisie: SaisieVoyageur = {
    nom: formData.has("nom") ? fdStr(formData, "nom") : v.nom,
    prenom: formData.has("prenom") ? fdStr(formData, "prenom") : v.prenom,
    segments: formData.has("segments") ? fdStr(formData, "segments") : v.segments,
    villeDepart: formData.has("villeDepart") ? fdStr(formData, "villeDepart") : v.villeDepart,
    villeArrivee: formData.has("villeArrivee") ? fdStr(formData, "villeArrivee") : v.villeArrivee,
    dateDepart: formData.has("dateDepart") ? fdStr(formData, "dateDepart") : jour(v.dateDepart),
    dateRetour: formData.has("dateRetour") ? fdStr(formData, "dateRetour") : jour(v.dateRetour),
    notes: formData.has("notes") ? fdStr(formData, "notes") : v.notes,
    // Un trajet passé en ALLER SIMPLE vide la date de retour, même si le formulaire ne la porte pas.
    trajet: formData.has("trajet") ? fdStr(formData, "trajet") : v.trajet,
    transport: formData.has("transport") ? fdStr(formData, "transport") : v.transport,
  };
  const lu = lireVoyageur(saisie);
  if (!lu.ok) return { ok: false, error: lu.error };
  const changements = changementsVoyageur(voyageurLu(v), lu.voyageur);
  if (changements.length === 0) return { ok: true, id, message: "Rien n'a changé." };

  await prisma.adProVoyageur.update({ where: { id }, data: { ...donneesVoyageur(lu.voyageur), updatedById: user.id } });
  // LA FICHE CHEZ L'ASSISTANTE (14/10) : modifiée après l'envoi, elle passe « à renvoyer ».
  await noterModificationFiche("VOYAGEUR", id, user.id);
  const sujet = await signalerAuSujet(item, user.id, `voyageur modifié — ${nomComplet(v)} : ${changements.join(" ; ")}`);
  await audit(user, owner.parent, owner.id, "UPDATE", `Voyageur « ${nomComplet(v)} » du poste « ${item.label} » modifié — ${changements.join(" ; ")}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: `Voyageur modifié.${sujet}` };
}

/**
 * RETIRER UN VOYAGEUR. Son passeport, s'il a été déposé, RESTE parmi les pièces du poste : une
 * pièce jointe ne s'efface pas en silence avec la ligne qui la désignait — elle se retire depuis
 * son aperçu, comme toute pièce.
 */
export async function retirerVoyageur(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Voyageur non précisé." };
  const found = await chargerVoyageur(id, user);
  if (!found) return { ok: false, error: "Voyageur introuvable." };
  const { voyageur: v, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  // SES DEVIS RESTENT DES DEVIS DU POSTE (§118.205) : seul le lien « pour ce voyageur » part avec lui.
  const devis = await prisma.adProVoyageurDevis.count({ where: { voyageurId: id } });
  await prisma.adProVoyageur.delete({ where: { id } });
  const sujet = await signalerAuSujet(item, user.id, `voyageur retiré : ${nomComplet(v)}.`);
  await audit(user, owner.parent, owner.id, "UPDATE", `Voyageur « ${nomComplet(v)} » retiré du poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, message: `Voyageur retiré.${devis > 0 ? ` Son devis reste sur le poste (case « Devis / pro forma »).` : ""}${sujet}` };
}

// ───────────────────────── Hôtellerie : une fiche par personne logée (Direction, 06/10) ─────────────────────────

/** Le poste « hôtellerie » d'une fiche, avec son opération — le point d'entrée des actions par fiche. */
async function chargerHebergement(id: string, user: SessionUser) {
  const h = await prisma.adProHebergement.findUnique({
    where: { id },
    select: { id: true, itemId: true, nom: true, prenom: true, hotel: true, ville: true, dateArrivee: true, dateDepart: true, typeChambre: true, notes: true },
  });
  if (!h) return null;
  const found = await loadItem(h.itemId, user);
  return found ? { hebergement: h, ...found } : null;
}

const hebergementLu = (h: HebergementLu): HebergementLu => ({
  nom: h.nom, prenom: h.prenom, hotel: h.hotel, ville: h.ville, dateArrivee: h.dateArrivee, dateDepart: h.dateDepart, typeChambre: h.typeChambre, notes: h.notes,
});

/**
 * AJOUTER UNE FICHE HÔTELLERIE à un poste « hôtellerie » — « une fiche hôtellerie pour chaque
 * personne ». Un NOM suffit ; la pièce d'identité et les autres documents se joignent dès la
 * création, rangés comme ceux d'un voyageur (documents du poste, `stepKey` = la fiche). Offert
 * aussi sur une demande clôturée : c'est une précision d'exécution, pas un arbitrage.
 */
export async function ajouterHebergement(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemId = fdStr(formData, "itemId");
  if (!itemId) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(itemId, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesHebergements(item.kind)) return { ok: false, error: "Seul un poste « hôtellerie » porte des fiches hôtellerie." };

  const lu = lireHebergement({
    nom: fdStr(formData, "nom"), prenom: fdStr(formData, "prenom"), hotel: fdStr(formData, "hotel"), ville: fdStr(formData, "ville"),
    dateArrivee: fdStr(formData, "dateArrivee"), dateDepart: fdStr(formData, "dateDepart"), typeChambre: fdStr(formData, "typeChambre"), notes: fdStr(formData, "notes"),
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const last = await prisma.adProHebergement.findFirst({ where: { itemId }, orderBy: { position: "desc" }, select: { position: true } });
  // DOUBLE ÉCRITURE (refonte, lot V2-B) : la Personne dans la même transaction, derrière son interrupteur.
  const cree = await prisma.$transaction(async (tx) => {
    const ligne = await tx.adProHebergement.create({
      data: { itemId, ...lu.hebergement, position: (last?.position ?? 0) + 1, createdById: user.id, updatedById: user.id },
      select: { id: true },
    });
    await relierALaPersonne(tx, "AdProHebergement", ligne.id, user.id);
    return ligne;
  });
  const pieces: { file: File; category: "ID_DOCUMENT" | "SUPPORTING_DOC" }[] = [
    ...formData.getAll("pieceIdentite").filter((v): v is File => v instanceof File && v.size > 0).map((file) => ({ file, category: "ID_DOCUMENT" as const })),
    ...formData.getAll("documents").filter((v): v is File => v instanceof File && v.size > 0).map((file) => ({ file, category: "SUPPORTING_DOC" as const })),
  ];
  const echecs: string[] = [];
  let piece = false;
  if (pieces.length > 0) {
    const refus = await validateAttachments(pieces.map((p) => p.file));
    if (refus) echecs.push(refus);
    else {
      for (const p of pieces) {
        const r = await persistUploadedDocument(user.id, {
          entityType: "AD_PRO_ITEM", entityId: itemId, category: p.category, confidentiality: "INTERNAL", stepKey: cree.id, file: p.file,
        }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "dépôt impossible", documentId: undefined }));
        if (r.ok) piece ||= p.category === "ID_DOCUMENT";
        else echecs.push(`${p.file.name} : ${r.error ?? "dépôt impossible"}`);
      }
    }
  }
  const joints = pieces.length - echecs.length;
  await audit(user, owner.parent, owner.id, "UPDATE", `Fiche hôtellerie « ${nomComplet(lu.hebergement)} » ajoutée au poste « ${item.label} »${pieces.length > 0 ? ` — ${joints} document(s) joint(s)` : ""}.`);
  revalidate(owner.parent, owner.id);
  return {
    ok: true, id: cree.id,
    message: `Fiche hôtellerie ajoutée${joints > 0 ? ` avec ${joints} document${joints > 1 ? "s" : ""}${piece ? " (pièce d'identité comprise)" : ""}` : ""}.${echecs.length > 0 ? ` Non joint : ${echecs.join(" ; ")} — joignez-le depuis la fiche.` : ""}`,
  };
}

/** MODIFIER UNE FICHE HÔTELLERIE — seules les clés PRÉSENTES s'écrivent (§118.152c). */
export async function modifierHebergement(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche hôtellerie non précisée." };
  const found = await chargerHebergement(id, user);
  if (!found) return { ok: false, error: "Fiche hôtellerie introuvable." };
  const { hebergement: h, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };

  const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  // SEULES LES CLÉS PRÉSENTES S'ÉCRIVENT (§118.152c) — chaque champ nommé en clair, pour que le contrat des actions le lise.
  const lu = lireHebergement({
    nom: formData.has("nom") ? fdStr(formData, "nom") : h.nom,
    prenom: formData.has("prenom") ? fdStr(formData, "prenom") : h.prenom,
    hotel: formData.has("hotel") ? fdStr(formData, "hotel") : h.hotel,
    ville: formData.has("ville") ? fdStr(formData, "ville") : h.ville,
    dateArrivee: formData.has("dateArrivee") ? fdStr(formData, "dateArrivee") : jour(h.dateArrivee),
    dateDepart: formData.has("dateDepart") ? fdStr(formData, "dateDepart") : jour(h.dateDepart),
    typeChambre: formData.has("typeChambre") ? fdStr(formData, "typeChambre") : h.typeChambre,
    notes: formData.has("notes") ? fdStr(formData, "notes") : h.notes,
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const changements = changementsHebergement(hebergementLu(h), lu.hebergement);
  if (changements.length === 0) return { ok: true, id, message: "Rien n'a changé." };

  await prisma.adProHebergement.update({ where: { id }, data: { ...lu.hebergement, updatedById: user.id } });
  // LA FICHE CHEZ L'ASSISTANTE (14/10) : modifiée après l'envoi, elle passe « à renvoyer ».
  await noterModificationFiche("HEBERGEMENT", id, user.id);
  await audit(user, owner.parent, owner.id, "UPDATE", `Fiche hôtellerie « ${nomComplet(h)} » du poste « ${item.label} » modifiée — ${changements.join(" ; ")}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: "Fiche hôtellerie modifiée." };
}

/**
 * RETIRER UNE FICHE HÔTELLERIE. Sa pièce d'identité, si elle a été déposée, RESTE parmi les pièces
 * du poste — comme le passeport d'un voyageur retiré : elle se retire depuis son aperçu.
 */
export async function retirerHebergement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche hôtellerie non précisée." };
  const found = await chargerHebergement(id, user);
  if (!found) return { ok: false, error: "Fiche hôtellerie introuvable." };
  const { hebergement: h, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  await prisma.adProHebergement.delete({ where: { id } });
  await audit(user, owner.parent, owner.id, "UPDATE", `Fiche hôtellerie « ${nomComplet(h)} » retirée du poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, message: "Fiche hôtellerie retirée." };
}

/** L'ANCIEN ENVOI EN BLOC EST FERMÉ (Direction, 27/10) : la réservation se fait FICHE PAR FICHE (`DemandeReservation`). */
const REFUS_RESERVATION_EN_BLOC =
  "La réservation se demande désormais fiche par fiche : envoyez chaque billet ou hôtel à l'assistante depuis sa fiche (« Envoyer », ou « Envoyer les fiches prêtes »).";

/**
 * DEMANDER LA RÉSERVATION des billets d'un poste — L'ANCIEN ENVOI EN BLOC, FERMÉ (Direction, 27/10).
 *
 * Deux mécanismes coexistaient : ce sujet unique qui listait tous les voyageurs, et la RÉSERVATION PAR FICHE
 * (`DemandeReservation`, `reservation-fiche-actions.ts`), où chaque billet ou hôtel a son état. La Direction
 * garde la fiche : ce geste n'écrit plus rien et le dit. Les envois en bloc déjà faits ont été repris en fiches
 * (migration `20270131120000_reservation_par_fiche_seule`). Les gardes restent AVANT le refus : on ne dit
 * pas à un inconnu qu'un poste existe.
 */
export async function demanderReservation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesVoyageurs(item.kind)) return { ok: false, error: "Seul un poste « billetterie » se réserve." };
  return { ok: false, error: REFUS_RESERVATION_EN_BLOC };
}

/**
 * RETIRER LA DEMANDE DE RÉSERVATION EN BLOC d'un poste — FERMÉ avec l'envoi en bloc (Direction, 27/10). Une fiche
 * envoyée se retire elle-même (`retirerFiche`) ; clore ici le sujet du poste couperait le fil des fiches qui
 * y écrivent.
 */
export async function retirerReservation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesVoyageurs(item.kind)) return { ok: false, error: "Seul un poste « billetterie » se réserve." };
  return { ok: false, error: "La réservation se suit désormais fiche par fiche : retirez chaque fiche envoyée depuis la fiche elle-même (« Retirer »)." };
}

// ───────────────────── Billetterie : le devis de chaque voyageur, puis le BC (§118.205) ─────────────────────
//
// « Pour chaque voyageur, on met le devis ou pro forma de l'agence ; si le demandeur valide une des pro
// forma ou un des devis, alors on demande à établir un BC, ensuite ça suit le process jusqu'à demander
// la facture » (Direction, 04/10). Pas de second circuit de pièces : le devis d'un voyageur EST un devis
// du poste (`ajouterDevisPoste`), et `AdProVoyageurDevis` dit seulement pour QUI il a été déposé et s'il
// est la proposition retenue. Le BC passe par la porte du poste (`requestAdProItemOrder`), inchangée.

/** Le prisma d'une contrainte d'unicité violée — l'index partiel « un retenu par voyageur ». */
const estConflitUnicite = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** Le BC a été demandé pendant la validation : la transaction se défait. */
class ChoixPerdu extends Error {}

/** Les étapes du BC où le choix d'un devis compte encore : il n'est ni demandé, ni établi. */
const BC_PAS_ENCORE_DEMANDE: AdProItemOrderStage[] = ["NONE", "REFUSED"];

/**
 * VALIDER UNE PROPOSITION D'UN VOYAGEUR — le demandeur en choisit une, les autres sont écartées. Choisir
 * un autre devis ensuite REMPLACE le choix, tant que le BC n'est pas demandé : après, le choix est ce que
 * le BC couvre, et il ne change plus d'ici.
 *
 * DEUX VALIDATIONS CROISÉES N'EN POSENT QU'UNE : la ligne du voyageur est verrouillée, le choix actuel
 * relu dessous et comparé à celui que la personne a VU (`retenuVu`) — le second geste trouve le choix
 * changé et le dit. L'écriture reste conditionnelle (devis encore libre, BC pas encore demandé), et l'index
 * partiel de la base n'admet qu'un retenu par voyageur. Un dépassement du montant accordé se DIT, sans bloquer.
 */
export async function validerDevisVoyageur(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const voyageurId = fdStr(formData, "voyageurId");
  const devisId = fdStr(formData, "devisId");
  if (!voyageurId || !devisId) return { ok: false, error: "Voyageur ou devis non précisés." };
  const found = await chargerVoyageur(voyageurId, user);
  if (!found) return { ok: false, error: "Voyageur introuvable." };
  const { voyageur: v, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (item.status === "REJECTED") return { ok: false, error: "Ce poste a été refusé : on n'y retient plus de devis." };
  if (!BC_PAS_ENCORE_DEMANDE.includes(item.orderStage)) {
    return { ok: false, error: "Le bon de commande de ce poste est déjà demandé : le devis retenu est celui qu'il couvre, il ne change plus d'ici." };
  }
  const lien = await prisma.adProVoyageurDevis.findFirst({
    where: { voyageurId, piece: { itemId: item.id, legalDocumentId: devisId } },
    select: { id: true, retenuLe: true, piece: { select: { legalDocument: { select: { status: true, cancelledAt: true } } } } },
  });
  if (!lien) return { ok: false, error: `Ce devis n'est pas une proposition déposée pour ${nomComplet(v)}.` };
  const doc = lien.piece.legalDocument;
  if (doc.status === "CANCELLED" || doc.cancelledAt) return { ok: false, error: "Ce devis a été annulé au registre : il ne se retient plus." };
  if (lien.retenuLe) {
    const depasse = await depassementDuPoste(item.id, item.amountGranted);
    return { ok: true, id: devisId, message: `Ce devis est déjà celui retenu pour ${nomComplet(v)}.${depasse ? ` ${depasse}` : ""}` };
  }
  // CE QUE LA PERSONNE A VU RETENU (§118.187) : changer de devis ne remplace QUE ce choix-là. L'écran
  // l'envoie ; sans lui, c'est le choix LU ICI qui fait foi — un choix posé entre cette lecture et
  // l'écriture (un autre clic, une autre personne) l'emporte, et le refus le dit.
  const retenuLu = (await prisma.adProVoyageurDevis.findFirst({
    where: { voyageurId, retenuLe: { not: null } }, select: { piece: { select: { legalDocumentId: true } } },
  }))?.piece.legalDocumentId ?? null;
  const retenuVu = formData.has("retenuVu") ? fdStr(formData, "retenuVu") : retenuLu;

  let issue: "POSE" | "DEJA" | "CHANGE" | "BC";
  try {
    issue = await prisma.$transaction(async (tx) => {
      // UN GESTE À LA FOIS PAR VOYAGEUR : la ligne du voyageur est verrouillée, le choix actuel RELU dessous.
      await tx.$queryRaw`SELECT id FROM "AdProVoyageur" WHERE id = ${voyageurId} FOR UPDATE`;
      const actuel = await tx.adProVoyageurDevis.findFirst({
        where: { voyageurId, retenuLe: { not: null } }, select: { id: true, piece: { select: { legalDocumentId: true } } },
      });
      // Retenu entre la lecture et ce verrou : par un autre geste — ce clic-ci n'a rien posé.
      if (actuel?.piece.legalDocumentId === devisId) return "DEJA" as const;
      if ((actuel?.piece.legalDocumentId ?? null) !== retenuVu) return "CHANGE" as const;
      if (actuel) await tx.adProVoyageurDevis.update({ where: { id: actuel.id }, data: { retenuLe: null, retenuParId: null } });
      const pose = await tx.adProVoyageurDevis.updateMany({
        where: { id: lien.id, retenuLe: null, piece: { item: { orderStage: { in: BC_PAS_ENCORE_DEMANDE } } } },
        data: { retenuLe: new Date(), retenuParId: user.id },
      });
      // Le BC vient d'être demandé : on défait le retrait de l'ancien choix avec le reste.
      if (pose.count === 0) throw new ChoixPerdu();
      return "POSE" as const;
    });
  } catch (e) {
    if (e instanceof ChoixPerdu) issue = "BC";
    // L'INDEX PARTIEL de la base, second filet : deux retenus pour un voyageur n'existent jamais.
    else if (estConflitUnicite(e)) issue = "CHANGE";
    else throw e;
  }
  if (issue === "DEJA") return { ok: false, error: `Ce devis vient d'être retenu pour ${nomComplet(v)} : rouvrez la fiche.` };
  if (issue === "CHANGE") return { ok: false, error: `Le devis retenu pour ${nomComplet(v)} vient de changer : rouvrez la fiche.` };
  if (issue === "BC") return { ok: false, error: "Le bon de commande de ce poste vient d'être demandé : le devis retenu ne change plus d'ici." };
  const depasse = await depassementDuPoste(item.id, item.amountGranted);
  await audit(user, owner.parent, owner.id, "UPDATE", `Devis retenu pour le voyageur « ${nomComplet(v)} » du poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id: devisId, message: `Devis retenu pour ${nomComplet(v)} — les autres propositions sont écartées.${depasse ? ` ${depasse}` : ""}` };
}
