import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { SortieInterdite } from "@/lib/sortie/garde";
import { notifyRoles, notifyUser } from "@/lib/notify";
import {
  CHEMIN_API, classerReponse, ESSAIS_MAX, externalIdValide, LIBELLE_NATURE, messageDuSite, prochainEssai, serialiser,
  type CorpsSuppression, type IssueRequete, type JobInput, type NatureContenu, type PostInput,
} from "./contrat";
import { configurationEnVigueur, presenterCleEnAttente } from "./cles";
import { envoyerAuSite, type ReponseSite, type TransportSite } from "./transport";
import { ECRAN_LIAISON } from "./ecran";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE D'ENVOI VERS LE SITE ADVENTUM (§118.158).
 *
 * ── UNE LIGNE PAR CONTENU, PAS UNE PAR ENVOI ─────────────────────────────────────────────
 *
 * Chaque PUT porte le document ENTIER : seule la dernière version compte. Trois corrections
 * rapides d'un article ne font pas trois requêtes en file, mais une ligne dont la `version` a
 * monté. Et la version protège de la course : un envoi réussi ne confirme QUE la version qu'il
 * portait — si l'auteur a corrigé pendant le vol, la correction repart au tour suivant au lieu
 * d'être déclarée « en ligne » sur la foi de l'envoi précédent.
 *
 * ── CE QUE DIT CHAQUE RÉPONSE (contrat §6 et §7) ─────────────────────────────────────────
 *
 *   200/201, 404 sur un DELETE  → fait ; l'adresse publique est gardée ;
 *   réseau, délai, 429, 5xx     → réessai à 1 s, 5 s, 30 s, 2 min, 10 min, puis ÉCHEC DIT ;
 *   4xx (hors 401 et 429)       → la charge utile est en cause : on s'arrête, on prévient
 *                                 celui qui a publié, et on ne rejoue JAMAIS le même contenu ;
 *   401, redirection            → la CONFIGURATION est en cause, pour tous les envois : on
 *                                 coupe tout (disjoncteur), on alerte une fois, et l'on ne
 *                                 réessaie pas en boucle une clé refusée.
 *
 * ── LE BATTEMENT EST LE FILET, LE MINUTEUR EST L'ACCÉLÉRATEUR ─────────────────────────────
 *
 * L'état vit en base (`nextAttemptAt`) : le battement de l'ERP (`scheduled.ts`, chaque minute)
 * reprend tout ce qui est dû, même après un redémarrage. Les délais courts du contrat (1 s, 5 s,
 * 30 s) sont tenus par un minuteur dans le processus — un confort, jamais une garantie : s'il se
 * perd, le battement rattrape à la minute.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une prise plus vieille que ça est celle d'un processus mort : dix secondes de délai, et large marge. */
export const VERROU_PERIME_MS = 2 * 60_000;
/** Les tentatives gardées au journal, par contenu. */
export const JOURNAL_PAR_CONTENU = 20;
/** Envois traités par passage : le battement ne monopolise pas le serveur. */
const PAR_PASSAGE = 25;

export const empreinteCorps = (corps: string): string => createHash("sha256").update(corps, "utf8").digest("hex");

/** Où l'on corrige un contenu — c'est le lien d'une alerte. */
export function lienDuContenu(nature: NatureContenu, externalId: string): string {
  return nature === "JOB" ? `/site-web/offres/${externalId}` : `/site-web/articles/${externalId}`;
}

// ───────────────────────────── Mettre en file ─────────────────────────────

export interface MiseEnFile {
  nature: NatureContenu;
  externalId: string;
  libelle: string;
  operation: "PUT" | "DELETE";
  /**
   * PUT : le contenu. DELETE : rien — sauf pour un contenu REPRIS du site (§118.160), dont la
   * suppression dit ce qu'elle remplaçait (`CorpsSuppression`).
   */
  corps: JobInput | PostInput | CorpsSuppression | null;
  demandeParId?: string | null;
  /** Rejouer même un contenu identique à la dernière version (relance, réconciliation). */
  forcer?: boolean;
}

