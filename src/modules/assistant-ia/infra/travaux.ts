import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { proprietaire } from "@/platform/ia/proprietaire";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";
import { accesAssistantIa, vueDeLAssistant } from "./role-config";
import { familleOuverte, LIBELLE_FAMILLE, refusFamille, type AccesIa } from "../domaine/acces-regles";
import { ECRITURES_DU_MOTEUR, famillesDeLaLecture, famillesDuGeste, outilsV1 } from "./outils-v1";
import { executerOperationIA, OPERATIONS_IA } from "./operations/index";
import { estChargeOperationIA } from "../domaine/operations/types";
import { fermerBudget, jetonsDuJour, lireReglagesAssistantIa, ouvrirBudget, PlafondIaAtteint, sousBudget, tarifDe } from "./consommation";
import { coutEstimeUsd } from "../domaine/consommation-regles";
import { genererTexte } from "./generer";
import { censurerTexte } from "../domaine/filtre-confidentialite";
import { PLAFOND_MENSUEL_DEFAUT_USD, PLAFOND_TRAVAIL_DEFAUT_USD } from "@/lib/missions/travaux/plan";
import type { PersonaTravaux, PieceTravail, PlafondsTravail, PortPiecesTravail } from "@/lib/missions/travaux/persona";
import { proposerTravail, responsableDe } from "@/lib/missions/travaux/service";
import { recordAudit } from "@/lib/audit";
import { executerHorsRequete, journaliserGeste } from "@/platform/ia/hors-requete";
import { droitsSurDocument } from "@/platform/ia/artifact/ports";
import { CONSIGNE_TRAVAUX, demandeLongue, INDICE_DEMANDE_LONGUE, outilLancerUnTravail, type OutilTravail } from "@/platform/ia/travaux/outil";
import { deposerLivrableTravail } from "./travaux-livrables";

// J8 (décision 0023) : la porte du moteur des travaux pour le reste du module — délégation, équipe, priorité.
export {
  declinerDemande, equipeVisible, lireDemandeRecue, lireTravailEquipe, listerDemandesRecues, listerTravauxEquipe, reglerPrioriteTravail, repondreDemande,
  type DemandeRecue, type EtapeVue, type TravailDEquipe,
} from "@/lib/missions/travaux/service";
export type { DocumentLivrable } from "@/lib/missions/travaux/persona";
export type { FormatLivrable } from "@/lib/missions/travaux/plan";

/**
 * LES PIÈCES D'UNE DÉLÉGATION (J8) — sous les droits du Drive, relus à chaque appel. VOIR : `droitsSurDocument`
 * (la règle de l'écran du Drive et de l'Atelier). PARTAGER : une ligne `DriveShare` en LECTURE, jamais par-dessus
 * un droit existant (`skipDuplicates`), ni au propriétaire — et chaque partage est à l'audit.
 */
