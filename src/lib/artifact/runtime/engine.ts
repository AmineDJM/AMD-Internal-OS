/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MOTEUR — ouvrir, modifier, annuler, rétablir, sauvegarder (§3, §18, §19-23, §48).
 *
 * ── LA DÉCISION CENTRALE : L'ÉTAT EST UN REJEU, PAS UN INSTANTANÉ ───────────────────────
 *
 * L'état courant d'un document ouvert = la version Drive de base, PLUS les opérations non
 * annulées du journal, rejouées dans l'ordre.
 *
 * Trois propriétés en découlent, gratuitement :
 *
 *   ANNULER      c'est marquer la dernière opération « annulée » et rejouer. Exact par
 *                construction, pour les quatre formats, sans écrire une seule commande inverse.
 *   RÉRABLIR     c'est la démarquer. Symétrique, donc sans code en plus.
 *   REPRISE      après un redémarrage du serveur ou la fermeture de l'application (§80-81), il
 *                n'y a RIEN à reconstruire : le journal est déjà en base, on rejoue.
 *
 * Le prix est un rejeu à chaque commande. Mesuré : quelques millisecondes sur les adaptateurs
 * déterministes de ce projet, et un cache mémoire (`cache.ts`) l'évite dans le cas courant —
 * on ne rejoue vraiment qu'au premier accès d'un processus, ou après une annulation.
 *
 * L'alternative (un instantané par opération) coûterait, sur un PPTX de 8 Mo retouché vingt
 * fois, 160 Mo de blobs pour une session — pour dire la même chose que le journal.
 *
 * ── LA SAUVEGARDE EST ATOMIQUE (§48) ────────────────────────────────────────────────────
 *
 * On sérialise, on RELIT ce qu'on vient de produire, et seulement si la relecture réussit on
 * écrit la version dans le Drive. Un fichier illisible ne remplace jamais un fichier lisible.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from "node:crypto";
import type { ArtifactFormat, ArtifactModel } from "@/lib/artifact/object-model/model";
import type { Cible, CommandeArtefact } from "@/lib/artifact/commands/ir";
import { CIBLE_VIDE } from "@/lib/artifact/commands/ir";
import { lireImage } from "@/lib/artifact/object-model/image";
import { compilerCommandes } from "@/lib/artifact/commands/compile";
import type { DocumentOuvert, EffetCommande, RessourceBinaire } from "@/lib/artifact/adapters/contract";
import { adaptateurPour, mimeDe } from "@/lib/artifact/adapters/registry";
import { controlerAvantLivraison, controlerVisuel, proportionsInitiales, type ControleLivraison } from "@/lib/artifact/qa/checks";
import { vueDuModele, type VueArtefact } from "@/lib/artifact/render/view";
import { comparer, type Comparaison } from "@/lib/artifact/versions/diff";
import type { PortsArtefact } from "@/lib/artifact/ports";
import { mesurer, type Chrono } from "@/lib/artifact/observability/timing";
import { sansBloquer } from "@/lib/journal";

// ─────────────────────────── Le magasin de sessions ───────────────────────────

/** L'état persistant d'une session, tel que le moteur en a besoin. Fourni par le magasin. */
export interface SessionPersistee {
  id: string;
  userId: string;
  threadId: string | null;
  blockId: string;
  nodeId: string;
  baseVersion: number;
  name: string;
  format: ArtifactFormat;
  state: string;
  revision: number;
  dirty: boolean;
  savedVersion: number | null;
  activePage: number | null;
  activeSlide: number | null;
  activeSheet: string | null;
  activeSelection: string[] | null;
}

export interface OperationPersistee {
  operationId: string;
  seq: number;
  beforeVersion: number;
  afterVersion: number;
  command: CommandeArtefact;
  summary: string;
  actorId: string;
  actorLabel: string;
  undone: boolean;
  createdAt: Date;
  /** Les zones que l'opération a touchées (Atelier, J3) — l'écran les surligne. Absent = non noté. */
  touches?: string[] | null;
  /**
   * LA REVUE de la personne (Atelier, J3), comme le suivi des modifications : « ACCEPTEE », ou « REFUSEE » —
   * une opération refusée est ANNULÉE (`undone`) et le reste, la revue dit pourquoi. Absent = pas encore revue.
   */
  revue?: RevueOperation | null;
}

export type RevueOperation = "ACCEPTEE" | "REFUSEE";

/**
 * LE MAGASIN. Le moteur ne connaît pas Prisma : c'est ce qui rend ses tests exécutables sans
 * base ET ce qui empêche le domaine `artifact/` d'importer le socle de persistance.
 */
export interface MagasinSessions {
  creer(s: Omit<SessionPersistee, "id" | "revision" | "dirty" | "savedVersion" | "state">): Promise<SessionPersistee>;
  lire(sessionId: string, userId: string): Promise<SessionPersistee | null>;
  /** La session ouverte de cette personne sur ce fichier, s'il y en a une (§36). */
  ouverte(userId: string, nodeId: string): Promise<SessionPersistee | null>;
  /** La DERNIÈRE session encore ouverte de cette personne — « annule », « sauvegarde » sans nom. */
  derniere(userId: string): Promise<SessionPersistee | null>;
  majSession(sessionId: string, champs: Partial<SessionPersistee> & { lastError?: string | null }): Promise<void>;
  operations(sessionId: string): Promise<OperationPersistee[]>;
  /** Écrit une opération. Rend `false` si `operationId` existait déjà (idempotence, §18). */
  ajouterOperation(sessionId: string, op: OperationPersistee): Promise<boolean>;
  marquerAnnulee(sessionId: string, seq: number, annulee: boolean): Promise<void>;
  /** La revue d'une opération (Atelier). Facultatif : un magasin qui ne la porte pas refuse la revue. */
  marquerRevue?(sessionId: string, seq: number, revue: RevueOperation | null): Promise<void>;
  fermer(sessionId: string): Promise<void>;
}

