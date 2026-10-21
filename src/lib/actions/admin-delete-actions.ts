"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, type Module, type Action } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { deleteFileByKey } from "@/lib/storage";
import { releaseBlob } from "@/lib/drive-storage";
import {
  DELETE_REGISTRY,
  apercuSuppression,
  deleteDelegateOf,
  isDeletableKind,
  type ApercuSuppression,
  type DeletableKind,
} from "@/lib/admin-delete-registry";
import { restaurerLotDeLaCorbeille, supprimerReversible, type DeleteResult } from "@/lib/suppression/coeur";
import { KIND_CORBEILLE_CTD } from "@/lib/regulatory/ctd-initiale";
import { restaurerLaCtdDeLaCorbeille } from "@/lib/regulatory/ctd-initiale-corbeille";
import { peutSupprimerUneDemandeAdPro } from "@/lib/queries/ad-pro-suppression";
import { estDemandeAdProSupprimable, REFUS_SUPPRESSION_AD_PRO } from "@/lib/ad-pro/suppression";
import { peutSupprimerUnRapportTerrain } from "@/lib/queries/field-reports";
import { peutSupprimerUneDemandePaiement } from "@/lib/queries/demande-paiement-suppression";
import { corbeillePermise, estDirecteurDesOperations, suppressionPermise } from "@/lib/suppression/delegation";

export type { DeleteResult } from "@/lib/suppression/coeur";


/**
 * Ce que le CRÉATEUR d'un objet peut supprimer lui-même — pas seulement le Super Admin.
 *
 * Un courrier saisi par erreur, un document légal en double : la personne qui l'a créé doit
 * pouvoir le retirer sans passer par l'administrateur. La suppression reste RÉVERSIBLE (elle
 * dépose l'instantané dans la même corbeille) : ce n'est donc pas un pouvoir de destruction, c'est
 * un pouvoir de rangement, que le Super Admin peut toujours défaire.
 */
const CREATOR_DELETABLE = new Set<DeletableKind>(["MAIL_ENTRY", "LEGAL_DOCUMENT"]);

/**
 * Le droit MODULE qui, à défaut d'être le créateur, autorise aussi la suppression réversible.
 *
 * Une assistante qui gère le registre du courrier doit pouvoir retirer un pli qu'un collègue a
 * saisi de travers, sans en être l'auteur — c'est son métier. On honore donc le droit `DELETE` du
 * module, en plus du créateur, sans pour autant confier ce pouvoir à tout le monde.
 */
const CREATOR_DELETE_PERMISSION: Partial<Record<DeletableKind, [Module, Action]>> = {
  MAIL_ENTRY: ["MAIL_REGISTER", "DELETE"],
  LEGAL_DOCUMENT: ["LEGAL", "DELETE"],
};


/**
 * LE CŒUR de la suppression réversible vit dans `lib/suppression/coeur.ts` (§118.162) : ce fichier
 * est `"use server"`, donc tout ce qu'il exporte est un point d'entrée public — une fonction qui
 * prend un type et un identifiant sans vérifier qui appelle n'a rien à y faire. Les actions
 * ci-dessous vérifient le DROIT, puis délèguent.
 */
/**
 * Suppression « définitive » d'un enregistrement par le Super Admin (et lui seul).
 * RÉVERSIBLE : voir `snapshotAndSoftDelete`.
 */
export async function superAdminDelete(formData: FormData): Promise<DeleteResult> {
  const user = await requireUser();
  const kind = String(formData.get("kind") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id || !isDeletableKind(kind)) return { ok: false, error: "Élément invalide." };
  // Le Super Admin — ou le DIRECTEUR DES OPÉRATIONS dans ses modules (Direction, 06/10), sur une ligne qu'il voit.
  const superAdmin = user.role === "SUPER_ADMIN";
  if (!superAdmin && !(await peutSupprimerDansSesModules(user, kind, id))) {
    return { ok: false, error: "Réservé au Super Admin (ou au directeur des opérations pour ses modules)." };
  }

  const name = await DELETE_REGISTRY[kind].describe(id);
  return supprimerReversible(kind, id, user.id, `Suppression définitive (${superAdmin ? "Super Admin" : "directeur des opérations"}) — ${DELETE_REGISTRY[kind].label} « ${name ?? id} » (restaurable depuis la corbeille)`);
}

