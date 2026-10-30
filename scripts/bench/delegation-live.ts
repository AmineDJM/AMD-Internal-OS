/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC LIVE DE LA DÉLÉGATION (J8, décision 0023) — un VRAI tour, une vraie demande, un vrai livrable.
 *
 *   npm run bench:live -- scripts/bench/delegation-live.ts      (base de banc locale `amd_bench`, migrée)
 *
 * Deux comptes neufs (supprimés à la fin) : Amina demande à son assistant « demande à Bruno le devis signé,
 * attends sa réponse, puis fais-moi une note » ; le tour (vrai modèle) doit appeler `lancer_un_travail` avec une
 * étape DEMANDE ; le plan est approuvé comme au clic ; la demande arrive chez Bruno ; Bruno répond ; le travail
 * reprend et dépose la note Word au Drive d'Amina. Borné : plafond du travail 0,40 $, un seul tour.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
process.env.ASSISTANT_IA_PRICE_IN ||= "2";
process.env.ASSISTANT_IA_PRICE_OUT ||= "12";

import fs from "node:fs";
import { prisma, estUneBaseDeBanc } from "@/lib/prisma";

const TAG = `__dlglive__${Date.now()}`;

async function main() {
  if (!estUneBaseDeBanc(process.env.DATABASE_URL ?? "")) throw new Error("Refus : base de banc locale uniquement.");
  const { proprietaire } = await import("@/platform/ia/proprietaire");
  const { jouerTour, PERSONA_ASSISTANT_IA } = await import("@/modules/assistant-ia/api");
  const svc = await import("@/lib/missions/travaux/service");
  const { balayerTravaux } = await import("@/lib/missions/travaux/balayage");
  const { repondreDemande, listerDemandesRecues } = await import("@/lib/missions/travaux/delegation");
  const debut = new Date();
  const creer = (nom: string, email: string) => prisma.user.create({ data: { name: nom, email: `${TAG}${email}`, passwordHash: "x", role: "SUPER_ADMIN" } });
  const [amina, bruno] = [await creer(`Amina ${TAG.slice(-5)}`, "amina@t.dz"), await creer(`Bruno Délégué ${TAG.slice(-5)}`, "bruno@t.dz")];
  const bilan: Record<string, unknown> = {};
  try {
    const user = await proprietaire(amina.id);
    if (!user) throw new Error("compte introuvable");
    const demande = `Demande à ${bruno.name} (${bruno.email}) le devis signé de l'agence pour le congrès d'Oran, avec une réponse sous 3 jours ; `
      + "attends sa réponse, puis fais-moi une note Word d'une demi-page qui résume ce qu'il a répondu. Fais-en un travail en arrière-plan.";
    const t0 = Date.now();
    const tour = await jouerTour(user, { texte: demande, pieces: [], historique: [], delaiMs: 180_000, maxEtapes: 8 });
    bilan.tour = { ok: tour.ok, s: Math.round((Date.now() - t0) / 1000), outils: tour.ok ? tour.outilsAppeles : [], reponse: tour.ok ? tour.content.slice(0, 400) : tour.error };
    const t = await prisma.mission.findFirst({ where: { kind: "TRAVAIL", principalId: amina.id, createdAt: { gte: debut } }, select: { id: true } });
    bilan.travailPropose = Boolean(t);
    if (!t) return;
    const vu = await svc.lireTravail(t.id, amina.id);
    bilan.plan = vu?.carnet.plan?.etapes.map((e) => `[${e.type}] ${e.titre}${e.demande ? ` → ${e.demande.aNom}` : ""}${e.format ? ` (${e.format})` : ""}`);
    const a = await svc.approuverTravail(t.id, amina.id, PERSONA_ASSISTANT_IA);
    if (!a.ok) throw new Error(a.erreur);
    await svc.reglerPlafondTravail(t.id, amina.id, 0.4);
    const pas = async () => balayerTravaux({ personas: { ASSISTANT_IA: PERSONA_ASSISTANT_IA }, seulement: [t.id] });
    await pas();
    const recues = await listerDemandesRecues(bruno.id);
    bilan.demandeRecue = recues[0] ? { de: recues[0].de, question: recues[0].question, attendues: recues[0].piecesAttendues, echeance: recues[0].echeance } : null;
    if (recues[0]) {
      const r = await repondreDemande(recues[0].id, bruno.id, { texte: "Le devis de l'agence Atlas Events est signé : 1 480 000 DZD TTC pour 12 médecins, hôtel et transferts compris." }, PERSONA_ASSISTANT_IA.pieces);
      bilan.reponse = r;
    }
    const limite = Date.now() + 5 * 60_000;
    let statut = "";
    while (Date.now() < limite) {
      await pas();
      statut = (await prisma.mission.findUnique({ where: { id: t.id }, select: { status: true } }))?.status ?? "?";
      if (["COMPLETED", "CANCELLED", "FAILED", "BLOCKED", "PARTIAL", "PAUSED"].includes(statut)) break;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    const fin = await svc.lireTravail(t.id, amina.id);
    const conso = await prisma.modelCallLog.aggregate({ where: { userId: amina.id, at: { gte: debut } }, _sum: { costUsd: true }, _count: true });
    Object.assign(bilan, {
      statut, etapes: fin?.liste.map((e) => `${e.cle}:${e.statut}`), document: fin?.carnet.livrables[0]?.document ?? null,
      livrable: fin?.carnet.livrables[0]?.contenu.slice(0, 800) ?? null, coutUsd: Number(conso._sum.costUsd ?? 0), appels: conso._count,
      dureeS: Math.round((Date.now() - debut.getTime()) / 1000),
    });
  } finally {
    console.log(JSON.stringify(bilan, null, 2));
    if (process.env.BANC_SORTIE) fs.writeFileSync(process.env.BANC_SORTIE, JSON.stringify(bilan, null, 2));
    await prisma.mission.deleteMany({ where: { ownerId: { in: [amina.id, bruno.id] } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: [amina.id, bruno.id] } } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { ownerId: amina.id, type: "FILE" } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { ownerId: amina.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
