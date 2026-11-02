import { prisma } from "@/lib/prisma";
import { SortieInterdite } from "@/lib/sortie/garde";
import { configurationEnVigueur, presenterCleEnAttente, type Presentation } from "./cles";
import { reveillerFile } from "./file";
import { rapprocherSite } from "./reconciliation";
import { envoyerAuSite, type ReponseSite, type TransportSite } from "./transport";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ENTRETIEN DE LA LIAISON AVEC LE SITE (§118.159) — ce que le battement fait tout seul, pour que
 * personne n'ait à le faire.
 *
 *   1. PRÉSENTER la clé en attente au site, au rythme dégressif de `cles.ts`, et la promouvoir dès
 *      qu'il la reconnaît — la personne colle le bloc, et l'écran passe à « Relié » sans un clic.
 *   2. LIRE LA SANTÉ du site une fois l'heure (`GET /health` avec la clé active) : ce qu'il dit de
 *      sa liaison à l'ERP, de sa signature, des candidatures qu'il n'a pas encore livrées, de son
 *      stockage. L'écran l'affiche ; rien ne s'y devine.
 *   3. S'APERCEVOIR QU'IL A REDÉMARRÉ (`bootId` changé) et rapprocher AUSSITÔT. Un site en plan
 *      gratuit efface ce qu'il a reçu à chaque mise en veille ; il se recharge lui-même auprès de
 *      l'ERP au démarrage, et ce rapprochement est le filet si ce rechargement a échoué.
 *
 * UNE FOIS L'HEURE, pas plus, et c'est une décision : chaque lecture RÉVEILLE un site hébergé en
 * plan gratuit, et le garder éveillé en permanence consommerait les heures gratuites de tout le
 * compte Render — le jour où elles manquent, c'est le site public qui s'éteint. Les candidatures,
 * elles, n'attendent pas cette lecture : le site les envoie à l'ERP au moment où elles arrivent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const INTERVALLE_SANTE_MS = 3_600_000;

/** Ce que le site dit de lui-même — lu sans supposer qu'il porte déjà les champs du §118.159. */
export interface SanteSite {
  lueLe: string;
  statut: number | null;
  erreur: string | null;
  configure: boolean | null;
  authentifie: boolean | null;
  capacites: string[];
  bootId: string | null;
  demarreLe: string | null;
  /** Le site connaît-il l'adresse de l'ERP (`ERP_BASE_URL`) ? Sans elle, pas de candidatures ni de rechargement. */
  erpRelie: boolean | null;
  /** Signe-t-il ses envois (`ERP_WEBHOOK_SECRET` posé chez lui) ? */
  signe: boolean | null;
  candidaturesEnAttente: number | null;
  plusAncienneEnAttente: string | null;
  derniereErreurDeLivraison: string | null;
  /** Le site écrit-il dans un dossier de secours (pas de disque persistant là où il l'attendait) ? */
  stockageDeSecours: boolean | null;
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const chaine = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const objet = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function lireSante(rep: Pick<ReponseSite, "statut" | "texte" | "erreur">, maintenant: Date): SanteSite {
  let j: Record<string, unknown> | null = null;
  try {
    j = rep.texte ? objet(JSON.parse(rep.texte)) : null;
  } catch {
    j = null;
  }
  const erp = objet(j?.erp);
  const candidatures = objet(j?.applications);
  const stockage = objet(j?.storage);
  const enAttente = typeof candidatures?.pending === "number" && Number.isFinite(candidatures.pending) ? candidatures.pending : null;
  return {
    lueLe: maintenant.toISOString(),
    statut: rep.statut,
    erreur: rep.statut === null ? (rep.erreur ?? "site injoignable") : chaine(j?.error),
    configure: bool(j?.configured),
    authentifie: bool(j?.authenticated),
    capacites: Array.isArray(j?.capabilities) ? (j!.capabilities as unknown[]).filter((c): c is string => typeof c === "string").slice(0, 20) : [],
    bootId: chaine(j?.bootId, 80),
    demarreLe: chaine(j?.startedAt, 40),
    erpRelie: bool(erp?.linked),
    signe: bool(erp?.signing),
    candidaturesEnAttente: enAttente,
    plusAncienneEnAttente: chaine(candidatures?.oldestAt, 40),
    derniereErreurDeLivraison: chaine(erp?.lastError, 300),
    stockageDeSecours: bool(stockage?.fallback),
  };
}

/**
 * LE SITE TOURNE-T-IL SUR UNE VERSION QUI REÇOIT LES CANDIDATURES ? (§118.159g) Une version d'avant
 * la liaison reconnaît la clé et publie les offres — l'écran dirait « Relié » — mais n'a ni
 * formulaire ni route de retour : rien n'arrivera jamais, en silence. Mesuré sur son code (b276b75) :
 * sa santé authentifiée annonce `["jobs", "posts"]`, la version reliée `["jobs", "posts",
 * "applications"]`. Sans clé reconnue, le site ne dit rien de lui-même : on rend `null` — on ne sait
 * pas —, jamais « non » (§118.16).
 */
export function recoitLesCandidatures(sante: SanteSite): boolean | null {
  if (sante.statut !== 200 || sante.authentifie !== true) return null;
  return sante.capacites.includes("applications");
}

export async function derniereSante(): Promise<{ sante: SanteSite | null; au: Date | null }> {
  const s = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { siteSante: true, siteSanteAt: true } }).catch(sansBloquer("liaison.derniereSante.appSetting", null));
  const sante = s?.siteSante && typeof s.siteSante === "object" ? (s.siteSante as unknown as SanteSite) : null;
  return { sante, au: s?.siteSanteAt ?? null };
}

