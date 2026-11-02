import { prisma } from "@/lib/prisma";
import { attendu, sansBloquer } from "@/lib/journal";
import { censurerTexte } from "../domaine/filtre-confidentialite";
import {
  CAPTURES_MAX_PAR_TOUR, CONSIGNE_EXTRACTEUR, entreeExtracteur, EXISTANTS_MAX, faitDurablePossible, garderCandidat, lireExtraction,
  sansEntete,
} from "../domaine/memoire/capture";
import { choisirSouvenirs, cosinus, sectionDuRappel, texteIndexe, toutTient, type Rappel } from "../domaine/memoire/rappel";
import { pertinence } from "../domaine/assembleur";
import type { MemoireRetenue, OrigineMemoire } from "../domaine/memoire-ui";
import { ajouterMemoire, memoireAutoActive, memoirePourContexte } from "./memoire";
import { genererTexte, modelesFactices, plongerTextes } from "./generer";
import { auNomDe } from "./consommation";
import { consoliderMemoire } from "./memoire-consolidation";
import { usurpationDeclaree } from "@/platform/ia/memoire-identite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SUPER MÉMOIRE (M1, décision 0045) — capture automatique et rappel par pertinence.
 *
 *   • CAPTURER (`capturerApresTour`) : après la réponse (jamais avant le premier mot), le DERNIER échange passe le filtre
 *     déterministe ; s'il peut porter un fait durable, le modèle RAPIDE en extrait les souvenirs (JSON strict, entrée
 *     courte, journal K8 sous l'usage « memoire »), la garde refuse ce que la personne n'a pas dit, et ils sont ENREGISTRÉS
 *     d'office — dédoublonnés, un fait qui change remplaçant l'ancien. Conversation privée, réglage coupé : rien.
 *   • RAPPELER (`rappelDuTour`) : le profil stable et les souvenirs pertinents pour la question, chacun dans son enveloppe.
 *     Un plongement de la question n'est calculé que si la mémoire ne tient pas entière dans l'enveloppe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que l'extracteur appelle — remplaçable par un banc ou un test (le vrai : `genererTexte`, rôle « rapide »). */
export type Extracteur = (consigne: string, entree: string) => Promise<{ ok: true; texte: string } | { ok: false; raison: string }>;
export type Plongeur = (textes: string[]) => Promise<number[][] | null>;

const extracteurParDefaut: Extracteur = (consigne, entree) => genererTexte(consigne, entree, 15_000, { role: "rapide", origine: "memoire" });
// Les plongements (text-embedding-3-small, 512 — la taille de la Bibliothèque J1), par la porte gardée de `generer.ts`.
const plongeurParDefaut: Plongeur = (textes) => plongerTextes(textes);

/**
 * LES BANCS ET LES TESTS : sous le faux modèle (`remplacerModelesPourTests`), la capture n'appelle rien d'elle-même — elle
 * ne consomme pas le scénario d'un autre test. Un test de la mémoire passe son extracteur (`deps`) ou le pose ici.
 */
let extracteurDeTest: Extracteur | null = null;
export function remplacerExtracteurPourTests(e: Extracteur | null): void {
  extracteurDeTest = e;
}
const extracteurDuMoment = (): Extracteur | null => extracteurDeTest ?? (modelesFactices() ? null : extracteurParDefaut);
const plongeurDuMoment = (): Plongeur | null => (extracteurDeTest || modelesFactices() ? null : plongeurParDefaut);

export interface DemandeCapture {
  userId: string;
  nom?: string | null;
  /** Ce que la PERSONNE a dit (le message du tour, ou la transcription de sa parole). */
  message: string;
  conversation: string | null;
  tour?: string | null;
  /** Conversation privée (décision 0027) : rien n'est retenu. */
  prive?: boolean;
  origine?: Extract<OrigineMemoire, "auto" | "voix">;
  deps?: { extraire?: Extracteur; plonger?: Plongeur; maintenant?: Date };
}

