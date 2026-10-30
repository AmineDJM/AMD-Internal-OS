import type { Prisma, TravailDemande } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordEvent } from "@/lib/events/ledger";
import { journaliser } from "@/lib/missions/runtime/store";
import type { DemandeCompilee } from "@/lib/missions/travaux/plan";
import type { PieceTravail, PortPiecesTravail } from "@/lib/missions/travaux/persona";
import { signalerReveil, signalerUneFois } from "@/lib/missions/travaux/signaux";
import { ecrireAuCarnet } from "@/lib/missions/travaux/carnet";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉLÉGATION (J8, décision 0023) — « DEMANDER À » : le travail de l'un dépose une demande précise chez
 * l'autre, puis reprend à la réponse.
 *
 *   1. DÉPOSER (étape WAIT_INPUT du travail) — une demande par étape (clé unique) : question, pièces
 *      attendues, échéance, et les pièces du Drive de la personne du travail qu'elle a choisi de PARTAGER
 *      (accordées en lecture). La personne sollicitée est notifiée ; la demande apparaît dans SON Assistant IA.
 *   2. RÉPONDRE (la personne sollicitée, dans son espace, sous SES droits) — un texte et des pièces de SON
 *      Drive, accordées en lecture à la personne du travail. L'étape se règle, le travail est réveillé.
 *   3. Ou DÉCLINER, avec un motif ; ou rien — relance, escalade, abandon (`jalons.ts`).
 *
 * CE QUE LA PERSONNE SOLLICITÉE VOIT : la question, les pièces attendues, les pièces partagées, qui demande
 * et pour quand. Jamais le carnet, le plan, ni le titre du travail. Pas de discussion entre agents : la
 * réponse est un geste HUMAIN, que son assistant l'aide seulement à préparer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const STATUTS_DEMANDE = ["OUVERTE", "REPONDUE", "DECLINEE", "EXPIREE", "ANNULEE"] as const;
export type StatutDemande = (typeof STATUTS_DEMANDE)[number];

/** Ce que l'étape rend une fois la demande close — les MÊMES clés qu'une attente réglée (`reponse.ts`, §118.20). */
export interface ResultatDemande {
  reveillePar: string;
  reponseDe: string | null;
  contenu: string;
  pieces: string[];
  piecesFournies: PieceTravail[];
  demandeId: string;
  statut: StatutDemande;
  fourniPar: string | null;
}

export type IssueDepot =
  | { etat: "ATTENTE"; demandeId: string }
  | { etat: "CLOSE"; resultat: ResultatDemande }
  | { etat: "IMPOSSIBLE"; erreur: string };

const lirePieces = (v: unknown): PieceTravail[] => (Array.isArray(v) ? v : [])
  .filter((p): p is PieceTravail => !!p && typeof p === "object" && typeof (p as PieceTravail).nodeId === "string")
  .map((p) => ({ nodeId: p.nodeId, nom: String(p.nom ?? "pièce") }));
const lireTextes = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const nomDe = async (id: string): Promise<string> => (await prisma.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? "un collègue";
const jour = (d: Date) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "Africa/Algiers" });
export const lienDemande = (id: string) => `/assistant?demande=${id}`;

function resultatDe(d: { id: string; statut: string; reponse: string | null; piecesFournies: unknown; reponduPar: string | null }, nom: string | null): ResultatDemande {
  const statut = d.statut as StatutDemande;
  const pieces = lirePieces(d.piecesFournies);
  return {
    reveillePar: statut === "EXPIREE" ? "TEMPS" : statut === "DECLINEE" ? "DEMANDE_DECLINEE" : "DEMANDE_REPONDUE",
    reponseDe: statut === "EXPIREE" ? null : nom,
    contenu: d.reponse ?? "",
    pieces: pieces.map((p) => p.nom),
    piecesFournies: pieces,
    demandeId: d.id,
    statut,
    fourniPar: statut === "EXPIREE" ? null : d.reponduPar,
  };
}

/**
 * DÉPOSE LA DEMANDE D'UNE ÉTAPE — idempotent : rejoué après un redémarrage, il retrouve la demande (et ne
 * renotifie pas) ; si elle a été close entre-temps (réponse arrivée pendant que le processus était mort),
 * il rend sa réponse et l'étape se termine.
 */