/** Le directeur des opérations, sur un type de ses modules (droit « supprimer ») ET une ligne qu'il voit. */
async function peutSupprimerDansSesModules(user: Awaited<ReturnType<typeof requireUser>>, kind: DeletableKind, id: string): Promise<boolean> {
  if (!suppressionPermise(user, kind)) return false;
  const entite = DELETE_REGISTRY[kind].entityType;
  return !entite || canAccessEntity(user, entite, id, "DELETE");
}

/**
 * Suppression par LE CRÉATEUR de son propre objet (courrier, document légal).
 *
 * Le serveur revérifie tout : le type doit être dans `CREATOR_DELETABLE`, et l'appelant doit en
 * être le créateur — ou le Super Admin, qui peut toujours. La suppression reste réversible (même
 * corbeille) : un administrateur peut la défaire. On ne délègue donc pas un pouvoir de destruction,
 * seulement de rangement.
 */
export async function deleteOwnRecord(formData: FormData): Promise<DeleteResult> {
  const user = await requireUser();
  const kind = String(formData.get("kind") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id || !isDeletableKind(kind)) return { ok: false, error: "Élément invalide." };
  if (!CREATOR_DELETABLE.has(kind)) return { ok: false, error: "Ce type d'élément ne peut pas être supprimé ainsi." };

  const spec = DELETE_REGISTRY[kind];
  const creatorId = spec.creatorOf ? await spec.creatorOf(id) : null;
  const isCreator = creatorId !== null && creatorId === user.id;
  const perm = CREATOR_DELETE_PERMISSION[kind];
  const hasModuleDelete = perm ? userCan(user, perm[0], perm[1]) : false;
  if (!isCreator && !hasModuleDelete && user.role !== "SUPER_ADMIN") {
    return { ok: false, error: "Seul le créateur (ou un administrateur) peut supprimer cet élément." };
  }

  const name = await spec.describe(id);
  return supprimerReversible(kind, id, user.id, `Suppression par ${isCreator ? "le créateur" : "un administrateur"} — ${spec.label} « ${name ?? id} » (restaurable depuis la corbeille)`);
}

/**
 * SUPPRIMER UNE DEMANDE AD & PRO — le Super Admin, le directeur des opérations, la directrice
 * marketing (§118.175). « Donner la main au Directeur des opérations pour la suppression des
 * demandes Ad&Pro, pareil pour la directrice marketing » (Direction, 01/10).
 *
 * Le geste reste celui du Super Admin, au même cœur : RÉVERSIBLE (la demande ET ses branches
 * partent ensemble à la corbeille, d'où elles reviennent ensemble, §118.162), refusé quand une
 * branche porte un fait qui a quitté l'ERP. On délègue un rangement, jamais une destruction.
 */
export async function supprimerDemandeAdPro(formData: FormData): Promise<DeleteResult> {
  const user = await requireUser();
  const kind = String(formData.get("kind") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id || !isDeletableKind(kind) || !estDemandeAdProSupprimable(kind)) return { ok: false, error: "Élément invalide." };
  if (!(await peutSupprimerUneDemandeAdPro(user, kind, id))) return { ok: false, error: REFUS_SUPPRESSION_AD_PRO };
  const name = await DELETE_REGISTRY[kind].describe(id);
  const r = await supprimerReversible(kind, id, user.id, `Suppression d'une demande Ad & Pro — ${DELETE_REGISTRY[kind].label} « ${name ?? id} » (restaurable depuis la corbeille)`);
  // Le cœur ne revalide que la liste de la nature : le tableau « Toutes les demandes » (Ad & Pro) et
  // « Mon espace » listent aussi la demande qui vient de partir.
  if (r.ok) {
    revalidatePath("/ad-pro");
    revalidatePath("/mon-espace");
  }
  return r;
}