export interface ResultatMiseEnFile {
  enFile: boolean;
  /** Pourquoi rien n'a été mis en file, quand c'est le cas — jamais un silence. */
  raison: string;
  publicationId: string | null;
}

/**
 * MET UN CONTENU EN FILE — idempotent : le même corps deux fois ne fait qu'une version.
 */
export async function mettreEnFile(m: MiseEnFile): Promise<ResultatMiseEnFile> {
  if (!externalIdValide(m.externalId)) {
    return { enFile: false, raison: `Identifiant « ${m.externalId} » impropre à une adresse : rien n'est envoyé.`, publicationId: null };
  }
  const body = m.corps ? serialiser(m.corps) : null;
  if (m.operation === "PUT" && body === null) return { enFile: false, raison: "Aucun contenu à envoyer.", publicationId: null };
  const bodyHash = body ? empreinteCorps(body) : null;

  const existant = await prisma.sitePublication.findUnique({
    where: { kind_externalId: { kind: m.nature, externalId: m.externalId } },
    select: { id: true, operation: true, bodyHash: true, state: true, confirmedHash: true, lastStatus: true },
  });

  // Supprimer ce qui n'est jamais parti : le site ne l'a pas, il n'y a rien à lui dire. Sauf une
  // suppression qui PORTE un corps — un contenu repris du site (§118.160) : le site détient SA copie
  // même si la nôtre n'est jamais partie, et c'est elle que cette suppression doit faire disparaître.
  if (m.operation === "DELETE" && !existant && !body) {
    return { enFile: false, raison: "Jamais envoyé au site : rien à y supprimer.", publicationId: null };
  }

  if (existant && existant.operation === m.operation && existant.bodyHash === bodyHash && !m.forcer) {
    if (existant.state === "PENDING") return { enFile: false, raison: "Déjà en file.", publicationId: existant.id };
    if (existant.state === "DONE") {
      return { enFile: false, raison: m.operation === "DELETE" ? "Déjà supprimé du site." : "Le site détient déjà cette version.", publicationId: existant.id };
    }
    // FAILED : le même contenu échouerait pareil. Refusé (4xx) : il faut le CORRIGER ; perdu en
    // réseau : la relance est un geste explicite, pas un effet de bord d'un enregistrement.
    const refuse = existant.lastStatus !== null && existant.lastStatus >= 400 && existant.lastStatus < 500;
    return {
      enFile: false,
      raison: refuse ? "Le site a refusé ce contenu tel quel : corrigez-le avant de le renvoyer." : "Cette version a déjà échoué : utilisez « Relancer » pour la renvoyer.",
      publicationId: existant.id,
    };
  }

  const maintenant = new Date();
  const ligne = await prisma.sitePublication.upsert({
    where: { kind_externalId: { kind: m.nature, externalId: m.externalId } },
    create: {
      kind: m.nature, externalId: m.externalId, label: m.libelle.slice(0, 300), operation: m.operation,
      body, bodyHash, version: 1, state: "PENDING", attempts: 0, nextAttemptAt: maintenant,
      requestedById: m.demandeParId ?? null,
    },
    update: {
      label: m.libelle.slice(0, 300), operation: m.operation, body, bodyHash,
      version: { increment: 1 }, state: "PENDING", attempts: 0, nextAttemptAt: maintenant,
      lastError: null, alertedAt: null,
      ...(m.demandeParId !== undefined ? { requestedById: m.demandeParId } : {}),
    },
    select: { id: true },
  });
  reveillerFile(0);
  return { enFile: true, raison: m.operation === "DELETE" ? "Suppression en file." : "Envoi en file.", publicationId: ligne.id };
}

