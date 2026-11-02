"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getMyCompanies } from "@/lib/company";
import { ouvreAnnuaireNomme } from "@/lib/queries/annuaires";
import { uniqueColumnKey } from "@/lib/medical/directory-mapping";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * LES ANNUAIRES DE PRATICIENS — plusieurs listes nommées, pas une seule.
 *
 * Une entreprise tient « Cardiologues Centre », « Prescripteurs Oncologie », « Congrès 2026 ».
 * Les fondre en un seul annuaire rend chacun inutilisable : on importe trois cents noms pour une
 * campagne, et l'annuaire de tout le monde est pollué pour six mois.
 *
 * Un annuaire RANGE, il n'AUTORISE pas : le cloisonnement par entité et la portée du délégué
 * (`delegateId`) restent les seules règles d'accès. Ranger un praticien dans un annuaire ne
 * l'ouvre à personne de plus.
 */

const PATH = "/medical/annuaire";

async function companyAllowed(userId: string, companyId: string | null): Promise<boolean> {
  if (!companyId) return true;
  const mine = await getMyCompanies(userId);
  return mine.some((c) => c.id === companyId);
}

/**
 * L'ANNUAIRE, SEULEMENT S'IL EST OUVERT À CETTE PERSONNE (audit sécurité 27/10, SECURITE-ACCES-08).
 *
 * Les écritures ne relisaient que le droit « Modifier » du module : qui n'était PAS sur la liste d'un
 * annuaire fermé (« Infectiologues », réservé à trois personnes) envoyait une liste vide — la restriction
 * tombait et il lisait tous ses praticiens — ou sa seule personne, et fermait l'annuaire aux autres. Toute
 * écriture passe donc par la règle de LECTURE de la feuille (`ouvreAnnuaireNomme`) et par l'entité.
 * Non exporté : dans un fichier `"use server"`, un export devient une action appelable.
 */
async function annuaireOuvert(user: SessionUser, id: string): Promise<{ name: string } | null> {
  const d = await prisma.medicalDirectory.findUnique({
    where: { id },
    select: { name: true, companyId: true, createdById: true, access: { select: { userId: true } } },
  });
  if (!d || !ouvreAnnuaireNomme(user)(d) || !(await companyAllowed(user.id, d.companyId))) return null;
  return { name: d.name };
}

export async function createMedicalDirectory(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "CREATE")) return { ok: false, error: "Non autorisé." };
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Donnez un nom à l'annuaire." };

  const companyId = fdStr(formData, "companyId");
  if (!(await companyAllowed(user.id, companyId))) return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };

  const created = await prisma.medicalDirectory.create({
    data: { name, description: fdStr(formData, "description"), companyId: companyId || null, createdById: user.id },
    select: { id: true },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Annuaire", entityType: "DOCTOR", entityId: created.id,
    summary: `Annuaire « ${name} » créé`,
  });
  revalidatePath(PATH);
  return { ok: true, id: created.id };
}