export const PIECES_TRAVAUX: PortPiecesTravail = {
  async visibles(userId, nodeIds) {
    const ids = [...new Set(nodeIds)].slice(0, 20);
    if (ids.length === 0) return [];
    const noeuds = await prisma.driveNode.findMany({ where: { id: { in: ids }, isTrashed: false }, select: { id: true, name: true } });
    const out: PieceTravail[] = [];
    for (const n of noeuds) if ((await droitsSurDocument(userId, n.id)).voir) out.push({ nodeId: n.id, nom: n.name });
    return out;
  },
  async partager(nodeIds, userId, parId) {
    const ids = [...new Set(nodeIds)];
    if (ids.length === 0) return;
    const noeuds = await prisma.driveNode.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, ownerId: true } });
    const cibles = noeuds.filter((n) => n.ownerId !== userId);
    if (cibles.length === 0) return;
    await prisma.driveShare.createMany({ data: cibles.map((n) => ({ nodeId: n.id, userId, access: "VIEW" as const })), skipDuplicates: true });
    const nom = (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? userId;
    await recordAudit({
      actorId: parId, action: "UPDATE", module: "Assistant IA — travaux", field: "Partage d'une demande",
      newValue: cibles.map((n) => n.name).join(", ").slice(0, 500),
      summary: `Pièce(s) partagée(s) en lecture avec ${nom} par une demande de travail : ${cibles.map((n) => n.name).join(", ")}`.slice(0, 500),
    });
  },
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PERSONA « ASSISTANT IA » DES TRAVAUX (J2, décision 0016) — le point d'accroche de l'Assistant IA
 * au moteur des travaux (`lib/missions/travaux/`). Le moteur ne connaît pas l'Assistant IA : il reçoit
 * cette persona, qui lui prête les MÊMES portes que la conversation, relues à chaque appel.
 *
 *   • LECTURES : les outils de lecture du tour (`outilsV1`), sous la VUE de la personne (familles de la
 *     console) — sorties censurées comme pour une routine (pas de coffret de repères hors conversation) ;
 *   • GESTES : les opérations de l'Assistant IA (`OPERATIONS_IA`) — `proposer` (contrôles de l'écran) puis
 *     `executerOperationIA` (arrêt d'urgence, droit d'écran, action métier) ; la famille est rejugée ;
 *   • MODÈLE : `genererTexte`, sous un budget ouvert au nom de la personne (journal de consommation,
 *     plafond de jetons du jour) — le coût de chaque appel revient au travail ;
 *   • PLAFONDS : la console (`AssistantIaReglage`, puis le rôle, puis la personne).
 *
 * Les routines (`programmer_routine`, `gerer_routine`) ne sont pas des gestes de travail : une routine
 * se programme dans la conversation, avec sa carte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// J8 : répondre à une demande est un geste de la personne SOLLICITÉE, dans sa conversation — jamais d'un travail.
const GESTES_EXCLUS = new Set(["programmer_routine", "gerer_routine", "preparer_reponse_demande"]);
const GESTES_TRAVAIL = OPERATIONS_IA.filter((o) => !GESTES_EXCLUS.has(o.nom));
/** Ce qui n'est pas une LECTURE parmi les outils du tour : les gestes (cartes) et la mémoire proposée. */
const PAS_UNE_LECTURE = new Set([...OPERATIONS_IA.map((o) => o.nom), ...ECRITURES_DU_MOTEUR, "proposer_memoire"]);

async function personne(principalId: string): Promise<{ user: CurrentUser; acces: AccesIa } | null> {
  const user = await proprietaire(principalId);
  if (!user || !peutUtiliserAssistantIA(user)) return null;
  return { user, acces: await accesAssistantIa(user) };
}

/** Les lectures OUVERTES à la personne : droit de l'outil ET familles de la console (une lecture fermée n'est pas offerte au plan). */
const lecturesDe = (p: { user: CurrentUser; acces: AccesIa }) =>
  outilsV1(p.user, [], undefined, undefined, null, p.acces)
    .filter((o) => !PAS_UNE_LECTURE.has(o.def.name) && o.allowed(p.user) && famillesDeLaLecture(o.def.name).every((f) => familleOuverte(p.acces, f)));

/** Une sortie d'outil qui est un REFUS (famille fermée, droit manquant) n'est pas une lecture réussie. */
function refusDeSortie(sortie: string): string | null {
  if (!sortie.trimStart().startsWith("{")) return null;
  try {
    const o = JSON.parse(sortie) as { statut?: unknown; raison?: unknown };
    return o.statut === "REFUS" ? String(o.raison ?? "lecture refusée") : null;
  } catch {
    return null;
  }
}

const refusFamilleGeste = (nom: string, acces: AccesIa): string | null => {
  const fermee = famillesDuGeste(nom).find((f) => !familleOuverte(acces, f));
  return fermee ? refusFamille(fermee) : null;
};

/** Le premier jour du mois, heure d'Alger (UTC+1, sans heure d'été). */
function debutDuMoisAlger(now: Date): Date {
  const alger = new Date(now.getTime() + 3600_000);
  return new Date(Date.UTC(alger.getUTCFullYear(), alger.getUTCMonth(), 1) - 3600_000);
}

