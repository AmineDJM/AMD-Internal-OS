import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { openSecret, sealSecret } from "@/lib/crypto/secret-box";
import { notifyRoles } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { SortieInterdite } from "@/lib/sortie/garde";
import {
  empreinteCle, lireConfiguration, normaliserBase,
  type IdentifiantsStockes, type LectureConfiguration,
} from "./config";
import type { ReponseSite, TransportSite } from "./transport";
import { ECRAN_LIAISON } from "./ecran";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CLÉS DE LA LIAISON, FABRIQUÉES PAR L'ERP (§118.159).
 *
 * Le contrat du site demandait à une personne de lancer `openssl rand -hex 32`, puis de poser la
 * valeur DES DEUX CÔTÉS. C'est exactement ce que le dirigeant a refusé de faire, et à juste titre :
 * une personne qui n'est pas développeur ne sait ni lancer la commande, ni reconnaître une valeur
 * tronquée au collage — et une erreur de recopie coupe la publication sans rien dire d'utile.
 *
 * ── CE QUI RESTE À FAIRE À LA MAIN, ET POURQUOI ─────────────────────────────────────────
 *
 * UN collage : le bloc que cet écran montre, dans l'environnement du SITE (Render). Il ne peut pas
 * disparaître : le site doit apprendre la clé par un canal que personne d'autre ne contrôle, et le
 * seul qui existe est son hébergeur. Tout le reste — fabriquer, sceller, reconnaître que le site a
 * la clé, basculer dessus, retirer l'ancienne — est fait ici.
 *
 * ── LA ROTATION NE COUPE RIEN ───────────────────────────────────────────────────────────
 *
 * Une clé naît EN ATTENTE. L'ERP continue de publier avec l'ancienne (ou l'environnement) et
 * PRÉSENTE la nouvelle au site (`GET /health`) à un rythme dégressif. Dès que le site la reconnaît
 * — ou qu'il s'en sert lui-même pour appeler l'ERP —, elle devient ACTIVE et l'ancienne est retirée
 * dans la même transaction. Jamais de fenêtre où l'ERP publie avec une clé que le site n'a pas.
 *
 * ── CE QUI SE MONTRE, ET QUAND ──────────────────────────────────────────────────────────
 *
 * Une clé EN ATTENTE se remontre au Super Admin : elle ne publie encore rien, et la perdre avant de
 * l'avoir collée ne doit pas obliger à tout recommencer. Une clé ACTIVE ne se montre PLUS JAMAIS :
 * elle publie sur le site public ; qui la veut de nouveau en génère une autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ATTENTE = "ATTENTE";
export const ACTIVE = "ACTIVE";
export const RETIREE = "RETIREE";

/** 32 octets aléatoires en hexadécimal — ce que le contrat demande (`openssl rand -hex 32`), sans commande. */
export function nouvelleValeur(): string {
  return randomBytes(32).toString("hex");
}

/**
 * LE RYTHME DE PRÉSENTATION d'une clé en attente — dégressif, et c'est ce qui le rend sûr :
 *
 *   • la première demi-heure, CHAQUE MINUTE : la personne vient de coller le bloc, le site
 *     redémarre en deux ou trois minutes, et elle attend de voir « Relié » ;
 *   • ensuite, toutes les dix minutes jusqu'à un jour ;
 *   • au-delà, une fois l'heure.
 *
 * Chaque présentation RÉVEILLE un site en plan gratuit (il s'endort après quinze minutes sans
 * visite). Présenter chaque minute une clé que personne ne collera jamais le garderait éveillé en
 * permanence et consommerait les heures gratuites de tout le compte Render — le jour où elles
 * manquent, c'est le site public qui s'éteint.
 */
export function prochainePresentation(creeLe: Date, maintenant: Date): Date {
  const age = maintenant.getTime() - creeLe.getTime();
  const pas = age < 30 * 60_000 ? 60_000 : age < 24 * 3_600_000 ? 10 * 60_000 : 3_600_000;
  return new Date(maintenant.getTime() + pas);
}

/**
 * LE BLOC À COLLER dans l'environnement du site (Render → Environment → « Add from .env »).
 * `ERP_BASE_URL` dit au site où joindre l'ERP : c'est par là que partent les candidatures et que
 * le site retrouve ses contenus après un redémarrage. Sans adresse lisible, la ligne est omise et
 * l'écran le dit — une adresse inventée ferait partir les candidatures ailleurs.
 */
export function blocEnvironnement(p: { cle: string; secret: string; erp: string | null }): string {
  return [`ERP_API_KEY=${p.cle}`, `ERP_WEBHOOK_SECRET=${p.secret}`, p.erp ? `ERP_BASE_URL=${p.erp}` : null]
    .filter((l): l is string => l !== null)
    .join("\n");
}

/**
 * L'ADRESSE PUBLIQUE DE L'ERP, telle que le site doit l'appeler. Dans l'ordre : celle que
 * l'exploitation a fixée (`APP_URL`), celle par laquelle le Super Admin est RÉELLEMENT arrivé (il
 * est devant l'écran : c'est une adresse qui marche), puis celle que Render annonce. Jamais une
 * adresse en clair hors d'un poste local : la clé partirait avec chaque candidature.
 */
export function origineDeLERP(env: NodeJS.ProcessEnv, requete: { hote: string | null; proto: string | null }): string | null {
  const candidates = [
    env.APP_URL,
    requete.hote ? `${requete.proto === "http" ? "http" : "https"}://${requete.hote}` : null,
    env.RENDER_EXTERNAL_URL,
    env.AUTH_URL,
    env.NEXTAUTH_URL,
  ];
  for (const c of candidates) {
    if (!c || !c.trim()) continue;
    try {
      const u = new URL(c.trim());
      const n = normaliserBase(`${u.protocol}//${u.host}`);
      if (n.ok) return n.racine;
    } catch {
      /* suivante */
    }
  }
  return null;
}

// ───────────────────────────── Lire ─────────────────────────────

type LigneCle = {
  id: string; etat: string; cle: string; secret: string; empreinte: string; creeLe: Date; creeParId: string | null;
  prochaineVerification: Date; derniereVerification: Date | null; dernierConstat: string | null; activeeLe: Date | null;
};

const SELECTION = {
  id: true, etat: true, cle: true, secret: true, empreinte: true, creeLe: true, creeParId: true,
  prochaineVerification: true, derniereVerification: true, dernierConstat: true, activeeLe: true,
} as const;

export interface CleOuverte extends IdentifiantsStockes {
  secret: string;
  etat: string;
  creeLe: Date;
  creeParId: string | null;
  prochaineVerification: Date;
  derniereVerification: Date | null;
  dernierConstat: string | null;
  activeeLe: Date | null;
}

/**
 * Ouvre une ligne. Rend `null` si le sceau ne s'ouvre plus (clé maîtresse du serveur changée,
 * colonne abîmée) — et le DIT : une clé illisible se remplace, elle ne doit pas faire croire
 * que le site n'a jamais été relié.
 */
function ouvrir(l: LigneCle | null): CleOuverte | null {
  if (!l) return null;
  const cle = openSecret(l.cle);
  const secret = openSecret(l.secret);
  if (!cle || !secret) {
    console.error(`[site-web] clé de liaison ${l.id} (${l.etat}) illisible : le sceau ne s'ouvre plus — générez-en une nouvelle.`);
    return null;
  }
  return {
    id: l.id, cle, secret, empreinte: l.empreinte, etat: l.etat, creeLe: l.creeLe, creeParId: l.creeParId,
    prochaineVerification: l.prochaineVerification, derniereVerification: l.derniereVerification,
    dernierConstat: l.dernierConstat, activeeLe: l.activeeLe,
  };
}

export async function cleActive(): Promise<CleOuverte | null> {
  const l = await prisma.siteWebCle.findFirst({ where: { etat: ACTIVE }, select: SELECTION }).catch(sansBloquer("cles.cleActive.siteWebCle", null));
  return ouvrir(l);
}

export async function cleEnAttente(): Promise<CleOuverte | null> {
  const l = await prisma.siteWebCle.findFirst({ where: { etat: ATTENTE }, select: SELECTION }).catch(sansBloquer("cles.cleEnAttente.siteWebCle", null));
  return ouvrir(l);
}

/** Une ligne existe-t-elle sans que son sceau s'ouvre ? L'écran le dit, au lieu de « jamais relié ». */
export async function clesIllisibles(): Promise<string[]> {
  const lignes = await prisma.siteWebCle.findMany({ where: { etat: { in: [ACTIVE, ATTENTE] } }, select: SELECTION }).catch(sansBloquer("cles.clesIllisibles.siteWebCle", []));
  return lignes.filter((l) => ouvrir(l) === null).map((l) => l.etat);
}

/**
 * LA CONFIGURATION EN VIGUEUR — l'adresse, et la clé ACTIVE de l'ERP si elle existe, sinon celle
 * de l'environnement. C'est la lecture que tout le module emploie : la file, le transport, la
 * réconciliation et les écrans disent la même chose de la même liaison (§118.5).
 */
export async function configurationEnVigueur(env: NodeJS.ProcessEnv = process.env): Promise<LectureConfiguration> {
  return lireConfiguration(env, await cleActive());
}

// ───────────────────────────── Générer ─────────────────────────────

export interface CleGeneree { id: string; cle: string; secret: string; empreinte: string }

/**
 * GÉNÈRE une clé et son secret de signature, EN ATTENTE. Une clé en attente plus ancienne est
 * retirée : il n'y a qu'un bloc à coller, et deux clés « en attente » feraient coller la mauvaise.
 * L'active, elle, reste active — c'est ce qui rend la rotation sans coupure.
 */
export async function genererCle(parId: string | null, maintenant: Date = new Date()): Promise<CleGeneree> {
  const cle = nouvelleValeur();
  const secret = nouvelleValeur();
  const empreinte = empreinteCle(cle);
  const ligne = await prisma.$transaction(async (tx) => {
    await tx.siteWebCle.updateMany({ where: { etat: ATTENTE }, data: { etat: RETIREE, retireeLe: maintenant } });
    return tx.siteWebCle.create({
      data: {
        etat: ATTENTE, cle: sealSecret(cle), secret: sealSecret(secret), empreinte, creeParId: parId,
        creeLe: maintenant, prochaineVerification: maintenant,
      },
      select: { id: true },
    });
  });
  await recordAudit({
    actorId: parId, action: "CREATE", module: "Site web",
    summary: `Clé de liaison au site générée (empreinte ${empreinte}) — en attente que le site la reconnaisse`,
  });
  return { id: ligne.id, cle, secret, empreinte };
}

/** ABANDONNE la clé en attente (collée nulle part, ou montrée à la mauvaise personne). L'active ne bouge pas. */
export async function abandonnerCleEnAttente(parId: string | null, maintenant: Date = new Date()): Promise<boolean> {
  const r = await prisma.siteWebCle.updateMany({ where: { etat: ATTENTE }, data: { etat: RETIREE, retireeLe: maintenant } });
  if (r.count) await recordAudit({ actorId: parId, action: "UPDATE", module: "Site web", summary: "Clé de liaison en attente abandonnée" });
  return r.count > 0;
}

// ───────────────────────────── Promouvoir ─────────────────────────────

/**
 * PROMEUT une clé en attente : l'active est retirée, celle-ci devient active — dans UNE
 * transaction, et à une condition : qu'elle soit toujours en attente. Deux promotions concurrentes
 * (le battement et une candidature qui arrive avec la nouvelle clé) ne font qu'une ; la perdante
 * est annulée entière, retrait compris.
 *
 * Rend `true` si ELLE a promu. L'appelant réveille la file : ce module ne connaît pas la file.
 */
export async function promouvoir(id: string, pourquoi: string, maintenant: Date = new Date()): Promise<boolean> {
  let promue = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.siteWebCle.updateMany({ where: { etat: ACTIVE, NOT: { id } }, data: { etat: RETIREE, retireeLe: maintenant } });
      const r = await tx.siteWebCle.updateMany({
        where: { id, etat: ATTENTE },
        data: { etat: ACTIVE, activeeLe: maintenant, derniereVerification: maintenant, dernierConstat: pourquoi.slice(0, 500) },
      });
      if (r.count !== 1) throw new PromotionPerdue();
    });
    promue = true;
  } catch (e) {
    if (!(e instanceof PromotionPerdue)) throw e;
  }
  if (!promue) return false;
  const l = await prisma.siteWebCle.findUnique({ where: { id }, select: { empreinte: true, creeParId: true } });
  await recordAudit({
    actorId: null, action: "UPDATE", module: "Site web",
    summary: `Liaison au site : la clé ${l?.empreinte ?? id} est désormais active (${pourquoi})`,
  });
  await notifyRoles(["SUPER_ADMIN"], {
    type: "GENERIC",
    title: "Site web relié",
    body: `Le site a reconnu la nouvelle clé (${pourquoi}). Les publications partent avec elle ; l'ancienne ne sert plus.`,
    link: ECRAN_LIAISON.href,
  });
  return true;
}

