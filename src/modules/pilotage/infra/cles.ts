import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { ficheFinale, planRepointage, type PlanRepointage } from "../domaine/repointage";
import { cleDeCible, jourAlger, type LigneSignal } from "../domaine/signaux";
import { ecrireSignaux } from "./ecriture";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CLÉS ORPHELINES (lot 2 du recensement) — le graphe d'influence (L4) et les études de marché (L10).
 *
 *   • `repointerInfluence` — appelé par la FUSION de deux fiches médecin : les liens d'influence de la fiche absorbée passent
 *     à la fiche gardée (plan pur `planRepointage`). Le geste de fusion retire doublons et boucles (`effacer`) — il est
 *     réversible d'un coup par le journal des effets ; le contrôle, lui, ne retire rien.
 *   • `controlerCles` — l'existant : les liens restés sur une fiche absorbée AVANT ce lot (la fusion ne les repointait pas)
 *     sont repointés (`corriger`) ou seulement comptés ; ce qui ne peut pas être repointé sans effacer (doublon, boucle)
 *     est SIGNALÉ, jamais effacé ; les lignes d'études de marché sans produit reçoivent le leur quand la molécule le
 *     désigne CERTAINEMENT. Le bilan est écrit en signaux datés (source « controle_cles »).
 *
 * Le score d'influence (`InfluenceScore`) n'est qu'un cache, recalculé chaque jour (`terrain.influence`) depuis les liens :
 * repointer les liens suffit, la fiche gardée retrouve son score au prochain passage.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface BilanRepointage { deplaces: number; doublons: number; decisionsReprises: number; boucles: number; retires: number }

async function lirePlan(absorbeId: string, gardeId: string) {
  const liens = await prisma.praticienRelation.findMany({
    where: { OR: [{ fromDoctorId: { in: [absorbeId, gardeId] } }, { toDoctorId: { in: [absorbeId, gardeId] } }] },
    select: { id: true, fromDoctorId: true, toDoctorId: true, type: true, statut: true, decideParId: true, decideLe: true },
  });
  return { liens, plan: planRepointage(liens, absorbeId, gardeId) };
}

/** Repointe les liens d'influence de `absorbeId` vers `gardeId`. */
export async function repointerInfluence(absorbeId: string, gardeId: string, opts: { effacer: boolean }): Promise<BilanRepointage & { plan: PlanRepointage }> {
  const { liens, plan } = await lirePlan(absorbeId, gardeId);
  const parId = new Map(liens.map((l) => [l.id, l]));
  let decisionsReprises = 0; let retires = 0;
  for (const d of plan.deplacer) {
    await prisma.praticienRelation.update({ where: { id: d.id }, data: { fromDoctorId: d.fromDoctorId, toDoctorId: d.toDoctorId } });
  }
  for (const d of plan.doublons) {
    const absorbe = parId.get(d.retirerId)!;
    if (d.reprendreDecision) {
      // LA DÉCISION HUMAINE SURVIT À LA FUSION : confirmé ou rejeté sur la fiche absorbée, le lien gardé l'est aussi.
      await prisma.praticienRelation.update({ where: { id: d.garderId }, data: { statut: absorbe.statut, decideParId: absorbe.decideParId, decideLe: absorbe.decideLe } });
      decisionsReprises += 1;
    }
    if (opts.effacer) { await prisma.praticienRelation.delete({ where: { id: d.retirerId } }); retires += 1; }
  }
  if (opts.effacer && plan.boucles.length) retires += (await prisma.praticienRelation.deleteMany({ where: { id: { in: plan.boucles } } })).count;
  return { plan, deplaces: plan.deplacer.length, doublons: plan.doublons.length, decisionsReprises, boucles: plan.boucles.length, retires };
}

export interface BilanControle {
  jour: string;
  fusionsLues: number;
  liensSurFicheAbsorbee: number;
  liensRepointes: number;
  doublonsSignales: number;
  bouclesSignalees: number;
  liensSurFicheArchivee: number;
  liensSansFiche: number;
  etudesRattachees: number;
  etudesExaminees: number;
}

const ECHANTILLON = 50;

/**
 * LE CONTRÔLE DES CLÉS. `corriger` : repointer les liens restés sur une fiche absorbée, rattacher les études de marché
 * à leur produit certain (`resoudreProduit` injecté : la résolution vit dans `lib/products`). Sans `corriger`, rien
 * n'est modifié : le contrôle compte et signale. Dans les deux cas, RIEN n'est effacé.
 */