export async function deposerDemande(o: {
  travailId: string; stepKey: string; principalId: string; demande: DemandeCompilee; pieces: PortPiecesTravail; maintenant: Date;
}): Promise<IssueDepot> {
  const { travailId, stepKey, principalId, demande: d, pieces: drive } = o;
  const existante = await prisma.travailDemande.findUnique({ where: { missionId_stepKey: { missionId: travailId, stepKey } } });
  if (existante && existante.statut !== "OUVERTE") {
    return { etat: "CLOSE", resultat: resultatDe(existante, existante.reponduPar ? await nomDe(existante.reponduPar) : null) };
  }
  let demandeId = existante?.id ?? null;
  if (!demandeId) {
    if (d.destinataireId === principalId) return { etat: "IMPOSSIBLE", erreur: "Un travail ne se délègue pas à la personne qui le mène." };
    const dest = await prisma.user.findUnique({ where: { id: d.destinataireId }, select: { isActive: true } });
    if (!dest?.isActive) return { etat: "IMPOSSIBLE", erreur: `${d.destinataireNom} n'a plus de compte actif : la demande ne peut pas être déposée.` };
    // Seules les pièces que la personne du travail voit ENCORE se partagent (droits relus maintenant).
    const partagees = d.partager.length ? await drive.visibles(principalId, d.partager) : [];
    // Les délais comptent du DÉPÔT, posés ici en dates absolues — une fois : un dépôt rejoué ne les décale pas.
    const a = (min: number) => new Date(o.maintenant.getTime() + min * 60_000);
    await prisma.travailDemande.createMany({
      data: [{
        missionId: travailId, stepKey, demandeurId: principalId, destinataireId: d.destinataireId, question: d.question.slice(0, 4000),
        piecesAttendues: d.pieces as Prisma.InputJsonValue, piecesPartagees: partagees as unknown as Prisma.InputJsonValue,
        echeance: a(d.echeanceMin), relanceA: d.relanceMin ? a(d.relanceMin) : null, escaladeA: a(d.escaladeMin), abandonA: a(d.abandonMin),
      }],
      skipDuplicates: true,
    });
    demandeId = (await prisma.travailDemande.findUniqueOrThrow({ where: { missionId_stepKey: { missionId: travailId, stepKey } }, select: { id: true } })).id;
  }
  // LA SUITE DU DÉPÔT, rejouable : partage, notification, journal — une fois (la clé est au journal).
  const deja = await prisma.missionEvent.count({ where: { missionId: travailId, kind: "DEMANDE_DEPOSEE", detail: { path: ["demandeId"], equals: demandeId } } });
  if (!deja) {
    const ligne = await prisma.travailDemande.findUniqueOrThrow({ where: { id: demandeId } });
    const partagees = lirePieces(ligne.piecesPartagees);
    if (partagees.length) await drive.partager(partagees.map((p) => p.nodeId), ligne.destinataireId, principalId);
    const de = await nomDe(principalId);
    await signalerUneFois(travailId, ligne.destinataireId, `demande:${demandeId}:deposee`, `${de} vous demande : ${ligne.question}`.slice(0, 200),
      `Réponse attendue avant le ${jour(ligne.echeance)}${lireTextes(ligne.piecesAttendues).length ? ` — pièces : ${lireTextes(ligne.piecesAttendues).join(", ")}` : ""}. Votre Assistant IA peut vous aider à la préparer.`,
      lienDemande(demandeId));
    await journaliser(travailId, "DEMANDE_DEPOSEE", `Demande déposée chez ${d.destinataireNom} — réponse attendue avant le ${jour(ligne.echeance)}.`,
      { demandeId, stepKey, destinataireId: ligne.destinataireId, partagees: partagees.length }, principalId);
    await recordEvent({
      type: "DEMANDE_DEPOSEE", sourceDomain: "TRAVAUX", actorId: principalId, relatedRefs: [`TRAVAIL_DEMANDE:${demandeId}`, `USER:${ligne.destinataireId}`],
      payload: { demandeId, destinataireId: ligne.destinataireId, echeance: ligne.echeance.toISOString() },
    });
  }
  return { etat: "ATTENTE", demandeId };
}