class PromotionPerdue extends Error {}

// ───────────────────────────── Présenter la clé en attente ─────────────────────────────

export type IssuePresentation = "AUCUNE" | "PAS_DUE" | "PROMUE" | "PAS_ENCORE" | "INJOIGNABLE" | "LOCAL";

export interface Presentation { issue: IssuePresentation; message: string }

function lireJson(texte: string | null): Record<string, unknown> | null {
  if (!texte) return null;
  try {
    const j = JSON.parse(texte) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * CE QUE LE SITE A RÉPONDU, dit à une personne qui n'est pas développeur — avec le geste qui
 * répare. Le site rend 503 « ERP_API_KEY is not set » tant qu'il n'a aucune clé, 401 quand il en
 * a une autre (contrat §6 et `lib/api-auth.ts` du site).
 */
export function constatDuSite(rep: Pick<ReponseSite, "statut" | "texte" | "erreur" | "location">): { reconnue: boolean; phrase: string } {
  if (rep.statut === null) return { reconnue: false, phrase: `Site injoignable pour l'instant (${rep.erreur ?? "aucune réponse"}) — nouvel essai automatique.` };
  const j = lireJson(rep.texte);
  if (rep.statut === 200 && j?.authenticated === true) return { reconnue: true, phrase: "Le site reconnaît la clé." };
  if (rep.statut === 503 || (rep.statut === 200 && j?.configured === false)) {
    return { reconnue: false, phrase: "Le site n'a encore aucune clé : collez le bloc dans l'environnement du site (Render), puis enregistrez." };
  }
  if (rep.statut === 401) {
    // Le site vérifie la clé AVANT la signature (`lib/api-auth.ts`) : un refus de SIGNATURE dit
    // donc qu'il a bien CETTE clé, mais un autre secret — presque toujours un bloc collé en partie.
    if (/signature/i.test(String(j?.error ?? ""))) {
      return { reconnue: false, phrase: "Le site a bien la clé, mais pas le secret de signature qui va avec : collez le bloc ENTIER (les trois lignes) dans l'environnement du site." };
    }
    return { reconnue: false, phrase: "Le site a une clé, mais pas celle-ci : collez le bloc affiché ICI (une clé plus ancienne a peut-être été collée)." };
  }
  if (rep.statut >= 300 && rep.statut < 400) {
    return { reconnue: false, phrase: `Le site redirige (${rep.statut}${rep.location ? ` vers ${rep.location}` : ""}) : l'adresse du site n'est pas la bonne.` };
  }
  return { reconnue: false, phrase: `Réponse inattendue du site (${rep.statut}).` };
}

/**
 * PRÉSENTE LA CLÉ EN ATTENTE au site (`GET /health`) et la promeut s'il la reconnaît. Le transport
 * est passé par l'appelant : ce module ne l'importe pas (la file et le battement ont chacun le leur).
 * `force` ignore le rythme — un clic « Vérifier maintenant », ou un 401 sur l'ancienne clé.
 */
export async function presenterCleEnAttente(
  transport: TransportSite,
  opts: { maintenant?: Date; force?: boolean } = {},
): Promise<Presentation> {
  const maintenant = opts.maintenant ?? new Date();
  const attente = await cleEnAttente();
  if (!attente) return { issue: "AUCUNE", message: "Aucune clé en attente." };
  if (!opts.force && attente.prochaineVerification.getTime() > maintenant.getTime()) {
    return { issue: "PAS_DUE", message: attente.dernierConstat ?? "En attente du site." };
  }
  let rep: ReponseSite;
  try {
    rep = await transport({ methode: "GET", chemin: "/health", identifiants: { cle: attente.cle, secret: attente.secret } });
  } catch (e) {
    if (e instanceof SortieInterdite) return { issue: "LOCAL", message: "Sortie interdite dans ce processus (test ou banc) : le site n'a pas été interrogé." };
    rep = { statut: null, texte: null, erreur: e instanceof Error ? e.message : String(e), ms: 0, retryAfterS: null, location: null };
  }
  const c = constatDuSite(rep);
  if (c.reconnue && (await promouvoir(attente.id, "reconnue par le site", maintenant))) {
    return { issue: "PROMUE", message: "Relié : le site a reconnu la clé. Les publications partent avec elle." };
  }
  await prisma.siteWebCle.updateMany({
    where: { id: attente.id, etat: ATTENTE },
    data: { derniereVerification: maintenant, dernierConstat: c.phrase.slice(0, 500), prochaineVerification: prochainePresentation(attente.creeLe, maintenant) },
  });
  return { issue: rep.statut === null ? "INJOIGNABLE" : "PAS_ENCORE", message: c.phrase };
}