/** Renomme un annuaire (et corrige sa description ou son entité). */
export async function updateMedicalDirectory(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Annuaire introuvable." };
  const existing = await annuaireOuvert(user, id);
  if (!existing) return { ok: false, error: "Annuaire introuvable." };

  const companyRaw = formData.get("companyId");
  if (companyRaw != null && !(await companyAllowed(user.id, String(companyRaw) || null))) {
    return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };
  }

  const name = fdStr(formData, "name") || existing.name;
  await prisma.medicalDirectory.update({
    where: { id },
    data: {
      name,
      ...(formData.has("description") ? { description: fdStr(formData, "description") } : {}),
      ...(companyRaw != null ? { companyId: String(companyRaw) || null } : {}),
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Annuaire", entityType: "DOCTOR", entityId: id,
    summary: `Annuaire modifié : ${existing.name}${name !== existing.name ? ` → ${name}` : ""}`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Supprime un annuaire. Ses PRATICIENS ne sont jamais supprimés : ils repassent dans l'annuaire
 * général (`ON DELETE SET NULL`). Ranger trois cents noms dans une liste ne doit pas offrir un
 * moyen de les perdre tous d'un clic.
 */
export async function deleteMedicalDirectory(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Annuaire introuvable." };
  const existing = await annuaireOuvert(user, id);
  if (!existing) return { ok: false, error: "Annuaire introuvable." };

  const count = await prisma.medicalDoctor.count({ where: { directoryId: id } });
  await prisma.medicalDirectory.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Annuaire", entityType: "DOCTOR", entityId: id,
    summary: `Annuaire « ${existing.name} » supprimé — ${count} praticien(s) rendus à l'annuaire général, aucun supprimé`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/** Range un ou plusieurs praticiens dans un annuaire — ou les en sort (`directoryId` vide). */
export async function moveDoctorsToDirectory(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const ids = [...new Set(formData.getAll("doctorId").map(String).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Aucun praticien sélectionné." };

  const directoryId = fdStr(formData, "directoryId");
  let directoryName = "Annuaire général";
  if (directoryId) {
    const d = await annuaireOuvert(user, directoryId);
    if (!d) return { ok: false, error: "Annuaire introuvable." };
    directoryName = d.name;
  }

  const mine = await getMyCompanies(user.id);
  const movable = await prisma.medicalDoctor.findMany({
    where: { id: { in: ids }, OR: [{ companyId: null }, { companyId: { in: mine.map((c) => c.id) } }] },
    select: { id: true },
  });
  if (movable.length === 0) return { ok: false, error: "Ces praticiens ne sont pas dans votre périmètre." };

  await prisma.medicalDoctor.updateMany({
    where: { id: { in: movable.map((d) => d.id) } },
    data: { directoryId: directoryId || null },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Annuaire",
    summary: `${movable.length} praticien(s) rangé(s) dans « ${directoryName} »`,
  });
  revalidatePath(PATH);
  return { ok: true, message: `${movable.length} praticien(s) rangé(s) dans « ${directoryName} ».` };
}

/**
 * QUI PEUT OUVRIR CET ANNUAIRE — l'accès se règle DEPUIS l'annuaire, par noms.
 *
 * Liste vide = ouvert à tout le module (le cas normal — un annuaire de travail se partage).
 * Nommer quelqu'un le FERME à tous les autres, hors vue globale : même règle que les lecteurs
 * désignés de Legal. Celui qui règle l'accès se garde sa propre porte — s'enfermer dehors en
 * oubliant son nom dans la liste serait la première erreur de tout le monde.
 */
export async function setDirectoryAccess(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Annuaire introuvable." };
  const dir = await annuaireOuvert(user, id);
  if (!dir) return { ok: false, error: "Annuaire introuvable." };

  const wanted = [...new Set(formData.getAll("userId").map(String).filter(Boolean))];
  // Celui qui restreint reste dedans — sinon l'annuaire disparaît de sa propre vue au clic.
  if (wanted.length > 0 && !wanted.includes(user.id)) wanted.push(user.id);
  const known = wanted.length
    ? (await prisma.user.findMany({ where: { id: { in: wanted }, isActive: true }, select: { id: true } })).map((u) => u.id)
    : [];

  await prisma.$transaction([
    prisma.medicalDirectoryAccess.deleteMany({ where: { directoryId: id, userId: { notIn: known } } }),
    ...known.map((userId) =>
      prisma.medicalDirectoryAccess.upsert({
        where: { directoryId_userId: { directoryId: id, userId } },
        create: { directoryId: id, userId, grantedById: user.id },
        update: {},
      }),
    ),
  ]);

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Annuaire", entityType: "DOCTOR", entityId: id,
    summary: known.length
      ? `Annuaire « ${dir.name} » — accès restreint à ${known.length} personne(s)`
      : `Annuaire « ${dir.name} » — restriction levée : ouvert à tout le module`,
  });
  revalidatePath(PATH);
  return { ok: true, message: known.length ? `Accès réglé — ${known.length} personne(s).` : "Restriction levée : ouvert à tout le module." };
}

// ───────────────────── LES COLONNES PROPRES À UN ANNUAIRE ─────────────────────

/**
 * AJOUTER UNE COLONNE — ce que le tronc commun ne prévoit pas.
 *
 * Un annuaire d'infectiologues veut « Dernier congrès » ; un fichier de pharmaciens veut
 * « Numéro d'officine ». Les mettre au tronc commun les imposerait à tous les annuaires, et la
 * grille finirait avec quarante colonnes vides pour tout le monde.
 *
 * La CLÉ est calculée ici et FIGÉE : c'est elle qui indexe la valeur dans `MedicalDoctor.custom`.
 * Renommer le libellé plus tard ne doit jamais perdre ce qui a déjà été saisi.
 */
export async function createDirectoryColumn(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "UPDATE")) return { ok: false, error: "Non autorisé." };

  const directoryId = fdStr(formData, "directoryId");
  const label = fdStr(formData, "label");
  if (!directoryId) return { ok: false, error: "Colonne à ajouter : annuaire non précisé." };
  if (!label) return { ok: false, error: "Donnez un nom à la colonne." };

  const dir = await annuaireOuvert(user, directoryId);
  if (!dir) return { ok: false, error: "Annuaire introuvable." };

  const kindRaw = fdStr(formData, "kind") || "TEXT";
  const kind = ["TEXT", "NUMBER", "DATE", "CHOICE"].includes(kindRaw) ? kindRaw : "TEXT";
  const options = kind === "CHOICE" ? fdStr(formData, "options") : null;
  if (kind === "CHOICE" && !options) return { ok: false, error: "Une colonne à choix a besoin de ses options." };

  const existantes = await prisma.medicalDirectoryColumn.findMany({
    where: { directoryId }, select: { key: true, position: true },
  });
  const key = uniqueColumnKey(label, existantes.map((c) => c.key));
  const position = existantes.reduce((m, c) => Math.max(m, c.position), -1) + 1;

  await prisma.medicalDirectoryColumn.create({
    data: { directoryId, key, label, kind, options, position, createdById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Annuaire", entityType: "DOCTOR", entityId: directoryId,
    summary: `Annuaire « ${dir.name} » — colonne « ${label} » ajoutée`,
  });
  revalidatePath(PATH);
  return { ok: true, message: `Colonne « ${label} » ajoutée.` };
}

/**
 * RENOMMER OU RETYPER UNE COLONNE. La `key` n'est JAMAIS touchée — c'est tout l'intérêt de
 * l'avoir figée : le libellé est de l'affichage, la clé est l'identité des valeurs déjà saisies.
 */
export async function updateDirectoryColumn(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "UPDATE")) return { ok: false, error: "Non autorisé." };

  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Colonne introuvable." };
  const col = await prisma.medicalDirectoryColumn.findUnique({
    where: { id }, select: { label: true, directoryId: true, kind: true },
  });
  if (!col || !(await annuaireOuvert(user, col.directoryId))) return { ok: false, error: "Colonne introuvable." };

  const label = fdStr(formData, "label") || col.label;
  const kindRaw = fdStr(formData, "kind") || col.kind;
  const kind = ["TEXT", "NUMBER", "DATE", "CHOICE"].includes(kindRaw) ? kindRaw : col.kind;
  const options = kind === "CHOICE" ? fdStr(formData, "options") || null : null;

  await prisma.medicalDirectoryColumn.update({ where: { id }, data: { label, kind, options } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Annuaire", entityType: "DOCTOR", entityId: col.directoryId,
    summary: `Colonne « ${col.label} »${label !== col.label ? ` renommée « ${label} »` : " modifiée"}`,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Colonne modifiée." };
}

/**
 * SUPPRIMER UNE COLONNE — la définition seulement.
 *
 * LES VALEURS DÉJÀ SAISIES RESTENT dans `MedicalDoctor.custom`, et c'est délibéré. Balayer des
 * centaines de fiches pour effacer un champ est long, irréversible, et surtout : la suppression
 * est le plus souvent une erreur de manipulation. La colonne disparaît de la grille ; la recréer
 * sous le même libellé retrouve la même clé, donc les mêmes valeurs.
 *
 * Le prix de ce choix est nommé plutôt que caché : du JSON orphelin subsiste. Il ne s'affiche
 * nulle part, ne se recherche nulle part, et ne pèse rien à côté d'une donnée perdue pour de bon.
 */
export async function deleteDirectoryColumn(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "UPDATE")) return { ok: false, error: "Non autorisé." };

  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Colonne introuvable." };
  const col = await prisma.medicalDirectoryColumn.findUnique({
    where: { id }, select: { label: true, directoryId: true },
  });
  if (!col || !(await annuaireOuvert(user, col.directoryId))) return { ok: false, error: "Colonne introuvable." };

  await prisma.medicalDirectoryColumn.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Annuaire", entityType: "DOCTOR", entityId: col.directoryId,
    summary: `Colonne « ${col.label} » retirée de la grille (valeurs conservées)`,
  });
  revalidatePath(PATH);
  return { ok: true, message: `Colonne « ${col.label} » retirée. Les valeurs saisies sont conservées.` };
}