/**
 * Règle l'étape qui attendait cette demande — conditionné à WAITING : deux gestes simultanés n'en règlent qu'un.
 * La réponse entre aussi au CARNET (la part de cette étape) : les étapes suivantes la relisent, même celles qui ne
 * dépendent pas directement de la demande.
 */
async function reglerEtape(d: { missionId: string; stepKey: string }, resultat: ResultatDemande, maintenant: Date): Promise<void> {
  const qui = resultat.reponseDe ?? "la personne sollicitée";
  const note = resultat.statut === "EXPIREE" ? `Demande « ${d.stepKey} » : sans réponse à l'échéance — le travail continue sans elle.`
    : resultat.statut === "DECLINEE" ? `Demande « ${d.stepKey} » déclinée par ${qui} : ${resultat.contenu}`
      : `Réponse de ${qui} (demande « ${d.stepKey} ») : ${resultat.contenu}${resultat.pieces.length ? ` — pièces : ${resultat.pieces.join(", ")}` : ""}`;
  await ecrireAuCarnet(d.missionId, d.stepKey, { trouvailles: [note] }, maintenant);
  await prisma.missionStep.updateMany({
    where: { missionId: d.missionId, key: d.stepKey, status: "WAITING", nodeType: "WAIT_INPUT" },
    data: { status: "DONE", completedAt: maintenant, result: resultat as unknown as Prisma.InputJsonValue },
  });
  await signalerReveil([d.missionId], maintenant);
}

export type ResultatGesteDemande = { ok: true; message: string } | { ok: false; erreur: string };

/** La demande, si elle est À CETTE personne et ouverte. */
async function demandeOuverte(demandeId: string, destinataireId: string): Promise<{ erreur: string } | { d: TravailDemande }> {
  const d = await prisma.travailDemande.findFirst({ where: { id: demandeId, destinataireId } });
  if (!d) return { erreur: "Demande introuvable — ou elle ne vous est pas adressée." };
  if (d.statut !== "OUVERTE") return { erreur: `Cette demande n'attend plus de réponse (${LIBELLE_STATUT[d.statut as StatutDemande] ?? d.statut}).` };
  return { d };
}

/**
 * RÉPONDRE — le geste de la personne sollicitée, sous SES droits : chaque pièce jointe doit être une pièce de
 * son Drive qu'elle voit ; elle est accordée en LECTURE à la personne du travail. Le travail reprend.
 */
export async function repondreDemande(
  demandeId: string, destinataireId: string, r: { texte: string; pieces?: readonly string[] }, drive: PortPiecesTravail, maintenant = new Date(),
): Promise<ResultatGesteDemande> {
  const o = await demandeOuverte(demandeId, destinataireId);
  if ("erreur" in o) return { ok: false, erreur: o.erreur };
  const texte = (r.texte ?? "").trim().slice(0, 8000);
  const demandees = [...new Set(r.pieces ?? [])].slice(0, 10);
  if (!texte && demandees.length === 0) return { ok: false, erreur: "La réponse est vide : écrivez-la, ou joignez les pièces demandées." };
  const pieces = demandees.length ? await drive.visibles(destinataireId, demandees) : [];
  if (pieces.length !== demandees.length) return { ok: false, erreur: "Une pièce jointe n'existe pas, ou vous n'y avez pas accès dans le Drive." };
  const pris = await prisma.travailDemande.updateMany({
    where: { id: demandeId, statut: "OUVERTE" },
    data: { statut: "REPONDUE", reponse: texte, piecesFournies: pieces as unknown as Prisma.InputJsonValue, reponduLe: maintenant, reponduPar: destinataireId },
  });
  if (pris.count !== 1) return { ok: false, erreur: "Cette demande vient d'être close." };
  if (pieces.length) await drive.partager(pieces.map((p) => p.nodeId), o.d.demandeurId, destinataireId);
  const nom = await nomDe(destinataireId);
  await reglerEtape(o.d, resultatDe({ ...o.d, statut: "REPONDUE", reponse: texte, piecesFournies: pieces, reponduPar: destinataireId }, nom), maintenant);
  await journaliser(o.d.missionId, "DEMANDE_REPONDUE", `${nom} a répondu${pieces.length ? ` (${pieces.length} pièce${pieces.length > 1 ? "s" : ""})` : ""} : le travail reprend.`,
    { demandeId, stepKey: o.d.stepKey, pieces: pieces.length }, destinataireId);
  await signalerUneFois(o.d.missionId, o.d.demandeurId, `demande:${demandeId}:repondue`, `${nom} a répondu à votre demande`, texte.slice(0, 240) || `${pieces.length} pièce(s) jointe(s).`);
  await recordEvent({
    type: "DEMANDE_REPONDUE", sourceDomain: "TRAVAUX", actorId: destinataireId, relatedRefs: [`TRAVAIL_DEMANDE:${demandeId}`, `USER:${o.d.demandeurId}`],
    payload: { demandeId, statut: "REPONDUE", pieces: pieces.length },
  });
  return { ok: true, message: `Réponse envoyée à ${await nomDe(o.d.demandeurId)}${pieces.length ? `, avec ${pieces.length} pièce${pieces.length > 1 ? "s" : ""} partagée${pieces.length > 1 ? "s" : ""} en lecture` : ""}.` };
}

