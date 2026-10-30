import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";
import { modeleVoix } from "@/platform/ia/modeles-roles";
import { ouvrirSessionLive, type SessionLiveOuverte } from "@/platform/ia/voix/session-temps-reel";
import { accesAssistantIa } from "../role-config";
import { consigneFamilles } from "../../domaine/acces-regles";
import { consigneGestesFermes } from "../outils-v1";
import { MASQUE_CONFIDENTIEL, sansValeursRevelees } from "../../domaine/filtre-confidentialite";
import { CONSIGNES_VOIX, DIT_A_L_ECRAN, pourLaVoix } from "../../domaine/terrain/voix";
import { appelVoix, auNomDe, budgetDeLAppel, fermerBudget, jetonsAudio, lireReglagesAssistantIa } from "../consommation";
import { cleFournisseurVoix } from "../modele";
import { deposerMessage, ETAT, filDe, traiterFil } from "../fil/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX TEMPS RÉEL DE L'ASSISTANT IA — GPT-Live, délégation « client » (lot J13, décision 0025 ; Direction 30/10 :
 * `gpt-live-1` seul, sans modèle de secours).
 *
 *   • OUVRIR : la porte de l'Assistant IA, la console d'accès relue, le plafond du jour ; puis l'offre WebRTC du
 *     navigateur est échangée ICI contre la réponse (`/v1/live/sessions`) — aucun secret ne sort du serveur.
 *   • DÉLÉGUER : GPT-Live tient la conversation ; dès qu'il faut l'ERP, il délègue. La demande dite part dans LE MÊME
 *     FIL que le texte (`deposerMessage` → `traiterFil`) : c'est le MÊME assistant — mêmes outils, mêmes droits, mêmes
 *     familles, mêmes repères, mêmes cartes. Sa réponse revient à la voix SANS valeur sensible (« affichée à l'écran »),
 *     l'écran la reçoit révélée à qui a le droit ; une écriture reste une CARTE, confirmée à l'écran seulement.
 *   • JOURNALISER : la durée vocale facturée au nom de la personne, les latences, et la transcription de la conversation
 *     dans le fil.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const VOIX_ASSISTANT = (process.env.ASSISTANT_IA_VOICE || "marin").trim();
/** Le temps qu'on attend la réponse de l'assistant délégué (un tour d'outils peut prendre 20 à 40 s). */
export const DELAI_DELEGATION_MS = 45_000;

export type OuvertureVoix = SessionLiveOuverte | { ok: false; erreur: string; statut: number };

async function porte(user: CurrentUser): Promise<{ ok: false; erreur: string; statut: number } | null> {
  if (!peutUtiliserAssistantIA(user)) return { ok: false, erreur: REFUS_ASSISTANT_IA, statut: 403 };
  if (user.impersonatedBy || user.visualise) return { ok: false, erreur: "Indisponible en « Vue exacte ».", statut: 403 };
  return null;
}

export async function ouvrirVoixAssistant(user: CurrentUser, sdp: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<OuvertureVoix> {
  const refus = await porte(user);
  if (refus) return refus;
  // Le plafond du jour : une session vocale qui ne pourrait rien dépenser ne s'ouvre pas.
  const budget = await auNomDe(user.id, () => budgetDeLAppel("synthese"));
  if (!budget.ok) return { ok: false, erreur: budget.raison, statut: 429 };
  if (budget.proprietaire) await fermerBudget(budget.budget, { ok: true, ms: 0 });

  const [acces, reglages] = await Promise.all([accesAssistantIa(user), lireReglagesAssistantIa()]);
  const instructions = [
    `Tu es la voix de l'Assistant IA d'Adventum Pharma (laboratoire pharmaceutique algérien). Tu parles avec ${user.name}.`,
    CONSIGNES_VOIX,
    "Pour TOUT ce qui touche l'entreprise (personnes, dossiers, demandes, chiffres, documents, comptes rendus, agenda), DÉLÈGUE :",
    "l'assistant de l'entreprise répond avec les droits de la personne. N'invente jamais une donnée de l'entreprise.",
    consigneFamilles(acces), consigneGestesFermes(user),
  ].filter(Boolean).join("\n");
  const modele = modeleVoix(reglages.modeleVoix);
  const s = await ouvrirSessionLive({ cle: cleFournisseurVoix(), modele, instructions, voix: VOIX_ASSISTANT, sdp, fetchImpl: opts.fetchImpl });
  if (s.ok) console.info("[assistant-ia] voix ouverte", { userId: user.id, modele, session: s.id });
  return s;
}

export interface ResultatDelegationVoix {
  pourVoix: string;
  carte?: Record<string, unknown> & { intentId: string };
  ecran?: string | null;
}

const NETTOYER_MD = (t: string) => t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`#>|]+/g, " ").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();

/** Ce que la voix peut dire d'une réponse écrite : sans valeur sensible, sans Markdown, borné (500 jetons). */
export function reponsePourVoix(contenu: string): string {
  return pourLaVoix(NETTOYER_MD(sansValeursRevelees(contenu)).split(MASQUE_CONFIDENTIEL).join(DIT_A_L_ECRAN), 1_600);
}

/**
 * DÉLÉGUER UNE DEMANDE DITE à l'assistant — par le FIL (le même que le texte) : la demande y est déposée, le fil la
 * joue, on attend sa réponse (45 s au plus ; au-delà, la voix dit que la réponse arrivera à l'écran).
 */
export async function deleguerALaVoix(user: CurrentUser, demande: string, conversation?: string | null): Promise<ResultatDelegationVoix> {
  const refus = await porte(user);
  if (refus) return { pourVoix: `Refus : ${refus.erreur}` };
  const texte = demande.trim();
  if (!texte) return { pourVoix: "Je n'ai pas compris la demande : demande à la personne de la répéter." };
  // Décision 0027 : la voix écrit dans la conversation OUVERTE (sans elle, la conversation courante).
  const d = await deposerMessage(user.id, `[Conversation vocale] ${texte}`.slice(0, 8_000), [], null, conversation ?? null);
  if (!d.ok) return { pourVoix: d.erreur };
  void traiterFil(user.id, d.conversation);
  const fin = Date.now() + DELAI_DELEGATION_MS;
  for (;;) {
    const [rep, q] = await Promise.all([
      prisma.assistantIaTour.findFirst({ where: { repondA: d.tour.id, role: "assistant" }, orderBy: { createdAt: "desc" }, select: { contenu: true, intent: true, etat: true } }),
      prisma.assistantIaTour.findUnique({ where: { id: d.tour.id }, select: { etat: true, erreur: true } }),
    ]);
    if (rep && rep.etat === ETAT.TERMINE) {
      const intent = rep.intent as (Record<string, unknown> & { id?: string }) | null;
      return {
        pourVoix: intent?.id
          ? `${reponsePourVoix(rep.contenu)} — Une carte est affichée à l'écran : seule la personne la confirme, sur l'écran. Ne dis pas que c'est fait.`.slice(0, 1_800)
          : reponsePourVoix(rep.contenu),
        ...(intent?.id ? { carte: { ...intent, intentId: intent.id } } : {}),
        ecran: rep.contenu,
      };
    }
    if (q?.etat === ETAT.ECHEC) return { pourVoix: `L'assistant n'a pas pu répondre : ${(q.erreur ?? "erreur").slice(0, 200)}` };
    if (Date.now() > fin) return { pourVoix: "La recherche prend plus de temps : dis que la réponse s'affichera dans la conversation écrite." };
    await new Promise((r) => setTimeout(r, 350));
  }
}

