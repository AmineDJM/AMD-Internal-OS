"use server";

import { revalidatePath } from "next/cache";
import { requireUser, type CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { entitePermisePourFiche } from "@/lib/company";
import { fdStr, fdNum, fdBool, type ActionResult } from "@/lib/actions/types";
import {
  annulerDepart, cocherTacheDeSortie, corrigerDepart, creerCompteDuSalarie, ecrireTacheDeSortie, emettreCertificat,
  enregistrerCertificat, enregistrerSolde, lireCertificatSaisi, lireSoldeSaisi, ouvrirDepart, refusSaisieDepart,
  renouvelerInvitationSalarie, retirerTacheDeSortie, transfererAuRepreneur, type MotifDepart, type SaisieDepart,
} from "@/modules/rh/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DE LA FIN DE CONTRAT ET DU COMPTE D'UNE FICHE (lot rhdepart) — clé `depart-salarie-actions`.
 *
 * Tous sont des gestes RH sur une fiche : il faut le droit d'écrire les fiches (`EMPLOYEES:UPDATE`) ET que la fiche
 * soit d'une société ouverte à la personne (§118.184). Le solde de tout compte, qui porte des montants de paie, exige en
 * plus de voir les salaires (`voitLesSalaires`). Les DÉCISIONS du circuit (N+1, DG) ne sont pas ici : elles se prennent
 * dans le Centre de validations, par `decideValidation`, comme toute validation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const NON_AUTORISE = "Réservé aux RH (droit de modifier les fiches salariés).";

/** La fiche est-elle ouverte à cette personne pour un geste RH ? Rend l'id de la fiche, ou le refus. */
async function ficheEcrivable(user: CurrentUser, employeeId: string | null): Promise<{ ok: true; employeeId: string } | { ok: false; error: string }> {
  if (!userCan(user, "EMPLOYEES", "UPDATE")) return { ok: false, error: NON_AUTORISE };
  if (!employeeId) return { ok: false, error: "Fiche salarié introuvable." };
  const f = await prisma.employee.findUnique({ where: { id: employeeId }, select: { companyId: true } });
  if (!f || !(await entitePermisePourFiche(user.id, f.companyId))) return { ok: false, error: "Fiche salarié introuvable." };
  return { ok: true, employeeId };
}
async function ficheDuDepart(user: CurrentUser, departId: string | null) {
  if (!departId) return { ok: false as const, error: "Fin de contrat introuvable." };
  const d = await prisma.departSalarie.findUnique({ where: { id: departId }, select: { employeeId: true } });
  return ficheEcrivable(user, d?.employeeId ?? null);
}
async function ficheDeLaTache(user: CurrentUser, tacheId: string | null) {
  if (!tacheId) return { ok: false as const, error: "Ligne introuvable : rechargez la fiche." };
  const t = await prisma.departSalarieTache.findUnique({ where: { id: tacheId }, select: { depart: { select: { employeeId: true } } } });
  return ficheEcrivable(user, t?.depart.employeeId ?? null);
}
function rafraichir(employeeId: string) {
  revalidatePath(`/rh/${employeeId}`);
  revalidatePath("/rh");
}

function lireSaisieDepart(formData: FormData): SaisieDepart | { refus: string } {
  const motif = fdStr(formData, "motif");
  const dateFin = fdStr(formData, "dateFin");
  const preavisJours = fdNum(formData, "preavisJours");
  const note = fdStr(formData, "note");
  const refus = refusSaisieDepart({ motif, dateFin, preavisJours, note });
  if (refus) return { refus };
  return { motif: motif as MotifDepart, dateFin: new Date(`${dateFin}T00:00:00.000Z`), preavisJours, note };
}

// ─────────────────────────────── Le compte applicatif ───────────────────────────────

/** CRÉER SON COMPTE — pour une fiche née sans (ancienne fiche, e-mail ajouté depuis). Idempotent. */
export async function creerCompteSalarie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await ficheEcrivable(user, fdStr(formData, "id"));
  if (!f.ok) return f;
  const r = await creerCompteDuSalarie(user, f.employeeId, { role: fdStr(formData, "role") });
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  if (!r.cree && r.phrase && !r.lien && !r.phrase.startsWith("Le compte applicatif existant")) return { ok: false, error: r.phrase };
  return { ok: true, message: r.phrase ?? "Cette fiche a déjà son compte applicatif." };
}

/** UN NOUVEAU LIEN D'INVITATION pour un compte jamais activé (lien perdu ou périmé). */
export async function renouvelerInvitation(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await ficheEcrivable(user, fdStr(formData, "id"));
  if (!f.ok) return f;
  const r = await renouvelerInvitationSalarie(user.id, f.employeeId);
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  return { ok: true, message: r.phrase };
}

// ─────────────────────────────── Le circuit ───────────────────────────────

/** OUVRIR LA FIN DE CONTRAT depuis la fiche — RH (acquise) → N+1 → DG. */
export async function ouvrirFinDeContrat(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await ficheEcrivable(user, fdStr(formData, "employeeId"));
  if (!f.ok) return f;
  const s = lireSaisieDepart(formData);
  if ("refus" in s) return { ok: false, error: s.refus };
  const r = await ouvrirDepart(user.id, f.employeeId, s);
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  revalidatePath("/validations");
  revalidatePath("/mon-espace");
  return { ok: true, id: r.id, message: r.message };
}