/** DÉCLINER — avec un motif, que la personne du travail lira ; le travail reprend sans la réponse. */
export async function declinerDemande(demandeId: string, destinataireId: string, motif: string, maintenant = new Date()): Promise<ResultatGesteDemande> {
  const o = await demandeOuverte(demandeId, destinataireId);
  if ("erreur" in o) return { ok: false, erreur: o.erreur };
  const raison = motif.trim().slice(0, 2000);
  if (!raison) return { ok: false, erreur: "Dites en une phrase pourquoi vous ne pouvez pas répondre." };
  const pris = await prisma.travailDemande.updateMany({
    where: { id: demandeId, statut: "OUVERTE" },
    data: { statut: "DECLINEE", reponse: raison, reponduLe: maintenant, reponduPar: destinataireId },
  });
  if (pris.count !== 1) return { ok: false, erreur: "Cette demande vient d'être close." };
  const nom = await nomDe(destinataireId);
  await reglerEtape(o.d, resultatDe({ ...o.d, statut: "DECLINEE", reponse: raison, piecesFournies: [], reponduPar: destinataireId }, nom), maintenant);
  await journaliser(o.d.missionId, "DEMANDE_DECLINEE", `${nom} a décliné la demande : ${raison}`, { demandeId, stepKey: o.d.stepKey }, destinataireId);
  await signalerUneFois(o.d.missionId, o.d.demandeurId, `demande:${demandeId}:declinee`, `${nom} a décliné votre demande`, raison);
  return { ok: true, message: "La demande est déclinée ; votre motif est transmis." };
}

/** CLÔT PAR LE TEMPS (abandon) — l'étape se règle en TIMEOUT : le plan peut prévoir une suite (`si: TIMEOUT`). */
export async function expirerDemande(demandeId: string, maintenant = new Date()): Promise<boolean> {
  const d = await prisma.travailDemande.findUnique({ where: { id: demandeId } });
  if (!d) return false;
  const pris = await prisma.travailDemande.updateMany({ where: { id: demandeId, statut: "OUVERTE" }, data: { statut: "EXPIREE" } });
  if (pris.count !== 1) return false;
  await reglerEtape(d, resultatDe({ ...d, statut: "EXPIREE" }, null), maintenant);
  await journaliser(d.missionId, "DEMANDE_EXPIREE", `Sans réponse de ${await nomDe(d.destinataireId)} : la demande est abandonnée, le travail continue sans elle.`, { demandeId, stepKey: d.stepKey });
  await signalerUneFois(d.missionId, d.demandeurId, `demande:${demandeId}:expiree`, "Demande restée sans réponse", `${await nomDe(d.destinataireId)} n'a pas répondu : le travail continue sans sa réponse.`);
  return true;
}

/** Le travail s'arrête : ses demandes ouvertes n'ont plus d'objet — la personne sollicitée le sait. */
export async function annulerDemandesDuTravail(travailId: string): Promise<number> {
  const ouvertes = await prisma.travailDemande.findMany({ where: { missionId: travailId, statut: "OUVERTE" }, select: { id: true, destinataireId: true, demandeurId: true } });
  let n = 0;
  for (const d of ouvertes) {
    const pris = await prisma.travailDemande.updateMany({ where: { id: d.id, statut: "OUVERTE" }, data: { statut: "ANNULEE" } });
    if (!pris.count) continue;
    n += 1;
    await signalerUneFois(travailId, d.destinataireId, `demande:${d.id}:annulee`, "Demande retirée", `${await nomDe(d.demandeurId)} n'a plus besoin de votre réponse.`, lienDemande(d.id));
  }
  return n;
}

