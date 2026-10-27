import type { AssistantIaTour, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { proprietaire } from "@/platform/in-process/missions/proprietaire";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/platform/in-process/visibilite-adam";
import { jouerTour } from "@/lib/agent/fil/tour";
import { messagePartiel } from "@/lib/agent/fil/partiel";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FIL DE L'ASSISTANT IA — une conversation par personne, GARDÉE, jouée EN ARRIÈRE-PLAN.
 *
 * Direction, 27/10 : « je ne veux pas qu'à chaque fois que je sors de l'assistant ça efface tout » ;
 * « je lui donne des choses à faire, je vais faire autre chose et ça me notifie quand c'est fait » ;
 * « un deuxième message avant qu'il réponde au premier ne doit pas annuler le premier ».
 *
 *   • Chaque message de la personne est un TOUR en base (`EN_ATTENTE`) : quitter la page, recharger,
 *     changer d'appareil n'efface rien. Rien ne vit dans l'onglet.
 *   • Le fil se joue sur le SERVEUR, un tour après l'autre, dans l'ordre d'arrivée (`traiterFil`) :
 *     le deuxième message attend le premier, et sa réponse voit la première — aucun n'est annulé.
 *     Une seule prise par fil à la fois (`traitementLe`), reprise si elle est perdue (redémarrage).
 *   • La réponse s'écrit PENDANT qu'elle se rédige (texte partiel + étapes « Annuaire consulté… ») :
 *     le premier mot s'affiche sans attendre la fin du tour.
 *   • Si la personne n'est plus sur l'écran (`consulteLe` vieux de plus de 6 s), la réponse lui est NOTIFIÉE.
 *   • En arrière-plan, un tour peut être long : jusqu'à 24 étapes d'outils et 4 minutes.
 *
 * Les limites ne bougent pas : droits RELUS à chaque tour (`proprietaire`), écritures en cartes à
 * confirmer, aucune donnée sensible au modèle (outils de l'Assistant IA, `censurerSortie`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ETAT = { ATTENTE: "EN_ATTENTE", COURS: "EN_COURS", TRAITE: "TRAITE", TERMINE: "TERMINE", ECHEC: "ECHEC" } as const;

const PRISE_PERDUE_MS = 10 * 60_000;
// Pendant un tour, l'écran relit le fil toutes les 0,9 s : six secondes sans lecture, la personne est ailleurs.
const ABSENT_APRES_MS = 6_000;
const TOURS_EN_CONTEXTE = 16;
const MAX_EN_FILE = 10;
const DELAI_FOND_MS = Number(process.env.ASSISTANT_FOND_TIMEOUT_MS) || 240_000;
const ETAPES_FOND = 24;
const ECRITURE_PARTIELLE_MS = 350;

export const CONSIGNE_FOND = [
  "TÂCHES LONGUES : tu travailles en arrière-plan, la personne peut quitter l'écran — elle sera notifiée.",
  "Pour une demande à plusieurs étapes, enchaîne les lectures nécessaires (une par une, sans t'arrêter à la première), puis rends UN compte rendu structuré : ce que tu as fait, ce que tu as trouvé, ce qui reste à confirmer.",
  "Si la personne a envoyé plusieurs messages d'affilée, réponds à CE message en tenant compte des précédents.",
].join("\n");

export async function filDe(userId: string) {
  return prisma.assistantIaFil.upsert({ where: { userId }, update: {}, create: { userId } });
}

export type PieceDuTour = { id: string; nom: string };

/** DÉPOSER un message dans le fil. Ne joue rien : l'appelant lance `traiterFil` (sans l'attendre). */
export async function deposerMessage(userId: string, texte: string, pieces: PieceDuTour[]): Promise<{ ok: true; tour: AssistantIaTour } | { ok: false; erreur: string }> {
  const t = (texte ?? "").trim().slice(0, 8000);
  const p = pieces.filter((x) => x && typeof x.id === "string").slice(0, 10).map((x) => ({ id: x.id, nom: String(x.nom ?? "").slice(0, 200) }));
  if (!t && !p.length) return { ok: false, erreur: "Message vide." };
  const fil = await filDe(userId);
  const enFile = await prisma.assistantIaTour.count({ where: { filId: fil.id, role: "user", etat: { in: [ETAT.ATTENTE, ETAT.COURS] } } });
  if (enFile >= MAX_EN_FILE) return { ok: false, erreur: `${MAX_EN_FILE} messages attendent déjà leur réponse — laissez l'assistant avancer.` };
  const tour = await prisma.assistantIaTour.create({
    data: { filId: fil.id, userId, role: "user", contenu: t, etat: ETAT.ATTENTE, ...(p.length ? { pieces: p as Prisma.InputJsonValue } : {}) },
  });
  await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { consulteLe: new Date() } });
  return { ok: true, tour };
}