export interface BilanLiaison {
  presentation: Presentation | null;
  sante: SanteSite | null;
  redemarrage: boolean;
  rapproche: boolean;
}

/**
 * LIT LA SANTÉ DU SITE et l'enregistre. Si l'identifiant de démarrage a changé depuis la dernière
 * lecture, le site a redémarré : on rapproche aussitôt (sauf `sansRapprochement`, pour un banc).
 */
export async function lireEtGarderSante(
  transport: TransportSite,
  maintenant: Date,
  opts: { sansRapprochement?: boolean } = {},
): Promise<{ sante: SanteSite | null; redemarrage: boolean; rapproche: boolean }> {
  let rep: ReponseSite;
  try {
    rep = await transport({ methode: "GET", chemin: "/health" });
  } catch (e) {
    if (e instanceof SortieInterdite) return { sante: null, redemarrage: false, rapproche: false };
    rep = { statut: null, texte: null, erreur: e instanceof Error ? e.message : String(e), ms: 0, retryAfterS: null, location: null };
  }
  const sante = lireSante(rep, maintenant);
  const avant = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { siteBootId: true } }).catch(sansBloquer("liaison.lireEtGarderSante.appSetting", null));
  const redemarrage = Boolean(sante.bootId && avant?.siteBootId && avant.siteBootId !== sante.bootId);
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", siteSante: sante as unknown as object, siteSanteAt: maintenant, ...(sante.bootId ? { siteBootId: sante.bootId } : {}) },
    update: { siteSante: sante as unknown as object, siteSanteAt: maintenant, ...(sante.bootId ? { siteBootId: sante.bootId } : {}) },
  });
  let rapproche = false;
  if (redemarrage && !opts.sansRapprochement) {
    console.info(`[site-web] le site a redémarré (${avant?.siteBootId} → ${sante.bootId}) : rapprochement immédiat`);
    const b = await rapprocherSite({ declencheur: "AUTO", maintenant, transport }).catch((e) => {
      console.error("[site-web] rapprochement après redémarrage du site", e);
      return null;
    });
    rapproche = Boolean(b?.ok);
  }
  return { sante, redemarrage, rapproche };
}

let entretienEnCours = false;

/**
 * LE PAS DU BATTEMENT (chaque minute). Présente la clé en attente quand elle est due, et lit la
 * santé du site une fois l'heure. `force` (le bouton « Vérifier maintenant ») ignore les deux rythmes.
 */
export async function entretenirLiaison(opts: { transport?: TransportSite; maintenant?: Date; force?: boolean } = {}): Promise<BilanLiaison> {
  const maintenant = opts.maintenant ?? new Date();
  const transport = opts.transport ?? envoyerAuSite;
  const bilan: BilanLiaison = { presentation: null, sante: null, redemarrage: false, rapproche: false };
  if (entretienEnCours && !opts.transport) return bilan;
  if (!opts.transport) entretienEnCours = true;
  try {
    const p = await presenterCleEnAttente(transport, { maintenant, force: opts.force });
    bilan.presentation = p.issue === "AUCUNE" ? null : p;
    if (p.issue === "PROMUE") {
      // La nouvelle clé part tout de suite : les envois qui attendaient repartent, et un premier
      // rapprochement dit au site tout ce que l'ERP veut qu'il détienne.
      if (!opts.transport) reveillerFile(0);
      await rapprocherSite({ declencheur: "AUTO", maintenant, transport }).catch((e) => console.error("[site-web] rapprochement après liaison", e));
    }
    const conf = await configurationEnVigueur();
    if (!conf.ok) return bilan;
    const { au } = await derniereSante();
    if (!opts.force && p.issue !== "PROMUE" && au && maintenant.getTime() - au.getTime() < INTERVALLE_SANTE_MS) return bilan;
    const s = await lireEtGarderSante(transport, maintenant);
    Object.assign(bilan, s);
    return bilan;
  } catch (e) {
    console.error("[site-web] entretien de la liaison", e);
    return bilan;
  } finally {
    if (!opts.transport) entretienEnCours = false;
  }
}
