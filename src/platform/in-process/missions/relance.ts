/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉCHELLE DE RELANCES — quand une attente a dépassé son délai, Adam relance LUI-MÊME.
 *
 * Avant ce fichier, une attente échue produisait un push au dirigeant : « attend toujours.
 * Voulez-vous relancer ? ». C'est l'agent passif : il transfère à la personne qu'il décharge la
 * micro-décision la plus évidente. Un chef de cabinet relance, puis relance encore, puis monte
 * d'un cran, et ne vient vous voir que quand tout cela n'a rien donné.
 *
 * ── L'ÉCHELLE, ET SES BORNES ─────────────────────────────────────────────────────────────
 *
 *   barreau 1  message interne à la personne attendue, signé Adam (compte système), un par 24 h ;
 *   barreau 2  seconde relance, même canal ;
 *   barreau 3  le responsable hiérarchique de la personne (Employee.managerId) est mis dans la
 *              boucle par un message ;
 *   au-delà    le dirigeant est prévenu par la porte d'attention (ATTENTION) — l'échelle est dite.
 *
 * Ce qui n'est PAS fait : écrire à l'extérieur (un partenaire, une autorité). Une relance externe
 * est une communication qui engage l'entreprise ; elle passe par un plan et un accord, jamais
 * par le battement. Quand la personne attendue n'est pas un compte interne, l'échelle saute
 * directement au dirigeant avec la mention « personne externe ».
 *
 * Tout est relu au journal de la mission (`NUDGED`, avec le barreau et la date) : aucune mémoire
 * de processus, donc aucun harcèlement au redémarrage et aucun oubli à la reprise.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { journaliser } from "@/lib/missions/runtime/store";
import { idCompteAgent } from "@/lib/missions/agent/account";
import { envoyerMessageDirect } from "@/lib/messaging";
import { porteAttentionPour } from "@/platform/in-process/missions/attention";
import { correspond, lireAttente, type Attente, type FaitObserve } from "@/lib/missions/events/match";
import { sansBloquer } from "@/lib/journal";

export const CADENCE_RELANCE_MS = 24 * 3600_000;
export const BARREAUX_AVANT_DIRIGEANT = 3;

export interface AttenteEchue {
  missionId: string; ownerId: string; missionTitle: string;
  stepKey: string; stepTitle: string; attente: Attente; depuis: Date;
}

export interface ResultatRelance {
  geste: "RELANCE" | "MANAGER" | "DIRIGEANT" | "SILENCE" | "EXTERNE";
  barreau: number;
  detail: string;
}