/**
 * LE JOURNAL D'UNE CONVERSATION VOCALE : la durée facturée (secondes GPT-Live, en équivalents jetons) au compte de la
 * personne ; les latences au journal d'exploitation ; la TRANSCRIPTION dans le fil, à côté du texte (une question
 * « traitée » et sa réponse, pour que l'historique et le résumé roulant la voient).
 */
export async function journaliserVoix(user: CurrentUser, d: {
  secondes: number; latences: number[]; confirme: boolean; lignes: { qui: "personne" | "assistant"; texte: string }[];
  /** Décision 0027 : la conversation ouverte, où la transcription s'écrit (sans elle, la conversation courante). */
  conversation?: string | null;
}): Promise<void> {
  const borne = (n: unknown, max: number) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : 0);
  const secondes = borne(d.secondes, 7_200);
  const latences = (Array.isArray(d.latences) ? d.latences : []).map((x) => borne(x, 120_000)).slice(0, 500);
  const reglages = await lireReglagesAssistantIa();
  if (secondes > 0) {
    await auNomDe(user.id, () => appelVoix("synthese", async (inscrire) => {
      inscrire({ provider: "openai-live", model: modeleVoix(reglages.modeleVoix), entree: jetonsAudio(secondes), sortie: 0, ms: secondes * 1000 });
      return { ok: true, valeur: null };
    }));
  }
  const lignes = (Array.isArray(d.lignes) ? d.lignes : [])
    .filter((l) => l && (l.qui === "personne" || l.qui === "assistant") && typeof l.texte === "string" && l.texte.trim())
    .slice(0, 400);
  if (lignes.length) {
    const dit = (q: string) => lignes.filter((l) => l.qui === q).map((l) => l.texte.trim()).join("\n").slice(0, 7_900);
    const fil = await filDe(user.id, d.conversation ?? null);
    await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { dernierLe: new Date() } });
    const question = await prisma.assistantIaTour.create({
      data: { filId: fil.id, userId: user.id, role: "user", contenu: `[Conversation vocale — transcription]\n${dit("personne")}`, etat: ETAT.TRAITE },
    });
    await prisma.assistantIaTour.create({
      data: { filId: fil.id, userId: user.id, role: "assistant", contenu: dit("assistant") || "(réponses vocales)", etat: ETAT.TERMINE, repondA: question.id },
    });
  }
  const tri = [...latences].sort((a, b) => a - b);
  console.info("[assistant-ia] voix temps réel", {
    userId: user.id, secondes, usageConfirme: d.confirme, reponses: latences.length, p50: tri.length ? tri[Math.floor(tri.length / 2)] : null,
  });
}
