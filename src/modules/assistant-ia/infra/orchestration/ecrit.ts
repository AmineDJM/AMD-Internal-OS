import { prisma } from "@/lib/prisma";
import { affichageEcrit, etatInitial, transition } from "@/platform/ia/conversation/orchestrateur";
import { REGLAGES_ORCHESTRATION, type OrchestrationFil } from "../../domaine/conversation/agenda";
import { voieDuClassement, type Classement } from "../../domaine/conversation/classement";
import { sansValeursRevelees } from "../../domaine/filtre-confidentialite";
import { auNomDe } from "../consommation";
import { genererTexte } from "../generer";
import { deposerMessage, ETAT, filDe, traiterFil, type PieceDuTour } from "../fil/service";
import { texteOuPiece } from "../fil/texte-long";
import {
  appliquerPrecisions, avancementDuTravail, enregistrerPrecision, ETAT_AGENDA, ouvrirAgenda, precisionsEnAttente, questionDeLElement, racineDe,
  repondreElement, versElement, versionsDAvant,
} from "./agenda";
import { classerEnonce } from "./classement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORCHESTRATEUR À L'ÉCRIT (lot O1, décision 0046) — la même machine que la voix, lue sur le fil.
 *
 * Direction : « pas que à l'oral, c'est aussi le cas pour l'écrit ». Pendant qu'un travail tourne :
 *   • chaque message est CLASSÉ (`classerEnonce`) : une précision du travail (réponse à la question posée, ou libre) est
 *     gardée et appliquée selon son impact — majeure réinjectée, mineure portée sur le rendu, sans relance ; une autre
 *     demande, ou une simple conversation, part dans la voie parallèle si le travail est long (elle ne l'attend pas) ;
 *   • l'assistant pose dans le fil les éléments utiles de l'agenda, un à la fois, tant que le travail tourne ;
 *   • un résultat arrivé pendant que SA question attend réponse est TENU (« affiché après ta réponse ») ; l'avancement
 *     réel est dit sous la réponse qui s'écrit. La carte K3 reste la source de l'avancement des missions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les seuils (décision 0046 §7 : des réglages, pas des plafonds) — relus de l'environnement, sinon les défauts. */
export function reglagesOrchestration() {
  const lu = (nom: string, defaut: number) => {
    const v = Number(process.env[nom]);
    return Number.isFinite(v) && v >= 0 ? v : defaut;
  };
  return {
    agendaEcritApresMs: lu("ASSISTANT_O1_AGENDA_ECRIT_MS", REGLAGES_ORCHESTRATION.agendaEcritApresMs),
    travailLongMs: lu("ASSISTANT_O1_TRAVAIL_LONG_MS", REGLAGES_ORCHESTRATION.travailLongMs),
    questionExpireMs: lu("ASSISTANT_O1_QUESTION_EXPIRE_MS", REGLAGES_ORCHESTRATION.questionExpireMs),
  };
}

/** La question de l'agenda qui attend réponse dans ce fil (la plus récente). */
const questionDuFil = (userId: string, filId: string) => prisma.assistantIaAgenda.findFirst({
  where: { userId, filId, etat: ETAT_AGENDA.POSEE, nature: { not: "partiel" } }, orderBy: { poseeLe: "desc" },
});

/** La réponse qui s'écrit dans la file habituelle (pas la voie parallèle) — le travail en cours, s'il y en a un. */
async function travailEnCours(filId: string) {
  const r = await prisma.assistantIaTour.findFirst({ where: { filId, role: "assistant", etat: ETAT.COURS }, orderBy: { createdAt: "asc" }, select: { id: true, repondA: true, createdAt: true } });
  if (!r?.repondA) return null;
  const q = await prisma.assistantIaTour.findUnique({ where: { id: r.repondA }, select: { id: true, parallele: true } });
  return q && !q.parallele ? { reponse: r.id, tour: q.id, depuisMs: Date.now() - r.createdAt.getTime() } : null;
}

/** La demande d'origine d'un travail (sa racine), sans le préfixe d'un tour vocal. */
const demandeDe = async (racine: string) => ((await prisma.assistantIaTour.findUnique({ where: { id: racine }, select: { contenu: true } }))?.contenu ?? "").replace(/^\[[^\]]*\]\s*/, "");