export interface BilanCapture {
  retenus: MemoireRetenue[];
  /** Pourquoi rien n'a été appelé ou retenu — pour le journal et le banc. */
  motif: "prive" | "reglage" | "filtre" | "identite" | "extracteur" | "rien" | "retenu";
  appel: boolean;
  refuses: { contenu: string; raison: string }[];
}

const dateLisible = (d: Date) => d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Algiers" });

/** Une capture PEUT-elle avoir lieu (réglage, privée, filtre déterministe) ? Rien n'est appelé — l'écran l'annonce. */
export async function captureEnvisagee(userId: string, message: string, prive: boolean): Promise<boolean> {
  if (prive || !faitDurablePossible(censurerTexte(sansEntete(message)).texte)) return false;
  return memoireAutoActive(userId).catch(sansBloquer("assistant-memoire.captureEnvisagee", false));
}

/** CAPTURER après un tour. Ne lève jamais : une mémoire qui échoue ne casse pas la conversation. */
export async function capturerApresTour(d: DemandeCapture): Promise<BilanCapture> {
  const vide = (motif: BilanCapture["motif"], appel = false): BilanCapture => ({ retenus: [], motif, appel, refuses: [] });
  try {
    if (d.prive) return vide("prive");
    if (!(await memoireAutoActive(d.userId))) return vide("reglage");
    // Ce que la personne a écrit, filtré comme tout ce qui part au modèle (un IBAN collé ne part pas à l'extracteur).
    const message = censurerTexte(sansEntete(d.message)).texte;
    if (!faitDurablePossible(message)) return vide("filtre");
    // S1 : « C'est Amine qui écrit depuis le poste de Radia » — ce tour ne nourrit pas la mémoire de Radia (rien n'est appelé).
    if (usurpationDeclaree(message, d.nom)) return vide("identite");

    const maintenant = d.deps?.maintenant ?? new Date();
    const tous = await memoirePourContexte(d.userId);
    const proches = [...tous].map((s, i) => ({ s, p: pertinence(texteIndexe(s), message) * 100 - i }))
      .sort((a, b) => b.p - a.p).slice(0, EXISTANTS_MAX).map((x) => x.s);
    const cles = new Map(proches.map((s, i) => [`m${i + 1}`, s.id]));
    const entree = entreeExtracteur({
      message, existants: proches.map((s, i) => ({ cle: `m${i + 1}`, contenu: s.contenu })), aujourdhui: dateLisible(maintenant), nom: d.nom,
    });
    const extraire = d.deps?.extraire ?? extracteurDuMoment();
    if (!extraire) return vide("extracteur");
    const r = await auNomDe(d.userId, () => extraire(CONSIGNE_EXTRACTEUR, entree), d.conversation);
    if (!r.ok) {
      console.warn("[assistant-memoire] extracteur", r.raison);
      return vide("extracteur", true);
    }
    const candidats = lireExtraction(r.texte);
    const retenus: MemoireRetenue[] = [];
    const refuses: BilanCapture["refuses"] = [];
    for (const c of candidats.slice(0, CAPTURES_MAX_PAR_TOUR)) {
      const g = garderCandidat(c, message, { nom: d.nom, aujourdhui: maintenant });
      if (!g.ok) { refuses.push({ contenu: c.contenu, raison: g.raison }); continue; }
      const a = await ajouterMemoire(d.userId, c.contenu, c.sorte, {
        origine: d.origine ?? "auto", sujet: c.sujet, remplace: c.remplace ? cles.get(c.remplace) ?? null : null,
        sourceThreadId: d.conversation, sourceTourId: d.tour ?? null,
      });
      if (!a.ok) { refuses.push({ contenu: c.contenu, raison: a.erreur }); continue; }
      if (a.geste === "doublon") continue;
      retenus.push({ id: a.element.id, contenu: a.element.contenu, sorte: String(a.element.sorte), geste: a.geste === "remplace" ? "remplace" : "ajoute" });
    }
    if (refuses.length) console.info("[assistant-memoire] souvenirs refusés par la garde", refuses.map((x) => x.raison));
    const plonger = d.deps?.plonger ?? plongeurDuMoment();
    if (retenus.length && plonger) await auNomDe(d.userId, () => plongerSouvenirs(d.userId, retenus.map((x) => x.id), plonger), d.conversation);
    // LE BUDGET EN JETONS : la capture qui fait franchir 85 % déclenche la consolidation (rare : une par jour au plus).
    if (retenus.length) await consoliderMemoire(d.userId, { maintenant }).catch(sansBloquer("assistant-memoire.consolidation"));
    return { retenus, motif: retenus.length ? "retenu" : "rien", appel: true, refuses };
  } catch (e) {
    console.error("[assistant-memoire] capture", e);
    return vide("extracteur");
  }
}