/**
 * L'ORDRE DE LECTURE : chaque réponse juste après le message auquel elle répond. Par date seule,
 * la réponse au premier message — écrite après l'arrivée du second — tombait APRÈS le second, à
 * l'écran comme dans le contexte du modèle.
 */
export function ordonner<T extends { id: string; role: string; repondA: string | null; createdAt: Date }>(tours: T[]): T[] {
  const parDate = [...tours].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const ids = new Set(parDate.map((t) => t.id));
  const reponses = new Map<string, T[]>();
  for (const t of parDate) if (t.repondA && ids.has(t.repondA)) reponses.set(t.repondA, [...(reponses.get(t.repondA) ?? []), t]);
  const out: T[] = [];
  for (const t of parDate) {
    if (t.repondA && ids.has(t.repondA)) continue;
    out.push(t, ...(reponses.get(t.id) ?? []));
  }
  return out;
}

/** LIRE le fil (depuis la dernière « nouvelle conversation ») — et dire que la personne est là. */
export async function lireFil(userId: string, limite = 80) {
  const fil = await prisma.assistantIaFil.upsert({ where: { userId }, update: { consulteLe: new Date() }, create: { userId, consulteLe: new Date() } });
  const tours = ordonner(await prisma.assistantIaTour.findMany({
    where: { filId: fil.id, createdAt: { gte: fil.depuisLe } },
    orderBy: { createdAt: "desc" },
    take: limite,
  }));
  // L'état d'une carte vit sur l'intention (confirmée, exécutée…), pas sur le tour qui l'a proposée.
  const ids = tours.map((t) => (t.intent as { id?: string } | null)?.id).filter((x): x is string => !!x);
  const intents = ids.length
    ? await prisma.assistantActionIntent.findMany({ where: { id: { in: ids }, userId }, select: { id: true, status: true, resultLink: true, resultMessage: true } })
    : [];
  const parId = new Map(intents.map((i) => [i.id, i]));
  return {
    tours: tours.map((t) => {
      const i = t.intent as { id?: string } | null;
      const etat = i?.id ? parId.get(i.id) : undefined;
      return etat ? { ...t, intent: { ...i, status: etat.status, resultLink: etat.resultLink ?? undefined, resultMessage: etat.resultMessage ?? undefined } } : t;
    }),
    enCours: tours.some((t) => t.etat === ETAT.ATTENTE || t.etat === ETAT.COURS),
  };
}

/** NOUVELLE CONVERSATION : le fil repart de zéro pour le modèle ; rien n'est supprimé en base. */
export async function nouvelleConversation(userId: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  const fil = await filDe(userId);
  const enCours = await prisma.assistantIaTour.count({ where: { filId: fil.id, etat: { in: [ETAT.ATTENTE, ETAT.COURS] } } });
  if (enCours) return { ok: false, erreur: "L'assistant travaille encore : attendez sa réponse avant de repartir de zéro." };
  await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { depuisLe: new Date() } });
  return { ok: true };
}

const prochain = (filId: string) => prisma.assistantIaTour.findFirst({
  where: { filId, role: "user", etat: ETAT.ATTENTE },
  orderBy: { createdAt: "asc" },
});

/**
 * JOUER LE FIL — prend le fil (une seule prise à la fois), joue les messages en attente dans
 * l'ordre, relâche. Un message déposé pendant qu'on relâchait est repris. Ne lève jamais.
 */