// ─────────────────────────────── Ce que chacun voit ───────────────────────────────

export const LIBELLE_STATUT: Record<StatutDemande, string> = {
  OUVERTE: "en attente de réponse", REPONDUE: "répondue", DECLINEE: "déclinée", EXPIREE: "expirée", ANNULEE: "retirée",
};

/** La demande VUE PAR LA PERSONNE SOLLICITÉE — la question et les pièces partagées, rien du travail. */
export interface DemandeRecue {
  id: string;
  de: string;
  question: string;
  piecesAttendues: string[];
  piecesPartagees: PieceTravail[];
  echeance: string;
  enRetard: boolean;
  statut: StatutDemande;
  creeLe: string;
  reponse: string | null;
  piecesFournies: PieceTravail[];
}

const VUE_RECUE = {
  id: true, demandeurId: true, question: true, piecesAttendues: true, piecesPartagees: true, echeance: true, statut: true,
  createdAt: true, reponse: true, piecesFournies: true,
} satisfies Prisma.TravailDemandeSelect;

async function versRecues(lignes: Prisma.TravailDemandeGetPayload<{ select: typeof VUE_RECUE }>[], maintenant: Date): Promise<DemandeRecue[]> {
  const noms = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(lignes.map((l) => l.demandeurId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return lignes.map((l) => ({
    id: l.id, de: noms.get(l.demandeurId) ?? "un collègue", question: l.question,
    piecesAttendues: lireTextes(l.piecesAttendues), piecesPartagees: lirePieces(l.piecesPartagees),
    echeance: l.echeance.toISOString(), enRetard: l.statut === "OUVERTE" && l.echeance < maintenant,
    statut: l.statut as StatutDemande, creeLe: l.createdAt.toISOString(), reponse: l.reponse, piecesFournies: lirePieces(l.piecesFournies),
  }));
}

/** LES DEMANDES REÇUES — les ouvertes d'abord (échéance la plus proche), puis les dernières closes. */
export async function listerDemandesRecues(destinataireId: string, maintenant = new Date()): Promise<DemandeRecue[]> {
  const [ouvertes, closes] = await Promise.all([
    prisma.travailDemande.findMany({ where: { destinataireId, statut: "OUVERTE" }, select: VUE_RECUE, orderBy: { echeance: "asc" }, take: 50 }),
    prisma.travailDemande.findMany({ where: { destinataireId, statut: { not: "OUVERTE" } }, select: VUE_RECUE, orderBy: { updatedAt: "desc" }, take: 10 }),
  ]);
  return versRecues([...ouvertes, ...closes], maintenant);
}

export async function lireDemandeRecue(demandeId: string, destinataireId: string, maintenant = new Date()): Promise<DemandeRecue | null> {
  const l = await prisma.travailDemande.findFirst({ where: { id: demandeId, destinataireId }, select: VUE_RECUE });
  return l ? (await versRecues([l], maintenant))[0]! : null;
}

/** Les demandes d'UN travail, vues par la personne du travail (panneau « Travaux ») : à qui, quoi, où on en est. */
export interface DemandeEnvoyee { id: string; etape: string; a: string; question: string; statut: StatutDemande; echeance: string; relances: number; escalade: boolean; reponse: string | null; piecesFournies: PieceTravail[] }

export async function demandesDuTravail(travailId: string): Promise<DemandeEnvoyee[]> {
  const lignes = await prisma.travailDemande.findMany({ where: { missionId: travailId }, orderBy: { createdAt: "asc" } });
  const noms = new Map((await prisma.user.findMany({ where: { id: { in: lignes.map((l) => l.destinataireId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return lignes.map((l) => ({
    id: l.id, etape: l.stepKey, a: noms.get(l.destinataireId) ?? "?", question: l.question, statut: l.statut as StatutDemande,
    echeance: l.echeance.toISOString(), relances: l.relances, escalade: l.escaladeLe !== null, reponse: l.reponse, piecesFournies: lirePieces(l.piecesFournies),
  }));
}