export interface ContexteMoteur {
  ports: PortsArtefact;
  magasin: MagasinSessions;
  /** Qui agit — l'audit portera ce nom (§76). */
  acteur: { id: string; libelle: string };
}

// ─────────────────────────── Le cache d'états ouverts ───────────────────────────

interface EtatOuvert {
  doc: DocumentOuvert;
  revision: number;
  proportions: Record<string, number>;
}

/**
 * Un document ouvert par session, dans CE processus. Borné : au-delà, la plus ancienne session
 * est évincée et se rejouera au prochain accès — jamais une erreur, juste un rejeu.
 */
const CACHE = new Map<string, EtatOuvert>();
const CACHE_MAX = 24;

function mettreEnCache(sessionId: string, etat: EtatOuvert): void {
  CACHE.delete(sessionId);
  CACHE.set(sessionId, etat);
  while (CACHE.size > CACHE_MAX) {
    const plusAncienne = CACHE.keys().next().value;
    if (plusAncienne === undefined) break;
    CACHE.delete(plusAncienne);
  }
}

/** Vide le cache — utilisé par les tests, et par la fermeture de session. */
export function oublierSession(sessionId: string): void {
  CACHE.delete(sessionId);
}

// ─────────────────────────── Résultats ───────────────────────────

export interface ResultatOuverture {
  ok: boolean;
  motif: string | null;
  vue: VueArtefact | null;
  /** Plusieurs fichiers correspondent au nom demandé : on laisse choisir plutôt que deviner. */
  candidats: { nodeId: string; nom: string; format: string }[];
  chrono: Chrono;
}

export interface ResultatEdition {
  ok: boolean;
  /** Ce qui s'est passé, commande par commande — c'est ce qu'Adam redit à la personne. */
  effets: EffetCommande[];
  motif: string | null;
  vue: VueArtefact | null;
  chrono: Chrono;
}

export interface ResultatSauvegarde {
  ok: boolean;
  motif: string | null;
  version: number | null;
  nodeId: string | null;
  vue: VueArtefact | null;
  chrono: Chrono;
}

// ─────────────────────────── Ouverture ───────────────────────────

/**
 * OUVRE un document. Si la personne a DÉJÀ une session ouverte dessus, on la RÉUTILISE (§36) :
 * ré-ouvrir perdrait les modifications non sauvegardées, et la personne dirait à juste titre
 * qu'Adam a effacé son travail.
 */
export async function ouvrir(
  ctx: ContexteMoteur,
  cible: { nodeId?: string; nom?: string; threadId?: string | null; blockId?: string },
): Promise<ResultatOuverture> {
  const chrono = mesurer();
  const vide = { vue: null, candidats: [] as ResultatOuverture["candidats"] };

  let nodeId = cible.nodeId ?? null;
  if (!nodeId) {
    if (!cible.nom) return { ok: false, motif: "Il faut dire quel document ouvrir.", ...vide, chrono: chrono.fin("open") };
    const trouves = await ctx.ports.documents.chercher(ctx.acteur.id, cible.nom, 6);
    const ouvrables = trouves.filter((f) => f.format !== null);
    if (ouvrables.length === 0) {
      return {
        ok: false,
        motif: `Je ne trouve aucun document bureautique nommé « ${cible.nom} » auquel vous ayez accès.`,
        ...vide, chrono: chrono.fin("open"),
      };
    }
    if (ouvrables.length > 1) {
      // On ne choisit PAS : ouvrir le mauvais contrat et l'annoncer comme le bon est la faute
      // la plus coûteuse de tout ce système.
      return {
        ok: false,
        motif: `${ouvrables.length} documents correspondent à « ${cible.nom} ». Lequel ?`,
        vue: null,
        candidats: ouvrables.map((f) => ({ nodeId: f.nodeId, nom: f.nom, format: String(f.format) })),
        chrono: chrono.fin("open"),
      };
    }
    nodeId = ouvrables[0].nodeId;
  }

  const fiche = await ctx.ports.documents.decrire(ctx.acteur.id, nodeId);
  if (!fiche) {
    return { ok: false, motif: "Ce document n'existe pas, ou vous n'y avez pas accès.", ...vide, chrono: chrono.fin("open") };
  }
  if (!fiche.format) {
    return {
      ok: false,
      motif: `« ${fiche.nom} » n'est pas un document Word, Excel, PowerPoint ou PDF — je ne sais pas l'éditer.`,
      ...vide, chrono: chrono.fin("open"),
    };
  }

  const dejaOuverte = await ctx.magasin.ouverte(ctx.acteur.id, nodeId);
  const session = dejaOuverte ?? await ctx.magasin.creer({
    userId: ctx.acteur.id,
    threadId: cible.threadId ?? null,
    blockId: cible.blockId ?? `artifact-${randomUUID()}`,
    nodeId,
    baseVersion: fiche.version,
    name: fiche.nom,
    format: fiche.format,
    activePage: fiche.format === "PDF" ? 1 : null,
    activeSlide: fiche.format === "PPTX" ? 1 : null,
    activeSheet: null,
    activeSelection: null,
  });

  try {
    const etat = await etatCourant(ctx, session);
    if (!dejaOuverte) await ctx.magasin.majSession(session.id, { state: "OPEN" });
    await ctx.ports.audit.tracer({
      userId: ctx.acteur.id, action: "ARTIFACT_OPEN", cible: nodeId,
      detail: `${fiche.nom} (${fiche.format}) v${fiche.version}`,
    });
    return {
      ok: true, motif: null,
      vue: await construireVue(ctx, { ...session, state: dejaOuverte?.state ?? "OPEN" }, etat),
      candidats: [], chrono: chrono.fin("open"),
    };
  } catch (e) {
    await ctx.magasin.majSession(session.id, { state: "FAILED", lastError: (e as Error).message });
    return { ok: false, motif: `Je n'arrive pas à ouvrir « ${fiche.nom} » : ${(e as Error).message}`, ...vide, chrono: chrono.fin("open") };
  }
}