/**
 * Restaure un élément de la corbeille des suppressions définitives : la ligne
 * principale est recréée à l'identique (mêmes id/référence), ainsi que ses pièces
 * jointes et commentaires. Les enfants perdus en cascade ne reviennent pas.
 */
export async function restoreDeletedRecord(formData: FormData): Promise<DeleteResult> {
  const user = await requireUser();
  // Le Super Admin, ou le DIRECTEUR DES OPÉRATIONS pour ce qui relève de ses modules (Direction, 06/10) — la règle
  // vit dans `suppression/delegation.ts`, lue aussi par l'écran de la corbeille.
  if (user.role !== "SUPER_ADMIN" && !estDirecteurDesOperations(user)) return { ok: false, error: "Réservé au Super Admin." };
  const recId = String(formData.get("id") ?? "");
  const rec = await prisma.deletedRecord.findUnique({ where: { id: recId } });
  if (!rec || rec.restoredAt || rec.purgedAt) return { ok: false, error: "Entrée introuvable ou déjà traitée." };
  if (!corbeillePermise(user, rec.kind)) return { ok: false, error: "Cet élément ne relève pas de vos modules : seul le Super Admin le restaure." };
  // LA CTD INITIALE d'un dossier Regulatory (§118.213) : un ensemble de documents, pas une ligne du registre.
  if (rec.kind === KIND_CORBEILLE_CTD) {
    const r = await restaurerLaCtdDeLaCorbeille(rec, user.id);
    if (!r.ok) return r;
    revalidatePath("/admin/corbeille");
    revalidatePath(`/regulatory/${rec.sourceId}`);
    return { ok: true, redirect: r.redirect };
  }
  if (!isDeletableKind(rec.kind)) return { ok: false, error: "Type inconnu." };
  const spec = DELETE_REGISTRY[rec.kind];

  // UN LOT (§118.162) : la demande ET ses branches reviennent ensemble, ou rien ne revient.
  const lot = await restaurerLotDeLaCorbeille(rec, rec.kind);
  if (lot) {
    if (!lot.ok) return lot;
    await prisma.deletedRecord.update({ where: { id: recId }, data: { restoredAt: new Date() } });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: spec.module, entityType: spec.entityType, entityId: rec.sourceId,
      summary: `Restauration depuis la corbeille — ${spec.label} « ${rec.name} », avec ses éléments liés`,
    });
    revalidatePath("/admin/corbeille");
    revalidatePath("/corbeille");
    revalidatePath(spec.redirect);
    return { ok: true, redirect: spec.redirect };
  }

  const exists = await deleteDelegateOf(spec).findUnique({ where: { id: rec.sourceId } });
  if (exists) return { ok: false, error: "Un enregistrement avec cet identifiant existe déjà (déjà restauré ?)." };

  try {
    await deleteDelegateOf(spec).create({ data: rec.payload as Record<string, unknown> });
    // Ce que la suppression avait compensé ailleurs (un solde de congés rendu, par exemple)
    // se reprend ici : sans ce geste, restaurer donnerait à la fois l'objet et sa compensation.
    await spec.restored?.(rec.sourceId);
    const docs = (rec.documents as Record<string, unknown>[] | null) ?? [];
    if (docs.length) await prisma.document.createMany({ data: docs as never[], skipDuplicates: true });
    const comments = (rec.comments as Record<string, unknown>[] | null) ?? [];
    if (comments.length) await prisma.comment.createMany({ data: comments as never[], skipDuplicates: true });
  } catch (err) {
    console.error("[restoreDeletedRecord] échec restauration", rec.kind, rec.sourceId, err);
    return { ok: false, error: "Restauration impossible (élément lié manquant, ex. employé ou dossier parent supprimé)." };
  }

  await prisma.deletedRecord.update({ where: { id: recId }, data: { restoredAt: new Date() } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: spec.module, entityType: spec.entityType, entityId: rec.sourceId,
    summary: `Restauration depuis la corbeille — ${spec.label} « ${rec.name} »`,
  });
  revalidatePath("/admin/corbeille");
  revalidatePath("/corbeille");
  revalidatePath(spec.redirect);
  return { ok: true, redirect: spec.redirect };
}

