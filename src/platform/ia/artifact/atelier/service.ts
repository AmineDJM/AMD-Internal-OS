/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ATELIER, CÔTÉ SERVEUR (J3, décision 0017) — des documents ouverts côte à côte, modifiés EN PLACE.
 *
 * Ce n'est pas un moteur de plus : c'est le Live Office (§104) vu par onglets. Un onglet = une
 * `ArtifactSession` dont le `blockId` commence par `atelier-` ; l'état = version Drive + journal rejoué ;
 * enregistrer = une NOUVELLE version Drive (jamais d'écrasement), inscrite à la Bibliothèque par le port.
 *
 * Ce que l'Atelier ajoute au moteur :
 *   • les DROITS dits d'avance — voir n'est pas modifier : un document qu'on peut lire mais pas écrire
 *     s'ouvre en lecture seule, et la modification est refusée AVANT d'être appliquée (pas à
 *     l'enregistrement, quand la personne aurait déjà vu des changements qu'elle ne peut pas garder) ;
 *   • les GESTES (`gestes.ts`) appliqués UN PAR UN, avec un pas : chacun devient une ligne d'historique
 *     et une révision que l'écran relit et anime pendant que l'assistant travaille ;
 *   • la REVUE (accepter / refuser / à revoir) et la COMPARAISON avant / après ;
 *   • le repère des documents SENSIBLES (pièce juridique, courrier, espace partagé) : leur enregistrement
 *     passe par une carte de confirmation — décidé par l'appelant, qui connaît son produit.
 *
 * Appartient au socle : Adam pourra ouvrir le même Atelier. N'importe ni Adam ni l'Assistant IA.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from "node:crypto";
import {
  comparerDocument, contexte, editerDocument, fermerDocument, ouvrirDocument, revoirDocument, sauvegarderDocument,
  vueDeVersionDocument, vueDocument, type Personne,
} from "@/platform/ia/artifact/office";
import { documentSensible, droitsSurDocument } from "@/platform/ia/artifact/ports";
import { ongletsDe, rattacherAuxOnglets } from "@/platform/ia/artifact/store";
import type { VueArtefact, VueContenu } from "@/platform/ia/artifact/view-types";
import { traduireGeste, type GesteAtelier } from "./gestes";

// Les droits et le repère « sensible » vivent au port (il connaît le Drive) ; l'Atelier les réexpose à ses appelants.
export { documentSensible, droitsSurDocument };
type CurrentUser = Personne;

export const PREFIXE_ATELIER = "atelier-";
const VIVANTS = ["OPENING", "OPEN", "EDITING", "DIRTY", "SAVING", "SAVED"] as const;
/** Le pas entre deux gestes appliqués par l'assistant : l'écran a le temps de montrer chacun (relu toutes les ~0,6 s). */
export const PAS_GESTES_MS = 700;

export interface Droits { voir: boolean; modifier: boolean }

export interface OngletAtelier {
  sessionId: string;
  nodeId: string;
  nom: string;
  format: string;
  revision: number;
  dirty: boolean;
  baseVersion: number;
  savedVersion: number | null;
  etat: string;
}

/** Les onglets ouverts de la personne — ce que l'écran relit pour savoir s'il doit redessiner. */
export async function ongletsAtelier(userId: string): Promise<OngletAtelier[]> {
  const lignes = await ongletsDe(userId, PREFIXE_ATELIER);
  return lignes.map((l) => ({
    sessionId: l.id, nodeId: l.nodeId, nom: l.name, format: l.format, revision: l.revision, dirty: l.dirty,
    baseVersion: l.baseVersion, savedVersion: l.savedVersion, etat: l.state,
  }));
}

export interface OuvertureAtelier {
  ok: boolean;
  motif: string | null;
  vue: VueArtefact | null;
  droits: Droits;
  candidats: { nodeId: string; nom: string; format: string }[];
}

/** OUVRE un document dans l'Atelier — par identifiant (pièce, clic) ou par nom (phrase). Droits de l'écran. */
export async function ouvrirDansAtelier(user: CurrentUser, cible: { nodeId?: string; nom?: string }): Promise<OuvertureAtelier> {
  const ferme: Droits = { voir: false, modifier: false };
  const r = await ouvrirDocument(user, { ...cible, blockId: `${PREFIXE_ATELIER}${randomUUID()}` });
  if (!r.ok || !r.vue) return { ok: false, motif: r.motif, vue: null, droits: ferme, candidats: r.candidats };
  // Une session déjà ouverte ailleurs (le workspace d'Adam) est RÉUTILISÉE (§36) : elle rejoint les onglets.
  if (!r.vue.blockId.startsWith(PREFIXE_ATELIER)) {
    const blockId = `${PREFIXE_ATELIER}${r.vue.blockId}`;
    await rattacherAuxOnglets(r.vue.sessionId, blockId);
    r.vue.blockId = blockId;
  }
  return { ok: true, motif: null, vue: r.vue, droits: await droitsSurDocument(user.id, r.vue.nodeId), candidats: [] };
}

export const vueAtelier = (user: CurrentUser, sessionId: string) => vueDocument(user, sessionId);

export interface GesteApplique {
  geste: string;
  ok: boolean;
  resumes: string[];
  motif: string | null;
  /** Plusieurs cibles possibles (§104.7) — le modèle doit trancher, jamais l'Atelier. */
  candidats: string[];
}

export interface ResultatGestes {
  ok: boolean;
  motif: string | null;
  gestes: GesteApplique[];
  vue: VueArtefact | null;
}

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * APPLIQUE des gestes, UN PAR UN, sur le fichier d'origine. Chaque commande traduite est éditée seule : une
 * ligne d'historique, une révision, que l'écran voit arriver. Un geste refusé (traduction, cible ambiguë) est
 * DIT et n'arrête pas les suivants — comme un lot du Live Office (§104.6).
 */
export async function appliquerGestes(
  user: CurrentUser,
  sessionId: string,
  gestes: GesteAtelier[],
  opts: { pasMs?: number; cle?: string } = {},
): Promise<ResultatGestes> {
  const ctx = contexte(user);
  const session = await ctx.magasin.lire(sessionId, user.id);
  if (!session) return { ok: false, motif: "Aucun document ouvert sous cette référence dans l'Atelier.", gestes: [], vue: null };
  const droits = await droitsSurDocument(user.id, session.nodeId);
  if (!droits.voir) return { ok: false, motif: "Vous n'avez plus accès à ce document.", gestes: [], vue: null };
  if (!droits.modifier) {
    return { ok: false, motif: `Vous pouvez lire « ${session.name} », pas le modifier : le Drive ne vous donne pas ce droit. Rien n'a été changé.`, gestes: [], vue: null };
  }
  const pas = opts.pasMs ?? PAS_GESTES_MS;
  const out: GesteApplique[] = [];
  let vue: VueArtefact | null = await vueDocument(user, sessionId);
  let premiere = true;
  for (const [i, g] of gestes.entries()) {
    if (!vue) break;
    const t = traduireGeste(g, vue.contenu);
    if (t.refus) { out.push({ geste: String(g.action), ok: false, resumes: [], motif: t.refus, candidats: [] }); continue; }
    const resumes: string[] = [];
    const motifs: string[] = [];
    const candidats: string[] = [];
    for (const [j, c] of t.commandes.entries()) {
      if (!premiere && pas > 0) await attendre(pas);
      premiere = false;
      const r = await editerDocument(user, sessionId, [c], opts.cle ? `${opts.cle}#${i}.${j}` : undefined);
      for (const e of r.effets) {
        if (e.ok) resumes.push(e.resume);
        else if (e.motif) motifs.push(e.motif);
        candidats.push(...e.candidats.map((x) => x.libelle));
      }
      if (r.vue) vue = r.vue;
    }
    out.push({ geste: String(g.action), ok: resumes.length > 0, resumes, motif: motifs.length ? [...new Set(motifs)].join(" ; ") : null, candidats });
  }
  return { ok: out.some((g) => g.ok), motif: out.some((g) => g.ok) ? null : out.map((g) => g.motif).filter(Boolean).join(" ; ") || "Aucun geste appliqué.", gestes: out, vue };
}

/** ACCEPTER / REFUSER / remettre À REVOIR une modification de l'historique. */
export async function revoirModification(user: CurrentUser, sessionId: string, seq: number, decision: "ACCEPTER" | "REFUSER" | "A_REVOIR") {
  return revoirDocument(user, sessionId, seq, decision);
}

/** Accepter TOUT ce qui n'a pas été revu (refusées comprises : elles restent refusées). */
export async function toutAccepter(user: CurrentUser, sessionId: string) {
  const ctx = contexte(user);
  const session = await ctx.magasin.lire(sessionId, user.id);
  if (!session) return null;
  const ops = await ctx.magasin.operations(session.id);
  let r = null;
  for (const o of ops) if (!o.undone && !o.revue) r = await revoirDocument(user, sessionId, o.seq, "ACCEPTER");
  return r?.vue ?? (await vueDocument(user, sessionId));
}

export interface Enregistrement {
  ok: boolean;
  motif: string | null;
  version: number | null;
  nodeId: string | null;
  vue: VueArtefact | null;
}

/**
 * ENREGISTRE une NOUVELLE VERSION Drive (`FileVersion`) — jamais un écrasement : la précédente reste
 * ouvrable (§104, port `ecrireVersion`), et la Bibliothèque reçoit la nouvelle (inscription au port).
 * `sousLeNom` = un nouveau fichier, l'original intact.
 */
export async function enregistrerAtelier(user: CurrentUser, sessionId: string, opts: { sousLeNom?: string } = {}): Promise<Enregistrement> {
  const ctx = contexte(user);
  const session = await ctx.magasin.lire(sessionId, user.id);
  if (!session) return { ok: false, motif: "Aucun document ouvert sous cette référence.", version: null, nodeId: null, vue: null };
  const droits = await droitsSurDocument(user.id, session.nodeId);
  if (!opts.sousLeNom && !droits.modifier) {
    return { ok: false, motif: "Vous n'avez pas le droit de modifier ce document : enregistrez sous un autre nom (une copie dans votre Drive).", version: null, nodeId: null, vue: null };
  }
  const r = await sauvegarderDocument(user, sessionId, opts);
  return { ok: r.ok, motif: r.motif, version: r.version, nodeId: r.nodeId, vue: r.vue };
}

export interface Comparatif {
  ok: boolean;
  motif: string | null;
  avant: VueContenu | null;
  apres: VueContenu | null;
  comparaison: Awaited<ReturnType<typeof comparerDocument>> | null;
  versionAvant: number | null;
}

/** COMPARER : la version d'origine et l'état courant, côte à côte, avec ce qui diffère RÉELLEMENT (§52). */
export async function comparerAtelier(user: CurrentUser, sessionId: string, depuis?: number): Promise<Comparatif> {
  const vide = { avant: null, apres: null, comparaison: null, versionAvant: null };
  const avant = await vueDeVersionDocument(user, sessionId, depuis);
  if (!avant) return { ok: false, motif: "Cette version est introuvable, ou ce document n'est plus accessible.", ...vide };
  const courante = await vueDocument(user, sessionId);
  const comparaison = await comparerDocument(user, sessionId, avant.version);
  return { ok: true, motif: null, avant: avant.contenu, apres: courante?.contenu ?? null, comparaison, versionAvant: avant.version };
}

export const fermerOnglet = (user: CurrentUser, sessionId: string) => fermerDocument(user, sessionId);