/** CORRIGER ET RENVOYER une fin de contrat renvoyée par un valideur. */
export async function corrigerFinDeContrat(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const departId = fdStr(formData, "departId");
  const f = await ficheDuDepart(user, departId);
  if (!f.ok) return f;
  const s = lireSaisieDepart(formData);
  if ("refus" in s) return { ok: false, error: s.refus };
  const correction = fdStr(formData, "correction");
  if (!correction) return { ok: false, error: "Dites ce que vous avez corrigé : c'est la première chose que le valideur lira." };
  const r = await corrigerDepart(user.id, departId!, s, correction);
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  revalidatePath("/validations");
  revalidatePath("/mon-espace");
  return { ok: true, message: r.message };
}

/** ANNULER la fin de contrat (tant que la fiche n'est pas fermée), motif exigé. */
export async function annulerFinDeContrat(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const departId = fdStr(formData, "departId");
  const f = await ficheDuDepart(user, departId);
  if (!f.ok) return f;
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Indiquez pourquoi la fin de contrat est annulée : les valideurs le liront." };
  const r = await annulerDepart(user.id, departId!, motif);
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  revalidatePath("/validations");
  revalidatePath("/mon-espace");
  return { ok: true, message: r.message };
}

// ─────────────────────────────── La liste de sortie ───────────────────────────────

/** COCHER (ou décocher) une ligne de la liste de sortie — qui, quand. */
export async function cocherLigneDeSortie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const tacheId = fdStr(formData, "tacheId");
  const f = await ficheDeLaTache(user, tacheId);
  if (!f.ok) return f;
  const r = await cocherTacheDeSortie(user.id, tacheId!, fdBool(formData, "fait"));
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  return { ok: true };
}

/** AJOUTER ou MODIFIER une ligne de la liste de sortie. */
export async function ecrireLigneDeSortie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const departId = fdStr(formData, "departId");
  const f = await ficheDuDepart(user, departId);
  if (!f.ok) return f;
  const r = await ecrireTacheDeSortie(user.id, {
    departId: departId!, tacheId: fdStr(formData, "tacheId"), categorie: fdStr(formData, "categorie") ?? "AUTRE",
    libelle: fdStr(formData, "libelle") ?? "", detail: fdStr(formData, "detail"),
  });
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  return { ok: true };
}

/** RETIRER une ligne de la liste de sortie. */
export async function retirerLigneDeSortie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const tacheId = fdStr(formData, "tacheId");
  const f = await ficheDeLaTache(user, tacheId);
  if (!f.ok) return f;
  const r = await retirerTacheDeSortie(user.id, tacheId!);
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  return { ok: true };
}

/** TRANSFÉRER ses tâches (ou sujets) ouverts à son supérieur hiérarchique. */
export async function transfererLigneDeSortie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const tacheId = fdStr(formData, "tacheId");
  const f = await ficheDeLaTache(user, tacheId);
  if (!f.ok) return f;
  const r = await transfererAuRepreneur(user.id, tacheId!);
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  revalidatePath("/mon-espace");
  return { ok: true, message: r.message };
}

// ─────────────────────────────── Solde et certificat ───────────────────────────────

/** ENREGISTRER LE SOLDE DE TOUT COMPTE (les lignes relues par les RH). Réservé à qui voit les salaires. */
export async function enregistrerSoldeDeToutCompte(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const departId = fdStr(formData, "departId");
  const f = await ficheDuDepart(user, departId);
  if (!f.ok) return f;
  if (!voitLesSalaires(user)) return { ok: false, error: "Le solde de tout compte porte des montants de paie : il est réservé à qui voit les salaires (RH)." };
  let brut: unknown = null;
  try { brut = JSON.parse(fdStr(formData, "lignes") ?? "null"); } catch { brut = null; }
  const lu = lireSoldeSaisi(brut);
  if (!lu.ok) return { ok: false, error: lu.refus };
  const r = await enregistrerSolde(user.id, departId!, lu.lignes);
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  return { ok: true, message: "Solde de tout compte enregistré." };
}

function lireChampsCertificat(formData: FormData) {
  let brut: unknown = null;
  try { brut = JSON.parse(fdStr(formData, "champs") ?? "null"); } catch { brut = null; }
  return lireCertificatSaisi(brut);
}

/** ENREGISTRER LE BROUILLON du certificat de travail (sans l'émettre). */
export async function enregistrerCertificatDeTravail(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const departId = fdStr(formData, "departId");
  const f = await ficheDuDepart(user, departId);
  if (!f.ok) return f;
  const champs = lireChampsCertificat(formData);
  if (!champs) return { ok: false, error: "Le certificat est illisible : rechargez la fiche." };
  const r = await enregistrerCertificat(user.id, departId!, champs);
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  return { ok: true, message: "Brouillon du certificat enregistré." };
}

/** ÉMETTRE le certificat de travail : Word + PDF au dossier RH, le PDF remis au salarié. */
export async function genererCertificatDeTravail(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const departId = fdStr(formData, "departId");
  const f = await ficheDuDepart(user, departId);
  if (!f.ok) return f;
  const champs = lireChampsCertificat(formData);
  if (!champs) return { ok: false, error: "Le certificat est illisible : rechargez la fiche." };
  const r = await emettreCertificat(user.id, departId!, champs);
  if (!r.ok) return r;
  rafraichir(f.employeeId);
  revalidatePath("/mon-dossier");
  return { ok: true, message: r.message };
}
