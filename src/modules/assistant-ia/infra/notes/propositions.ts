import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import type { BlocNote } from "../../domaine/notes/blocs";
import {
  appliquerSurBlocs, gesteDeLigne, inverseDe, lignesAjoutees, lireGeste, type EtatProposition, type GesteNote, type PropositionNote,
} from "../../domaine/notes/gestes";

export type { PropositionNote } from "../../domaine/notes/gestes";
import { creerPage, ecrirePage, lirePage, supprimerPage } from "./pages";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MES NOTES » — LES MODIFICATIONS PROPOSÉES PAR L'IA (décision 0026, Direction : « toute modification par l'IA
 * demande la confirmation de la personne »).
 *
 *   PROPOSEE  l'outil de l'assistant l'a écrite ici — RIEN n'a touché la page ; le panneau la montre en surbrillance,
 *             la conversation en carte ;
 *   ACCEPTEE  le geste de la personne : appliquée à la page (état d'avant gardé en version), son INVERSE gardé ;
 *   REFUSEE   rien n'est écrit (et ce qui en dépendait est refusé avec elle) ;
 *   ANNULEE   acceptée puis annulée : l'inverse a été rejoué ;
 *   PERIMEE   la page a changé au point que le geste n'a plus de cible (ligne supprimée, page à la corbeille).
 *
 * Une proposition qui s'appuie sur une autre (« ajoute X dans la page que tu viens de proposer ») en DÉPEND :
 * l'accepter accepte d'abord l'autre ; refuser l'autre la refuse. Le journal d'audit garde les actions de l'IA —
 * le geste, jamais le texte des notes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Ligne = { id: string; pageId: string | null; geste: string; resume: string; etat: string; createdAt: Date; decideLe: Date | null; dependDe: string[]; args: Prisma.JsonValue };

function versVue(p: Ligne): PropositionNote | null {
  const g = lireGeste(p.args);
  if (!g) return null;
  const cible: PropositionNote["cible"] =
    g.geste === "ajouter_note" ? { id: g.bloc.id, bloc: g.bloc, apres: g.apres }
      : g.geste === "modifier_note" ? { id: g.id, texte: g.texte }
        : g.geste === "cocher_note" ? { id: g.id, fait: g.fait }
          : g.geste === "deplacer_note" ? { id: g.id, apres: g.apres }
            : g.geste === "supprimer_note" ? { id: g.id }
              : g.geste === "creer_page" || g.geste === "renommer_page" ? { id: null, titre: g.titre }
                : { id: null };
  return {
    id: p.id, pageId: p.pageId, geste: g.geste, resume: p.resume, etat: p.etat as EtatProposition,
    creeLe: p.createdAt.toISOString(), decideLe: p.decideLe?.toISOString() ?? null, dependDe: p.dependDe, cible,
  };
}

const CHAMPS = { id: true, pageId: true, geste: true, resume: true, etat: true, createdAt: true, decideLe: true, dependDe: true, args: true } as const;

/** La trace d'une action de l'IA — sans le texte des notes (elles sont privées, le journal ne l'est pas). */
async function tracer(userId: string, quoi: string, geste: string, canal = "texte"): Promise<void> {
  await recordAudit({ actorId: userId, action: "UPDATE", module: "Assistant IA", summary: `Mes notes — ${quoi} (${geste}${canal === "voix" ? ", à la voix" : ""})` });
}

/** PROPOSER — l'outil de l'assistant ne fait QUE ceci : une ligne de plus ici, rien sur la page. */
export async function proposer(
  userId: string, g: GesteNote, resume: string, o: { dependDe?: string[]; filId?: string | null; canal?: "texte" | "voix" } = {},
): Promise<PropositionNote> {
  const p = await prisma.assistantIaNoteProposition.create({
    data: {
      userId, pageId: g.pageId, geste: g.geste, args: g as unknown as Prisma.InputJsonValue, resume: resume.slice(0, 400),
      dependDe: o.dependDe ?? [], filId: o.filId ?? null, canal: o.canal ?? "texte",
    },
    select: CHAMPS,
  });
  await tracer(userId, "modification proposée par l'assistant", g.geste, o.canal);
  return versVue(p)!;
}

/**
 * L'ÉTAT « VIRTUEL » d'une page : elle, plus les propositions en attente — l'assistant peut ajouter après une ligne
 * qu'il vient de proposer. Rend aussi QUI a ajouté chaque ligne virtuelle (la dépendance).
 */
export async function pageVirtuelle(userId: string, pageId: string): Promise<{ blocs: BlocNote[]; ajouteesPar: Map<string, string> } | null> {
  const page = await lirePage(userId, pageId);
  const enAttente = await prisma.assistantIaNoteProposition.findMany({ where: { userId, pageId, etat: "PROPOSEE" }, orderBy: { createdAt: "asc" }, select: { id: true, args: true } });
  const creee = !page && enAttente.some((p) => lireGeste(p.args)?.geste === "creer_page");
  if (!page && !creee) return null;
  let blocs = page?.blocs ?? [];
  const ajouteesPar = new Map<string, string>();
  for (const p of enAttente) {
    const g = lireGeste(p.args);
    if (!g || !gesteDeLigne(g)) continue;
    const a = appliquerSurBlocs(blocs, g);
    if (!a.ok) continue;
    blocs = a.blocs;
    for (const id of lignesAjoutees(g)) ajouteesPar.set(id, p.id);
  }
  return { blocs, ajouteesPar };
}

/** Les pages telles que l'assistant les voit : les vraies, plus celles qu'il a proposé de créer (et pas encore refusées). */
export async function pagesProposees(userId: string): Promise<{ pageId: string; titre: string; propositionId: string }[]> {
  const ps = await prisma.assistantIaNoteProposition.findMany({ where: { userId, etat: "PROPOSEE", geste: "creer_page" }, orderBy: { createdAt: "asc" }, select: { id: true, args: true } });
  return ps.flatMap((p) => {
    const g = lireGeste(p.args);
    return g && g.geste === "creer_page" ? [{ pageId: g.pageId, titre: g.titre, propositionId: p.id }] : [];
  });
}

class Perimee extends Error {}

/** APPLIQUER un geste (accepté, ou l'inverse d'un geste annulé) — page et proposition dans la même transaction. */
async function appliquer(userId: string, g: GesteNote, tx: Prisma.TransactionClient, corbeille: boolean): Promise<GesteNote> {
  if (g.geste === "creer_page") {
    const r = await creerPage(userId, g.titre, g.pageId);
    if (!r.ok) throw new Perimee(r.erreur);
    return inverseDe([], g);
  }
  if (g.geste === "retirer_page") {
    if (!(await supprimerPage(userId, g.pageId))) throw new Perimee("La page n'existe plus.");
    return g;
  }
  const page = await lirePage(userId, g.pageId);
  if (!page) throw new Perimee("La page n'existe plus (supprimée ou à la corbeille).");
  if (g.geste === "renommer_page") {
    const ancien = page.titre;
    await tx.assistantIaNotePage.updateMany({ where: { id: page.id, userId }, data: { titre: g.titre } });
    return { geste: "renommer_page", pageId: g.pageId, titre: ancien, ancien: g.titre };
  }
  const a = appliquerSurBlocs(page.blocs, g);
  if (!a.ok) throw new Perimee(a.raison);
  const e = await ecrirePage(userId, page.id, page.version, a.blocs, { auteur: "IA", tx, corbeille });
  if (!e.ok) throw new Perimee(e.erreur);
  return inverseDe(page.blocs, g);
}

export type Decision = { ok: true; proposition: PropositionNote; acceptees: string[] } | { ok: false; erreur: string; perimee?: boolean };

/** ACCEPTER : ses dépendances d'abord ; puis le geste, appliqué ; son inverse gardé pour « Annuler ». */
export async function accepter(userId: string, id: string, pile: Set<string> = new Set()): Promise<Decision> {
  if (pile.has(id)) return { ok: false, erreur: "Propositions liées en boucle." };
  pile.add(id);
  const p = await prisma.assistantIaNoteProposition.findFirst({ where: { id, userId }, select: { ...CHAMPS, canal: true } });
  if (!p) return { ok: false, erreur: "Proposition introuvable." };
  if (p.etat !== "PROPOSEE") return { ok: false, erreur: p.etat === "ACCEPTEE" ? "Déjà acceptée." : "Cette proposition n'est plus en attente." };
  const acceptees: string[] = [];
  for (const d of p.dependDe) {
    const dep = await prisma.assistantIaNoteProposition.findFirst({ where: { id: d, userId }, select: { etat: true } });
    if (dep?.etat === "PROPOSEE") {
      const r = await accepter(userId, d, pile);
      if (!r.ok) return r;
      acceptees.push(...r.acceptees);
    } else if (dep && dep.etat !== "ACCEPTEE") {
      return { ok: false, erreur: "Elle s'appuie sur une proposition refusée : demandez-la de nouveau à l'assistant." };
    }
  }
  const g = lireGeste(p.args);
  if (!g) return { ok: false, erreur: "Proposition illisible." };
  try {
    await prisma.$transaction(async (tx) => {
      // LA PRISE : un double clic, deux onglets — un seul passage applique.
      const prise = await tx.assistantIaNoteProposition.updateMany({ where: { id, userId, etat: "PROPOSEE" }, data: { etat: "ACCEPTEE", decideLe: new Date() } });
      if (!prise.count) throw new Error("DEJA");
      const inverse = await appliquer(userId, g, tx, true);
      await tx.assistantIaNoteProposition.update({ where: { id }, data: { inverse: inverse as unknown as Prisma.InputJsonValue } });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "DEJA") return { ok: false, erreur: "Déjà décidée." };
    if (e instanceof Perimee) {
      await prisma.assistantIaNoteProposition.updateMany({ where: { id, userId, etat: "PROPOSEE" }, data: { etat: "PERIMEE", decideLe: new Date() } });
      return { ok: false, erreur: `Elle ne s'applique plus : ${e.message}`, perimee: true };
    }
    throw e;
  }
  await tracer(userId, "modification de l'assistant acceptée", g.geste, p.canal);
  const vue = versVue((await prisma.assistantIaNoteProposition.findFirstOrThrow({ where: { id, userId }, select: CHAMPS })))!;
  return { ok: true, proposition: vue, acceptees: [...acceptees, id] };
}

/** REFUSER : rien n'est écrit ; ce qui s'appuyait dessus est refusé aussi. */
export async function refuser(userId: string, id: string): Promise<{ ok: boolean; refusees: string[] }> {
  const refusees: string[] = [];
  const file = [id];
  while (file.length) {
    const x = file.shift()!;
    const r = await prisma.assistantIaNoteProposition.updateMany({ where: { id: x, userId, etat: "PROPOSEE" }, data: { etat: "REFUSEE", decideLe: new Date() } });
    if (!r.count) continue;
    refusees.push(x);
    const dependantes = await prisma.assistantIaNoteProposition.findMany({ where: { userId, etat: "PROPOSEE", dependDe: { has: x } }, select: { id: true } });
    file.push(...dependantes.map((d) => d.id));
  }
  if (refusees.length) await tracer(userId, `${refusees.length > 1 ? `${refusees.length} modifications` : "modification"} de l'assistant refusée${refusees.length > 1 ? "s" : ""}`, "refus");
  return { ok: refusees.length > 0, refusees };
}

/** TOUT ACCEPTER — dans l'ordre où l'assistant les a proposées ; celles qui ne s'appliquent plus sont dites. */
export async function toutAccepter(userId: string, ids?: readonly string[]): Promise<{ acceptees: string[]; echecs: { id: string; erreur: string }[] }> {
  const ps = await prisma.assistantIaNoteProposition.findMany({
    where: { userId, etat: "PROPOSEE", ...(ids?.length ? { id: { in: [...ids] } } : {}) }, orderBy: { createdAt: "asc" }, select: { id: true },
  });
  const acceptees: string[] = [];
  const echecs: { id: string; erreur: string }[] = [];
  for (const { id } of ps) {
    if (acceptees.includes(id)) continue;
    const r = await accepter(userId, id);
    if (r.ok) acceptees.push(...r.acceptees);
    else if (!acceptees.includes(id)) echecs.push({ id, erreur: r.erreur });
  }
  return { acceptees, echecs };
}

/** ANNULER une modification acceptée : son inverse est rejoué (la page a pu changer : la ligne doit encore exister). */
export async function annuler(userId: string, id: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  const p = await prisma.assistantIaNoteProposition.findFirst({ where: { id, userId }, select: { etat: true, inverse: true, geste: true, canal: true } });
  if (!p || p.etat !== "ACCEPTEE") return { ok: false, erreur: "Rien à annuler." };
  const inverse = lireGeste(p.inverse);
  if (!inverse) return { ok: false, erreur: "Cette modification ne peut pas être annulée : passez par l'historique de la page." };
  try {
    await prisma.$transaction(async (tx) => {
      const prise = await tx.assistantIaNoteProposition.updateMany({ where: { id, userId, etat: "ACCEPTEE" }, data: { etat: "ANNULEE", decideLe: new Date() } });
      if (!prise.count) throw new Perimee("Déjà annulée.");
      await appliquer(userId, inverse, tx, p.geste !== "ajouter_note");
    });
  } catch (e) {
    if (e instanceof Perimee) return { ok: false, erreur: `${e.message} Retrouvez l'état d'avant dans l'historique de la page.` };
    throw e;
  }
  await tracer(userId, "modification de l'assistant annulée", p.geste, p.canal);
  return { ok: true };
}

/** Une acceptation s'annule depuis le panneau pendant 24 heures (au-delà : l'historique de la page). */
export const ANNULABLE_PENDANT_MS = 24 * 3_600_000;

/** CE QUE LE PANNEAU MONTRE : les propositions en attente, et les acceptées qu'on peut encore annuler. */
export async function propositionsDuPanneau(userId: string): Promise<PropositionNote[]> {
  const ps = await prisma.assistantIaNoteProposition.findMany({
    where: { userId, OR: [{ etat: "PROPOSEE" }, { etat: "ACCEPTEE", decideLe: { gte: new Date(Date.now() - ANNULABLE_PENDANT_MS) } }] },
    orderBy: { createdAt: "asc" }, take: 60, select: CHAMPS,
  });
  return ps.map(versVue).filter((x): x is PropositionNote => !!x);
}

/** La carte de la conversation : les propositions d'un tour, dans leur état présent. */
export async function propositionsParIds(userId: string, ids: readonly string[]): Promise<PropositionNote[]> {
  if (!ids.length) return [];
  const ps = await prisma.assistantIaNoteProposition.findMany({ where: { userId, id: { in: [...ids] } }, orderBy: { createdAt: "asc" }, select: CHAMPS });
  return ps.map(versVue).filter((x): x is PropositionNote => !!x);
}
