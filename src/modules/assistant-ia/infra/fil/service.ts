import type { AssistantIaTour, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { proprietaire } from "@/platform/ia/proprietaire";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";
import { jouerTour } from "./tour";
import { messagePartiel } from "../../domaine/fil/partiel";
import { sansBloquer } from "@/lib/journal";
import { auNomDe } from "../consommation";
import { resumeLecture, type AudioDuTour, type LecturePiece, type VocalDuTour } from "../../domaine/lecture/regles";
import { PIECES_PAR_ENVOI_MAX } from "../../domaine/lecture/depot";
import { repondreAVoixHaute, transcrireVocal } from "../lecture/voix";
import { sansValeursRevelees } from "../../domaine/filtre-confidentialite";
import { compacterFil } from "./resume";
import { conversationCourante, conversationDe, creerConversation, marquerActivite, proposerTitre } from "../conversations/service";
import { sectionDossierDuTour } from "../conversations/dossiers";
import { titreProvisoire } from "../../domaine/conversations";
import { lireVueSimulation } from "../../domaine/simulation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FIL DE L'ASSISTANT IA — chaque conversation GARDÉE, jouée EN ARRIÈRE-PLAN.
 *
 * Décision 0027 (Adventum IA, 30/10/2026) : PLUSIEURS conversations par personne. Chaque geste nomme sa
 * conversation (`conversation`) ; sans nom (anciens écrans, anciens liens), c'est la conversation courante — la
 * plus récente, ni archivée ni privée (`conversationCourante`). Une conversation privée ne lit ni n'écrit la
 * mémoire ; une conversation rangée dans un dossier en reçoit les consignes et les documents.
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
 * confirmer, aucune donnée sensible au modèle (sorties d'outils jetonnées, `filtre-confidentialite.ts` — repères).
 *
 * VOCAUX ET PIÈCES LUES (28/10/2026) : un message peut être un VOCAL (fichier du Drive, transcrit
 * au moment d'être joué, la transcription gardée sur le tour et affichée sous le lecteur) ; les
 * pièces sont LUES (`lecture/pieces.ts`) et ce que la lecture a donné — lue, partielle, refusée —
 * est gardé sur le tour (`lecture`) pour que l'écran DISE chaque limite. Option « réponse vocale » :
 * la réponse est aussi synthétisée (`audio`, un fichier du Drive de la personne).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ETAT = { ATTENTE: "EN_ATTENTE", COURS: "EN_COURS", TRAITE: "TRAITE", TERMINE: "TERMINE", ECHEC: "ECHEC" } as const;

const PRISE_PERDUE_MS = 10 * 60_000;
// Pendant un tour, l'écran relit le fil toutes les 0,9 s : six secondes sans lecture, la personne est ailleurs.
const ABSENT_APRES_MS = 6_000;
/**
 * Au plus 16 tours mot pour mot — une borne de sûreté : en régime, J4 (décision 0018) n'en garde que les échanges
 * POSTÉRIEURS au résumé roulant (`resume.ts`), soit 4 à 7 échanges, et l'assembleur les met dans leur enveloppe.
 */
const TOURS_EN_CONTEXTE = 16;
const MAX_EN_FILE = 10;
const DELAI_FOND_MS = Number(process.env.ASSISTANT_FOND_TIMEOUT_MS) || 240_000;
const ETAPES_FOND = 24;
const ECRITURE_PARTIELLE_MS = 350;
/**
 * TROIS ESSAIS PAR MESSAGE (IA-ASSISTANT-06). Un tour qui LÈVE (base indisponible au mauvais moment,
 * pièce illisible) laissait son message « en cours » ; le battement le remettait en file, le rejouait,
 * créait une réponse en échec de plus — chaque minute, sans fin, et en rappelant le modèle si la panne
 * survenait après lui. Chaque prise compte désormais un essai ; au-delà, le message échoue et le dit.
 */
export const ESSAIS_MAX = 3;
export const ECHEC_ESSAIS = "La demande a échoué trois fois — reformulez-la, ou réessayez dans un moment.";

export const CONSIGNE_FOND = [
  "TÂCHES LONGUES : tu travailles en arrière-plan, la personne peut quitter l'écran — elle sera notifiée.",
  "Pour une demande à plusieurs étapes, enchaîne les lectures nécessaires (une par une, sans t'arrêter à la première), puis rends UN compte rendu structuré : ce que tu as fait, ce que tu as trouvé, ce qui reste à confirmer.",
  "Si la personne a envoyé plusieurs messages d'affilée, réponds à CE message en tenant compte des précédents.",
].join("\n");

/** La conversation nommée (si elle est à la personne), sinon la conversation courante. */
export async function filDe(userId: string, conversation?: string | null) {
  if (conversation) {
    const f = await conversationDe(userId, conversation);
    if (f) return f;
  }
  return conversationCourante(userId);
}

export type PieceDuTour = { id: string; nom: string };

/**
 * DÉPOSER un message dans le fil. Ne joue rien : l'appelant lance `traiterFil` (sans l'attendre).
 * `vocal` : l'identifiant Drive de l'enregistrement (déjà déposé sous les droits de la personne) et
 * sa durée — la transcription viendra quand le fil jouera le message.
 */
export async function deposerMessage(
  userId: string, texte: string, pieces: PieceDuTour[], vocal?: { id: string; dureeS: number | null } | null, conversation?: string | null,
): Promise<{ ok: true; tour: AssistantIaTour; conversation: string } | { ok: false; erreur: string }> {
  const t = (texte ?? "").trim().slice(0, 8000);
  const p = pieces.filter((x) => x && typeof x.id === "string").slice(0, PIECES_PAR_ENVOI_MAX).map((x) => ({ id: x.id, nom: String(x.nom ?? "").slice(0, 200) }));
  const v: VocalDuTour | null = vocal && typeof vocal.id === "string" && vocal.id
    ? { id: vocal.id, dureeS: Number.isFinite(vocal.dureeS) ? Math.max(0, Math.round(vocal.dureeS as number)) : null, etat: "TRANSCRIPTION" }
    : null;
  if (!t && !p.length && !v) return { ok: false, erreur: "Message vide." };
  if (conversation && !(await conversationDe(userId, conversation))) return { ok: false, erreur: "Conversation introuvable." };
  const fil = await filDe(userId, conversation);
  const enFile = await prisma.assistantIaTour.count({ where: { filId: fil.id, role: "user", etat: { in: [ETAT.ATTENTE, ETAT.COURS] } } });
  if (enFile >= MAX_EN_FILE) return { ok: false, erreur: `${MAX_EN_FILE} messages attendent déjà leur réponse — laissez l'assistant avancer.` };
  const tour = await prisma.assistantIaTour.create({
    data: {
      filId: fil.id, userId, role: "user", contenu: t, etat: ETAT.ATTENTE,
      ...(p.length ? { pieces: p as Prisma.InputJsonValue } : {}),
      ...(v ? { vocal: v as unknown as Prisma.InputJsonValue } : {}),
    },
  });
  // La conversation remonte en tête de liste ; son premier message lui donne un titre provisoire.
  await marquerActivite(fil.id, titreProvisoire(t || (p.length ? `Pièces : ${p.map((x) => x.nom).join(", ")}` : ""), !!v));
  return { ok: true, tour, conversation: fil.id };
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

/** LIRE une conversation (depuis sa dernière « nouvelle conversation ») — et dire que la personne est là. */
export async function lireFil(userId: string, limite = 80, conversation?: string | null) {
  const trouve = await filDe(userId, conversation);
  const fil = await prisma.assistantIaFil.update({ where: { id: trouve.id }, data: { consulteLe: new Date() } });
  const tours = ordonner(await prisma.assistantIaTour.findMany({
    where: { filId: fil.id, createdAt: { gte: fil.depuisLe } },
    orderBy: { createdAt: "desc" },
    take: limite,
  }));
  // L'état d'une carte vit sur l'intention (confirmée, exécutée…), pas sur le tour qui l'a proposée.
  const ids = tours.map((t) => (t.intent as { id?: string } | null)?.id).filter((x): x is string => !!x);
  const intents = ids.length
    ? await prisma.assistantActionIntent.findMany({ where: { id: { in: ids }, userId }, select: { id: true, status: true, resultLink: true, resultMessage: true, payload: true } })
    : [];
  const parId = new Map(intents.map((i) => [i.id, i]));
  return {
    tours: tours.map((t) => {
      const i = t.intent as { id?: string } | null;
      const etat = i?.id ? parId.get(i.id) : undefined;
      // J7 : une carte REMONTRÉE (la simulation rejouée a changé) montre son nouveau diff, pas celui du tour.
      const simulation = lireVueSimulation((etat?.payload as { simulation?: unknown } | null)?.simulation);
      return etat ? { ...t, intent: { ...i, status: etat.status, resultLink: etat.resultLink ?? undefined, resultMessage: etat.resultMessage ?? undefined, ...(simulation ? { simulation } : {}) } } : t;
    }),
    enCours: tours.some((t) => t.etat === ETAT.ATTENTE || t.etat === ETAT.COURS),
    reponseVocale: fil.reponseVocale,
    conversation: { id: fil.id, titre: fil.titre, prive: fil.prive, dossierId: fil.dossierId },
  };
}

/** L'option « réponse vocale » de la personne : chaque réponse est aussi dite à voix haute. */
export async function reglerReponseVocale(userId: string, active: boolean): Promise<void> {
  // Un réglage de la PERSONNE : toutes ses conversations (une nouvelle le reprend de la plus récente).
  await conversationCourante(userId);
  await prisma.assistantIaFil.updateMany({ where: { userId }, data: { reponseVocale: active } });
}

/**
 * NOUVELLE CONVERSATION : une conversation neuve, qui devient la courante — l'ancienne reste dans la liste, rien
 * n'est supprimé (décision 0027 ; avant, le fil unique repartait de zéro par `depuisLe`).
 */
export async function nouvelleConversation(userId: string, opts: { prive?: boolean; dossierId?: string | null } = {}): Promise<{ ok: true; conversation: string } | { ok: false; erreur: string }> {
  const r = await creerConversation(userId, opts);
  return r.ok ? { ok: true, conversation: r.conversation.id } : r;
}

const prochain = (filId: string) => prisma.assistantIaTour.findFirst({
  where: { filId, role: "user", etat: ETAT.ATTENTE },
  orderBy: { createdAt: "asc" },
});

/**
 * JOUER LE FIL — prend le fil (une seule prise à la fois), joue les messages en attente dans
 * l'ordre, relâche. Un message déposé pendant qu'on relâchait est repris. Ne lève jamais.
 */
export async function traiterFil(userId: string, conversation?: string | null): Promise<void> {
  // Sans conversation nommée : chacune de celles qui ont un message en attente (anciens appelants, balayage).
  if (!conversation) {
    const fils = await prisma.assistantIaFil.findMany({
      where: { userId, tours: { some: { role: "user", etat: ETAT.ATTENTE } } }, select: { id: true },
    }).catch(sansBloquer("fil-service.traiterFil.conversations", [] as { id: string }[]));
    await Promise.all(fils.map((f) => traiterFil(userId, f.id)));
    return;
  }
  try {
    const fil = await prisma.assistantIaFil.findFirst({ where: { id: conversation, userId }, select: { id: true } });
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
        await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { traitementLe: null } }).catch(sansBloquer("fil-service.traiterFil.assistantIaFil"));
      }
      if (!(await prochain(fil.id))) return;
    }
  } catch (e) {
    console.error("[assistant-fil] traitement", userId, e);
  }
}

