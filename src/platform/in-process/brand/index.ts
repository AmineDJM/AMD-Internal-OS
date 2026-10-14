/**
 * LE REGISTRE DE MARQUE, côté plateforme (mandat 4 §26) — lire et régler la charte d'une société,
 * déposer son logo, et la rendre à la fabrique pour qu'elle l'applique d'elle-même.
 *
 * Où vit la marque : dans `CompanyDocumentProfile.settings.marque` — le profil documentaire EST
 * la fondation du registre (README), et son `settings` a été prévu « extensible sans migration
 * (marque, polices, mentions) ». Une société = un profil = une marque. Qui la règle : ceux qui
 * tiennent la papeterie (`canManageLetterheads`), comme le profil — une erreur ici part sur
 * toutes les pièces suivantes. Qui la lit : qui voit la société (`resoudreSociete`).
 *
 * Le logo est un FICHIER (PNG ou JPEG, 2 Mo au plus) déposé par une action serveur : jamais une
 * chaîne tapée dans la conversation — un modèle ne fabrique pas une image de marque.
 */

import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getBlob, putBlob } from "@/lib/drive-storage";
import { canManageLetterheads } from "@/lib/office/letterhead";
import { hasGlobalView } from "@/lib/rbac";
import { peutGererDirectionArtistique } from "@/lib/direction-artistique/droits";
import type { CurrentUser } from "@/lib/session";
import { resoudreSociete, type EchecFabrique } from "@/platform/in-process/artifact/factory";
import { charteDe, lireMarque, mentionsDe, resumerMarque, validerMarque, type Charte, type Marque } from "@/lib/brand/model";

export { charteDe, lireMarque, mentionsDe, resumerMarque, signatairePour, validerMarque, MARQUE_VIDE, POLICES_SURES, TYPES_PIECE, LIBELLE_TYPE_PIECE, type Charte, type Marque, type TypePiece } from "@/lib/brand/model";

/**
 * QUI RÈGLE LA MARQUE : la Direction (vue globale — c'est elle qui décide de la charte) et ceux qui
 * tiennent la papeterie (assistante de direction, Super Admin — c'est eux qui l'exécutent). Le banc
 * l'a montré : le PDG qui dit « règle la charte d'Adventum » ne peut pas être renvoyé vers son
 * assistante ; la charte est une décision de direction, pas un geste de papeterie. Et quiconque
 * tient la « Direction artistique » (module ouvert par la console à une personne) : la charte de
 * l'entité s'y règle (Transverse › Direction artistique).
 */
export const peutReglerMarque = (user: { role: string; secondaryRole?: string | null; access?: CurrentUser["access"] }): boolean => canManageLetterheads(user) || hasGlobalView(user as never) || peutGererDirectionArtistique(user, "UPDATE");

export const LOGO_TAILLE_MAX = 2 * 1024 * 1024;
export const LOGO_MIMES = new Set(["image/png", "image/jpeg"]);

export interface MarqueLue {
  societe: { id: string; nom: string; couleur: string | null };
  marque: Marque;
  charte: Charte;
  resume: string;
  /** Vrai quand la personne peut la RÉGLER (pas seulement la lire). */
  modifiable: boolean;
}

const echec = (e: EchecFabrique["echec"], motif: string): EchecFabrique => ({ ok: false, echec: e, motif });

async function reglagesDe(companyId: string): Promise<Record<string, unknown>> {
  const p = await prisma.companyDocumentProfile.findUnique({ where: { companyId }, select: { settings: true } });
  const s = p?.settings;
  return s && typeof s === "object" && !Array.isArray(s) ? { ...(s as Record<string, unknown>) } : {};
}

/** LIRE la marque d'une société — qui la voit peut la lire. */
export async function marqueDe(user: CurrentUser, societe?: string | null): Promise<{ ok: true; lue: MarqueLue } | EchecFabrique> {
  const r = await resoudreSociete(user.id, societe);
  if (!r.ok) return r;
  const s = r.societe;
  const marque = lireMarque(await reglagesDe(s.id));
  const charte = charteDe(marque);
  return { ok: true, lue: { societe: { id: s.id, nom: s.name, couleur: s.color }, marque, charte, resume: resumerMarque(marque, charte), modifiable: peutReglerMarque(user) } };
}

/** La marque et la charte par IDENTIFIANT de société — pour la fabrique, qui a déjà résolu la société. */
export async function marqueEtCharte(companyId: string): Promise<{ marque: Marque; charte: Charte }> {
  const marque = lireMarque(await reglagesDe(companyId));
  return { marque, charte: charteDe(marque) };
}

