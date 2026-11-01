import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";
import { modeleVoix } from "@/platform/ia/modeles-roles";
import { ouvrirSessionLive, type SessionLiveOuverte } from "@/platform/ia/voix/session-temps-reel";
import { accesAssistantIa } from "../role-config";
import { consigneFamilles } from "../../domaine/acces-regles";
import { consigneGestesFermes } from "../outils-v1";
import { consignesVoix } from "../../domaine/terrain/voix";
import { appelVoix, auNomDe, budgetDeLAppel, fermerBudget, jetonsAudio, lireReglagesAssistantIa } from "../consommation";
import { cleFournisseurVoix } from "../modele";
import { ETAT, filDe } from "../fil/service";
import { capturerApresTour, memoirePourVoix } from "../memoire-capture";
import { enregistrerSessionVoix, fermerSessionVoix, reponsePourVoix, reprisesOrales, traiterEnonceVocal, type RetourOral } from "./oral";

export { reponsePourVoix };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX TEMPS RÉEL DE L'ASSISTANT IA — GPT-Live, délégation « client » (lot J13, décision 0025 ; Direction 30/10 :
 * `gpt-live-1` seul, sans modèle de secours).
 *
 *   • OUVRIR : la porte de l'Assistant IA, la console d'accès relue, le plafond du jour ; puis l'offre WebRTC du
 *     navigateur est échangée ICI contre la réponse (`/v1/live/sessions`) — aucun secret ne sort du serveur.
 *   • DÉLÉGUER : GPT-Live tient la conversation ; dès qu'il faut l'ERP, il délègue. La demande dite part dans LE MÊME
 *     FIL que le texte : c'est le MÊME assistant — mêmes outils, mêmes droits, mêmes familles, mêmes repères, mêmes
 *     cartes. K9 (décision 0039) : la délégation NE BLOQUE PLUS la voix — elle rend un « travail » que le navigateur
 *     suit, et la voix annonce le résultat d'elle-même ; une carte se résume, se complète et se confirme À L'ORAL
 *     (`./oral.ts`, garde-fous serveur). Valeurs sensibles selon la console (décision 0034).
 *   • JOURNALISER : la durée vocale facturée au nom de la personne, les latences, et la transcription de la conversation
 *     dans le fil.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const VOIX_ASSISTANT = (process.env.ASSISTANT_IA_VOICE || "marin").trim();

export type OuvertureVoix = (SessionLiveOuverte & { reprises: string[] }) | { ok: false; erreur: string; statut: number };

async function porte(user: CurrentUser): Promise<{ ok: false; erreur: string; statut: number } | null> {
  if (!peutUtiliserAssistantIA(user)) return { ok: false, erreur: REFUS_ASSISTANT_IA, statut: 403 };
  if (user.impersonatedBy || user.visualise) return { ok: false, erreur: "Indisponible en « Vue exacte ».", statut: 403 };
  return null;
}

export async function ouvrirVoixAssistant(user: CurrentUser, sdp: string, opts: { fetchImpl?: typeof fetch; conversation?: string | null } = {}): Promise<OuvertureVoix> {
  const refus = await porte(user);
  if (refus) return refus;
  // Le plafond du jour : une session vocale qui ne pourrait rien dépenser ne s'ouvre pas.
  const budget = await auNomDe(user.id, () => budgetDeLAppel("synthese"));
  if (!budget.ok) return { ok: false, erreur: budget.raison, statut: 429 };
  if (budget.proprietaire) await fermerBudget(budget.budget, { ok: true, ms: 0 });

  // M1 (décision 0045) : la voix connaît la personne — le même profil et les mêmes souvenirs (rien en conversation privée).
  const prive = opts.conversation ? (await filDe(user.id, opts.conversation)).prive : false;
  const [acces, reglages, memoire] = await Promise.all([accesAssistantIa(user), lireReglagesAssistantIa(), prive ? null : memoirePourVoix(user.id)]);
  const instructions = [
    `Tu es la voix de l'Assistant IA d'Adventum Pharma (laboratoire pharmaceutique algérien). Tu parles avec ${user.name}.`,
    consignesVoix(reglages.valeursSensibles === "EN_CLAIR"),
    "Pour TOUT ce qui touche l'entreprise (personnes, dossiers, demandes, chiffres, documents, comptes rendus, agenda), DÉLÈGUE :",
    "l'assistant de l'entreprise répond avec les droits de la personne. N'invente jamais une donnée de l'entreprise.",
    // Direction, 31/10/2026 : « Je ne peux pas vérifier l'actualité en temps réel » n'existe pas — l'assistant cherche sur le web.
    `Nous sommes le ${new Date().toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers", weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`,
    "Pour TOUT ce qui vient de l'EXTÉRIEUR (actualité, manifestations, météo, prix, réglementation, un laboratoire, un congrès,",
    "un événement en France, en Algérie ou ailleurs), DÉLÈGUE aussi : l'assistant cherche sur le web et rend des sources datées.",
    "Ne dis JAMAIS que tu ne peux pas vérifier l'actualité, que tu n'as pas accès à Internet ou au temps réel : délègue, dis",
    "« je regarde », puis donne la réponse en citant d'où elle vient (le nom du média ou du site, sans adresse web).",
    // K6 (décision 0036) : « attends, je vais t'envoyer la lettre par WhatsApp » — l'assistant doit s'y attendre.
    "Si la personne annonce qu'elle va envoyer une pièce (par WhatsApp ou par mail), ou si une pièce manque, DÉLÈGUE-le en nommant la",
    "pièce et la demande visée : l'assistant l'attendra et la rangera par une carte à son arrivée.",
    consigneFamilles(acces), consigneGestesFermes(user),
    memoire,
  ].filter(Boolean).join("\n");
  const modele = modeleVoix(reglages.modeleVoix);
  // K9 : 800 ms avant l'accusé automatique d'une délégation — le temps que le serveur rende sa propre phrase d'attente.
  const s = await ouvrirSessionLive({ cle: cleFournisseurVoix(), modele, instructions, voix: VOIX_ASSISTANT, sdp, fetchImpl: opts.fetchImpl, delaiAccuseMs: 800 });
  if (!s.ok) return s;
  // La session est À LA PERSONNE : les gestes oraux (confirmer, annuler) n'y valent que pour elle, tant qu'elle est ouverte.
  const conversation = opts.conversation ? (await filDe(user.id, opts.conversation)).id : null;
  await enregistrerSessionVoix(user.id, s.id, conversation);
  console.info("[assistant-ia] voix ouverte", { userId: user.id, modele, session: s.id });
  // Ce qui est arrivé depuis la dernière session et n'a pas été dit : la voix le dit en ouvrant.
  return { ...s, reprises: await reprisesOrales(user, s.id) };
}

