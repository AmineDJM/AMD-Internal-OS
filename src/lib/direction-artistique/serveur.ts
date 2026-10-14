/**
 * LA DIRECTION ARTISTIQUE, côté serveur — déposer un modèle, désigner celui d'une entité, et lire
 * l'état de la papeterie d'une entité pour l'écran.
 *
 * Toutes les écritures passent ici (les actions serveur ne font que lire le formulaire) : la
 * garde de droit, la garde de PÉRIMÈTRE (on n'écrit jamais dans la papeterie d'une entité qu'on
 * ne voit pas) et la règle « un papier d'une autre entité n'est jamais désigné » sont écrites une
 * fois. ⚠️ Module serveur (base, stockage) : un composant client n'en importe rien — il lit
 * `modeles.ts`, pur.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { putBlob } from "@/lib/drive-storage";
import { validateUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { getMyCompanies, companyLabel } from "@/lib/company";
import { isOfficeKind, type OfficeKind } from "@/lib/office-templates";
import { validateLetterheadFile, KIND_LABEL } from "@/lib/office/letterhead";
import type { CurrentUser } from "@/lib/session";
import { peutGererDirectionArtistique } from "@/lib/direction-artistique/droits";
import { avecModeleParType, lireModelesParType, LIBELLE_TYPE_MODELE, papiersUtilisables, type ModeleLu, type TypeModele } from "@/lib/direction-artistique/modeles";

export type { ModeleLu };

export const MODULE_AUDIT = "Direction artistique";

export type Resultat = { ok: true; id?: string; message?: string } | { ok: false; error: string };

/** L'entité est-elle dans le périmètre de la personne ? (Le Super Admin voit toutes les entités par `getMyCompanies`.) */
export async function entiteDansPerimetre(userId: string, companyId: string): Promise<boolean> {
  const mine = await getMyCompanies(userId);
  return mine.some((c) => c.id === companyId);
}

/**
 * DÉPOSE un modèle (papier en-tête Word, modèle Excel ou PowerPoint). `companyId` vide = commun au
 * groupe (l'ancien geste du Drive) ; l'écran Direction artistique, lui, l'attache TOUJOURS à
 * l'entité ouverte.
 */
