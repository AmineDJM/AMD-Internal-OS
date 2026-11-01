/**
 * LOT M1 — LA MÉMOIRE EN JETONS, MESURÉE au vrai modèle (décisions de la Direction, 01/11/2026).
 *
 *   DATABASE_URL=…/amd_bench OPENAI_API_KEY=sk-banc NODE_OPTIONS="--require ./scripts/proxy-dispatcher.cjs" \
 *     npx tsx scripts/bench/m1-jetons.ts
 *
 * Une mémoire réaliste et REDONDANTE (≈ 150 faits, comme après des semaines de conversations) pour le compte de banc :
 * jetons stockés, jetons injectés par tour (trois questions), puis la consolidation au modèle rapide — et les mêmes
 * mesures après. Coût lu dans le journal K8. Sortie : `docs/assistant/preuves/m1/jetons.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { consoliderMemoire, jetonsDeLaMemoire, jetonsMemoire, rappelDuTour } from "@/modules/assistant-ia/api";

const EMAIL = process.env.M1_EMAIL ?? "yacine.benali@adventum-bench.dz";
const QUESTIONS = ["Tu te souviens de mon voyage ?", "Que sais-tu de ma famille ?", "Prépare-moi la réunion de dimanche."];

const FAITS: [string, string][] = [
  ["FAMILLE", "Fille : Lina."], ["FAMILLE", "Lina a 9 ans."], ["FAMILLE", "Lina est en CM1 à l'école Les Oliviers d'Alger."],
  ["FAMILLE", "Fils : Adam."], ["FAMILLE", "Adam commence l'université à Constantine en septembre 2027."], ["FAMILLE", "Adam veut étudier la pharmacie."],
  ["FAMILLE", "Épouse : Sarah, médecin."], ["FAMILLE", "Sarah travaille au CHU Mustapha."], ["FAMILLE", "Mère : Fatiha, vit à Oran."],
  ["VOYAGES", "Part à Lyon le 12 novembre 2026 avec sa fille Lina."], ["VOYAGES", "Le voyage à Lyon dure cinq jours."], ["VOYAGES", "Hôtel réservé à Lyon près de la gare Part-Dieu."],
  ["VOYAGES", "A visité Istanbul en août 2025."], ["VOYAGES", "Aime voyager en Turquie l'été."], ["VOYAGES", "Prévoit un séjour à Tlemcen au printemps 2027."],
  ["GOUTS_LOISIRS", "Adore le café noir le matin."], ["GOUTS_LOISIRS", "Boit son café sans sucre."], ["GOUTS_LOISIRS", "Joue au tennis le samedi matin."],
  ["GOUTS_LOISIRS", "Joue au tennis au club d'Hydra."], ["GOUTS_LOISIRS", "Lit des biographies."], ["GOUTS_LOISIRS", "Supporte le MC Alger."],
  ["SANTE_DECLAREE", "Allergique à la pénicilline."], ["SANTE_DECLAREE", "Ne mange pas de fruits de mer."],
  ["ETUDES_PARCOURS", "A fait ses études à l'École nationale polytechnique d'Alger."], ["ETUDES_PARCOURS", "Diplômé de Polytechnique en 2004."], ["ETUDES_PARCOURS", "MBA à HEC Alger en 2012."],
  ["ETUDES_PARCOURS", "A travaillé chez Saidal de 2005 à 2014."], ["ETUDES_PARCOURS", "Directeur général d'Adventum Pharma depuis 2019."],
  ["USER_PREFERENCE", "Préfère des réponses courtes."], ["USER_PREFERENCE", "Veut les montants en DZD."], ["USER_PREFERENCE", "Préfère le tutoiement."], ["USER_PREFERENCE", "Veut les chiffres avec leur source."],
  ["CONTRAINTES", "Réunion de direction chaque dimanche à 9 h."], ["CONTRAINTES", "Ne pas planifier de rendez-vous avant 10 h le dimanche."], ["CONTRAINTES", "Indisponible le jeudi après-midi."],
  ["PERSONNES_CITEES", "Karim : directeur financier."], ["PERSONNES_CITEES", "Travaille avec Karim sur le dossier export vers la Tunisie."], ["PERSONNES_CITEES", "Amel : responsable des affaires réglementaires."],
  ["PROJETS", "Projet d'export vers la Tunisie en 2027."], ["PROJETS", "Veut lancer Cardiofix en janvier 2027."], ["PROJETS", "Souhaite ouvrir un bureau à Oran."],
];

async function mesure(userId: string) {
  const stockes = await jetonsDeLaMemoire(userId);
  const injectes: Record<string, number> = {};
  for (const q of QUESTIONS) injectes[q] = jetonsMemoire((await rappelDuTour(userId, q)).section ?? "");
  const actifs = await prisma.assistantMemoryItem.count({ where: { userId, active: true } });
  return { actifs, stockes, injectes };
}

async function main() {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL }, select: { id: true } });
  await prisma.assistantMemoryItem.deleteMany({ where: { userId: u.id } });
  await prisma.assistantIaPreference.deleteMany({ where: { userId: u.id } });
  // Des semaines de conversations : les faits reviennent sous plusieurs formes (3 passages, reformulés).
  const variantes = (t: string, i: number) => (i === 0 ? t : i === 1 ? `Il a été dit que : ${t.charAt(0).toLowerCase()}${t.slice(1)}` : `Rappel — ${t}`);
  for (let i = 0; i < 3; i++) {
    for (const [type, content] of FAITS) await prisma.assistantMemoryItem.create({ data: { userId: u.id, type, content: variantes(content, i), origine: "auto" } });
  }
  const debut = new Date();
  const avant = await mesure(u.id);
  const bilan = await consoliderMemoire(u.id, { force: true });
  const apres = await mesure(u.id);
  const appels = await prisma.modelCallLog.findMany({ where: { userId: u.id, at: { gte: debut }, role: "memoire" }, select: { model: true, inputTokens: true, outputTokens: true, costUsd: true, ms: true } });
  const sortie = { le: new Date().toISOString(), avant, apres, bilan: { ...bilan, refuses: bilan.refuses.slice(0, 10) }, consolidation: appels.map((a) => ({ ...a, costUsd: Number(a.costUsd ?? 0) })) };
  const f = path.join(process.cwd(), "docs", "assistant", "preuves", "m1", "jetons.json");
  fs.writeFileSync(f, JSON.stringify(sortie, null, 2));
  console.log(JSON.stringify(sortie, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