/** Destruction RÉELLE d'une entrée de la corbeille : efface aussi les fichiers stockés. */
export async function destroyDeletedRecord(formData: FormData): Promise<DeleteResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const recId = String(formData.get("id") ?? "");
  const rec = await prisma.deletedRecord.findUnique({ where: { id: recId } });
  if (!rec || rec.purgedAt) return { ok: false, error: "Entrée introuvable ou déjà détruite." };

  // Fichiers des pièces jointes snapshotées (s'il n'a pas été restauré).
  if (!rec.restoredAt) {
    const docs = (rec.documents as { fileKey?: string | null }[] | null) ?? [];
    for (const d of docs) {
      if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {});
    }
    // Cas particulier : audio d'un rapport terrain (blob chiffré du Drive).
    const audioBlobId = (rec.payload as { audioBlobId?: string | null } | null)?.audioBlobId;
    if (rec.kind === "FIELD_REPORT" && audioBlobId) await releaseBlob(audioBlobId).catch(() => {});
    // Les PIÈCES JOINTES d'un rapport terrain (§118.212) voyagent dans le lot, et leurs fichiers
    // restent au stockage tant que l'entrée existe : la destruction réelle les libère — comme
    // l'ancien geste « supprimer » le faisait d'emblée, sans corbeille.
    if (rec.kind === "FIELD_REPORT") {
      const lot = rec.lot as { lignes?: { modele: string; donnees: { blobId?: string | null } }[] } | null;
      for (const l of lot?.lignes ?? []) {
        if (l.modele === "FieldReportAttachment" && l.donnees.blobId) await releaseBlob(l.donnees.blobId).catch(() => {});
      }
    }
    // UN ÉLÉMENT DU DRIVE : ses versions tenaient leurs octets jusqu'ici — la suppression depuis la corbeille du
    // Drive ne les rendait pas, pour qu'il reste restaurable. La destruction réelle rend chaque référence (un
    // contenu partagé par une copie ailleurs reste, `releaseBlob` compte ses détenteurs).
    if (rec.kind === "DRIVE_NODE") {
      const lot = rec.lot as { lignes?: { modele: string; donnees: { blobId?: string | null } }[] } | null;
      for (const l of lot?.lignes ?? []) {
        if (l.modele === "FileVersion" && l.donnees.blobId) await releaseBlob(l.donnees.blobId).catch(() => {});
      }
    }
  }

  await prisma.deletedRecord.update({ where: { id: recId }, data: { purgedAt: new Date() } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Administration",
    summary: `Corbeille — destruction définitive : ${rec.label} « ${rec.name} »`,
  });
  revalidatePath("/admin/corbeille");
  return { ok: true };
}

/**
 * CE QUE LA SUPPRESSION EMPORTERA — lu par la fenêtre de confirmation AVANT le clic (§118.53).
 *
 * Même porte que la suppression elle-même : le Super Admin, ou — pour les types qu'un MODULE
 * laisse supprimer depuis son écran — qui détient ce droit ET voit la ligne. Un aperçu ouvert à
 * tout le monde dirait à n'importe qui ce qui dépend d'une demande qu'il ne voit pas.
 */
/**
 * La porte de l'aperçu est EXACTEMENT celle de l'action qui supprime — ni plus large (on dirait à
 * quelqu'un ce qui dépend d'une ligne qu'il ne peut pas toucher), ni plus étroite (le bouton ne
 * s'armerait pas devant une suppression que l'action accepte).
 */
const SUPPRIME_PAR_SON_MODULE: Partial<Record<DeletableKind, { module: Module; action: Action; ligne: boolean }>> = {
  // `deleteEvent` (§118.162) : le droit « supprimer » du module Événements, et lui seul.
  EVENT: { module: "EVENTS", action: "DELETE", ligne: false },
  // `deleteBdProject` (§118.163) : le droit du module Projets ET la ligne dans sa portée.
  BD_PROJECT: { module: "BD_PROJECTS", action: "DELETE", ligne: true },
  // `deleteTender` (§118.185) : le droit de supprimer au PCH ET le marché dans sa portée.
  PCH_TENDER: { module: "PCH", action: "DELETE", ligne: true },
};