/** RELANCE explicite d'un contenu en échec : même version, compteur remis à zéro. */
export async function relancerPublication(publicationId: string, parId: string | null): Promise<{ ok: boolean; message: string }> {
  const r = await prisma.sitePublication.updateMany({
    where: { id: publicationId, state: { in: ["FAILED", "PENDING"] } },
    data: { state: "PENDING", attempts: 0, nextAttemptAt: new Date(), alertedAt: null, lastError: null, ...(parId ? { requestedById: parId } : {}) },
  });
  if (r.count === 0) return { ok: false, message: "Rien à relancer : ce contenu est déjà à jour sur le site." };
  reveillerFile(0);
  return { ok: true, message: "Relancé : l'envoi repart maintenant." };
}

// ───────────────────────────── Le disjoncteur ─────────────────────────────

export interface Blocage { empreinte: string; at: Date; motif: string }

export async function lireBlocage(): Promise<Blocage | null> {
  const s = await prisma.appSetting.findUnique({
    where: { id: "global" },
    select: { siteBlocageEmpreinte: true, siteBlocageAt: true, siteBlocageMotif: true },
  }).catch(sansBloquer("site-web-file.lireBlocage.appSetting", null));
  if (!s?.siteBlocageEmpreinte) return null;
  return { empreinte: s.siteBlocageEmpreinte, at: s.siteBlocageAt ?? new Date(0), motif: s.siteBlocageMotif ?? "Configuration refusée par le site." };
}

/** Pose le blocage ; rend `true` s'il est NOUVEAU (c'est alors, et alors seulement, qu'on alerte). */
async function poserBlocage(empreinte: string, motif: string, at: Date): Promise<boolean> {
  const avant = await lireBlocage();
  if (avant?.empreinte === empreinte) return false;
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", siteBlocageEmpreinte: empreinte, siteBlocageAt: at, siteBlocageMotif: motif.slice(0, 500) },
    update: { siteBlocageEmpreinte: empreinte, siteBlocageAt: at, siteBlocageMotif: motif.slice(0, 500) },
  });
  return true;
}

/**
 * LE SITE A REFUSÉ LA CONFIGURATION (401, ou une redirection) : on coupe tout, et l'on prévient
 * les Super Admins UNE fois — c'est eux qui tiennent les variables d'environnement. Rend la phrase
 * qui nomme la cause et le geste qui répare. Partagée par la file et la réconciliation : deux
 * rédactions du même refus finiraient par dire deux choses différentes (§118.5).
 */
export async function bloquerPourConfiguration(
  empreinte: string,
  rep: Pick<ReponseSite, "statut" | "texte" | "location">,
  maintenant: Date,
  /** Ce que le site a répondu à la clé EN ATTENTE, quand elle a été présentée juste avant (§118.159). */
  cleEnAttente: string | null = null,
): Promise<string> {
  const detail = messageDuSite(rep.texte);
  // Deux 401 qui ne se réparent pas pareil : la CLÉ refusée (le site en a une autre) et la
  // SIGNATURE refusée (la clé est bonne, le secret diffère). Le site le dit dans son message.
  const signature = rep.statut === 401 && /signature/i.test(detail ?? "");
  const motifBase = rep.statut === 401
    ? signature
      ? `Le site reconnaît la clé mais refuse la SIGNATURE des envois (401${detail ? ` : ${detail}` : ""}) : la ligne ERP_WEBHOOK_SECRET de son environnement n'est pas celle du bloc. Générez une nouvelle clé depuis ${ECRAN_LIAISON.nom} et collez le bloc entier dans Render — ou retirez ERP_WEBHOOK_SECRET du site.`
      : `Le site refuse la clé (401${detail ? ` : ${detail}` : ""}) : il en porte une autre. Générez une nouvelle clé depuis ${ECRAN_LIAISON.nom} et collez le bloc dans l'environnement du site (Render) — l'ERP bascule tout seul dès que le site la reconnaît.`
    : `Le site redirige (${rep.statut}${rep.location ? ` vers ${rep.location}` : ""}) : l'adresse du site n'est pas la bonne. Corrigez ADVENTUM_BASE_URL (Render de l'ERP), ou retirez-la pour revenir à l'adresse mesurée.`;
  // Une clé en attente a été présentée et le site ne l'a pas prise : c'est presque toujours LÀ
  // qu'est la réparation (bloc collé en partie, ou pas encore enregistré) — on le dit dans le motif.
  const motif = cleEnAttente ? `${motifBase} Clé en attente : ${cleEnAttente}` : motifBase;
  if (await poserBlocage(empreinte, motif, maintenant)) {
    await notifyRoles(["SUPER_ADMIN"], { type: "GENERIC", title: "Site web : publication suspendue", body: `${motif} Aucun envoi ne part d'ici là.`, link: ECRAN_LIAISON.href });
  }
  return motif;
}