export type ResultatDelegationVoix = RetourOral;

/**
 * DÉLÉGUER UN ÉNONCÉ — K9 (décision 0039) : rend AUSSITÔT (travail lancé, précision transmise, carte résumée ou
 * confirmée, commande appliquée). Plus d'attente de 70 s, plus de « la réponse arrivera à l'écran ».
 */
export async function deleguerALaVoix(user: CurrentUser, demande: string, d: { session: unknown; delegationId?: string | null; enCours?: string | null; parole?: string | null; question?: string | null }): Promise<ResultatDelegationVoix> {
  const refus = await porte(user);
  if (refus) return { pourVoix: `Refus : ${refus.erreur}` };
  const texte = demande.trim();
  if (!texte) return { pourVoix: "Je n'ai pas compris la demande : demande à la personne de la répéter." };
  return traiterEnonceVocal(user, { ...d, demande: texte });
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
  /** K9 : la session vocale qui se ferme — plus aucun geste oral n'y vaut. */
  session?: string | null;
}): Promise<void> {
  await fermerSessionVoix(user.id, d.session);
  const borne = (n: unknown, max: number) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : 0);
  const secondes = borne(d.secondes, 7_200);
  const latences = (Array.isArray(d.latences) ? d.latences : []).map((x) => borne(x, 120_000)).slice(0, 500);
  const reglages = await lireReglagesAssistantIa();
  if (secondes > 0) {
    await auNomDe(user.id, () => appelVoix("voix", async (inscrire) => {
      // GPT-Live se paie à la DURÉE (0,05 $ la minute, à la seconde) : la durée est facturée, les équivalents (10/s)
      // ne servent qu'au plafond (audit K8, E3 — la ligne portait le rôle « synthese »).
      inscrire({ provider: "openai-live", model: modeleVoix(reglages.modeleVoix), entree: jetonsAudio(secondes), sortie: 0, ms: secondes * 1000, dureeMs: Math.round(secondes * 1000), equivalents: true });
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
    const reponse = await prisma.assistantIaTour.create({
      data: { filId: fil.id, userId: user.id, role: "assistant", contenu: dit("assistant") || "(réponses vocales)", etat: ETAT.TERMINE, repondA: question.id },
    });
    // M1 (décision 0045) : en fin de conversation vocale, ce que la personne a DIT d'elle est retenu (privée : rien).
    const b = await capturerApresTour({
      userId: user.id, nom: user.name, message: dit("personne"), conversation: fil.id, tour: question.id, prive: fil.prive, origine: "voix",
    });
    if (b.retenus.length) {
      await prisma.assistantIaTour.update({ where: { id: reponse.id }, data: { memoireEtat: "FAIT", memoiresRetenues: b.retenus as unknown as Prisma.InputJsonValue } });
    }
  }
  const tri = [...latences].sort((a, b) => a - b);
  console.info("[assistant-ia] voix temps réel", {
    userId: user.id, secondes, usageConfirme: d.confirme, reponses: latences.length, p50: tri.length ? tri[Math.floor(tri.length / 2)] : null,
  });
}