/** Rejoue la base + les opérations non annulées, ou rend l'état déjà en cache. */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RÉSOUDRE LES OCTETS QU'UN LOT VA POSER — ici, et nulle part ailleurs.
 *
 * ── POURQUOI LE MOTEUR, ET PAS L'ADAPTATEUR ─────────────────────────────────────────────
 *
 * Parce que résoudre veut dire LIRE UN FICHIER, donc franchir une porte de droits. Un
 * adaptateur qui saurait le faire serait un adaptateur capable de lire un document auquel la
 * personne n'a pas accès, puis de le coller dans un autre (§104.9). Le port `documents.lire`
 * reçoit l'identifiant de la personne et refuse pour elle ; on passe par lui, toujours.
 *
 * ── POURQUOI À CHAQUE REJEU, ET PAS UNE FOIS POUR TOUTES ────────────────────────────────
 *
 * L'état d'un document est un REJEU (§104.3). Si la source d'une image devient illisible entre
 * deux ouvertures — droit retiré, fichier supprimé — le rejeu doit ÉCHOUER sur cette opération
 * et le dire, pas ressusciter des octets mis en cache. Une image qu'on n'a plus le droit de
 * lire ne doit pas continuer d'apparaître dans un document qu'on rouvre.
 *
 * Une référence introuvable n'est pas une erreur ICI : c'est l'adaptateur qui refusera, avec le
 * motif exact et le nom de la source. Échouer ici rendrait le lot entier muet.
 */
interface ResolutionRessources {
  trouvees: Map<string, RessourceBinaire>;
  /** Les références qui désignent PLUSIEURS fichiers — on ne choisit pas (§104.7). */
  ambigues: Map<string, { id: string; libelle: string }[]>;
}

async function resoudreRessources(
  ctx: ContexteMoteur,
  commandes: readonly CommandeArtefact[],
): Promise<ResolutionRessources> {
  const refs = new Set<string>();
  for (const c of commandes) if (c.imageSource) refs.add(c.imageSource);
  const res: ResolutionRessources = { trouvees: new Map(), ambigues: new Map() };
  if (refs.size === 0) return res;

  for (const ref of refs) {
    // 1. L'IDENTIFIANT D'ABORD. Exact, sans ambiguïté possible — et c'est ce que rend
    //    `artifact.inspect` quand la personne a déjà désigné le fichier.
    let fiche = await ctx.ports.documents.decrire(ctx.acteur.id, ref).catch(sansBloquer("runtime-engine.resoudreRessources.decrire", null));

    /**
     * 2. LE NOM ENSUITE. Une personne dit « le logo Adventum », pas un cuid. On cherche donc
     *    dans SON Drive — le port filtre par ses droits, un fichier qu'elle ne peut pas voir
     *    n'est pas un candidat.
     *
     *    UN SEUL résultat désigne ce fichier. PLUSIEURS n'en désignent aucun : coller la
     *    mauvaise image dans un contrat et annoncer que c'est fait est exactement le défaut
     *    que §104.7 interdit. On rend les candidats, la personne tranche.
     */
    if (!fiche) {
      const trouves = await ctx.ports.documents.chercher(ctx.acteur.id, ref, 5).catch(sansBloquer("runtime-engine.resoudreRessources.chercher", []));
      if (trouves.length === 1) fiche = trouves[0];
      else if (trouves.length > 1) {
        res.ambigues.set(ref, trouves.map((f) => ({ id: f.nodeId, libelle: f.nom })));
        continue;
      }
    }
    if (!fiche) continue;

    const octets = await ctx.ports.documents.lire(ctx.acteur.id, fiche.nodeId, fiche.version).catch(sansBloquer("runtime-engine.resoudreRessources.lire", null));
    if (!octets) continue;
    res.trouvees.set(ref, { octets, nom: fiche.nom });
  }
  return res;
}

/** Dépose les ressources sur l'adaptateur quand il sait en recevoir — sinon, rien à faire. */
function armerRessources(doc: DocumentOuvert, res: ReadonlyMap<string, RessourceBinaire>): void {
  doc.fournirRessources?.(res);
}

async function etatCourant(ctx: ContexteMoteur, session: SessionPersistee): Promise<EtatOuvert> {
  const enCache = CACHE.get(session.id);
  if (enCache && enCache.revision === session.revision) return enCache;

  const octets = await ctx.ports.documents.lire(ctx.acteur.id, session.nodeId, session.baseVersion);
  if (!octets) throw new Error("le contenu de ce document est introuvable");
  const doc = await adaptateurPour(session.format).ouvrir(octets);
  const proportions = proportionsInitiales(doc.modele());

  const ops = await ctx.magasin.operations(session.id);
  // Les octets dont le REJEU a besoin, relus sous les droits COURANTS de la personne.
  armerRessources(doc, (await resoudreRessources(ctx, ops.filter((o) => !o.undone).map((o) => o.command))).trouvees);
  for (const op of ops) {
    if (op.undone) continue;
    // Un rejeu qui échoue ne doit pas rendre la session inutilisable : on le note et on continue.
    // Le contraire (interrompre) laisserait la personne devant un document figé sans recours.
    const effet = doc.appliquer(op.command);
    if (!effet.ok) {
      await ctx.magasin.majSession(session.id, {
        lastError: `L'opération « ${op.summary} » n'a pas pu être rejouée : ${effet.motif}`,
      });
    }
  }
  const etat: EtatOuvert = { doc, revision: session.revision, proportions };
  mettreEnCache(session.id, etat);
  return etat;
}