/**
 * Le prédicat est NOMMÉ : écrit en ligne avec un module lu dans une table, la carte de
 * confirmation l'aurait décrit « gardé par rien » (§118.150g) — la dérivation ne reconnaît une
 * garde qu'à son nom ou à un module littéral.
 */
async function peutSupprimerDepuisSonModule(user: Awaited<ReturnType<typeof requireUser>>, kind: DeletableKind, id: string): Promise<boolean> {
  if (user.role === "SUPER_ADMIN") return true;
  // UNE DEMANDE AD & PRO (§118.175) : le directeur des opérations et la directrice marketing la
  // suppriment aussi — la MÊME règle que `supprimerDemandeAdPro`, sans quoi l'aperçu ne s'ouvrirait
  // pas devant une suppression que l'action accepte.
  if (estDemandeAdProSupprimable(kind) && (await peutSupprimerUneDemandeAdPro(user, kind, id))) return true;
  // UN RAPPORT TERRAIN (§118.212) : l'auteur, la hiérarchie qui le gère dans son périmètre d'entité —
  // la MÊME règle que `deleteFieldReport`, sans quoi l'aperçu ne s'ouvrirait pas devant une
  // suppression que l'action accepte (ni ne s'ouvrirait à qui l'action refuse).
  if (kind === "FIELD_REPORT") return peutSupprimerUnRapportTerrain(user, id);
  // UNE DEMANDE DE PAIEMENT (19/10) : son demandeur — la MÊME règle que `supprimerDemandePaiement`.
  if (kind === "PAYMENT_REQUEST") return peutSupprimerUneDemandePaiement(user, id);
  // LE DIRECTEUR DES OPÉRATIONS dans ses modules — la MÊME règle que `superAdminDelete` (§118.209).
  if (await peutSupprimerDansSesModules(user, kind, id)) return true;
  const droit = SUPPRIME_PAR_SON_MODULE[kind];
  if (!droit || !userCan(user, droit.module, droit.action)) return false;
  const entite = DELETE_REGISTRY[kind].entityType;
  return !droit.ligne || !entite || canAccessEntity(user, entite, id, droit.action);
}