export async function traiterFil(userId: string): Promise<void> {
  try {
    const fil = await prisma.assistantIaFil.findUnique({ where: { userId }, select: { id: true } });
    if (!fil) return;
    for (let reprise = 0; reprise < 3; reprise++) {
      const pris = await prisma.assistantIaFil.updateMany({
        where: { id: fil.id, OR: [{ traitementLe: null }, { traitementLe: { lt: new Date(Date.now() - PRISE_PERDUE_MS) } }] },
        data: { traitementLe: new Date() },
      });
      if (!pris.count) return; // un autre passage tient le fil : il verra ce message
      try {
        for (let t = await prochain(fil.id); t; t = await prochain(fil.id)) {
          await jouerTourDuFil(userId, t);
          await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { traitementLe: new Date() } });
        }
      } finally {
        await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { traitementLe: null } }).catch(() => undefined);
      }
      if (!(await prochain(fil.id))) return;
    }
  } catch (e) {
    console.error("[assistant-fil] traitement", userId, e);
  }
}

function pourHistorique(t: AssistantIaTour): { role: "user" | "assistant"; content: string } {
  const pieces = (t.pieces as PieceDuTour[] | null) ?? [];
  return t.role === "user"
    ? { role: "user", content: pieces.length ? `${t.contenu}\n[Pièces jointes : ${pieces.map((p) => `« ${p.nom} » (identifiant ${p.id})`).join(" ; ")}]` : t.contenu }
    : { role: "assistant", content: t.contenu };
}

