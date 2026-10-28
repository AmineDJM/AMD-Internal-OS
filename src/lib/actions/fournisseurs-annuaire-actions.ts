"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { peutAnnuaire } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { reposerWilayaCode } from "@/lib/lieux/rattachement-prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdCase, type ActionResult } from "@/lib/actions/types";

/**
 * L'ANNUAIRE « FOURNISSEURS REGULATORY » (Direction, 06/10) — les fabricants des dossiers d'enregistrement, tenus
 * comme les autres annuaires : ajouter, corriger, retirer. C'est la MÊME fiche (`Supplier`) que les dossiers et le
 * portail externe : jamais une copie. Un fournisseur qui porte des dossiers ou des comptes du portail ne se supprime
 * pas — il se désactive, pour que ses dossiers gardent leur fabricant.
 */

const PATHS = ["/annuaires/fournisseurs", "/admin/suppliers"] as const;
const revalider = () => { for (const p of PATHS) revalidatePath(p); };

function lire(fd: FormData) {
  return {
    name: (fdStr(fd, "name") ?? "").replace(/\s+/g, " ").trim(),
    country: fdStr(fd, "country") || null,
    contactName: fdStr(fd, "contactName") || null,
    contactEmail: fdStr(fd, "contactEmail")?.toLowerCase() || null,
    phone: fdStr(fd, "phone") || null,
    website: fdStr(fd, "website") || null,
    address: fdStr(fd, "address") || null,
    city: fdStr(fd, "city") || null,
    notes: fdStr(fd, "notes") || null,
  };
}

export async function creerFournisseurAnnuaire(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutAnnuaire(user, "FOURNISSEURS", "CREATE")) return { ok: false, error: "Non autorisé (Regulatory, ou accès ouvert depuis la console)." };
  const data = lire(fd);
  if (!data.name) return { ok: false, error: "Le nom du fournisseur est obligatoire." };
  const doublon = await prisma.supplier.findFirst({ where: { name: { equals: data.name, mode: "insensitive" } }, select: { id: true } });
  if (doublon) return { ok: false, error: `« ${data.name} » existe déjà dans l'annuaire des fournisseurs.` };
  const s = await prisma.supplier.create({ data: { ...data, createdById: user.id }, select: { id: true } });
  await reposerWilayaCode("Supplier", s.id); // double écriture des lieux (refonte V2-D) : ville + pays → wilaya
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Annuaires", entityType: "SUPPLIER", entityId: s.id, summary: `Fournisseur Regulatory « ${data.name} » ajouté` });
  revalider();
  return { ok: true, id: s.id };
}

export async function modifierFournisseurAnnuaire(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutAnnuaire(user, "FOURNISSEURS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(fd, "id");
  if (!id) return { ok: false, error: "Fournisseur introuvable." };
  const avant = await prisma.supplier.findUnique({ where: { id }, select: { name: true } });
  if (!avant) return { ok: false, error: "Fournisseur introuvable." };
  const data = lire(fd);
  if (!data.name) return { ok: false, error: "Le nom du fournisseur est obligatoire." };
  // La case « Actif » a un témoin caché : `fdCase` la lit (cochée, décochée, ou absente du formulaire).
  const actif = fdCase(fd, "active");
  await prisma.supplier.update({ where: { id }, data: { ...data, ...(actif !== undefined ? { active: actif } : {}) } });
  await reposerWilayaCode("Supplier", id); // double écriture des lieux (refonte V2-D)
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "SUPPLIER", entityId: id, summary: `Fournisseur Regulatory « ${avant.name}${data.name !== avant.name ? ` → ${data.name}` : ""} » corrigé` });
  revalider();
  return { ok: true };
}

/** Retire un fournisseur — supprimé s'il ne porte rien, sinon désactivé (ses dossiers gardent leur fabricant). */
export async function retirerFournisseurAnnuaire(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutAnnuaire(user, "FOURNISSEURS", "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(fd, "id");
  if (!id) return { ok: false, error: "Fournisseur introuvable." };
  const s = await prisma.supplier.findUnique({ where: { id }, select: { name: true, _count: { select: { products: true, users: true } } } });
  if (!s) return { ok: false, error: "Fournisseur introuvable." };
  if (s._count.products + s._count.users > 0) {
    await prisma.supplier.update({ where: { id }, data: { active: false } });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "SUPPLIER", entityId: id, summary: `Fournisseur Regulatory « ${s.name} » désactivé (${s._count.products} dossier(s), ${s._count.users} compte(s) portail)` });
    revalider();
    return { ok: true, message: `« ${s.name} » porte ${s._count.products} dossier(s) et ${s._count.users} compte(s) du portail : il est désactivé, pas supprimé.` };
  }
  await prisma.supplier.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Annuaires", entityType: "SUPPLIER", entityId: id, summary: `Fournisseur Regulatory « ${s.name} » supprimé` });
  revalider();
  return { ok: true };
}