// ─────────────────────────── Édition ───────────────────────────

/**
 * APPLIQUE un lot de commandes. `operationId` rend l'opération idempotente : un double clic ou
 * un rejeu réseau ne centre pas le titre deux fois.
 *
 * Une commande refusée n'annule PAS les autres (voir `compile.ts`) : « centre le titre, réduis-le
 * à 16 et remonte le tableau » doit appliquer les deux premières même si la troisième est ambiguë.
 */
export async function editer(
  ctx: ContexteMoteur,
  sessionId: string,
  commandes: CommandeArtefact[],
  opts: { operationId?: string } = {},
): Promise<ResultatEdition> {
  const chrono = mesurer();
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return { ok: false, effets: [], motif: "Aucun document ouvert sous cette référence.", vue: null, chrono: chrono.fin("edit") };
  if (session.state === "CLOSED") return { ok: false, effets: [], motif: "Ce document a été fermé.", vue: null, chrono: chrono.fin("edit") };

  const compile = compilerCommandes(commandes, session.format);
  chrono.etape("commandParse");
  if (compile.commandes.length === 0) {
    const motif = compile.refus.map((r) => `« ${r.op} » : ${r.motif}`).join(" ; ");
    return { ok: false, effets: [], motif: motif || "Aucune commande exploitable.", vue: null, chrono: chrono.fin("edit") };
  }

  const dejaFaites = await ctx.magasin.operations(session.id);
  const seqDepart = dejaFaites.reduce((m, o) => Math.max(m, o.seq), 0);
  const clesConnues = new Set(dejaFaites.map((o) => o.operationId));

  const etat = await etatCourant(ctx, session);
  const ressources = await resoudreRessources(ctx, compile.commandes);
  armerRessources(etat.doc, ressources.trouvees);
  const effets: EffetCommande[] = [];
  let revision = session.revision;
  let seq = seqDepart;
  let nAppliquees = 0;
  let course = false;

  for (const [i, cmd] of compile.commandes.entries()) {
    // Sur un lot, chaque commande a sa propre clé dérivée : rejouer le lot entier reste
    // idempotent commande par commande.
    const cle = opts.operationId ? `${opts.operationId}#${i}` : randomUUID();

    /**
     * L'IDEMPOTENCE SE VÉRIFIE AVANT D'APPLIQUER, ET C'EST TOUT LE POINT.
     *
     * La vérifier après — en se fiant au refus d'écriture du journal — laisserait la commande
     * s'appliquer au document EN MÉMOIRE avant d'être rejetée. Un double clic sur « supprime le
     * deuxième paragraphe » supprimerait alors le deuxième, puis le troisième, tout en
     * répondant « déjà fait ». Le journal serait juste, l'écran serait faux, et l'écart ne se
     * verrait qu'à la sauvegarde.
     */
    if (clesConnues.has(cle)) {
      effets.push({ ok: false, resume: "", motif: "Cette modification a déjà été appliquée.", touches: [], candidats: [] });
      continue;
    }

    /**
     * UNE SOURCE AMBIGUË S'ARRÊTE ICI, avec ses candidats.
     *
     * L'adaptateur ne saurait dire que « le fichier n'a pas pu être lu » — il ne connaît ni le
     * Drive ni la recherche. Le moteur, lui, sait qu'il y avait DEUX « logo Adventum », et
     * c'est cette information-là qui permet de trancher en une phrase au lieu d'aller chercher.
     */
    const candidats = cmd.imageSource ? ressources.ambigues.get(cmd.imageSource) : undefined;
    if (candidats) {
      effets.push({
        ok: false, resume: "", touches: [], candidats,
        motif: `« ${cmd.imageSource} » désigne ${candidats.length} fichiers : lequel ?`,
      });
      continue;
    }

    const effet = etat.doc.appliquer(cmd);
    effets.push(effet);
    if (!effet.ok) continue;
    seq += 1;
    const avant = revision;
    revision += 1;
    const ecrite = await ctx.magasin.ajouterOperation(session.id, {
      operationId: cle,
      seq, beforeVersion: avant, afterVersion: revision,
      command: cmd, summary: effet.resume,
      actorId: ctx.acteur.id, actorLabel: ctx.acteur.libelle,
      undone: false, createdAt: new Date(), touches: effet.touches.length ? effet.touches : null,
    });
    if (!ecrite) {
      // Une requête CONCURRENTE a gagné la course entre notre vérification et l'écriture. Le
      // document en mémoire porte maintenant une modification de trop : on le jette et on
      // rejouera depuis le journal, qui fait autorité.
      revision = avant;
      seq -= 1;
      course = true;
      effets[effets.length - 1] = { ok: false, resume: "", motif: "Cette modification a déjà été appliquée.", touches: [], candidats: [] };
      break;
    }
    clesConnues.add(cle);
    nAppliquees += 1;
  }
  chrono.etape("commandApply");

  if (course) oublierSession(session.id);

  for (const r of compile.refus) {
    effets.push({ ok: false, resume: "", motif: `« ${r.op} » : ${r.motif}`, touches: [], candidats: [] });
  }

  if (nAppliquees > 0) {
    if (!course) {
      etat.revision = revision;
      mettreEnCache(session.id, etat);
    }
    await ctx.magasin.majSession(session.id, { revision, dirty: true, state: "DIRTY", lastError: null });
    await ctx.ports.audit.tracer({
      userId: ctx.acteur.id, action: "ARTIFACT_EDIT", cible: session.nodeId,
      detail: effets.filter((e) => e.ok).map((e) => e.resume).join(" | ").slice(0, 500),
    });
  }

  const sessionMaj = { ...session, revision, dirty: session.dirty || nAppliquees > 0, state: nAppliquees > 0 ? "DIRTY" : session.state };
  const vue = await construireVue(ctx, sessionMaj, etat, effets.flatMap((e) => e.touches));
  return {
    ok: nAppliquees > 0,
    effets,
    motif: nAppliquees > 0 ? null : effets.find((e) => !e.ok)?.motif ?? "Aucune modification appliquée.",
    vue,
    chrono: chrono.fin("edit"),
  };
}