export async function leverBlocage(): Promise<void> {
  await prisma.appSetting.updateMany({
    where: { id: "global" },
    data: { siteBlocageEmpreinte: null, siteBlocageAt: null, siteBlocageMotif: null },
  });
}

/**
 * L'ÉTAT DU DISJONCTEUR pour la configuration EN VIGUEUR. Une configuration qui a changé depuis le
 * refus (nouvelle clé, nouvelle adresse) lève le blocage d'elle-même : c'est le geste qui répare,
 * et exiger en plus un clic ferait croire que la réparation n'a pas pris.
 */
export async function blocageEnVigueur(empreinte: string): Promise<Blocage | null> {
  const b = await lireBlocage();
  if (!b) return null;
  if (b.empreinte === empreinte) return b;
  await leverBlocage();
  console.info("[site-web] configuration changée depuis le refus du site : blocage levé");
  return null;
}

// ───────────────────────────── Le minuteur ─────────────────────────────

let minuteur: ReturnType<typeof setTimeout> | null = null;
let echeanceMinuteur = Number.POSITIVE_INFINITY;

/**
 * RÉVEILLE LA FILE dans `delaiMs`. Le minuteur le plus proche gagne. Jamais pendant les tests :
 * un banc appelle `viderFile` lui-même, avec son transport et son horloge — un minuteur qui
 * viderait la file en parallèle rendrait le verdict dépendant de l'ordonnancement.
 */
export function reveillerFile(delaiMs: number): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const echeance = Date.now() + Math.max(0, delaiMs);
  if (minuteur && echeance >= echeanceMinuteur) return;
  if (minuteur) clearTimeout(minuteur);
  echeanceMinuteur = echeance;
  minuteur = setTimeout(() => {
    minuteur = null;
    echeanceMinuteur = Number.POSITIVE_INFINITY;
    void viderFile().catch((e) => console.error("[site-web] vidage de la file échoué", e));
  }, Math.max(0, delaiMs));
  minuteur.unref?.();
}

// ───────────────────────────── Vider la file ─────────────────────────────

export interface BilanVidage {
  envoyes: number;
  reussis: number;
  aReessayer: number;
  refuses: number;
  epuises: number;
  bloque: boolean;
  nonConfigure: boolean;
  /** La sortie est interdite dans ce processus (test, banc) : rien n'est parti, rien n'a été compté. */
  sortieInterdite: boolean;
  /**
   * La clé a été refusée, mais la clé EN ATTENTE vient d'être reconnue et promue (§118.159) : rien
   * n'est bloqué, le prochain passage part avec la nouvelle — le vidage s'arrête pour la relire.
   */
  reconfigure: boolean;
}

export interface OptionsVidage {
  maintenant?: Date;
  transport?: TransportSite;
  limite?: number;
  /** Ne traiter que ces lignes (un banc, ou « envoyer celle-ci tout de suite »). */
  seulement?: string[];
}

let videEnCours = false;

/**
 * VIDE LA FILE : prend chaque envoi dû, l'envoie, classe la réponse, écrit la suite. Ne lève
 * jamais : le battement enchaîne d'autres balayages derrière.
 */