/**
 * ÉCRIRE PENDANT UN TRAVAIL — classé (précision / autre demande / conversation), puis : la précision est gardée et
 * appliquée au travail ; le reste part dans la voie parallèle (travail long) ou la file habituelle. Le message reste
 * toujours visible dans le fil, tel qu'il a été écrit.
 */
export async function deposerEcrit(userId: string, texteBrut: string, piecesBrutes: PieceDuTour[], conversation?: string | null) {
  // Direction (02/11/2026) : jamais coupé — un texte trop long devient une pièce AVANT le classement.
  const { texte, pieces } = await texteOuPiece(userId, texteBrut ?? "", piecesBrutes);
  const fil = await filDe(userId, conversation);
  if (conversation && fil.id !== conversation) return { ok: false as const, erreur: "Conversation introuvable." };
  const [q, t] = await Promise.all([questionDuFil(userId, fil.id), travailEnCours(fil.id)]);
  if ((!q && !t) || pieces.length || !texte.trim()) {
    const d = await deposerMessage(userId, texte, pieces, null, fil.id);
    if (d.ok) void traiterFil(userId, d.conversation);
    return d.ok ? { ...d, voie: "suite" as const } : d;
  }
  const racine = q ? q.tourId : await racineDe(t!.tour);
  const c: Classement = await classerEnonce(userId, fil.id, {
    enonce: texte, demandeEnCours: await demandeDe(racine), question: q ? { ...questionDeLElement(q), texte: q.question } : null,
  });
  const voie = voieDuClassement(c, { travailEnCoursDepuisMs: t?.depuisMs ?? null, questionEnAttente: !!q, travailLongMs: reglagesOrchestration().travailLongMs });
  if (voie === "precision") {
    // Le message de la personne, tel qu'écrit, reste dans le fil (traité : c'est la suite du travail).
    const tour = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId, role: "user", contenu: texte.trim(), etat: ETAT.TRAITE } });
    await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { dernierLe: new Date() } });
    if (c.repondA && q && q.id === c.repondA) await repondreElement(userId, q, texte);
    else await enregistrerPrecision(userId, racine, c);
    const app = await appliquerPrecisions(userId, racine);
    if (app.texte.length) await miseEnFormeEcrite(userId, fil.id, app.courant, app.texte);
    return { ok: true as const, tour, conversation: fil.id, voie, classement: c };
  }
  const d = await deposerMessage(userId, texte, pieces, null, fil.id, { parallele: voie === "parallele" });
  if (d.ok) void traiterFil(userId, d.conversation);
  return d.ok ? { ...d, voie, classement: c } : d;
}

const CONSIGNE_MISE_EN_FORME = [
  "Tu remets en forme une réponse DÉJÀ ÉCRITE selon les consignes de la personne (ton, longueur, présentation, langue).",
  "Tu ne changes AUCUN fait, chiffre, nom ni conclusion ; tu n'ajoutes rien. Les repères ⟦…⟧ ou « [confidentiel] » restent tels quels.",
  "Rends seulement la réponse remise en forme, en Markdown, sans préambule.",
].join("\n");

/**
 * UNE PRÉCISION MINEURE DE TEXTE sur une réponse déjà écrite (« plus court », « plus formel ») — PAS de relance : la
 * réponse est remise en forme par le modèle rapide (sans outil, sans valeur révélée), déposée juste sous l'originale.
 */