/** RÉGLER la marque — modification partielle, refus nommés, audit au nom de la personne. */
export async function definirMarque(
  user: CurrentUser, opts: { societe?: string | null; modification: unknown },
): Promise<{ ok: true; lue: MarqueLue; refus: string[]; champsModifies: string[] } | EchecFabrique> {
  if (!peutReglerMarque(user)) return echec("MISSING_PERMISSION", "La marque d'une société se règle par la Direction ou par ceux qui tiennent sa papeterie (assistante de direction, Super Admin).");
  const r = await resoudreSociete(user.id, opts.societe);
  if (!r.ok) return r;
  const s = r.societe;
  const settings = await reglagesDe(s.id);
  const existante = lireMarque(settings);
  const v = validerMarque(existante, opts.modification);
  if (v.champsModifies.length === 0) {
    const lue = await marqueDe(user, s.id);
    if (!lue.ok) return lue;
    return { ok: true, lue: lue.lue, refus: v.refus.length ? v.refus : ["aucun champ à modifier"], champsModifies: [] };
  }
  const marque: Marque = { ...v.marque, logo: existante.logo };
  await prisma.companyDocumentProfile.upsert({
    where: { companyId: s.id },
    create: { companyId: s.id, settings: { ...settings, marque } as object, updatedById: user.id },
    update: { settings: { ...settings, marque } as object, updatedById: user.id },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Legal", entityType: "COMPANY", entityId: s.id, summary: `Registre de marque de ${s.name} réglé : ${v.champsModifies.join(", ")}` });
  const lue = await marqueDe(user, s.id);
  if (!lue.ok) return lue;
  return { ok: true, lue: lue.lue, refus: v.refus, champsModifies: v.champsModifies };
}

/** DÉPOSER (ou retirer) le logo — un fichier image, borné, chiffré dans le stockage du Drive. */
export async function definirLogo(
  user: CurrentUser, opts: { societe?: string | null; fichier: { nom: string; mime: string; octets: Buffer; largeurCm?: number } | null },
): Promise<{ ok: true; lue: MarqueLue } | EchecFabrique> {
  if (!peutReglerMarque(user)) return echec("MISSING_PERMISSION", "Le logo d'une société se dépose par la Direction ou par ceux qui tiennent sa papeterie.");
  const r = await resoudreSociete(user.id, opts.societe);
  if (!r.ok) return r;
  const s = r.societe;
  const settings = await reglagesDe(s.id);
  const existante = lireMarque(settings);
  let logo: Marque["logo"] = null;
  if (opts.fichier) {
    const f = opts.fichier;
    if (!LOGO_MIMES.has(f.mime)) return echec("MISSING_INPUT", `Le logo doit être un PNG ou un JPEG (reçu : ${f.mime || "type inconnu"}). Un SVG ne s'insère pas dans Word sans conversion.`);
    if (f.octets.length === 0) return echec("MISSING_INPUT", "Fichier vide.");
    if (f.octets.length > LOGO_TAILLE_MAX) return echec("MISSING_INPUT", `Logo trop lourd (${Math.round(f.octets.length / 1024)} Ko) : 2 Mo au plus.`);
    const png = f.octets.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = f.octets[0] === 0xff && f.octets[1] === 0xd8;
    if (!(png || jpeg)) return echec("MISSING_INPUT", "Le contenu du fichier n'est ni un PNG ni un JPEG : le type déclaré ne correspond pas aux octets.");
    const blob = await putBlob(f.octets);
    const largeurCm = typeof f.largeurCm === "number" && f.largeurCm >= 1 && f.largeurCm <= 8 ? f.largeurCm : 4;
    logo = { blobId: blob.blobId, nom: f.nom.trim().slice(0, 120) || "logo", mime: png ? "image/png" : "image/jpeg", taille: f.octets.length, largeurCm };
  }
  const marque: Marque = { ...existante, logo, misAJourLe: new Date().toISOString() };
  await prisma.companyDocumentProfile.upsert({
    where: { companyId: s.id },
    create: { companyId: s.id, settings: { ...settings, marque } as object, updatedById: user.id },
    update: { settings: { ...settings, marque } as object, updatedById: user.id },
  });
  await recordAudit({ actorId: user.id, action: logo ? "UPLOAD" : "UPDATE", module: "Legal", entityType: "COMPANY", entityId: s.id, summary: logo ? `Logo de ${s.name} déposé (${logo.nom}, ${Math.round(logo.taille / 1024)} Ko)` : `Logo de ${s.name} retiré` });
  const lue = await marqueDe(user, s.id);
  if (!lue.ok) return lue;
  return { ok: true, lue: lue.lue };
}

/** LES OCTETS DU LOGO — pour la fabrique (en-tête d'une pièce sans papier) et l'aperçu de l'écran. */
export async function logoOctets(marque: Marque): Promise<{ png: boolean; octets: Buffer; largeurCm: number } | null> {
  if (!marque.logo) return null;
  const octets = await getBlob(marque.logo.blobId).catch(() => null);
  if (!octets || octets.length === 0) return null;
  return { png: marque.logo.mime === "image/png", octets: Buffer.from(octets), largeurCm: marque.logo.largeurCm };
}