export async function apercuDeSuppression(formData: FormData): Promise<ApercuSuppression | { erreur: string }> {
  const user = await requireUser();
  const kind = String(formData.get("kind") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id || !isDeletableKind(kind)) return { erreur: "Élément invalide." };
  if (!(await peutSupprimerDepuisSonModule(user, kind, id))) return { erreur: "Réservé à qui peut supprimer cet élément." };
  return apercuSuppression(kind, id);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER UNE SÉLECTION D'UN GESTE — les écritures « à imputer » (§118.176).
 *
 * « Tu dois me donner la main pour que je supprime carrément ça, une ou plusieurs » (Direction,
 * 01/10, devant la liste « À imputer » des Budgets : une facture informative datée de décembre,
 * deux fois la même location de voiture, des dotations de caisse). Le geste est celui du Super
 * Admin, au MÊME cœur que sa suppression unitaire : chaque écriture part en lot à la corbeille,
 * avec ce qui la cite (vidé, nommé, rétabli si on la restaure, §118.162).
 *
 * Trois propriétés :
 *   • CHAQUE élément est indépendant : une écriture refusée n'empêche pas les autres de partir, et
 *     le refus est NOMMÉ, élément par élément — un lot partiellement valide applique ce qu'il peut
 *     et DIT le reste (§104.6). Jamais « 5 supprimées » sur quatre.
 *   • La liste des types est FERMÉE (`SUPPRESSION_GROUPEE`) : la demande porte sur les écritures, et
 *     un geste de sélection sur tout le registre serait une empreinte plus large que la demande
 *     (§118.16). L'élargir est une décision.
 *   • Une limite opérationnelle, dite comme telle (§118.2) : au-delà de `MAX_PAR_GESTE`, refus en
 *     nommant le nombre — l'écran n'en montre de toute façon que trente à la fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const SUPPRESSION_GROUPEE: ReadonlySet<DeletableKind> = new Set<DeletableKind>(["FINANCE_TRANSACTION"]);
const MAX_PAR_GESTE = 100;

export interface ResultatSuppressionGroupee {
  ok: boolean;
  error?: string;
  message?: string;
  supprimes: string[];
  refus: { nom: string; raison: string }[];
}

export async function superAdminDeleteMany(formData: FormData): Promise<ResultatSuppressionGroupee> {
  const user = await requireUser();
  const vide = { supprimes: [] as string[], refus: [] as { nom: string; raison: string }[] };
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin.", ...vide };
  const kind = String(formData.get("kind") ?? "");
  const ids = [...new Set(formData.getAll("id").map((v) => String(v)).filter(Boolean))];
  if (!isDeletableKind(kind) || !SUPPRESSION_GROUPEE.has(kind)) return { ok: false, error: "Ce type d'élément ne se supprime pas en sélection.", ...vide };
  if (ids.length === 0) return { ok: false, error: "Aucun élément sélectionné.", ...vide };
  if (ids.length > MAX_PAR_GESTE) {
    return { ok: false, error: `${ids.length} éléments sélectionnés : au-delà de ${MAX_PAR_GESTE}, une suppression ne se fait pas d'un seul geste.`, ...vide };
  }
  const spec = DELETE_REGISTRY[kind];
  const supprimes: string[] = [];
  const refus: { nom: string; raison: string }[] = [];
  for (const id of ids) {
    const nom = (await spec.describe(id)) ?? id;
    const r = await supprimerReversible(kind, id, user.id, `Suppression définitive (Super Admin, sélection de ${ids.length}) — ${spec.label} « ${nom} » (restaurable depuis la corbeille)`);
    if (r.ok) supprimes.push(nom);
    else refus.push({ nom, raison: r.error ?? "Suppression refusée." });
  }
  const n = supprimes.length;
  const phrase = n === 0
    ? "Aucun élément supprimé."
    : `${n} ${n > 1 ? "écritures supprimées" : "écriture supprimée"} — restaurable${n > 1 ? "s" : ""} depuis Administration › Corbeille.`;
  const detailRefus = refus.length ? ` ${refus.length} refusée${refus.length > 1 ? "s" : ""} : ${refus.map((x) => `${x.nom} (${x.raison})`).join(" ; ")}.` : "";
  return { ok: n > 0, ...(n === 0 ? { error: phrase + detailRefus } : { message: phrase + detailRefus }), supprimes, refus };
}

/**
 * L'APERÇU D'UNE SÉLECTION — ce que chaque élément emporte et ce qui, en restant, perd son lien,
 * lu par le MÊME inventaire que la suppression (`apercuSuppression`) : la confirmation dit ce qui
 * se passera, élément par élément, avant le clic (§118.53). N'écrit rien.
 */
export async function apercuSuppressionGroupee(formData: FormData): Promise<{ erreur: string } | { elements: (ApercuSuppression & { id: string })[] }> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { erreur: "Réservé au Super Admin." };
  const kind = String(formData.get("kind") ?? "");
  const ids = [...new Set(formData.getAll("id").map((v) => String(v)).filter(Boolean))];
  if (!isDeletableKind(kind) || !SUPPRESSION_GROUPEE.has(kind)) return { erreur: "Ce type d'élément ne se supprime pas en sélection." };
  if (ids.length === 0 || ids.length > MAX_PAR_GESTE) return { erreur: ids.length === 0 ? "Aucun élément sélectionné." : `Au-delà de ${MAX_PAR_GESTE} éléments, une suppression ne se fait pas d'un seul geste.` };
  const elements: (ApercuSuppression & { id: string })[] = [];
  for (const id of ids) elements.push({ id, ...(await apercuSuppression(kind, id)) });
  return { elements };
}