// ─────────────────────────── Annuler / Rétablir ───────────────────────────

export async function annuler(ctx: ContexteMoteur, sessionId: string): Promise<ResultatEdition> {
  return bougerHistorique(ctx, sessionId, "annuler");
}

export async function retablir(ctx: ContexteMoteur, sessionId: string): Promise<ResultatEdition> {
  return bougerHistorique(ctx, sessionId, "retablir");
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REVUE D'UNE OPÉRATION (Atelier, J3) — accepter, refuser, remettre à revoir, comme le suivi des
 * modifications de Word.
 *
 * Refuser une opération qui n'est PAS la dernière ne demande, ici non plus, aucune commande inverse :
 * on la marque annulée et on REJOUE (§104.3). Les opérations suivantes se rejouent sur l'état sans elle ;
 * une qui n'a plus de cible (elle visait le paragraphe que la refusée avait inséré) est sautée par le
 * rejeu — la vue, reconstruite, montre ce qui est VRAIMENT là.
 *
 * Accepter ne change pas le document : c'est un jugement, porté au journal. « À revoir » efface le
 * jugement et rétablit l'opération si elle avait été refusée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function revoir(
  ctx: ContexteMoteur,
  sessionId: string,
  seq: number,
  decision: "ACCEPTER" | "REFUSER" | "A_REVOIR",
): Promise<ResultatEdition> {
  const chrono = mesurer();
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return { ok: false, effets: [], motif: "Aucun document ouvert sous cette référence.", vue: null, chrono: chrono.fin("review") };
  if (!ctx.magasin.marquerRevue) return { ok: false, effets: [], motif: "La revue n'est pas disponible ici.", vue: null, chrono: chrono.fin("review") };
  const op = (await ctx.magasin.operations(session.id)).find((o) => o.seq === seq);
  if (!op) return { ok: false, effets: [], motif: "Cette modification n'existe pas dans l'historique.", vue: null, chrono: chrono.fin("review") };

  const annulee = decision === "REFUSER";
  const revue: RevueOperation | null = decision === "ACCEPTER" ? "ACCEPTEE" : decision === "REFUSER" ? "REFUSEE" : null;
  await ctx.magasin.marquerRevue(session.id, seq, revue);
  let revision = session.revision;
  if (op.undone !== annulee) {
    await ctx.magasin.marquerAnnulee(session.id, seq, annulee);
    revision += 1;
    oublierSession(session.id);
    await ctx.magasin.majSession(session.id, { revision, dirty: true, state: "DIRTY" });
  }
  const maj = { ...session, revision, ...(op.undone !== annulee ? { dirty: true, state: "DIRTY" } : {}) };
  const etat = await etatCourant(ctx, maj);
  const resume = decision === "ACCEPTER" ? `Accepté : ${op.summary}` : decision === "REFUSER" ? `Refusé : ${op.summary}` : `À revoir : ${op.summary}`;
  await ctx.ports.audit.tracer({
    userId: ctx.acteur.id, action: decision === "REFUSER" ? "ARTIFACT_REJECT" : decision === "ACCEPTER" ? "ARTIFACT_ACCEPT" : "ARTIFACT_REVIEW_RESET",
    cible: session.nodeId, detail: op.summary.slice(0, 300),
  });
  return {
    ok: true,
    effets: [{ ok: true, resume, motif: null, touches: annulee ? [] : (op.touches ?? []), candidats: [] }],
    motif: null,
    vue: await construireVue(ctx, maj, etat, annulee ? [] : (op.touches ?? [])),
    chrono: chrono.fin("review"),
  };
}

async function bougerHistorique(ctx: ContexteMoteur, sessionId: string, sens: "annuler" | "retablir"): Promise<ResultatEdition> {
  const chrono = mesurer();
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return { ok: false, effets: [], motif: "Aucun document ouvert sous cette référence.", vue: null, chrono: chrono.fin(sens) };

  const ops = (await ctx.magasin.operations(session.id)).sort((a, b) => a.seq - b.seq);
  const cible = sens === "annuler"
    ? [...ops].reverse().find((o) => !o.undone)
    : ops.find((o) => o.undone);
  if (!cible) {
    return {
      ok: false, effets: [],
      motif: sens === "annuler" ? "Il n'y a rien à annuler sur ce document." : "Il n'y a rien à rétablir.",
      vue: null, chrono: chrono.fin(sens),
    };
  }
  await ctx.magasin.marquerAnnulee(session.id, cible.seq, sens === "annuler");

  /**
   * L'INCRÉMENT DE RÉVISION EST CE QUI FORCE LE REJEU.
   *
   * Le cache d'états ouverts est indexé par `(sessionId, revision)` : en changeant la révision,
   * on garantit un défaut de cache, donc une reconstruction depuis la version Drive de base et
   * le journal. C'est ce qui rend l'annulation EXACTE pour les quatre formats, sans écrire une
   * seule commande inverse.
   *
   * La purge explicite qui suit est une ceinture en plus de la bretelle : elle libère la mémoire
   * tout de suite plutôt qu'à la prochaine éviction. Un sabotage l'a montrée redondante — les
   * tests passaient sans elle — et c'est dit ici plutôt que de laisser croire qu'elle porte la
   * propriété.
   */
  const revision = session.revision + 1;
  oublierSession(session.id);
  await ctx.magasin.majSession(session.id, { revision, dirty: true, state: "DIRTY" });
  const etat = await etatCourant(ctx, { ...session, revision });
  chrono.etape("commandApply");

  const resume = sens === "annuler" ? `Annulé : ${cible.summary}` : `Rétabli : ${cible.summary}`;
  await ctx.ports.audit.tracer({
    userId: ctx.acteur.id, action: sens === "annuler" ? "ARTIFACT_UNDO" : "ARTIFACT_REDO",
    cible: session.nodeId, detail: cible.summary.slice(0, 300),
  });
  return {
    ok: true,
    effets: [{ ok: true, resume, motif: null, touches: [], candidats: [] }],
    motif: null,
    vue: await construireVue(ctx, { ...session, revision, dirty: true, state: "DIRTY" }, etat),
    chrono: chrono.fin(sens),
  };
}