async function miseEnFormeEcrite(userId: string, filId: string, courant: string, lignes: string[]): Promise<void> {
  const rep = await prisma.assistantIaTour.findFirst({ where: { repondA: courant, role: "assistant", etat: ETAT.TERMINE }, orderBy: { createdAt: "desc" }, select: { contenu: true } });
  if (!rep) return;
  const r = await auNomDe(userId, () => genererTexte(CONSIGNE_MISE_EN_FORME, `Consignes : ${lignes.join(" ")}\n\nRéponse à remettre en forme :\n${sansValeursRevelees(rep.contenu).slice(0, 12_000)}`, 45_000, { role: "rapide" }), filId);
  await prisma.assistantIaTour.create({
    data: {
      filId, userId, role: "assistant", repondA: courant, etat: r.ok ? ETAT.TERMINE : ETAT.ECHEC,
      contenu: r.ok ? `_Mise en forme demandée — ${lignes.join(" ")}_\n\n${r.texte.trim()}` : `La mise en forme demandée (${lignes.join(" ")}) n'a pas pu être faite : ${r.raison}`,
    },
  });
}

export type { OrchestrationFil };

/**
 * L'ÉTAT D'ORCHESTRATION D'UN FIL, à chaque lecture de l'écran. Applique les précisions dont le travail a fini ; ouvre
 * l'agenda d'un travail devenu long et pose l'élément suivant (un seul à la fois, `A_POSER` → `POSEE`, atomique) — tant
 * que le travail tourne, l'agenda se renouvelle ; dit quelles réponses sont tenues.
 */
export async function orchestrationDuFil(userId: string, filId: string): Promise<OrchestrationFil> {
  const reglages = reglagesOrchestration();
  for (const racine of await precisionsEnAttente(userId, filId)) {
    const app = await appliquerPrecisions(userId, racine);
    if (app.texte.length) await miseEnFormeEcrite(userId, filId, app.courant, app.texte);
  }
  let q = await questionDuFil(userId, filId);
  const t = await travailEnCours(filId);
  let avancement: OrchestrationFil["avancement"] = null;
  if (t && t.depuisMs >= reglages.agendaEcritApresMs) {
    if (!q) {
      const racine = await racineDe(t.tour);
      const a = (await ouvrirAgenda(userId, filId, racine, await demandeDe(racine))).find((x) => x.etat === ETAT_AGENDA.A_POSER && x.nature !== "partiel");
      if (a) {
        const n = await prisma.assistantIaAgenda.updateMany({ where: { id: a.id, etat: ETAT_AGENDA.A_POSER }, data: { etat: ETAT_AGENDA.POSEE, poseeLe: new Date() } });
        if (n.count) q = await questionDuFil(userId, filId);
      }
    }
    const texte = await avancementDuTravail(userId, t.tour);
    if (texte && t.depuisMs >= reglages.travailLongMs) avancement = { reponseId: t.reponse, texte };
  }
  // LA MÊME MACHINE QUE LA VOIX : le travail, sa question posée, son résultat s'il est là → ce qui est tenu.
  let e = etatInitial();
  if (q) {
    const el = versElement(q);
    e = transition(e, { type: "reponse_prise_en_compte", ms: 0, accuse: "", silencieux: true, lance: { id: q.tourId, agenda: [el] } });
    e = transition(e, { type: "dit", ms: 0, action: { type: "dire", contenu: el.texte, delegationId: null, accuse: false, annonce: null, element: el, avancement: null, travail: q.tourId } });
    const reponses = await prisma.assistantIaTour.findMany({ where: { repondA: q.tourId, role: "assistant", etat: { in: [ETAT.TERMINE, ETAT.ECHEC] } }, select: { id: true, etat: true } });
    for (const r of reponses) e = transition(e, { type: "resultat", ms: 1, travail: r.id, contenu: "", echec: r.etat === ETAT.ECHEC });
  }
  return {
    question: q ? { id: q.id, tourId: q.tourId, texte: q.question, choix: versElement(q).choix ?? [] } : null,
    tenus: affichageEcrit(e).tenus,
    avancement,
    ajustes: await versionsDAvant(userId, filId),
  };
}