export async function controlerCles(opts: {
  corriger: boolean;
  maintenant?: Date;
  resoudreProduit?: (mention: string) => Promise<string | null>;
}): Promise<BilanControle> {
  const jour = jourAlger(opts.maintenant ?? new Date());
  // 1. Les fusions décidées, et la fiche qui reste au bout de chaque chaîne.
  const fusions = await prisma.decisionFusionMedecin.findMany({ where: { decision: "FUSIONNEE", gardeId: { not: null } }, select: { medecinAId: true, medecinBId: true, gardeId: true } });
  const gardeDe = new Map<string, string>();
  for (const f of fusions) {
    const absorbe = f.medecinAId === f.gardeId ? f.medecinBId : f.medecinAId;
    gardeDe.set(absorbe, f.gardeId!);
  }
  // Une fusion ANNULÉE (journal des effets) rend la fiche à la vie : seule une fiche absorbée ENCORE archivée se repointe.
  const archivees = new Set((await prisma.medicalDoctor.findMany({ where: { id: { in: [...gardeDe.keys()] }, archivedAt: { not: null } }, select: { id: true } })).map((d) => d.id));
  let liensSurFicheAbsorbee = 0; let liensRepointes = 0; let doublons = 0; let boucles = 0;
  const echantillon: { absorbe: string; garde: string; liens: string[] }[] = [];
  for (const absorbe of archivees) {
    const garde = ficheFinale(absorbe, gardeDe);
    if (!garde) continue;
    const touches = await prisma.praticienRelation.count({ where: { OR: [{ fromDoctorId: absorbe }, { toDoctorId: absorbe }] } });
    if (touches === 0) continue;
    liensSurFicheAbsorbee += touches;
    // Sans `corriger`, le plan se LIT seulement : il dit ce que la correction ferait.
    const { plan } = opts.corriger ? await repointerInfluence(absorbe, garde, { effacer: false }) : await lirePlan(absorbe, garde);
    if (opts.corriger) liensRepointes += plan.deplacer.length;
    doublons += plan.doublons.length; boucles += plan.boucles.length;
    if (echantillon.length < ECHANTILLON) echantillon.push({ absorbe, garde, liens: [...plan.doublons.map((d) => d.retirerId), ...plan.boucles] });
  }
  // 2. Les liens qui touchent une fiche archivée sans fusion (une fiche « supprimée » de l'annuaire) — comptés, pas touchés.
  const [surArchivee, sansFiche] = await Promise.all([
    prisma.praticienRelation.count({ where: { OR: [{ medecinDe: { archivedAt: { not: null } } }, { medecinVers: { archivedAt: { not: null } } }], NOT: { OR: [{ fromDoctorId: { in: [...archivees] } }, { toDoctorId: { in: [...archivees] } }] } } }),
    // La base porte la clé étrangère : zéro attendu. Compté quand même — une base où la contrainte manquerait se verrait ici.
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM "PraticienRelation" r WHERE NOT EXISTS (SELECT 1 FROM "MedicalDoctor" d WHERE d.id = r."fromDoctorId") OR NOT EXISTS (SELECT 1 FROM "MedicalDoctor" d WHERE d.id = r."toDoctorId")`,
  ]);
  // 3. L10 — les études de marché sans produit.
  let etudesRattachees = 0; let etudesExaminees = 0;
  if (opts.corriger && opts.resoudreProduit) {
    const lignes = await prisma.marketResearchRow.findMany({ where: { productId: null }, select: { id: true, product: true }, take: 2000 });
    etudesExaminees = lignes.length;
    for (const l of lignes) {
      const productId = await opts.resoudreProduit(l.product).catch(sansBloquer("pilotage.controlerCles.resoudreProduit", null));
      if (!productId) continue;
      etudesRattachees += (await prisma.marketResearchRow.updateMany({ where: { id: l.id, productId: null }, data: { productId } })).count;
    }
  }

  const bilan: BilanControle = {
    jour, fusionsLues: fusions.length, liensSurFicheAbsorbee, liensRepointes, doublonsSignales: doublons, bouclesSignalees: boucles,
    liensSurFicheArchivee: surArchivee, liensSansFiche: Number(sansFiche[0]?.n ?? 0), etudesRattachees, etudesExaminees,
  };
  const signal = (nature: string, valeur: number, charge: Record<string, unknown> = {}): LigneSignal =>
    ({ jour, source: "controle_cles", nature, cle: cleDeCible("groupe"), producteur: "regle", valeur, unite: "lignes", charge });
  await ecrireSignaux([
    signal("influence_sur_fiche_absorbee", liensSurFicheAbsorbee - (opts.corriger ? liensRepointes : 0), { avantCorrection: liensSurFicheAbsorbee, repointes: liensRepointes, echantillon }),
    signal("influence_doublon_apres_fusion", doublons),
    signal("influence_boucle_apres_fusion", boucles),
    signal("influence_sur_fiche_archivee", surArchivee),
    signal("influence_sans_fiche", bilan.liensSansFiche),
    ...(opts.corriger && opts.resoudreProduit ? [signal("etude_marche_rattachee", etudesRattachees, { examinees: etudesExaminees })] : []),
  ]);
  return bilan;
}