/** Ce que la personne a DIT : son texte, sinon la transcription de son vocal. */
export function texteDuTour(t: Pick<AssistantIaTour, "contenu" | "vocal">): string {
  const v = t.vocal as VocalDuTour | null;
  return t.contenu.trim() || (v?.etat === "TRANSCRIT" ? v.transcription ?? "" : "");
}

/**
 * Un tour ancien, tel que le modèle le relit : le texte (ou le vocal transcrit), puis les pièces avec
 * ce que leur lecture a donné — leur CONTENU n'est pas repris (il a servi au tour où elles ont été
 * jointes ; `lire_document` les relit au besoin).
 */
function pourHistorique(t: AssistantIaTour): { role: "user" | "assistant"; content: string } {
  if (t.role !== "user") return { role: "assistant", content: t.contenu };
  const pieces = (t.pieces as PieceDuTour[] | null) ?? [];
  const lectures = (t.lecture as LecturePiece[] | null) ?? [];
  const parId = new Map(lectures.map((l) => [l.id, l]));
  const texte = texteDuTour(t);
  const dit = (t.vocal as VocalDuTour | null)?.etat === "TRANSCRIT" && !t.contenu.trim() ? `[Message vocal transcrit] ${texte}` : texte;
  if (!pieces.length) return { role: "user", content: dit };
  const liste = pieces.map((p) => {
    const l = parId.get(p.id);
    return `« ${p.nom} » (identifiant ${p.id})${l ? ` — ${resumeLecture(l)}` : ""}`;
  }).join(" ; ");
  return { role: "user", content: `${dit}\n[Pièces jointes : ${liste}]` };
}