export async function viderFile(opts: OptionsVidage = {}): Promise<BilanVidage> {
  const bilan: BilanVidage = { envoyes: 0, reussis: 0, aReessayer: 0, refuses: 0, epuises: 0, bloque: false, nonConfigure: false, sortieInterdite: false, reconfigure: false };
  const conf = await configurationEnVigueur();
  if (!conf.ok) { bilan.nonConfigure = true; return bilan; }
  // Un seul vidage à la fois dans ce processus ; entre processus, c'est la prise en base qui
  // arbitre. Un banc qui injecte son transport arbitre lui-même — c'est la PRISE qu'il éprouve.
  const verrouLocal = !opts.transport;
  if (verrouLocal && videEnCours) return bilan;
  if (verrouLocal) videEnCours = true;
  try {
    if (await blocageEnVigueur(conf.config.empreinte)) { bilan.bloque = true; return bilan; }
    const transport = opts.transport ?? envoyerAuSite;
    const limite = opts.limite ?? PAR_PASSAGE;
    for (let i = 0; i < limite; i += 1) {
      const maintenant = opts.maintenant ?? new Date();
      const pub = await prendreUne(maintenant, opts.seulement);
      if (!pub) break;
      const issue = await envoyerUne(pub, transport, maintenant, conf.config.empreinte);
      if (issue === "LOCAL") { bilan.sortieInterdite = true; break; }
      if (issue === "RECONFIGURE") { bilan.reconfigure = true; break; }
      bilan.envoyes += 1;
      if (issue === "SUCCES" || issue === "DEJA_ABSENT") bilan.reussis += 1;
      else if (issue === "REESSAYER") bilan.aReessayer += 1;
      else if (issue === "EPUISE") bilan.epuises += 1;
      else if (issue === "CORRIGER") bilan.refuses += 1;
      else if (issue === "BLOQUANT") { bilan.bloque = true; break; }
    }
    if (bilan.reconfigure && !opts.transport) reveillerFile(0);
    if (!bilan.bloque && !bilan.sortieInterdite && !bilan.reconfigure && !opts.transport) {
      const suivante = await prisma.sitePublication.findFirst({
        where: { state: "PENDING", claimedAt: null },
        orderBy: { nextAttemptAt: "asc" },
        select: { nextAttemptAt: true },
      }).catch(sansBloquer("site-web-file.viderFile.sitePublication", null));
      if (suivante) reveillerFile(suivante.nextAttemptAt.getTime() - Date.now());
    }
    if (bilan.envoyes) console.info("[site-web] file", JSON.stringify(bilan));
    return bilan;
  } catch (err) {
    console.error("[site-web] vidage échoué", err);
    return bilan;
  } finally {
    if (verrouLocal) videEnCours = false;
  }
}

interface EnvoiPris {
  id: string;
  kind: NatureContenu;
  externalId: string;
  label: string;
  operation: string;
  body: string | null;
  bodyHash: string | null;
  version: number;
  attempts: number;
  requestedById: string | null;
}

/**
 * PREND UN ENVOI DÛ. La précondition de l'`updateMany` EST le verrou : entre la lecture et la
 * prise, un autre passage a pu passer devant, et c'est la base qui arbitre (même motif que le
 * planificateur, `scheduler/runner.ts`).
 */
async function prendreUne(maintenant: Date, seulement?: string[]): Promise<EnvoiPris | null> {
  const perime = new Date(maintenant.getTime() - VERROU_PERIME_MS);
  const libre = [{ claimedAt: null }, { claimedAt: { lt: perime } }];
  const candidats = await prisma.sitePublication.findMany({
    where: { state: "PENDING", nextAttemptAt: { lte: maintenant }, OR: libre, ...(seulement ? { id: { in: seulement } } : {}) },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: 5,
    select: { id: true, kind: true, externalId: true, label: true, operation: true, body: true, bodyHash: true, version: true, attempts: true, requestedById: true },
  });
  for (const c of candidats) {
    const pris = await prisma.sitePublication.updateMany({
      where: { id: c.id, version: c.version, state: "PENDING", OR: libre },
      data: { claimedAt: maintenant },
    });
    if (pris.count === 1) return c as EnvoiPris;
  }
  return null;
}