/** La personne attendue, si c'est un compte interne actif : par nom, par adresse, ou par identifiant. */
async function personneAttendue(from: string | undefined): Promise<{ id: string; name: string; managerUserId: string | null } | null> {
  if (!from || from.trim().length < 3) return null;
  const f = from.trim();
  const user = await prisma.user.findFirst({
    where: {
      isActive: true, isSystem: false,
      OR: [{ id: f }, { email: { equals: f, mode: "insensitive" } }, { name: { equals: f, mode: "insensitive" } }, { name: { contains: f, mode: "insensitive" } }],
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  }).catch(sansBloquer("relance.personneAttendue.user", null));
  if (!user) return null;
  const fiche = await prisma.employee.findFirst({ where: { userId: user.id }, select: { manager: { select: { userId: true } } } }).catch(sansBloquer("relance.personneAttendue.employee", null));
  return { id: user.id, name: user.name, managerUserId: fiche?.manager?.userId ?? null };
}

/** Les relances déjà faites pour cette étape, et la date de la dernière — lues au journal. */
async function historique(missionId: string, stepKey: string): Promise<{ n: number; derniere: Date | null }> {
  const rows = await prisma.missionEvent.findMany({
    where: { missionId, kind: "NUDGED", detail: { path: ["stepKey"], equals: stepKey } },
    select: { at: true }, orderBy: { at: "desc" },
  }).catch(sansBloquer("relance.historique.missionEvent", []));
  return { n: rows.length, derniere: rows[0]?.at ?? null };
}

async function messageSigneAdam(agentId: string, destinataireId: string, body: string, missionId?: string): Promise<boolean> {
  try {
    // Le MÊME geste que l'écran et l'assistant : conversation, message, fait MESSAGE_RECEIVED.
    const { conversationId } = await envoyerMessageDirect({ senderId: agentId, senderName: "Adam", recipientId: destinataireId, body, missionId: missionId ?? null });
    // Le lien ouvre LA conversation où Adam vient d'écrire, pas la messagerie à parcourir.
    await notifyUser({ userId: destinataireId, type: "GENERIC", title: "Relance d'Adam", body: body.slice(0, 100), link: `/messages?c=${encodeURIComponent(conversationId)}` });
    return true;
  } catch (e) {
    console.error("[relance] message impossible", e);
    return false;
  }
}

/**
 * RELANCE UNE PERSONNE INTERNE PAR MESSAGE SIGNÉ ADAM — le geste commun aux attentes de mission
 * et aux engagements en retard. Barreaux 1-2 : la personne ; barreau 3 : sa hiérarchie si elle
 * existe ; au-delà : `null` — c'est à l'appelant de prévenir le dirigeant. Ne lève jamais.
 */
export async function relancerPersonne(opts: {
  personneId: string; barreau: number; pour: string; objet: string; contexte: string; jours: number;
}): Promise<{ geste: "RELANCE" | "MANAGER"; destinataire: string; envoye: boolean } | null> {
  if (opts.barreau > BARREAUX_AVANT_DIRIGEANT) return null;
  const agentId = await idCompteAgent();
  if (!agentId) return null;
  const personne = await personneAttendue(opts.personneId);
  if (!personne) return null;
  const prenom = personne.name.split(" ")[0];
  if (opts.barreau === BARREAUX_AVANT_DIRIGEANT && personne.managerUserId && personne.managerUserId !== personne.id) {
    const corps = `Bonjour — pour ${opts.pour} : « ${opts.objet} » (${opts.contexte}) attend ${personne.name} depuis ${opts.jours} jour(s), `
      + `après ${opts.barreau - 1} relance(s) restées sans réponse. Pouvez-vous voir avec ${prenom} ce qui bloque ? — Adam`;
    const envoye = await messageSigneAdam(agentId, personne.managerUserId, corps);
    return { geste: "MANAGER", destinataire: personne.managerUserId, envoye };
  }
  const corps = `Bonjour ${prenom} — pour ${opts.pour} : « ${opts.objet} » (${opts.contexte}) attend votre retour depuis ${opts.jours} jour(s)`
    + (opts.barreau > 1 ? `, c'est ma ${opts.barreau}ᵉ relance` : "") + `. Un mot ici suffit, même pour dire « pas avant tel jour ». Merci — Adam`;
  const envoye = await messageSigneAdam(agentId, personne.id, corps);
  return { geste: "RELANCE", destinataire: personne.id, envoye };
}

/**
 * RELANCE UNE ATTENTE ÉCHUE — un barreau par appel, jamais deux le même jour. Idempotent au
 * battement : rappelé dix fois dans la journée, il ne fait rien neuf fois.
 */
export async function relancerAttente(e: AttenteEchue, maintenant = new Date()): Promise<ResultatRelance> {
  const h = await historique(e.missionId, e.stepKey);
  if (h.derniere && maintenant.getTime() - h.derniere.getTime() < CADENCE_RELANCE_MS) {
    return { geste: "SILENCE", barreau: h.n, detail: "relance déjà faite dans les 24 h" };
  }
  const jours = Math.max(1, Math.round((maintenant.getTime() - e.depuis.getTime()) / 86_400_000));
  const barreau = h.n + 1;
  const porte = porteAttentionPour();

  // ── L'ÉCHELLE ÉPUISÉE, OU PERSONNE À RELANCER EN INTERNE : LE DIRIGEANT ─────────────
  const personne = await personneAttendue(e.attente.from);
  if (!personne || barreau > BARREAUX_AVANT_DIRIGEANT) {
    const geste: ResultatRelance["geste"] = personne ? "DIRIGEANT" : "EXTERNE";
    await porte.signaler({
      kind: "WAIT_OVERDUE", missionId: e.missionId, ownerId: e.ownerId, titre: e.missionTitle, stepKey: e.stepKey,
      raison: personne
        ? `« ${e.stepTitle} » attend ${personne.name} depuis ${jours} jour(s) malgré ${h.n} relance(s) et l'alerte de sa hiérarchie`
        : `« ${e.stepTitle} » attend ${e.attente.from ?? "une partie externe"} (hors de l'entreprise) depuis ${jours} jour(s)`,
      decision: personne ? "trancher : relancer autrement, réassigner, ou clore" : "relancer le partenaire par un e-mail que je préparerai, ou clore",
      attente: { jours, relances: Math.max(h.n, BARREAUX_AVANT_DIRIGEANT) },
    }).catch(sansBloquer("relance.relancerAttente.signaler"));
    await journaliser(e.missionId, "NUDGED", `Barreau ${barreau} : le dirigeant est prévenu (${geste === "EXTERNE" ? "partie externe" : "échelle épuisée"}).`,
      { stepKey: e.stepKey, barreau, geste });
    return { geste, barreau, detail: geste === "EXTERNE" ? "partie externe : le dirigeant décide" : "échelle épuisée : le dirigeant décide" };
  }

  const agentId = await idCompteAgent();
  if (!agentId) {
    await journaliser(e.missionId, "NUDGED", `Barreau ${barreau} impossible : le compte d'Adam n'existe pas encore.`, { stepKey: e.stepKey, barreau, geste: "SILENCE" });
    return { geste: "SILENCE", barreau, detail: "compte d'Adam absent" };
  }
  const proprietaire = await prisma.user.findUnique({ where: { id: e.ownerId }, select: { name: true } }).catch(sansBloquer("relance.relancerAttente.user", null));
  const pour = proprietaire?.name ?? "la direction";

  // ── BARREAU 3 : LA HIÉRARCHIE DANS LA BOUCLE ─────────────────────────────────────────
  if (barreau === BARREAUX_AVANT_DIRIGEANT && personne.managerUserId && personne.managerUserId !== personne.id) {
    const corps = `Bonjour — pour ${pour} : « ${e.stepTitle} » (mission « ${e.missionTitle} ») attend ${personne.name} depuis ${jours} jour(s), `
      + `après ${h.n} relance(s) restées sans réponse. Pouvez-vous voir avec ${personne.name.split(" ")[0]} ce qui bloque ? — Adam`;
    const ok = await messageSigneAdam(agentId, personne.managerUserId, corps);
    await journaliser(e.missionId, "NUDGED", `Barreau ${barreau} : la hiérarchie de ${personne.name} est prévenue${ok ? "" : " (envoi impossible)"}.`,
      { stepKey: e.stepKey, barreau, geste: "MANAGER", destinataire: personne.managerUserId });
    return { geste: "MANAGER", barreau, detail: `hiérarchie de ${personne.name} prévenue` };
  }

  // ── BARREAUX 1 ET 2 : LA RELANCE DIRECTE, SIGNÉE ADAM ─────────────────────────────────
  const corps = `Bonjour ${personne.name.split(" ")[0]} — pour ${pour} : « ${e.stepTitle} » (mission « ${e.missionTitle} ») attend votre retour depuis ${jours} jour(s)`
    + (h.n > 0 ? `, c'est ma ${h.n + 1}ᵉ relance` : "") + `. Un mot ici suffit, même pour dire « pas avant tel jour ». Merci — Adam`;
  const ok = await messageSigneAdam(agentId, personne.id, corps);
  await journaliser(e.missionId, "NUDGED", `Barreau ${barreau} : relance envoyée à ${personne.name}${ok ? "" : " (envoi impossible)"}.`,
    { stepKey: e.stepKey, barreau, geste: "RELANCE", destinataire: personne.id });
  return { geste: "RELANCE", barreau, detail: `relance ${barreau} à ${personne.name}` };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉPONSE TARDIVE — la personne répond APRÈS que l'attente s'est réglée par le temps.
 *
 * Adam a relancé Raihana lundi ; l'attente a expiré mercredi ; la mission a poursuivi (relance
 * par la hiérarchie, ou branche « sinon ») ; Raihana répond jeudi. Plus aucune étape n'attend ce
 * fait : le réveil ne le voit pas, et la réponse serait PERDUE — exactement ce que « rien perdu »
 * interdit. Ici, un fait de message ou d'e-mail dont l'auteur a été relancé par Adam pour une
 * mission encore vivante, et qu'aucune attente n'attrape, est INSCRIT au journal de la mission
 * (`LATE_REPLY`) et DIT au dirigeant en information — jamais interprété, jamais exécuté.
 *
 * Appelée par le registre d'événements, en parallèle du réveil ; ne lève jamais.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const FENETRE_REPONSE_TARDIVE_MS = 14 * 86_400_000;
const FAITS_DE_REPONSE = new Set(["MESSAGE_RECEIVED", "EMAIL_RECEIVED"]);

export async function observerReponseTardive(fait: FaitObserve & { messageId?: string | null }): Promise<number> {
  if (!FAITS_DE_REPONSE.has(fait.type) || !fait.actorId) return 0;
  try {
    const depuis = new Date(Date.now() - FENETRE_REPONSE_TARDIVE_MS);
    const relances = await prisma.missionEvent.findMany({
      where: { kind: "NUDGED", at: { gte: depuis }, detail: { path: ["destinataire"], equals: fait.actorId }, mission: { status: { notIn: ["COMPLETED", "CANCELLED"] } } },
      select: { missionId: true, detail: true, mission: { select: { ownerId: true, title: true, planVersion: true } } },
      orderBy: { at: "desc" }, take: 50,
    });
    if (relances.length === 0) return 0;
    const porte = porteAttentionPour();
    const charge = fait.payload && typeof fait.payload === "object" && !Array.isArray(fait.payload) ? (fait.payload as Record<string, unknown>) : {};
    const texte = typeof charge.text === "string" ? charge.text : typeof charge.snippet === "string" ? charge.snippet : "";
    const auteur = typeof charge.from === "string" ? charge.from : "la personne relancée";
    const idFait = typeof charge.messageId === "string" ? charge.messageId : fait.messageId ?? `${fait.type}:${Date.now()}`;
    let n = 0;
    for (const missionId of new Set(relances.map((r) => r.missionId))) {
      const r = relances.find((x) => x.missionId === missionId)!;
      // Une attente encore ouverte qui attrape ce fait : c'est le réveil qui s'en charge, pas nous.
      const attentes = await prisma.missionStep.findMany({ where: { missionId, status: "WAITING", nodeType: "WAIT_EVENT" }, select: { waitFor: true } });
      if (attentes.some((a) => { const at = lireAttente(a.waitFor); return at !== null && correspond(at, fait); })) continue;
      // Une même réponse ne se journalise qu'une fois par mission.
      const deja = await prisma.missionEvent.findFirst({ where: { missionId, kind: "LATE_REPLY", detail: { path: ["fait"], equals: idFait } }, select: { id: true } });
      if (deja) continue;
      const stepKey = typeof (r.detail as { stepKey?: unknown })?.stepKey === "string" ? (r.detail as { stepKey: string }).stepKey : null;
      await journaliser(missionId, "LATE_REPLY",
        `${auteur} a répondu après la relance${stepKey ? ` (« ${stepKey} »)` : ""} : « ${texte.slice(0, 160)}${texte.length > 160 ? "…" : ""} » — la réponse est conservée ici, rien n'est interprété.`,
        { fait: idFait, event: fait.type, from: fait.actorId, stepKey, texte: texte.slice(0, 300) });
      await porte.signaler({
        kind: "QUESTION", missionId, ownerId: r.mission.ownerId, titre: r.mission.title, stepKey: `reponse:${idFait}`, planVersion: r.mission.planVersion, niveauSuggere: "INFO",
        raison: `${auteur} a répondu après la relance : « ${texte.slice(0, 200)}${texte.length > 200 ? "…" : ""} ».`,
        decision: "dire à Adam ce qu'il doit en faire (reprendre, clore, ou ignorer)",
      }).catch(sansBloquer("relance.observerReponseTardive.signaler"));
      n += 1;
    }
    return n;
  } catch (e) {
    console.error("[relance] réponse tardive : observation impossible", e);
    return 0;
  }
}
