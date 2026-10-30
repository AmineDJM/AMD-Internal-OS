/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC LIVE DES TRAVAUX (J2, décision 0016) — un VRAI travail, du message à son livrable.
 *
 *   BENCH_SEED_ALLOW=1 npm run adam:bench:seed
 *   BENCH_SEED_ALLOW=1 npm run bench:live -- scripts/bench/seed-assistant-jarvis.ts
 *   npm run bench:live -- scripts/bench/travaux-live.ts
 *
 * Par le MÊME chemin que l'écran : l'assistante de direction (pas le Super Admin — les travaux sont
 * pour tous) écrit une demande qui dépasse un tour ; le tour de l'Assistant IA (vrai modèle) doit
 * appeler `lancer_un_travail` ; le plan est approuvé comme au clic ; le battement des travaux le
 * conduit, étape par étape, jusqu'au livrable. Si le modèle ne propose pas de travail, le banc le DIT
 * (échec du critère) puis éprouve quand même le moteur sur un plan fixe en cinq étapes.
 *
 * Borné : le travail a un plafond de 2 $ (le banc entier s'arrête avant 3 $). Base de banc locale seulement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
process.env.ASSISTANT_IA_PRICE_IN ||= "2";
process.env.ASSISTANT_IA_PRICE_OUT ||= "12";

import fs from "node:fs";
import { prisma, estUneBaseDeBanc } from "@/lib/prisma";
import { lireFixtures } from "./seed-assistant-jarvis";

const DEMANDE = "Analyse toutes les demandes Ad & Pro de l'année : repère les plus gros montants, celles qui attendent une validation depuis longtemps, et rends-moi un rapport d'une page. Fais-en un travail en arrière-plan.";

async function main() {
  if (!estUneBaseDeBanc(process.env.DATABASE_URL ?? "")) throw new Error("Refus : base de banc locale uniquement.");
  const F = lireFixtures();
  if (!F.assistante) throw new Error("Semis manquant : lancer seed-assistant-jarvis.ts d'abord.");
  const { proprietaire } = await import("@/platform/ia/proprietaire");
  const { jouerTour } = await import("@/modules/assistant-ia/api");
  const { PERSONA_ASSISTANT_IA } = await import("@/modules/assistant-ia/api");
  const svc = await import("@/lib/missions/travaux/service");
  const { balayerTravaux } = await import("@/lib/missions/travaux/balayage");
  const debut = new Date();
  const user = await proprietaire(F.assistante);
  if (!user) throw new Error("compte de l'assistante introuvable");
  console.log(`Principal : ${user.name} (${user.role})`);
  // LA CONSOLE, comme la Direction le ferait : la famille Ad & Pro ouverte à l'assistante le temps du banc (rétablie à la fin).
  const avantAcces = await prisma.assistantIaAcces.findUnique({ where: { userId: user.id } });
  await prisma.assistantIaAcces.upsert({ where: { userId: user.id }, update: { ouvertes: [...new Set([...(avantAcces?.ouvertes ?? []), "AD_PRO"])] }, create: { userId: user.id, ouvertes: ["AD_PRO"] } });
  const retablir = () => (avantAcces
    ? prisma.assistantIaAcces.update({ where: { userId: user.id }, data: { ouvertes: avantAcces.ouvertes } })
    : prisma.assistantIaAcces.deleteMany({ where: { userId: user.id } }));

  // ── 1. LE TOUR, COMME L'ÉCRAN : le modèle doit proposer un travail ──────────────────────────
  // `BANC_PLAN_FIXE=1` : pas de tour — le plan fixe en cinq étapes (minuterie comprise) éprouve le moteur seul.
  if (!process.env.BANC_PLAN_FIXE) {
    const t0 = Date.now();
    const tour = await jouerTour(user, { texte: DEMANDE, pieces: [], historique: [], delaiMs: 180_000, maxEtapes: 12 });
    console.log(`Tour : ${tour.ok ? "ok" : `échec — ${tour.error}`} en ${Math.round((Date.now() - t0) / 1000)} s · outils : ${tour.ok ? tour.outilsAppeles.join(", ") : "-"}`);
    if (tour.ok) console.log(`Réponse : ${tour.content.slice(0, 600)}`);
  }
  let travail = await prisma.mission.findFirst({ where: { kind: "TRAVAIL", principalId: user.id, createdAt: { gte: debut } }, orderBy: { createdAt: "desc" }, select: { id: true } });
  const proposeParLeModele = Boolean(travail);
  if (!travail) {
    if (!process.env.BANC_PLAN_FIXE) console.log("⚠️ Le modèle n'a pas proposé de travail : plan fixe en cinq étapes pour éprouver le moteur.");
    const cat = await PERSONA_ASSISTANT_IA.catalogue(user.id);
    const lecture = cat.lectures.find((l) => /demande|adpro|ad_pro|sponsor|validation/i.test(l.nom)) ?? cat.lectures[0];
    if (!lecture) throw new Error("aucune lecture ouverte à cette personne");
    const p = await svc.proposerTravail(user.id, PERSONA_ASSISTANT_IA, {
      titre: "Demandes Ad & Pro de l'année", objectif: DEMANDE,
      etapes: [
        { cle: "lire", titre: "Lire les demandes", type: "LECTURE", outil: lecture.nom, entree: {} },
        { cle: "montants", titre: "Repérer les gros montants", type: "ANALYSE", consigne: "Liste les demandes aux montants les plus élevés.", apres: ["lire"] },
        { cle: "retards", titre: "Repérer les attentes longues", type: "ANALYSE", consigne: "Liste les demandes qui attendent une validation depuis longtemps.", apres: ["lire"] },
        { cle: "pause", titre: "Attendre une minute", type: "ATTENTE", attente: { minutes: 1 }, apres: ["montants", "retards"] },
        { cle: "rapport", titre: "Rapport d'une page", type: "LIVRABLE", consigne: "Rédige le rapport d'une page.", apres: ["pause"] },
      ],
    });
    if (!p.ok) throw new Error(p.fautes.join(" | "));
    travail = { id: p.travailId };
  }
  const id = travail.id;
  const vu = await svc.lireTravail(id, user.id);
  console.log(`Plan (${proposeParLeModele ? "proposé par le modèle" : "fixe"}) : ${vu?.carnet.plan?.etapes.map((e) => `[${e.type}] ${e.titre}`).join(" → ")}`);
  console.log(`Gestes à autoriser : ${vu?.gestes.map((g) => g.libelle).join(", ") || "aucun"}`);

  // ── 2. L'APPROBATION, comme au clic — plafond de banc : 2 $ ──────────────────────────────────
  const a = await svc.approuverTravail(id, user.id, PERSONA_ASSISTANT_IA);
  if (!a.ok) throw new Error(a.erreur);
  await svc.reglerPlafondTravail(id, user.id, 2);

  // ── 3. LE BATTEMENT, jusqu'au livrable (10 min au plus) ──────────────────────────────────────
  const limite = Date.now() + 10 * 60_000;
  let statut = "";
  let passages = 0;
  while (Date.now() < limite) {
    await balayerTravaux({ personas: { ASSISTANT_IA: PERSONA_ASSISTANT_IA }, seulement: [id] });
    passages += 1;
    const m = await prisma.mission.findUnique({ where: { id }, select: { status: true, pausedReason: true } });
    statut = m?.status ?? "?";
    if (["COMPLETED", "CANCELLED", "FAILED", "BLOCKED", "PARTIAL"].includes(statut) || (statut === "PAUSED")) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const fin = await svc.lireTravail(id, user.id);
  const m = await prisma.mission.findUnique({ where: { id }, select: { costUsd: true, modelCalls: true, toolCalls: true } });
  const conso = await prisma.modelCallLog.aggregate({ where: { userId: user.id, at: { gte: debut } }, _sum: { costUsd: true }, _count: true });
  const bilan = {
    proposeParLeModele, statut, etat: fin?.etat, passages,
    etapes: fin?.liste.map((e) => `${e.cle}:${e.statut}`), coutTravailUsd: m?.costUsd, appelsModeleTravail: m?.modelCalls, lectures: m?.toolCalls,
    coutTotalBancUsd: Number(conso._sum.costUsd ?? 0), appelsTotal: conso._count,
    livrable: fin?.carnet.livrables[0]?.contenu.slice(0, 1500) ?? null,
    trouvailles: fin?.carnet.trouvailles.length ?? 0,
    dureeS: Math.round((Date.now() - debut.getTime()) / 1000),
  };
  console.log(JSON.stringify(bilan, null, 2));
  await retablir();
  if (process.env.BANC_SORTIE) fs.writeFileSync(process.env.BANC_SORTIE, JSON.stringify(bilan, null, 2));
  await prisma.$disconnect();
  if (statut !== "COMPLETED") process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