type IssueEnvoi = IssueRequete | "EPUISE" | "LOCAL" | "RECONFIGURE";

/** L'adresse publique rendue par le site, lue sans supposer la forme exacte de la réponse. */
function lireEnregistrement(texte: string | null): { url: string | null; slug: string | null; published: boolean | null } {
  if (!texte) return { url: null, slug: null, published: null };
  try {
    const j = JSON.parse(texte) as Record<string, unknown>;
    const r = (j.job ?? j.post) as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") return { url: null, slug: null, published: null };
    return {
      url: typeof r.url === "string" ? r.url : null,
      slug: typeof r.slug === "string" ? r.slug : null,
      published: typeof r.published === "boolean" ? r.published : null,
    };
  } catch {
    return { url: null, slug: null, published: null };
  }
}

async function envoyerUne(pub: EnvoiPris, transport: TransportSite, maintenant: Date, empreinte: string): Promise<IssueEnvoi> {
  const methode = pub.operation === "DELETE" ? "DELETE" : "PUT";
  const chemin = `/${CHEMIN_API[pub.kind]}/${encodeURIComponent(pub.externalId)}`;
  const memeVersion = { id: pub.id, version: pub.version };
  // La prise tombe TOUJOURS, quelle que soit la version : sinon une version posée pendant le vol
  // attendrait le délai de péremption pour partir.
  const relacher = () => prisma.sitePublication.updateMany({ where: { id: pub.id }, data: { claimedAt: null } });

  let rep: ReponseSite;
  try {
    // Le corps de la ligne part tel qu'il a été sérialisé — y compris sur un DELETE de contenu repris.
    rep = await transport({ methode, chemin, corps: pub.body });
  } catch (e) {
    if (e instanceof SortieInterdite) {
      // RIEN N'EST PARTI. Ce n'est ni un échec du site ni une tentative : on n'en consomme pas,
      // on le dit au journal, et on repasse plus tard (un processus de banc ne vide pas la file).
      await journaliser(pub, methode, chemin, { statut: null, texte: null, erreur: e.message, ms: 0, retryAfterS: null, location: null }, "LOCAL");
      await prisma.sitePublication.updateMany({
        where: memeVersion,
        data: { nextAttemptAt: new Date(maintenant.getTime() + 10 * 60_000), lastError: "Sortie interdite dans ce processus (test ou banc) : rien n'est parti." },
      });
      await relacher();
      return "LOCAL";
    }
    rep = { statut: null, texte: null, erreur: e instanceof Error ? e.message : String(e), ms: 0, retryAfterS: null, location: null };
  }

  const issue = classerReponse(methode, rep.statut);
  await journaliser(pub, methode, chemin, rep, issue);
  const essais = pub.attempts + 1;

  if (issue === "SUCCES" || issue === "DEJA_ABSENT") {
    const lu = methode === "PUT" ? lireEnregistrement(rep.texte) : { url: null, slug: null, published: null };
    const etatSite = {
      confirmedHash: methode === "PUT" ? pub.bodyHash : null,
      confirmedPublished: methode === "PUT" ? (lu.published ?? lirePublieDuCorps(pub.body)) : null,
      confirmedAt: maintenant,
      siteUrl: methode === "PUT" ? lu.url : null,
      siteSlug: methode === "PUT" ? lu.slug : null,
    };
    const r = await prisma.sitePublication.updateMany({
      where: memeVersion,
      data: { ...etatSite, state: "DONE", attempts: essais, lastStatus: rep.statut, lastError: null, lastAttemptAt: maintenant, alertedAt: null },
    });
    // Corrigé pendant le vol : le site détient la version d'AVANT. On note ce qu'il détient ; la
    // nouvelle version, elle, reste en file et repartira.
    if (r.count === 0) await prisma.sitePublication.updateMany({ where: { id: pub.id }, data: etatSite });
    await relacher();
    return issue;
  }

  const message = rep.statut === null ? (rep.erreur ?? "site injoignable") : (messageDuSite(rep.texte) ?? `réponse ${rep.statut}`);

  if (issue === "BLOQUANT") {
    // ROTATION EN COURS (§118.159) : le site vient peut-être de recevoir la NOUVELLE clé et refuse
    // l'ancienne. Avant de tout couper et d'alerter, on lui présente la clé en attente ; s'il la
    // reconnaît, elle devient active et l'envoi repart avec elle — ni blocage ni alerte pour un
    // changement de clé réussi. Aucune tentative consommée : le contenu n'est pas en cause.
    let constatAttente: string | null = null;
    if (rep.statut === 401) {
      const essai = await presenterCleEnAttente(transport, { maintenant, force: true });
      if (essai.issue === "PROMUE") {
        await prisma.sitePublication.updateMany({ where: memeVersion, data: { lastStatus: rep.statut, lastError: null, lastAttemptAt: maintenant } });
        await relacher();
        return "RECONFIGURE";
      }
      if (essai.issue === "PAS_ENCORE" || essai.issue === "INJOIGNABLE") constatAttente = essai.message;
    }
    const motif = await bloquerPourConfiguration(empreinte, rep, maintenant, constatAttente);
    // Le CONTENU n'est pas en cause : aucune tentative consommée, la ligne attend la réparation.
    await prisma.sitePublication.updateMany({ where: memeVersion, data: { lastStatus: rep.statut, lastError: motif.slice(0, 500), lastAttemptAt: maintenant } });
    await relacher();
    return issue;
  }

  if (issue === "REESSAYER") {
    const suivant = prochainEssai(essais, maintenant, rep.retryAfterS);
    if (suivant) {
      await prisma.sitePublication.updateMany({
        where: memeVersion,
        data: { attempts: essais, nextAttemptAt: suivant, lastStatus: rep.statut, lastError: message.slice(0, 500), lastAttemptAt: maintenant },
      });
      await relacher();
      return issue;
    }
    // ÉPUISÉ : le dire, une fois — la réconciliation quotidienne reprendra ce qui diverge.
    await echouer(pub, { attempts: essais, lastStatus: rep.statut, lastError: message.slice(0, 500), lastAttemptAt: maintenant }, maintenant,
      "Site web : envoi impossible",
      `« ${pub.label} » (${LIBELLE_NATURE[pub.kind].toLowerCase()}) n'a pas pu être envoyé au site après ${ESSAIS_MAX} essais — dernière réponse : ${rep.statut ?? "aucune"} (${message}). La réconciliation quotidienne réessaiera ; vous pouvez aussi relancer depuis Site web.`);
    await relacher();
    return "EPUISE";
  }

  // CORRIGER : la charge utile est en cause. On s'arrête, on prévient celui qui a publié.
  await echouer(pub, { attempts: essais, lastStatus: rep.statut, lastError: message.slice(0, 500), lastAttemptAt: maintenant }, maintenant,
    "Site web : contenu refusé",
    `Le site a refusé « ${pub.label} » (${rep.statut}) : ${message}. Corrigez le contenu puis enregistrez-le à nouveau — le même contenu serait refusé pareil.`);
  await relacher();
  return issue;
}

