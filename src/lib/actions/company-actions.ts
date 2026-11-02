"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { COMPANY_COOKIE, getMyCompanies } from "@/lib/company";
import { fdStr, type ActionResult } from "@/lib/actions/types";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 an
const ADMIN_PATH = "/admin/entites";

/** Gestion des entités : réservée à l'administration (Super Admin / Direction). */
function canManageCompanies(user: SessionUser): boolean {
  return userCan(user, "ADMIN", "CREATE");
}

/**
 * Change la portée d'entité du sélecteur de la barre supérieure (cookie).
 *
 * ON NE CHOISIT QUE CE À QUOI ON A DROIT. L'action acceptait n'importe quelle entité active :
 * demander Pharmagène depuis un compte Adventum écrivait le cookie sans broncher, et les écrans
 * qui posent ce cookie tel quel montraient alors les dossiers de l'autre société. Une entité
 * refusée retombe sur la portée légitime de la personne — jamais sur « toutes ».
 *
 * `"ALL"` reste possible pour qui a plusieurs entités : cela veut dire « toutes CELLES
 * AUXQUELLES J'AI DROIT », ce que les filtres serveur savent déjà appliquer.
 */
export async function setCompanyScope(value: string): Promise<void> {
  const user = await requireUser();
  const mine = await getMyCompanies(user.id);
  let scope = "ALL";
  if (value && value !== "ALL") {
    scope = mine.some((c) => c.id === value) ? value : (mine.length === 1 ? mine[0].id : "ALL");
  } else if (mine.length === 1) {
    // Mono-entité : « toutes » n'a pas de sens, et laisser le cookie vide reviendrait à ne
    // filtrer nulle part. On l'ancre sur la seule entité qui le concerne.
    scope = mine[0].id;
  }
  (await cookies()).set(COMPANY_COOKIE, scope, { path: "/", maxAge: COOKIE_MAX_AGE, sameSite: "lax", httpOnly: true });
}

/** Crée une nouvelle entité (dynamique : 3ᵉ société, filiale…). */
export async function createCompany(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageCompanies(user)) return { ok: false, error: "Réservé à l'administration." };
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom de l'entité est obligatoire." };
  const dup = await prisma.company.findUnique({ where: { name }, select: { id: true } });
  if (dup) return { ok: false, error: "Une entité porte déjà ce nom." };

  const count = await prisma.company.count();
  const c = await prisma.company.create({
    data: {
      name,
      shortName: fdStr(formData, "shortName") || null,
      color: fdStr(formData, "color") || null,
      sortOrder: count + 1,
      createdById: user.id,
    },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "ADMIN", summary: `Entité créée : ${name}` });
  revalidatePath(ADMIN_PATH);
  return { ok: true, id: c.id };
}

/** Met à jour une entité (nom, libellé court, couleur, ordre, activation). */
export async function updateCompany(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageCompanies(user)) return { ok: false, error: "Réservé à l'administration." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Entité introuvable." };
  const existing = await prisma.company.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return { ok: false, error: "Entité introuvable." };

  const name = fdStr(formData, "name") || existing.name;
  if (name !== existing.name) {
    const dup = await prisma.company.findFirst({ where: { name, id: { not: id } }, select: { id: true } });
    if (dup) return { ok: false, error: "Une autre entité porte déjà ce nom." };
  }
  const isActiveRaw = formData.get("isActive");
  await prisma.company.update({
    where: { id },
    data: {
      name,
      shortName: fdStr(formData, "shortName") || null,
      color: fdStr(formData, "color") || null,
      ...(isActiveRaw != null ? { isActive: isActiveRaw === "on" || isActiveRaw === "true" } : {}),
    },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "ADMIN", summary: `Entité modifiée : ${name}` });
  revalidatePath(ADMIN_PATH);
  return { ok: true };
}

/** Active / désactive une entité (une entité inactive disparaît du sélecteur). */
export async function toggleCompany(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageCompanies(user)) return { ok: false, error: "Réservé à l'administration." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Entité introuvable." };
  const c = await prisma.company.findUnique({ where: { id }, select: { isActive: true, name: true } });
  if (!c) return { ok: false, error: "Entité introuvable." };
  await prisma.company.update({ where: { id }, data: { isActive: !c.isActive } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "ADMIN",
    summary: `Entité ${c.isActive ? "désactivée" : "réactivée"} : ${c.name}`,
  });
  revalidatePath(ADMIN_PATH);
  return { ok: true };
}
