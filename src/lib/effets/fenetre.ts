import { Prisma } from "@prisma/client";
import { journaliser, sansBloquer } from "@/lib/journal";
import { prisma, prismaBrut } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FENÊTRE D'ANNULATION D'UN EFFET SORTANT (K10c — interface minimale, à réconcilier avec K10b).
 *
 * Un effet qui SORT de l'ERP (une diffusion de notifications poussées à toute l'entreprise…) ne part pas au clic :
 * il attend la fin de sa fenêtre (`AssistantIaReglage.fenetreAnnulationSec`, 120 s par défaut, réglée par le Super
 * Admin dans la console IA › accès). Pendant la fenêtre, l'annuler = RIEN N'EST PARTI. Après, il est parti : son
 * annulation est une COMPENSATION dite (retrait des notifications non lues, rectificatif à qui les a lues) et l'écran
 * dit ce qui ne se « dés-envoie » pas (une notification poussée affichée sur un téléphone).
 *
 * ── POURQUOI C'EST LE JOURNAL J7 QUI L'ANNULE ────────────────────────────────────────────
 *
 * `differerEffetSortant` écrit une ligne `EffetSortantDiffere` par `prisma` : sous un geste journalisé, c'est une
 * CRÉATION au journal des effets, comme n'importe quelle écriture. L'annulation du geste la retire si elle attend
 * encore (verrou, relecture : la course avec l'expédition est fermée par `FOR UPDATE` d'un côté et la réclamation
 * atomique `EN_ATTENTE → ENVOI` de l'autre) ; partie, `issueEffetDiffere` la compense. Pas de second mécanisme.
 *
 * Les expéditeurs sont DÉCLARÉS ici (import tardif), jamais enregistrés par effet de bord : le worker qui expédie
 * n'a pas chargé l'écran qui a différé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Charge = Record<string, unknown>;

export interface Expediteur {
  /** Fait partir l'effet ; rend ce qu'il a laissé (identifiants), matière de sa compensation. */
  envoyer: (charge: Charge) => Promise<Charge>;
  /**
   * Parti : la compensation, au nom de `parNom`. Rend ce qui a été fait et ce qui ne peut PAS être défait — l'écran
   * et la voix le disent tels quels. `appliquer` faux : seulement le dire (le plan).
   */
  compenser: (charge: Charge, resultat: Charge | null, ctx: { appliquer: boolean; parNom: string; libelle: string }) => Promise<{ fait: string; irreversible: string }>;
}

const EXPEDITEURS: Readonly<Record<string, () => Promise<Expediteur>>> = {
  "notification.diffusion": async () => (await import("@/lib/notifications/diffusion-differee")).expediteurDiffusion,
};

export const STATUTS_EFFET = ["EN_ATTENTE", "ENVOI", "PARTI", "ANNULE", "ECHEC", "COMPENSE"] as const;

/** La fenêtre réglée (secondes, 0 à 900) — 120 par défaut. */
export async function fenetreAnnulationSec(): Promise<number> {
  const r = await prismaBrut.assistantIaReglage.findUnique({ where: { id: "global" }, select: { fenetreAnnulationSec: true } }).catch(sansBloquer("effets.fenetre.reglage", null));
  return Math.max(0, Math.min(900, r?.fenetreAnnulationSec ?? 120));
}

export interface EffetDiffere { id: string; partA: Date; secondes: number }

/**
 * DIFFÈRE un effet sortant : il partira à la fin de la fenêtre, sauf annulation. `secondes` force la durée (tests).
 * Une fenêtre réglée à 0 le fait partir tout de suite (toujours journalisé, toujours compensable).
 */
export async function differerEffetSortant(e: { type: keyof typeof EXPEDITEURS | string; libelle: string; cible: string; principalId: string | null; charge: Charge; secondes?: number }): Promise<EffetDiffere> {
  if (!EXPEDITEURS[e.type]) throw new Error(`Effet sortant inconnu : ${e.type}`);
  const secondes = e.secondes ?? await fenetreAnnulationSec();
  const partA = new Date(Date.now() + secondes * 1000);
  const ligne = await prisma.effetSortantDiffere.create({
    data: { type: e.type, libelle: e.libelle.slice(0, 300), cible: e.cible.slice(0, 500), principalId: e.principalId, charge: e.charge as Prisma.InputJsonValue, partA },
    select: { id: true },
  });
  if (secondes === 0) await expedierUn(ligne.id);
  return { id: ligne.id, partA, secondes };
}

/** Expédie UN effet échu, s'il attend encore (réclamation atomique : jamais deux départs). */
async function expedierUn(id: string): Promise<boolean> {
  const prise = await prismaBrut.effetSortantDiffere.updateMany({ where: { id, statut: "EN_ATTENTE" }, data: { statut: "ENVOI" } });
  if (prise.count !== 1) return false;
  const e = await prismaBrut.effetSortantDiffere.findUniqueOrThrow({ where: { id } });
  try {
    const exp = await EXPEDITEURS[e.type]!();
    const resultat = await exp.envoyer(e.charge as Charge);
    await prismaBrut.effetSortantDiffere.update({ where: { id }, data: { statut: "PARTI", parti: new Date(), resultat: resultat as Prisma.InputJsonValue } });
    return true;
  } catch (err) {
    journaliser("erreur", "effets.fenetre.envoi", { id, type: e.type }, err);
    await prismaBrut.effetSortantDiffere.update({ where: { id }, data: { statut: "ECHEC", erreur: (err instanceof Error ? err.message : String(err)).slice(0, 500) } });
    return false;
  }
}

/** La tâche de fond : tout ce dont la fenêtre est close part. Rend le nombre d'effets partis. */
export async function expedierEffetsEchus(maintenant = new Date()): Promise<number> {
  const echus = await prismaBrut.effetSortantDiffere.findMany({ where: { statut: "EN_ATTENTE", partA: { lte: maintenant } }, select: { id: true }, orderBy: { partA: "asc" }, take: 100 });
  let n = 0;
  for (const e of echus) if (await expedierUn(e.id)) n++;
  return n;
}

export interface IssueDiffere { issue: "ANNULE" | "COMPENSE" | "IMPOSSIBLE" | "SANS_OBJET"; pourquoi: string; aLaPlace?: string | null }

/**
 * L'ANNULATION d'un effet différé créé par un geste (`annulation.ts` l'appelle pour chaque création au journal).
 * Ses écritures passent par `prisma` : sous le journal de l'annulation, « rétablir » les défait.
 */
export async function issueEffetDiffere(id: string, ctx: { appliquer: boolean; parNom: string; libelle: string }): Promise<IssueDiffere> {
  const e = await prismaBrut.effetSortantDiffere.findUnique({ where: { id } });
  if (!e) return { issue: "SANS_OBJET", pourquoi: "l'envoi différé n'existe plus" };
  if (e.statut === "EN_ATTENTE") {
    if (ctx.appliquer) {
      // Retiré par le client de l'annulation : la suppression est au journal, « rétablir » la remet (fenêtre neuve).
      const fait = await prisma.effetSortantDiffere.deleteMany({ where: { id, statut: "EN_ATTENTE" } });
      if (fait.count !== 1) return issueEffetDiffere(id, ctx);
    }
    return { issue: "ANNULE", pourquoi: `annulé dans la fenêtre d'annulation : rien n'est parti (${e.cible})` };
  }
  if (e.statut === "ENVOI") return { issue: "IMPOSSIBLE", pourquoi: "l'envoi part à l'instant même", aLaPlace: "réessayer l'annulation dans quelques secondes : il sera alors compensé" };
  if (e.statut === "ECHEC" || e.statut === "ANNULE") {
    if (ctx.appliquer && e.statut === "ECHEC") await prisma.effetSortantDiffere.update({ where: { id }, data: { statut: "ANNULE" } });
    return { issue: "SANS_OBJET", pourquoi: e.statut === "ECHEC" ? `il n'était jamais parti (échec d'envoi : ${e.erreur ?? "inconnu"}) — il ne sera pas retenté` : "déjà annulé" };
  }
  if (e.statut === "COMPENSE") return { issue: "SANS_OBJET", pourquoi: "déjà compensé" };
  const exp = await EXPEDITEURS[e.type]!();
  const c = await exp.compenser(e.charge as Charge, (e.resultat as Charge | null) ?? null, ctx);
  if (ctx.appliquer) await prisma.effetSortantDiffere.update({ where: { id }, data: { statut: "COMPENSE" } });
  const quand = e.parti ? ` le ${e.parti.toLocaleString("fr-FR", { timeZone: "Africa/Algiers" })}` : "";
  return { issue: "COMPENSE", pourquoi: `parti${quand}, après la fenêtre d'annulation : ${c.fait}. Ce qui ne se défait pas : ${c.irreversible}` };
}

/** RÉTABLIR un effet différé retiré dans sa fenêtre : il repart pour une fenêtre NEUVE (jamais tout de suite). */
export async function nouvelleFenetre(id: string): Promise<void> {
  const secondes = await fenetreAnnulationSec();
  await prismaBrut.effetSortantDiffere.updateMany({ where: { id, statut: "EN_ATTENTE" }, data: { partA: new Date(Date.now() + secondes * 1000) } });
}