async function jouerTourDuFil(userId: string, tour: AssistantIaTour): Promise<void> {
  const debut = Date.now();
  if (tour.essais >= ESSAIS_MAX) {
    await prisma.assistantIaTour.create({
      data: { filId: tour.filId, userId, role: "assistant", contenu: ECHEC_ESSAIS, etat: ETAT.ECHEC, erreur: "essais", repondA: tour.id },
    });
    await prisma.assistantIaTour.update({ where: { id: tour.id }, data: { etat: ETAT.ECHEC } });
    return;
  }
  await prisma.assistantIaTour.update({ where: { id: tour.id }, data: { etat: ETAT.COURS, essais: { increment: 1 } } });
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
  // J4 : ce que le RÉSUMÉ ROULANT couvre déjà ne repart pas mot pour mot (la question de l'échange en fait foi).
  const dateQuestion = new Map(anterieurs.filter((t) => t.role === "user").map((t) => [t.id, t.createdAt.getTime()]));
  const apresResume = (t: AssistantIaTour) => !fil.resumeJusquA
    || (dateQuestion.get(t.role === "user" ? t.id : t.repondA ?? "") ?? 0) > fil.resumeJusquA.getTime();
  const precedents = anterieurs
    .filter((t) => (t.role === "user" ? questions.has(t.id) && t.etat === ETAT.TRAITE : !!t.repondA && questions.has(t.repondA) && t.etat === ETAT.TERMINE))
    .filter((t) => (t.role === "user" ? texteDuTour(t) || (t.pieces as unknown[] | null)?.length : t.contenu.trim()))
    .filter(apresResume)
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
    enVol = enVol.then(() => prisma.assistantIaTour.update({ where: { id: reponse.id }, data: { contenu, etapes: liste } }).catch(sansBloquer("fil-service.publier.assistantIaTour")));
  };

  // LE VOCAL D'ABORD : transcrit une fois (gardé sur le tour — un essai suivant ne repaie pas), la
  // transcription s'affiche sous le lecteur pendant que l'assistant rédige.
  let vocal = tour.vocal as VocalDuTour | null;
  if (vocal && vocal.etat !== "TRANSCRIT") {
    const v = vocal;
    vocal = await auNomDe(userId, () => transcrireVocal(user, v), tour.filId);
    await prisma.assistantIaTour.update({ where: { id: tour.id }, data: { vocal: vocal as unknown as Prisma.InputJsonValue } });
    if (vocal.etat !== "TRANSCRIT" && !tour.contenu.trim() && !((tour.pieces as unknown[] | null)?.length)) {
      const raison = `Le vocal n'a pas pu être transcrit : ${vocal.erreur ?? "raison inconnue"}`;
      await finir({ etat: ETAT.ECHEC, contenu: raison, erreur: raison.slice(0, 300) }, ETAT.ECHEC);
      return;
    }
  }
  const texteDit = texteDuTour({ contenu: tour.contenu, vocal: vocal as unknown as Prisma.JsonValue });

  const r = await jouerTour(user, {
    texte: texteDit,
    prive: fil.prive,
    sectionDossier: await sectionDossierDuTour(user, fil.dossierId),
    vocal: !tour.contenu.trim() && vocal?.etat === "TRANSCRIT",
    surLecture: async (lectures) => {
      await prisma.assistantIaTour.update({ where: { id: tour.id }, data: { lecture: lectures as unknown as Prisma.InputJsonValue } }).catch(sansBloquer("fil-service.surLecture.assistantIaTour"));
    },
    pieces: tour.pieces ?? [],
    historique: precedents.map(pourHistorique),
    resume: fil.resume,
    delaiMs: DELAI_FOND_MS,
    maxEtapes: ETAPES_FOND,
    conversation: tour.filId,
    consigne: CONSIGNE_FOND,
    // J14 : la trace rejouable, rattachée à la réponse affichée (et au message de la personne).
    trace: { tourId: reponse.id, messageId: tour.id },
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
      ...(r.notesProposees.length ? { notesProposees: r.notesProposees as unknown as Prisma.InputJsonValue } : {}),
      outils: r.outilsAppeles,
    }, ETAT.TRAITE);
  } else {
    await finir({ etat: ETAT.ECHEC, contenu: r.error, erreur: r.error.slice(0, 300), etapes }, ETAT.ECHEC);
  }

  // LA RÉPONSE VOCALE (option de la personne) : après le texte, qui s'affiche sans l'attendre.
  if (r.ok && fil.reponseVocale) {
    let audio: AudioDuTour | null;
    try {
      // La voix est synthétisée par un modèle : une valeur révélée n'y part pas (décision 0012).
      audio = await auNomDe(userId, () => repondreAVoixHaute(user, sansValeursRevelees(r.content)), tour.filId);
    } catch (e) {
      console.error("[assistant-fil] réponse vocale", e);
      audio = { id: "", dureeS: null, erreur: "La réponse vocale n'a pas pu être préparée." };
    }
    if (audio) await prisma.assistantIaTour.update({ where: { id: reponse.id }, data: { audio: audio as unknown as Prisma.InputJsonValue } }).catch(sansBloquer("fil-service.reponseVocale.assistantIaTour"));
  }

  // LA PERSONNE EST AILLEURS : la réponse va la chercher (cloche + téléphone).
  const vu = await prisma.assistantIaFil.findUnique({ where: { id: tour.filId }, select: { consulteLe: true } });
  if (!vu?.consulteLe || Date.now() - vu.consulteLe.getTime() > ABSENT_APRES_MS) {
    const sujet = texteDit.replace(/\s+/g, " ").trim().slice(0, 60) || (vocal ? "message vocal" : "pièces jointes");
    await notifyUser({
      userId, type: "GENERIC",
      title: r.ok ? `Assistant IA : réponse prête — « ${sujet} »` : `Assistant IA : la demande n'a pas abouti — « ${sujet} »`,
      // Une notification sort de l'écran (téléphone, cloche) : jamais une valeur révélée.
      body: sansValeursRevelees(r.ok ? r.content : r.error).replace(/[#*_`>]/g, "").trim().slice(0, 280),
      // LA BONNE CONVERSATION (décision 0027) : l'ERP l'ouvre sur `/assistant`, l'app Adventum IA renvoie ce lien vers `/ia`.
      link: `/assistant?c=${tour.filId}`,
    }).catch(sansBloquer("fil-service.jouerTourDuFil.notifyUser"));
  }

  // LE TITRE PROPOSÉ (décision 0027) : après la première réponse, par le modèle rapide — jamais avant le premier mot.
  if (r.ok && fil.titreSource !== "manuel" && fil.titreSource !== "auto") await proposerTitre(tour.filId);

  // LE RÉSUMÉ ROULANT (J4) : après la réponse, jamais avant — il ne retarde aucun premier mot.
  if (r.ok) await compacterFil(tour.filId);
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
    relances.push(traiterFil(f.userId, f.id));
  }
  // Le battement n'attend pas les tours (ils peuvent durer des minutes) ; un test, si.
  if (attendre) await Promise.all(relances);
  return { relances: fils.length };
}