// ─────────────────────────── Sauvegarde ───────────────────────────

/**
 * SAUVEGARDE en créant une NOUVELLE version Drive (§19-21).
 *
 * Séquence : sérialiser → RELIRE ce qu'on vient de produire → écrire seulement si la relecture
 * passe. Un document illisible ne remplace jamais un document lisible (§48).
 *
 * `verrou` implémente §50 : si quelqu'un d'autre a écrit une version pendant qu'on éditait, on
 * REFUSE et on le dit, plutôt que d'écraser silencieusement son travail.
 */
export async function sauvegarder(
  ctx: ContexteMoteur,
  sessionId: string,
  opts: { sousLeNom?: string; forcer?: boolean } = {},
): Promise<ResultatSauvegarde> {
  const chrono = mesurer();
  const rien = { version: null, nodeId: null, vue: null };
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return { ok: false, motif: "Aucun document ouvert sous cette référence.", ...rien, chrono: chrono.fin("save") };

  const etat = await etatCourant(ctx, session);
  if (!session.dirty && !opts.sousLeNom) {
    return {
      ok: true, motif: "Ce document n'a aucune modification à enregistrer.",
      version: session.savedVersion ?? session.baseVersion, nodeId: session.nodeId,
      vue: await construireVue(ctx, session, etat), chrono: chrono.fin("save"),
    };
  }

  await ctx.magasin.majSession(session.id, { state: "SAVING" });
  try {
    const validation = await etat.doc.valider();
    if (!validation.ok) {
      await ctx.magasin.majSession(session.id, { state: "FAILED", lastError: validation.problemes.join(" ; ") });
      return {
        ok: false,
        motif: `Je n'enregistre pas : le fichier produit ne serait pas lisible (${validation.problemes.join(" ; ")}).`,
        ...rien, chrono: chrono.fin("save"),
      };
    }
    const octets = await etat.doc.serialiser();
    chrono.etape("serialize");

    if (opts.sousLeNom) {
      const cree = await ctx.ports.documents.creerFichier(ctx.acteur.id, {
        nom: opts.sousLeNom, octets, mime: mimeDe(session.format),
      });
      await ctx.ports.audit.tracer({
        userId: ctx.acteur.id, action: "ARTIFACT_SAVE_AS", cible: cree.nodeId,
        detail: `${opts.sousLeNom} depuis ${session.name}`,
      });
      await ctx.magasin.majSession(session.id, { state: "SAVED" });
      return {
        ok: true, motif: null, version: cree.version, nodeId: cree.nodeId,
        vue: await construireVue(ctx, { ...session, state: "SAVED" }, etat), chrono: chrono.fin("save"),
      };
    }

    // §50 — le verrou optimiste. La version courante du Drive doit être celle qu'on a ouverte.
    const fiche = await ctx.ports.documents.decrire(ctx.acteur.id, session.nodeId);
    const attendue = session.savedVersion ?? session.baseVersion;
    if (fiche && fiche.version !== attendue && !opts.forcer) {
      await ctx.magasin.majSession(session.id, { state: "DIRTY" });
      return {
        ok: false,
        motif: `Quelqu'un a enregistré une version ${fiche.version} de « ${session.name} » pendant que vous travailliez (vous êtes parti de la ${attendue}). Vos modifications sont conservées : dites-moi si je dois enregistrer par-dessus, ou enregistrer sous un autre nom.`,
        ...rien, chrono: chrono.fin("save"),
      };
    }

    const ecrite = await ctx.ports.documents.ecrireVersion(ctx.acteur.id, session.nodeId, octets, {
      mime: mimeDe(session.format),
      resume: resumeDesModifications(await ctx.magasin.operations(session.id)),
    });
    await ctx.magasin.majSession(session.id, {
      state: "SAVED", dirty: false, savedVersion: ecrite.version, lastError: null,
    });
    await ctx.ports.audit.tracer({
      userId: ctx.acteur.id, action: "ARTIFACT_SAVE", cible: session.nodeId,
      detail: `${session.name} → version ${ecrite.version}`,
    });
    return {
      ok: true, motif: null, version: ecrite.version, nodeId: session.nodeId,
      vue: await construireVue(ctx, { ...session, state: "SAVED", dirty: false, savedVersion: ecrite.version }, etat),
      chrono: chrono.fin("save"),
    };
  } catch (e) {
    await ctx.magasin.majSession(session.id, { state: "FAILED", lastError: (e as Error).message });
    return { ok: false, motif: `L'enregistrement a échoué : ${(e as Error).message}`, ...rien, chrono: chrono.fin("save") };
  }
}

/** Le résumé versé au Drive (§22) — ce qu'on lira dans trois mois pour savoir ce qui a changé. */
export function resumeDesModifications(ops: OperationPersistee[]): string {
  const vivantes = ops.filter((o) => !o.undone).sort((a, b) => a.seq - b.seq);
  if (vivantes.length === 0) return "Aucune modification.";
  const resumes = vivantes.map((o) => o.summary.replace(/\s+/g, " ").trim());
  const texte = resumes.join(" ; ");
  return texte.length <= 480 ? texte : `${resumes.length} modifications : ${texte.slice(0, 460)}…`;
}

