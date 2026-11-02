import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { sansBloquer } from "@/lib/journal";
import { profilDocumentaire } from "@/platform/ia/artifact/factory/profil";
import { prenomDe, type CharteMail, type SignatureMail } from "../../domaine/mails/gabarit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QU'IL FAUT POUR UN BEAU MAIL, SANS QUESTION (lot P1, décision 0047) — Direction, 02/11 : « il ne faut pas qu'il
 * pose tellement de questions pour faire un mail ».
 *
 *   • les DESTINATAIRES : une adresse est prise telle quelle ; un NOM se résout par l'annuaire (comptes actifs, puis
 *     fiches salariés) — une question SEULEMENT si deux personnes portent ce nom, ou si personne ne le porte ;
 *   • la SIGNATURE : la personne qui envoie via Adam — son nom, sa fonction et sa société (fiche salarié), ses
 *     coordonnées ;
 *   • la CHARTE : le registre de marque de la société d'envoi (couleur, police, coordonnées, mentions) — celle que
 *     la demande nomme, sinon la société de la personne ; jamais une question pour ça : à défaut, la charte de la maison.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Destinataire { email: string; nom: string | null; prenom: string | null }
export type Resolution = { ok: true; destinataire: Destinataire } | { ok: false; ambigu: string[] } | { ok: false; inconnu: string };

const ADRESSE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const plier = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** UN DESTINATAIRE par son adresse ou son nom (annuaire) — l'ambiguïté est NOMMÉE, jamais tranchée au hasard. */
export async function resoudreDestinataire(qui: string): Promise<Resolution> {
  const q = qui.trim().replace(/^<|>$/g, "");
  if (ADRESSE.test(q)) {
    const u = await prisma.user.findFirst({ where: { email: { equals: q, mode: "insensitive" } }, select: { name: true } });
    return { ok: true, destinataire: { email: q.toLowerCase(), nom: u?.name ?? null, prenom: u?.name ? prenomDe(u.name) : null } };
  }
  const mots = plier(q).split(/\s+/).filter((m) => m.length >= 2);
  if (!mots.length) return { ok: false, inconnu: qui };
  const comptes = await prisma.user.findMany({ where: { isActive: true, AND: mots.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) }, select: { name: true, email: true }, take: 6 });
  const exacts = comptes.filter((c) => plier(c.name) === plier(q));
  const retenus = exacts.length ? exacts : comptes;
  if (retenus.length === 1) return { ok: true, destinataire: { email: retenus[0]!.email.toLowerCase(), nom: retenus[0]!.name, prenom: prenomDe(retenus[0]!.name) } };
  if (retenus.length > 1) return { ok: false, ambigu: retenus.map((c) => `${c.name} <${c.email}>`) };
  // Les fiches salariés portent une adresse quand le compte n'existe pas (encore).
  const fiches = await prisma.employee.findMany({ where: { isActive: true, email: { not: null }, AND: mots.map((m) => ({ fullName: { contains: m, mode: "insensitive" as const } })) }, select: { fullName: true, email: true }, take: 4 })
    .catch(sansBloquer("mails.destinataire.fiches", [] as { fullName: string; email: string | null }[]));
  if (fiches.length === 1 && fiches[0]!.email) return { ok: true, destinataire: { email: fiches[0]!.email.toLowerCase(), nom: fiches[0]!.fullName, prenom: prenomDe(fiches[0]!.fullName) } };
  if (fiches.length > 1) return { ok: false, ambigu: fiches.map((f) => `${f.fullName} <${f.email}>`) };
  return { ok: false, inconnu: qui };
}

/** LA SIGNATURE de la personne qui envoie via Adam. */
export async function signatureDe(user: CurrentUser): Promise<SignatureMail & { societeId: string | null }> {
  const fiche = await prisma.employee.findFirst({ where: { userId: user.id }, select: { position: true, phone: true, company: { select: { id: true, name: true } } } })
    .catch(sansBloquer("mails.signature", null));
  return {
    nom: user.name ?? user.email ?? "", fonction: fiche?.position ?? null,
    societe: fiche?.company?.name ?? "Adventum Pharma", societeId: fiche?.company?.id ?? null,
    telephone: fiche?.phone ?? null, email: user.email ?? null,
  };
}

/** LA CHARTE de la société d'envoi — nommée, sinon celle de la personne ; à défaut, la charte de la maison (sans question). */
export async function charteDuMail(user: CurrentUser, societe: string | null, signature: { societe: string; societeId: string | null }): Promise<CharteMail> {
  for (const essai of [societe, signature.societeId, signature.societe].filter((x): x is string => !!x)) {
    const r = await profilDocumentaire(user, essai).catch(sansBloquer("mails.charte", null));
    if (r && r.ok) {
      const { profil } = r;
      const c = profil.marque.coordonnees;
      const coord = [c.adresse ?? profil.identite.adresse, [c.telephone ?? profil.identite.telephone, c.email ?? profil.identite.email, c.siteWeb].filter(Boolean).join(" · ")]
        .filter((x): x is string => !!x && x.trim().length > 0);
      return { societe: profil.societe.nom, accent: profil.charte.accent, texteSurAccent: profil.charte.texteSurAccent, police: profil.charte.policeTexte, coordonnees: coord, mentions: profil.marque.mentionsLegales.slice(0, 3) };
    }
  }
  return { societe: signature.societe, accent: "087084", texteSurAccent: "FFFFFF", police: "Calibri", coordonnees: [], mentions: [] };
}