export async function plafondsDe(principalId: string, now = new Date()): Promise<PlafondsTravail> {
  const [reglage, user] = await Promise.all([
    prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { plafondTravailUsd: true, plafondMensuelUsd: true } }),
    prisma.user.findUnique({ where: { id: principalId }, select: { role: true } }),
  ]);
  const [parRole, parPersonne] = await Promise.all([
    user ? prisma.assistantIaAcces.findUnique({ where: { role: user.role }, select: { plafondTravailUsd: true, plafondMensuelUsd: true } }) : null,
    prisma.assistantIaAcces.findUnique({ where: { userId: principalId }, select: { plafondTravailUsd: true, plafondMensuelUsd: true } }),
  ]);
  const depense = await prisma.modelCallLog.aggregate({ where: { userId: principalId, at: { gte: debutDuMoisAlger(now) } }, _sum: { costUsd: true } });
  const reglages = await lireReglagesAssistantIa();
  return {
    travailUsd: parPersonne?.plafondTravailUsd ?? parRole?.plafondTravailUsd ?? reglage?.plafondTravailUsd ?? PLAFOND_TRAVAIL_DEFAUT_USD,
    mensuelUsd: parPersonne?.plafondMensuelUsd ?? parRole?.plafondMensuelUsd ?? reglage?.plafondMensuelUsd ?? PLAFOND_MENSUEL_DEFAUT_USD,
    depenseMoisUsd: Number(depense._sum.costUsd ?? 0),
    jourAtteint: (await jetonsDuJour(principalId, now)) >= reglages.plafondJetonsJour,
  };
}