export async function deposerPapier(
  user: CurrentUser,
  o: { kind: string | null | undefined; file: unknown; name?: string | null; companyId?: string | null },
): Promise<Resultat> {
  if (!peutGererDirectionArtistique(user, "UPLOAD")) {
    return { ok: false, error: "Seule l'assistante de direction (ou qui tient la Direction artistique) dépose les modèles de la société." };
  }
  const kind = o.kind ?? "";
  if (!isOfficeKind(kind)) return { ok: false, error: "Type de document invalide." };
  const file = o.file;
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choisissez un fichier." };

  const badType = validateLetterheadFile(kind, file.name);
  if (badType) return { ok: false, error: badType };
  const badUpload = validateUpload(file.name, file.size, (await getAppSettings()).maxUploadMb);
  if (badUpload) return { ok: false, error: badUpload };

  // L'entité, si elle est précisée, doit être dans le périmètre : on ne dépose pas le papier
  // à en-tête d'une société qu'on ne voit pas.
  const companyId = (o.companyId ?? "").trim() || null;
  if (companyId && !(await entiteDansPerimetre(user.id, companyId))) {
    return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const { blobId, size } = await putBlob(buf);
  const name = (o.name ?? "").trim() || file.name;

  const created = await prisma.officeLetterhead.create({
    data: {
      name, kind, companyId,
      blobId, mime: file.type || "application/octet-stream", size,
      uploadedById: user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    actorId: user.id, action: "UPLOAD", module: MODULE_AUDIT,
    entityType: companyId ? "COMPANY" : undefined, entityId: companyId ?? undefined,
    summary: `Modèle ${KIND_LABEL[kind as OfficeKind]} ajouté : ${name}`,
  });
  return { ok: true, id: created.id };
}

/**
 * Le papier désigné doit être un modèle Word ACTIF de l'entité (ou commun au groupe) : la même
 * liste que celle où la fabrique choisit (`papiersUtilisables`). Sinon, refus nommé.
 */
async function verifierPapierWord(companyId: string, letterheadId: string): Promise<string | null> {
  const lh = await prisma.officeLetterhead.findUnique({ where: { id: letterheadId }, select: { id: true, kind: true, isActive: true, companyId: true } });
  if (!lh || !lh.isActive) return "Ce papier en-tête n'existe plus ou a été retiré.";
  if (lh.kind !== "word") return "Le modèle d'une pièce est un document Word.";
  if (papiersUtilisables([lh], companyId).length === 0) return "Ce papier en-tête appartient à une autre entité.";
  return null;
}

async function reglagesDe(companyId: string): Promise<Prisma.JsonValue | null> {
  return (await prisma.companyDocumentProfile.findUnique({ where: { companyId }, select: { settings: true } }))?.settings ?? null;
}

/** DÉSIGNE le papier en-tête par défaut de l'entité (`CompanyDocumentProfile.letterheadId`) ; vide = aucun. */
export async function reglerPapierParDefaut(user: CurrentUser, companyId: string, letterheadId: string | null): Promise<Resultat> {
  if (!peutGererDirectionArtistique(user, "UPDATE")) return { ok: false, error: "Non autorisé." };
  if (!companyId || !(await entiteDansPerimetre(user.id, companyId))) return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };
  const id = (letterheadId ?? "").trim() || null;
  if (id) {
    const refus = await verifierPapierWord(companyId, id);
    if (refus) return { ok: false, error: refus };
  }
  await prisma.companyDocumentProfile.upsert({
    where: { companyId },
    create: { companyId, letterheadId: id, updatedById: user.id },
    update: { letterheadId: id, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "COMPANY", entityId: companyId,
    summary: id ? "Papier en-tête par défaut désigné" : "Papier en-tête par défaut retiré",
  });
  return { ok: true };
}

/**
 * DÉSIGNE le modèle Word d'une nature de pièce pour l'entité (`settings.modelesParType[type]`) —
 * c'est là que la fabrique ira le chercher quand elle émet un bon de commande. Vide = la nature
 * reprend le papier par défaut.
 */
export async function reglerModeleParType(user: CurrentUser, companyId: string, type: TypeModele, letterheadId: string | null): Promise<Resultat> {
  if (!peutGererDirectionArtistique(user, "UPDATE")) return { ok: false, error: "Non autorisé." };
  if (!companyId || !(await entiteDansPerimetre(user.id, companyId))) return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };
  const id = (letterheadId ?? "").trim() || null;
  if (id) {
    const refus = await verifierPapierWord(companyId, id);
    if (refus) return { ok: false, error: refus };
  }
  const settings = avecModeleParType(await reglagesDe(companyId), type, id) as Prisma.InputJsonValue;
  await prisma.companyDocumentProfile.upsert({
    where: { companyId },
    create: { companyId, settings, updatedById: user.id },
    update: { settings, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "COMPANY", entityId: companyId,
    summary: id ? `Modèle de ${LIBELLE_TYPE_MODELE[type].toLowerCase()} désigné` : `Modèle de ${LIBELLE_TYPE_MODELE[type].toLowerCase()} retiré (papier par défaut)`,
  });
  return { ok: true };
}

/**
 * Le papier en-tête VISÉ par un geste de gestion (renommer, retirer, supprimer) est-il dans le
 * périmètre ? Commun au groupe : oui pour qui tient la papeterie ; d'une entité : il faut la voir.
 */
export async function papierDansPerimetre(userId: string, companyId: string | null): Promise<boolean> {
  if (!companyId) return true;
  return entiteDansPerimetre(userId, companyId);
}

// ─────────────────────────── L'écran ───────────────────────────

export interface EntiteDirectionArtistique {
  id: string;
  label: string;
  color: string | null;
  modeles: ModeleLu[];
  papierParDefautId: string | null;
  modelesParType: Partial<Record<TypeModele, string>>;
}

/** Les entités que la personne voit, et pour celle ouverte, sa papeterie (ses modèles + les communs). */
export async function vueDirectionArtistique(user: CurrentUser, entite?: string | null): Promise<{ entites: { id: string; label: string; color: string | null }[]; ouverte: EntiteDirectionArtistique | null }> {
  const mine = await getMyCompanies(user.id);
  const entites = mine.map((c) => ({ id: c.id, label: companyLabel(c), color: c.color ?? null }));
  const choisie = entites.find((c) => c.id === entite) ?? entites[0] ?? null;
  if (!choisie) return { entites, ouverte: null };

  const [rows, profil] = await Promise.all([
    prisma.officeLetterhead.findMany({
      where: { OR: [{ companyId: choisie.id }, { companyId: null }] },
      select: { id: true, name: true, kind: true, companyId: true, isActive: true, size: true, updatedAt: true, uploadedById: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.companyDocumentProfile.findUnique({ where: { companyId: choisie.id }, select: { letterheadId: true, settings: true } }),
  ]);
  const uploaderIds = [...new Set(rows.map((r) => r.uploadedById).filter((v): v is string => !!v))];
  const uploaders = uploaderIds.length ? await prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, name: true } }) : [];
  const noms = new Map(uploaders.map((u) => [u.id, u.name]));

  return {
    entites,
    ouverte: {
      ...choisie,
      modeles: rows.map((r) => ({
        id: r.id, name: r.name, kind: r.kind, companyId: r.companyId, isActive: r.isActive, size: r.size,
        updatedAt: r.updatedAt.toISOString(), uploadedBy: r.uploadedById ? noms.get(r.uploadedById) ?? null : null,
      })),
      papierParDefautId: profil?.letterheadId ?? null,
      modelesParType: lireModelesParType(profil?.settings),
    },
  };
}
