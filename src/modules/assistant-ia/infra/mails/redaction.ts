import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { sansBloquer } from "@/lib/journal";
import { profilDocumentaire } from "@/platform/ia/artifact/factory/profil";
import { htmlToText, sanitizeMailHtml } from "@/platform/mail/assainir";
import { apercuTexte, composerMail, prenomDe, toutALaCharte, type CharteMail, type DocumentMail, type SignatureMail } from "../../domaine/mails/composer";
import { mailEnBlocsActif } from "../observation/interrupteurs";

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

/**
 * P1 bis (banc d'audit Q1 ML-04) : un GROUPE nommé — « toute la direction », « le comité de direction », « le codir » — se
 * résout par l'annuaire : les comptes ACTIFS de la Direction (Directeur général, Direction, Super Admin — le PDG). Sans question ; la carte les
 * nomme un à un, la personne retire qui elle veut. `null` : ce n'est pas un groupe connu.
 */
const GROUPE_DIRECTION = /^(a |pour )?(toute |tous |toutes )?(la |les |le )?(direction|directeurs?|membres? de la direction|comite de direction|codir)( generale)?$/;
export async function groupeDestinataires(qui: string): Promise<Destinataire[] | null> {
  if (!GROUPE_DIRECTION.test(plier(qui).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim())) return null;
  const membres = await prisma.user.findMany({
    // Le PDG est Super Admin : la Direction, c'est le Directeur général, les comptes Direction et le Super Admin.
    where: { isActive: true, role: { in: ["GENERAL_MANAGER", "DIRECTION", "SUPER_ADMIN"] as never[] } },
    select: { name: true, email: true }, orderBy: { name: "asc" }, take: 20,
  });
  return membres.map((m) => ({ email: m.email.toLowerCase(), nom: m.name, prenom: prenomDe(m.name) }));
}

/**
 * P1 bis (rédaction de mails, pièce jointe de l'ERP) : les PIÈCES à joindre — des fichiers du Drive DONT LA PERSONNE EST
 * PROPRIÉTAIRE (un BC, une facture, une attestation déjà déposés), désignés par leur nom. Une référence, jamais des
 * octets : le transport relit le fichier au départ. Introuvable ou ambigu : NOMMÉ (une question), jamais deviné.
 */
export interface PieceJointe { driveNodeId: string; filename: string; mimeType: string | null; sizeBytes: number }
export async function piecesDuDrive(user: CurrentUser, noms: readonly string[]): Promise<{ ok: true; pieces: PieceJointe[] } | { ok: false; manque: string[] }> {
  const pieces: PieceJointe[] = [];
  for (const nom of noms.map((n) => n.trim()).filter(Boolean).slice(0, 5)) {
    const trouves = await prisma.driveNode.findMany({
      where: { ownerId: user.id, type: "FILE", isTrashed: false, name: { contains: nom, mode: "insensitive" } },
      select: { id: true, name: true, mimeType: true, size: true }, orderBy: { updatedAt: "desc" }, take: 6,
    });
    const exacts = trouves.filter((f) => plier(f.name) === plier(nom) || plier(f.name.replace(/\.[a-z0-9]+$/i, "")) === plier(nom));
    const un = exacts.length === 1 ? exacts[0] : trouves.length === 1 ? trouves[0] : null;
    if (!un) return { ok: false, manque: [trouves.length ? `quel fichier joindre pour « ${nom} » : ${trouves.map((f) => f.name).join(", ")}` : `le fichier « ${nom} » (introuvable dans ton Drive : dépose-le, ou donne son nom exact)`] };
    if (!pieces.some((x) => x.driveNodeId === un.id)) pieces.push({ driveNodeId: un.id, filename: un.name, mimeType: un.mimeType, sizeBytes: Math.round(un.size) });
  }
  return { ok: true, pieces };
}

/** LA SIGNATURE de la personne qui envoie. */
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

/** Un mail rendu : ce qui partira (HTML assaini, ou aucun), son texte, et l'aperçu que la carte montre. */
export interface MailRendu { html: string | null; texte: string; apercu: string }

/**
 * RENDRE UN MAIL — LE seul chemin (lot I1, étape 5) : le document de blocs composé (`composerMail`), TOUT son corps passé
 * par la liste blanche du serveur (`sanitizeMailHtml` avec styles en ligne filtrés). `texteSeul` : la boîte n'envoie que
 * du texte (SMTP, envoi de l'ERP) — le HTML n'existe pas, et l'observation le dira. Interrupteur `ADAM_MAIL_BLOCS=0` :
 * tout mail repart à la charte, comme avant le lot.
 */
export function rendreLeMail(d: DocumentMail, signature: SignatureMail, charte: CharteMail, objet: string, opts: { texteSeul?: boolean } = {}): MailRendu {
  const doc: DocumentMail = mailEnBlocsActif() ? d : toutALaCharte(d);
  const m = composerMail(opts.texteSeul ? { ...doc, style: "texte" } : doc, signature, charte, objet, {
    assainir: (html) => sanitizeMailHtml(html, { styles: true }),
    versTexte: (html) => htmlToText(sanitizeMailHtml(html)),
  });
  return { html: m.html, texte: m.texte, apercu: m.html ?? apercuTexte(m.texte) };
}