// ─────────────────────────── Fermeture, sélection, vue ───────────────────────────

export async function fermer(ctx: ContexteMoteur, sessionId: string): Promise<{ ok: boolean; motif: string | null; perdues: boolean }> {
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return { ok: false, motif: "Aucun document ouvert sous cette référence.", perdues: false };
  await ctx.magasin.fermer(session.id);
  oublierSession(session.id);
  return { ok: true, motif: null, perdues: session.dirty };
}

/** Met à jour le working set (§4) : page, diapo, feuille, sélection cliquée. */
export async function viser(
  ctx: ContexteMoteur,
  sessionId: string,
  ou: { page?: number | null; diapo?: number | null; feuille?: string | null; selection?: string[] | null },
): Promise<ResultatEdition> {
  const chrono = mesurer();
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return { ok: false, effets: [], motif: "Aucun document ouvert sous cette référence.", vue: null, chrono: chrono.fin("aim") };
  const champs: Partial<SessionPersistee> = {};
  if (ou.page !== undefined) champs.activePage = ou.page;
  if (ou.diapo !== undefined) champs.activeSlide = ou.diapo;
  if (ou.feuille !== undefined) champs.activeSheet = ou.feuille;
  if (ou.selection !== undefined) champs.activeSelection = ou.selection;
  await ctx.magasin.majSession(session.id, champs);
  const fusion = { ...session, ...champs };
  const etat = await etatCourant(ctx, fusion);
  return { ok: true, effets: [], motif: null, vue: await construireVue(ctx, fusion, etat), chrono: chrono.fin("aim") };
}

/**
 * « QU'EST-CE QUE TU AS CHANGÉ ? » (§52) — la réponse CONSTATÉE, pas racontée.
 *
 * ── POURQUOI PAS SIMPLEMENT RELIRE LE JOURNAL ───────────────────────────────────────────
 *
 * `resumeDesModifications` redit ce qu'on a DEMANDÉ ; c'est ce que le workspace affiche sous
 * la barre, et c'est la bonne chose à cet endroit. Mais entre la version d'origine et l'état
 * courant, une opération a pu être rejouée sans effet (sa cible avait disparu), et le journal
 * l'annoncerait quand même. Ici on relit la version de base, on la compare au modèle courant,
 * et on rend ce qui DIFFÈRE réellement.
 *
 * ── DEUX BORNES, PAS TROIS ──────────────────────────────────────────────────────────────
 *
 * `depuis` permet de choisir la version de départ : sans elle, la comparaison part de la
 * version sur laquelle la session s'est ouverte (« depuis que je l'ai ouvert ») ; avec elle,
 * de n'importe quelle version du Drive (« par rapport à la v3 »). Le point d'arrivée est
 * toujours l'état COURANT, y compris non sauvegardé — c'est celui qu'on a sous les yeux.
 */