export const PERSONA_ASSISTANT_IA: PersonaTravaux = {
  persona: "ASSISTANT_IA",
  nom: "Assistant IA",

  async refusTravail(principalId) {
    const user = await proprietaire(principalId);
    if (!user) return "Le compte n'est plus actif.";
    return peutUtiliserAssistantIA(user) ? null : REFUS_ASSISTANT_IA;
  },

  async catalogue(principalId) {
    const p = await personne(principalId);
    if (!p) return { lectures: [], gestes: [] };
    const vue = vueDeLAssistant(p.user, p.acces);
    return {
      lectures: lecturesDe(p).map((o) => ({ nom: o.def.name, libelle: o.label })),
      gestes: GESTES_TRAVAIL.filter((o) => o.ouverte(vue) && !refusFamilleGeste(o.nom, p.acces)).map((o) => {
        const famille = famillesDuGeste(o.nom).find((f) => f !== "ECRITURES") ?? "ECRITURES";
        return { nom: o.nom, libelle: o.libelle, famille, libelleFamille: LIBELLE_FAMILLE[famille] };
      }),
    };
  },

  async lire(principalId, outil, entree) {
    const p = await personne(principalId);
    if (!p) return { ok: false, erreur: "La personne n'a plus accès à l'Assistant IA.", reessayable: false };
    const o = lecturesDe(p).find((x) => x.def.name === outil);
    if (!o) return { ok: false, erreur: `La lecture « ${outil} » n'est plus ouverte à cette personne.`, reessayable: false };
    try {
      const sortie = await o.run(entree ?? {}, p.user);
      const refus = refusDeSortie(sortie);
      return refus ? { ok: false, erreur: refus, reessayable: false } : { ok: true, sortie };
    } catch (e) {
      return { ok: false, erreur: e instanceof Error ? e.message : String(e), reessayable: true };
    }
  },

  async refusGeste(principalId, geste) {
    const p = await personne(principalId);
    if (!p) return "La personne n'a plus accès à l'Assistant IA.";
    const o = GESTES_TRAVAIL.find((x) => x.nom === geste);
    if (!o) return `« ${geste} » n'est pas un geste de travail.`;
    const famille = refusFamilleGeste(geste, p.acces);
    if (famille) return famille;
    return o.ouverte(vueDeLAssistant(p.user, p.acces)) ? null : `Votre rôle n'a pas le droit de « ${o.libelle.replace(/ préparée?$/, "")} » dans l'application.`;
  },

  async ecrire(principalId, geste, entree, contexte) {
    const p = await personne(principalId);
    if (!p) return { ok: false, erreur: "La personne n'a plus accès à l'Assistant IA." };
    const o = GESTES_TRAVAIL.find((x) => x.nom === geste);
    if (!o) return { ok: false, erreur: `« ${geste} » n'est pas un geste de travail.` };
    // LES CONTRÔLES DE L'ÉCRAN D'ABORD (doublons, pièces, seuils) — puis l'action métier, qui revérifie tout.
    const prop = await o.proposer(entree ?? {}, vueDeLAssistant(p.user, p.acces));
    if ("manque" in prop) return { ok: false, erreur: `Il manque : ${prop.manque.join(", ")}${prop.precision ? ` (${prop.precision})` : ""}.` };
    if ("erreur" in prop) return { ok: false, erreur: prop.erreur };
    const charge = { kind: "assistant_ia_op" as const, op: o.nom, args: prop.args };
    if (!estChargeOperationIA(charge)) return { ok: false, erreur: "Geste illisible." };
    // HORS REQUÊTE (le worker) : l'action de l'écran trouve la personne du geste et un store pour ses invalidations
    // (`contexte-geste.ts`) — sans quoi `requireUser` redirigeait et `revalidatePath` levait APRÈS l'écriture.
    // J7 : sous le JOURNAL DES EFFETS — chaque écriture du geste garde sa valeur avant (annulable, travail et étape nommés).
    const { resultat: { resultat: r } } = await journaliserGeste(p.user, {
      origine: "travail", capaciteId: `operation:${o.nom}`, libelle: prop.carte.title,
      travailId: contexte?.travailId ?? null, etape: contexte?.etape ?? null, cleIdempotence: contexte?.cle ?? null,
    }, () => executerHorsRequete(p.user, { origine: "travail", travailId: contexte?.travailId, etape: contexte?.etape, cleIdempotence: contexte?.cle }, () => executerOperationIA(p.user, charge)), { horsRequete: true });
    return r.ok ? { ok: true, resultat: { titre: prop.carte.title }, message: r.message, lien: r.link } : { ok: false, erreur: r.error ?? "Le geste n'a pas pu être exécuté." };
  },

  async raisonner(principalId, d) {
    let budget;
    try {
      budget = await ouvrirBudget({ userId: principalId, origine: "redaction", conversation: `travail:${d.travailId}` });
    } catch (e) {
      if (e instanceof PlafondIaAtteint) return { ok: false, erreur: e.message, plafond: true };
      throw e;
    }
    const debut = Date.now();
    // Ce qui part au modèle passe le filtre de confidentialité, comme une saisie (décision IA-ASSISTANT-09).
    const r = await sousBudget(budget, () => genererTexte(d.consigne, censurerTexte(d.texte).texte, 120_000));
    await fermerBudget(budget, { ok: r.ok, erreur: r.ok ? null : r.raison, ms: Date.now() - debut });
    const couts = budget.appels.map((a) => coutEstimeUsd(a.entree, a.sortie, tarifDe(a.provider), a.cache));
    const usage = {
      entree: budget.appels.reduce((s, a) => s + a.entree, 0),
      sortie: budget.appels.reduce((s, a) => s + a.sortie, 0),
      coutUsd: couts.length && couts.every((c) => c !== null) ? couts.reduce((s: number, c) => s + (c ?? 0), 0) : null,
    };
    return r.ok ? { ok: true, texte: r.texte, usage } : { ok: false, erreur: r.raison };
  },

  plafonds: (principalId) => plafondsDe(principalId),

  pieces: PIECES_TRAVAUX,
  responsable: (userId) => responsableDe(userId),
  deposerLivrable: (principalId, d) => deposerLivrableTravail(principalId, d),
};

/** L'outil « lancer_un_travail » du tour — le socle le décrit, le moteur des travaux l'exécute pour CETTE personne. */
export function outilTravailPour(user: CurrentUser): OutilTravail {
  return outilLancerUnTravail(user.id, async (plan) => {
    const r = await proposerTravail(user.id, PERSONA_ASSISTANT_IA, plan, { origine: "assistant-ia:conversation" });
    return r.ok ? { ok: true, travailId: r.travailId, etapes: r.plan.etapes.length, gestes: r.gestes.map((g) => g.libelle), plafondUsd: r.plafondUsd } : r;
  }, "LECTURE : le nom exact d'un de tes outils de lecture ; GESTE : le nom exact d'un de tes outils « preparer_… » / de relance / de rendez-vous.");
}

/** La consigne des travaux, renforcée d'un indice quand la demande a la forme d'un travail long. */
export const consigneTravaux = (texte: string): string => (demandeLongue(texte) ? `${CONSIGNE_TRAVAUX}\n${INDICE_DEMANDE_LONGUE}` : CONSIGNE_TRAVAUX);