/**
 * MARQUE L'ÉCHEC DÉFINITIF d'une version, et prévient UNE fois : l'alerte est posée dans la même
 * écriture que l'échec (`alertedAt: null` en précondition), si bien que deux passages concurrents
 * n'envoient pas deux notifications pour le même incident.
 *
 * DEUX GARDES tiennent « une seule alerte » : la PRISE atomique (`prendreUne`) empêche deux passages
 * de tenir la même ligne, et cette précondition couvre ce que la prise ne couvre pas — un passage
 * resté bloqué au-delà de `VERROU_PERIME_MS`, dont la ligne a été reprise par un autre. Chacune est
 * éprouvée en concurrence RÉELLE, et chacune a son témoin (`publication.test.ts`, « CONCURRENCE ») :
 * huit passages lancés ensemble n'envoient qu'une fois — prise sans verrou, QUATRE envois mesurés,
 * et pourtant une seule alerte, parce que cette précondition tenait encore ; un retardataire dont
 * la ligne a été reprise ne redit pas l'échec — précondition retirée, deux alertes (§118.159).
 */
async function echouer(
  pub: EnvoiPris,
  data: { attempts: number; lastStatus: number | null; lastError: string; lastAttemptAt: Date },
  maintenant: Date,
  titre: string,
  corps: string,
): Promise<void> {
  const premier = await prisma.sitePublication.updateMany({
    where: { id: pub.id, version: pub.version, alertedAt: null },
    data: { ...data, state: "FAILED", alertedAt: maintenant },
  });
  if (premier.count === 1) {
    await alerter(pub, titre, corps);
    return;
  }
  await prisma.sitePublication.updateMany({ where: { id: pub.id, version: pub.version }, data: { ...data, state: "FAILED" } });
}