export async function comparerDepuis(
  ctx: ContexteMoteur,
  sessionId: string,
  depuis?: number,
): Promise<Comparaison> {
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return { ok: false, motif: "Aucun document ouvert sous cette référence.", changements: [], resume: "" };

  const version = depuis ?? session.baseVersion;
  const octets = await ctx.ports.documents.lire(ctx.acteur.id, session.nodeId, version);
  if (!octets) {
    return { ok: false, motif: `La version ${version} de « ${session.name} » est introuvable.`, changements: [], resume: "" };
  }

  const origine = await adaptateurPour(session.format).ouvrir(octets);
  const etat = await etatCourant(ctx, session);
  return comparer(origine.modele(), etat.doc.modele());
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « QUE DIT LE TAMPON SUR LA PAGE 4 ? » — LIRE une image que le document PORTE.
 *
 * ── POURQUOI CE CHEMIN, ET PAS « JOINDRE LE FICHIER À LA CONVERSATION » ─────────────────
 *
 * Un contrat scanné, un tampon d'homologation, un graphique collé dans un deck, une photo
 * d'étiquette dans un classeur : le texte du fichier n'en dit RIEN. Aujourd'hui la seule
 * façon de les lire était de télécharger le document et de le rejoindre en pièce — c'est-à-dire
 * de sortir du document ouvert, donc du contexte, des droits vérifiés et de la session.
 *
 * ── LE PARTAGE DES RÔLES, QUI EST LA RAISON D'ÊTRE DE CETTE FONCTION ───────────────────
 *
 * L'ADAPTATEUR sait OÙ sont les octets et rien d'autre. Le PORT sait les lire et ne sait rien
 * du document. Le moteur les met bout à bout — et c'est ici, et seulement ici, que les droits
 * ont déjà été vérifiés : `magasin.lire` refuse une session qui n'est pas à cette personne.
 *
 * Ce que la fonction ne fait JAMAIS : conclure. Elle rend le texte lu ET la note qui dit
 * comment il a été obtenu. Un OCR et un modèle de vision se trompent ; livrer leur sortie
 * sans sa méthode la ferait citer comme une certitude (§29).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ResultatLectureImage {
  ok: boolean;
  motif: string | null;
  /** Candidats à départager quand la désignation visait plusieurs images (§104.7). */
  candidats: { id: string; libelle: string }[];
  /** Où l'image se trouve, en clair — « diapositive 3, forme 2 », « page 4 ». */
  ou: string | null;
  texte: string;
  /** Ce que l'auteur du document avait écrit comme texte alternatif, s'il y en a un. */
  description: string | null;
  /** Méthode, confiance, durée. Voyage AVEC le texte, toujours. */
  note: string | null;
}

const echecLecture = (motif: string, candidats: { id: string; libelle: string }[] = []): ResultatLectureImage =>
  ({ ok: false, motif, candidats, ou: null, texte: "", description: null, note: null });

export async function lireImageDuDocument(
  ctx: ContexteMoteur,
  sessionId: string,
  ou: { cible?: Cible | null; feuille?: string | null; diapo?: number | null; page?: number | null },
): Promise<ResultatLectureImage> {
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return echecLecture("Aucun document ouvert sous cette référence.");

  const vision = ctx.ports.vision;
  if (!vision) {
    // PAS « la lecture a échoué » : rien n'a été tenté. Un composeur sans vision est une
    // limite d'INSTALLATION, et la nommer envoie au bon endroit (§34).
    return echecLecture("la lecture d'image n'est pas branchée sur cette installation — les octets sont là, mais rien ici ne sait les regarder");
  }

  const etat = await etatCourant(ctx, session);
  if (!etat.doc.extraireImage) {
    return echecLecture(`le format ${session.format} ne porte pas d'image lisible de cette façon`);
  }

  // LE WORKING SET COMPLÈTE la demande, il ne la remplace pas : « lis le tampon » alors qu'on
  // regarde la page 4 vise la page 4, et « lis le tampon page 7 » vise la 7 (§104.4).
  const extrait = await etat.doc.extraireImage({
    cible: ou.cible ?? null,
    feuille: ou.feuille ?? session.activeSheet ?? null,
    diapo: ou.diapo ?? session.activeSlide ?? null,
    pages: ou.page ? [ou.page] : (session.activePage ? [session.activePage] : null),
  });
  if (!extrait.ok) return echecLecture(extrait.motif, extrait.candidats);

  const lue = await vision.lire(ctx.acteur.id, extrait.image.octets, extrait.image.nom);
  await ctx.ports.audit.tracer({
    userId: ctx.acteur.id,
    action: "artifact.image.lire",
    cible: session.nodeId,
    detail: `${session.name} — ${extrait.image.ou}`,
  });
  return {
    ok: true,
    motif: null,
    candidats: [],
    ou: extrait.image.ou,
    texte: lue.texte,
    description: extrait.image.description,
    note: lue.note,
  };
}

/**
 * LES OCTETS D'UNE IMAGE, SANS LA LIRE — ce dont le workspace a besoin pour l'AFFICHER.
 *
 * `lireImageDuDocument` appelle le port de vision, ce qui coûte un OCR ; afficher une image
 * n'en demande pas. Le chemin est le même à cela près : mêmes droits (`magasin.lire` refuse une
 * session qui n'est pas à cette personne), même état courant, même extraction.
 */
export async function octetsImageDeSession(
  ctx: ContexteMoteur, sessionId: string, imageId: string,
): Promise<{ ok: true; octets: Buffer; mime: string } | { ok: false; motif: string }> {
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return { ok: false, motif: "session" };
  const etat = await etatCourant(ctx, session);
  if (!etat.doc.extraireImage) return { ok: false, motif: `le format ${session.format} ne porte pas d'image affichable` };

  const extrait = await etat.doc.extraireImage({
    cible: { ...CIBLE_VIDE, id: imageId }, feuille: null, diapo: null, pages: null,
  });
  if (!extrait.ok) return { ok: false, motif: extrait.motif };
  const lue = lireImage(extrait.image.octets);
  // Un type inconnu est SERVI en `application/octet-stream` : le navigateur n'affichera rien,
  // ce qui est honnête. Deviner `image/png` ferait afficher un cadre cassé sans explication.
  return { ok: true, octets: extrait.image.octets, mime: lue?.mime ?? "application/octet-stream" };
}

/** L'état complet d'une session, tel que le workspace le dessine. */
/**
 * LE CONTRÔLE AVANT LIVRAISON d'une session : ce qui BLOQUE (un reste de brouillon, une diapo
 * sans titre, une cellule en erreur) et ce qui avertit. Ne modifie rien ; la personne décide.
 */
export async function controlerSession(ctx: ContexteMoteur, sessionId: string): Promise<(ControleLivraison & { nom: string; format: ArtifactFormat }) | null> {
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return null;
  const etat = await etatCourant(ctx, session);
  return { ...controlerAvantLivraison(etat.doc.modele(), etat.proportions), nom: session.name, format: session.format };
}

export async function vueDeSession(ctx: ContexteMoteur, sessionId: string): Promise<VueArtefact | null> {
  const session = await ctx.magasin.lire(sessionId, ctx.acteur.id);
  if (!session) return null;
  return construireVue(ctx, session, await etatCourant(ctx, session));
}

async function construireVue(
  ctx: ContexteMoteur,
  session: SessionPersistee,
  etat: EtatOuvert,
  surbrillance: string[] = [],
): Promise<VueArtefact> {
  const modele: ArtifactModel = etat.doc.modele();
  const ops = (await ctx.magasin.operations(session.id)).sort((a, b) => a.seq - b.seq);
  return {
    sessionId: session.id,
    blockId: session.blockId,
    nodeId: session.nodeId,
    nom: session.name,
    format: session.format,
    etat: session.state,
    revision: session.revision,
    dirty: session.dirty,
    baseVersion: session.baseVersion,
    savedVersion: session.savedVersion,
    activePage: session.activePage,
    activeSlide: session.activeSlide,
    activeSheet: session.activeSheet,
    surbrillance: surbrillance.length ? [...new Set(surbrillance)] : (session.activeSelection ?? []),
    peutAnnuler: ops.some((o) => !o.undone),
    peutRetablir: ops.some((o) => o.undone),
    historique: ops.map((o) => ({
      operationId: o.operationId, seq: o.seq, resume: o.summary,
      annulee: o.undone, quand: o.createdAt.toISOString(),
      revue: o.revue ?? null, touches: o.touches ?? [], acteur: o.actorLabel,
    })),
    contenu: vueDuModele(modele),
    alertes: controlerVisuel(modele, etat.proportions),
  };
}