async function jouerTourDuFil(userId: string, tour: AssistantIaTour): Promise<void> {
  const debut = Date.now();
  await prisma.assistantIaTour.update({ where: { id: tour.id }, data: { etat: ETAT.COURS } });
  const reponse = await prisma.assistantIaTour.create({
    data: { filId: tour.filId, userId, role: "assistant", contenu: "", etat: ETAT.COURS, repondA: tour.id },
  });
  const finir = async (data: Prisma.AssistantIaTourUpdateInput, etatDuMessage: string) => {
    await prisma.assistantIaTour.update({ where: { id: reponse.id }, data: { ...data, ms: Date.now() - debut } });
    await prisma.assistantIaTour.update({ where: { id: tour.id }, data: { etat: etatDuMessage } });
  };

  // LES DROITS SONT RELUS À CHAQUE TOUR : un compte désactivé, un assistant retiré — on le dit.
  const user = await proprietaire(userId);
  if (!user || !peutUtiliserAssistantIA(user)) {
    await finir({ etat: ETAT.ECHEC, contenu: user ? REFUS_ASSISTANT_IA : "Le compte n'est plus actif.", erreur: "acces" }, ETAT.ECHEC);
    return;
  }

  const fil = await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: tour.filId } });
  // Le contexte : les échanges ABOUTIS d'avant ce message, chaque réponse après sa question.
  const anterieurs = ordonner(await prisma.assistantIaTour.findMany({
    where: { filId: tour.filId, createdAt: { gte: fil.depuisLe }, id: { notIn: [tour.id, reponse.id] } },
    orderBy: { createdAt: "desc" },
    take: TOURS_EN_CONTEXTE * 3,
  }));
  const questions = new Set(anterieurs.filter((t) => t.role === "user" && t.createdAt < tour.createdAt).map((t) => t.id));
  const precedents = anterieurs
    .filter((t) => (t.role === "user" ? questions.has(t.id) && t.etat === ETAT.TRAITE : !!t.repondA && questions.has(t.repondA) && t.etat === ETAT.TERMINE))
    .filter((t) => t.contenu.trim())
    .slice(-TOURS_EN_CONTEXTE);

  // LE TEXTE QUI S'ÉCRIT : une écriture toutes les 350 ms au plus, jamais en parallèle.
  let partiel = "";
  const etapes: string[] = [];
  let dernier = 0;
  let enVol: Promise<unknown> = Promise.resolve();
  const publier = (force = false) => {
    if (!force && Date.now() - dernier < ECRITURE_PARTIELLE_MS) return;
    dernier = Date.now();
    const contenu = partiel;
    const liste = [...etapes];
    enVol = enVol.then(() => prisma.assistantIaTour.update({ where: { id: reponse.id }, data: { contenu, etapes: liste } }).catch(() => undefined));
  };

  const r = await jouerTour(user, {
    texte: tour.contenu,
    pieces: tour.pieces ?? [],
    historique: precedents.map(pourHistorique),
    delaiMs: DELAI_FOND_MS,
    maxEtapes: ETAPES_FOND,
    consigne: CONSIGNE_FOND,
    surTexte: (brut) => { partiel = messagePartiel(brut); publier(); },
    surOutil: (libelle) => { if (!etapes.includes(libelle)) etapes.push(libelle); publier(true); },
  });
  await enVol;

  if (r.ok) {
    await finir({
      etat: ETAT.TERMINE, contenu: r.content, etapes,
      blocs: r.blocs as unknown as Prisma.InputJsonValue,
      ...(r.intent ? { intent: r.intent as unknown as Prisma.InputJsonValue } : {}),
      ...(r.memoireProposee ? { memoireProposee: r.memoireProposee as unknown as Prisma.InputJsonValue } : {}),
      outils: r.outilsAppeles,
    }, ETAT.TRAITE);
  } else {
    await finir({ etat: ETAT.ECHEC, contenu: r.error, erreur: r.error.slice(0, 300), etapes }, ETAT.ECHEC);
  }

  // LA PERSONNE EST AILLEURS : la réponse va la chercher (cloche + téléphone).
  const vu = await prisma.assistantIaFil.findUnique({ where: { id: tour.filId }, select: { consulteLe: true } });
  if (!vu?.consulteLe || Date.now() - vu.consulteLe.getTime() > ABSENT_APRES_MS) {
    const sujet = tour.contenu.replace(/\s+/g, " ").trim().slice(0, 60) || "pièces jointes";
    await notifyUser({
      userId, type: "GENERIC",
      title: r.ok ? `Assistant IA : réponse prête — « ${sujet} »` : `Assistant IA : la demande n'a pas abouti — « ${sujet} »`,
      body: (r.ok ? r.content : r.error).replace(/[#*_`>]/g, "").trim().slice(0, 280),
      link: "/assistant",
    }).catch(() => undefined);
  }
}

/**
 * LE BALAYAGE (battement du serveur) — rien ne reste en plan :
 *   • un tour resté « en cours » sous une prise perdue (redémarrage) repart en file, sa réponse
 *     partielle est close et le dit ;
 *   • un fil qui a des messages en attente sans personne pour les jouer est relancé.
 */
export async function reprendreLesFils(now = new Date(), parPassage = 5, attendre = false): Promise<{ relances: number }> {
  const perdue = new Date(now.getTime() - PRISE_PERDUE_MS);
  const fils = await prisma.assistantIaFil.findMany({
    where: {
      OR: [{ traitementLe: null }, { traitementLe: { lt: perdue } }],
      tours: { some: { etat: { in: [ETAT.ATTENTE, ETAT.COURS] }, createdAt: { lt: new Date(now.getTime() - 15_000) } } },
    },
    select: { id: true, userId: true },
    take: parPassage,
  });
  const relances: Promise<void>[] = [];
  for (const f of fils) {
    await prisma.assistantIaTour.updateMany({
      where: { filId: f.id, role: "assistant", etat: ETAT.COURS },
      data: { etat: ETAT.ECHEC, erreur: "interrompu", contenu: "Réponse interrompue (redémarrage du serveur) — la demande est reprise." },
    });
    await prisma.assistantIaTour.updateMany({ where: { filId: f.id, role: "user", etat: ETAT.COURS }, data: { etat: ETAT.ATTENTE } });
    await prisma.assistantIaFil.update({ where: { id: f.id }, data: { traitementLe: null } });
    relances.push(traiterFil(f.userId));
  }
  // Le battement n'attend pas les tours (ils peuvent durer des minutes) ; un test, si.
  if (attendre) await Promise.all(relances);
  return { relances: fils.length };
}