function lirePublieDuCorps(body: string | null): boolean | null {
  if (!body) return null;
  try {
    const j = JSON.parse(body) as { published?: unknown };
    return typeof j.published === "boolean" ? j.published : null;
  } catch {
    return null;
  }
}

/** Prévenir celui qui a demandé la publication ; à défaut, les Super Admins. Jamais les deux fois. */
async function alerter(pub: EnvoiPris, titre: string, corps: string): Promise<void> {
  const lien = lienDuContenu(pub.kind, pub.externalId);
  if (pub.requestedById) {
    await notifyUser({ userId: pub.requestedById, type: "GENERIC", title: titre, body: corps, link: lien });
  } else {
    await notifyRoles(["SUPER_ADMIN"], { type: "GENERIC", title: titre, body: corps, link: lien });
  }
}

/**
 * LE JOURNAL : externalId, code HTTP, corps de réponse (contrat §7). Jamais la clé, jamais les
 * en-têtes — le corps envoyé non plus : il est déjà dans la ligne de file, et le recopier à chaque
 * tentative ferait peser 200 000 caractères par essai.
 */
async function journaliser(pub: EnvoiPris, methode: string, chemin: string, rep: ReponseSite, issue: IssueRequete | "LOCAL"): Promise<void> {
  console.info(`[site-web] ${methode} ${chemin} → ${rep.statut ?? "—"} ${issue} (${rep.ms} ms)${rep.erreur ? ` — ${rep.erreur}` : ""}`);
  try {
    await prisma.sitePushAttempt.create({
      data: {
        publicationId: pub.id, kind: pub.kind, externalId: pub.externalId, method: methode, path: chemin, version: pub.version,
        status: rep.statut, outcome: issue, responseBody: rep.texte ? rep.texte.slice(0, 2_000) : null,
        error: rep.erreur ? rep.erreur.slice(0, 500) : null, durationMs: Math.max(0, Math.round(rep.ms)),
      },
    });
    const anciens = await prisma.sitePushAttempt.findMany({
      where: { publicationId: pub.id }, orderBy: { createdAt: "desc" }, skip: JOURNAL_PAR_CONTENU, select: { id: true },
    });
    if (anciens.length) await prisma.sitePushAttempt.deleteMany({ where: { id: { in: anciens.map((a) => a.id) } } });
  } catch (err) {
    // Un journal qu'on ne sait pas écrire ne doit pas faire croire que l'envoi n'a pas eu lieu.
    console.error("[site-web] journal non écrit", pub.externalId, err);
  }
}