/** Le plongement des souvenirs neufs (au mieux : sans clé ou en panne, le rappel reste lexical). */
export async function plongerSouvenirs(userId: string, ids: readonly string[], plonger: Plongeur): Promise<number> {
  const items = await prisma.assistantMemoryItem.findMany({ where: { id: { in: [...ids] }, userId }, select: { id: true, type: true, content: true } });
  if (!items.length) return 0;
  const v = await plonger(items.map((i) => texteIndexe({ sorte: i.type, contenu: i.content }))).catch(attendu("plongement au mieux : sans lui, le rappel reste lexical", null));
  if (!v || v.length !== items.length) return 0;
  await Promise.all(items.map((i, k) => prisma.assistantMemoryItem.updateMany({ where: { id: i.id, userId }, data: { vecteur: v[k] } })));
  return items.length;
}

/**
 * LE RAPPEL D'UN TOUR : la section « MÉMOIRE DE L'INTERLOCUTEUR » (profil + pertinents), ou `null`. Le filtre de
 * confidentialité y repasse (deuxième garde). `lastUsedAt` des souvenirs servis est noté, au mieux.
 */
export async function rappelDuTour(userId: string, question: string, deps: { plonger?: Plongeur } = {}): Promise<{ section: string | null; rappel: Rappel; censure: boolean }> {
  const tous = await memoirePourContexte(userId);
  const souvenirs = tous.map((s, rang) => ({ id: s.id, sorte: s.sorte, contenu: s.contenu, rang }));
  let similarites: Map<string, number> | undefined;
  // Le sens ne sert que si tout ne tient pas — et seulement si des souvenirs ont leur plongement.
  if (question.trim() && !toutTient(souvenirs) && tous.some((s) => s.vecteur.length)) {
    const plonger = deps.plonger ?? plongeurDuMoment();
    const q = plonger ? await plonger([question.slice(0, 2_000)]).catch(attendu("plongement au mieux : sans lui, le rappel reste lexical", null)) : null;
    if (q?.[0]) similarites = new Map(tous.filter((s) => s.vecteur.length).map((s) => [s.id, cosinus(q[0], s.vecteur)]));
  }
  const rappel = choisirSouvenirs(souvenirs, question, { similarites });
  let censure = false;
  const section = sectionDuRappel(rappel, (t) => {
    const c = censurerTexte(t);
    if (c.censure) censure = true;
    return c.texte;
  });
  const servis = [...rappel.profil, ...rappel.pertinents].map((s) => s.id);
  if (servis.length) {
    // Le temps n'est pas celui du tour : `lastUsedAt` ne touche pas `updatedAt` (l'ordre « du plus récent » reste celui des faits).
    void prisma.$executeRaw`UPDATE "AssistantMemoryItem" SET "lastUsedAt" = NOW() WHERE "userId" = ${userId} AND "id" = ANY(${servis})`.catch(sansBloquer("assistant-memoire.lastUsedAt"));
  }
  return { section, rappel, censure };
}

/** Pour la VOIX : la même mémoire, en quelques lignes dans la consigne de session (profil + plus récents). */
export async function memoirePourVoix(userId: string): Promise<string | null> {
  const { section } = await rappelDuTour(userId, "");
  return section ? `${section}\nSi la personne te dit un fait durable sur elle, il est retenu d'office : dis-le une fois, brièvement (« je le retiens »).` : null;
}
