/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BANC LIVE DE L'ATELIER (J3, décision 0017) — le VRAI modèle de l'Assistant IA (`gpt-6.1-terra`), la base de banc.
 *
 *   1. un PowerPoint semé, joint au message : « remplace le titre et ajoute une diapositive de synthèse » ;
 *   2. un contrat Word semé (titre en style Heading1, tableau de rémunération), joint : « mets la période d'essai
 *      à 6 mois » — puis on ENREGISTRE (nouvelle version) et on vérifie que styles et tableau sont conservés.
 *
 * Le modèle doit choisir LUI-MÊME `ouvrir_dans_l_atelier` puis `modifier_document` (et non `preparer_document`).
 * Lancement : `OPENAI_API_KEY=sk-mandataire npm run bench:live -- scripts/bench/atelier-live.ts` (≤ 3 $).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
process.env.ASSISTANT_IA_PRICE_IN ||= "2";
process.env.ASSISTANT_IA_PRICE_OUT ||= "12";

import fs from "node:fs";
import { prisma, estUneBaseDeBanc } from "@/lib/prisma";

const TAG = `__banc_atelier__${Date.now()}`;

async function main() {
  if (!estUneBaseDeBanc(process.env.DATABASE_URL ?? "")) throw new Error("Refus : base de banc locale uniquement.");
  const { getAccess } = await import("@/lib/rbac");
  const { putBlob, getBlob } = await import("@/lib/drive-storage");
  const { docxDeParagraphes, pptxDiapos } = await import("@/lib/artifact/adapters/fixtures");
  const { adaptateurPour } = await import("@/lib/artifact/adapters/registry");
  const { jouerTour } = await import("@/modules/assistant-ia/api");
  const { enregistrerAtelier, vueAtelier } = await import("@/platform/ia/artifact/atelier/service");
  const debut = new Date();

  const u = await prisma.user.create({ data: { name: `${TAG} Amel`, email: `${TAG}@banc.dz`, passwordHash: "x", role: "DIRECTION" } });
  const access = await getAccess(u.id, u.role);
  const user = { id: u.id, name: "Amel Banc", email: u.email, role: u.role, secondaryRole: null, access, mustChangePassword: false };
  await prisma.assistantIaAcces.create({ data: { userId: u.id, ouvertes: ["DRIVE", "ECRITURES"] } });

  const deposer = async (nom: string, octets: Buffer, mime: string) => {
    const b = await putBlob(octets);
    return (await prisma.driveNode.create({ data: { name: nom, type: "FILE", ownerId: u.id, createdById: u.id, mimeType: mime, size: b.size, versions: { create: { blobId: b.blobId, version: 1, size: b.size, mimeType: mime, createdById: u.id } } } })).id;
  };
  // Un vrai deck : la synthèse doit pouvoir se tirer de son contenu (le modèle n'invente pas — mesuré : sur un deck
  // générique, il demande les points clés au lieu de les inventer, ce qui est le bon comportement).
  const { default: Pptx } = await import("pptxgenjs");
  const deck = new Pptx();
  const diapo = (titre: string, puces: string[]) => {
    const s = deck.addSlide();
    s.addText(titre, { x: 0.6, y: 0.4, w: 8.8, h: 1, fontSize: 30, bold: true, color: "0B2545" });
    s.addText(puces.map((t) => ({ text: t, options: { bullet: true } })), { x: 0.8, y: 1.6, w: 8.4, h: 3.4, fontSize: 18 });
  };
  diapo("Revue trimestrielle", ["Adventum Pharma — Direction commerciale", "Période : juillet à septembre 2026"]);
  diapo("Ventes du trimestre", ["Chiffre d'affaires : 412 M DZD (+12 % sur un an)", "Cardiplus premier produit : 31 % des ventes", "Oran et Constantine en tête de la croissance"]);
  diapo("Lancements et marché", ["Deux lancements : Dolexan 500 et Betacor LP", "Part de marché cardiologie : 18 % (+2 points)", "Rupture Amoxival en août, résorbée en 9 jours"]);
  void pptxDiapos;
  const pptxId = await deposer("Revue trimestrielle.pptx", (await deck.write({ outputType: "nodebuffer" })) as Buffer, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  const docxId = await deposer("Contrat Benali.docx", await docxDeParagraphes([
    "Contrat de travail à durée indéterminée",
    "Article 1 — Engagement : M. Karim Benali est engagé en qualité de délégué médical à compter du 1er décembre 2026.",
    "Article 2 — Période d'essai : la période d'essai est fixée à 3 mois, renouvelable une fois.",
    "Article 3 — Rémunération : selon le tableau ci-dessous.",
  ], { premierEstTitre: true, tableau: [["Élément", "Montant"], ["Salaire de base", "95 000 DZD"], ["Prime de route", "15 000 DZD"]] }), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  const tour = async (texte: string, piece: { id: string; nom: string }) => {
    const t0 = Date.now();
    const r = await jouerTour(user, { texte, pieces: [piece], historique: [], delaiMs: 240_000, maxEtapes: 14 });
    return { ok: r.ok, ms: Date.now() - t0, outils: r.ok ? r.outilsAppeles : [], reponse: r.ok ? r.content.slice(0, 700) : r.error };
  };
  const session = async (nodeId: string) => prisma.artifactSession.findFirst({ where: { userId: u.id, nodeId, blockId: { startsWith: "atelier-" } }, orderBy: { updatedAt: "desc" } });

  // ── 1. PowerPoint ──────────────────────────────────────────────────────────────────────────
  const t1 = await tour("Dans cette présentation, remplace le titre par « Revue du 3e trimestre 2026 » et ajoute une diapositive de synthèse à la fin.", { id: pptxId, nom: "Revue trimestrielle.pptx" });
  const s1 = await session(pptxId);
  const v1 = s1 ? await vueAtelier(user, s1.id) : null;
  const diapos = v1?.contenu.kind === "PPTX" ? v1.contenu.diapos : [];
  const pptx = {
    ...t1,
    ops: v1?.historique.map((h) => h.resume) ?? [],
    titre1: diapos[0]?.titre ?? null,
    diapositives: diapos.length,
    derniere: diapos.at(-1) ? { titre: diapos.at(-1)!.titre, texte: diapos.at(-1)!.formes.map((f) => f.texte).join(" / ") } : null,
    reussi: diapos.length === 4 && /3e trimestre 2026/.test(diapos[0]?.titre ?? "") && /synth/i.test(diapos.at(-1)?.titre ?? ""),
  };

  // ── 2. Word ────────────────────────────────────────────────────────────────────────────────
  const t2 = await tour("Dans ce contrat, mets la période d'essai à 6 mois.", { id: docxId, nom: "Contrat Benali.docx" });
  const s2 = await session(docxId);
  const v2 = s2 ? await vueAtelier(user, s2.id) : null;
  let word: Record<string, unknown> = { ...t2, ouvert: Boolean(s2) };
  if (s2 && v2) {
    const e = await enregistrerAtelier(user, s2.id);
    const versions = await prisma.fileVersion.findMany({ where: { nodeId: docxId }, orderBy: { version: "asc" } });
    const relu = (await adaptateurPour("DOCX").ouvrir((await getBlob(versions.at(-1)!.blobId))!)).modele();
    if (relu.kind !== "DOCX") throw new Error("format");
    const essai = relu.paragraphs.find((p) => /essai/i.test(p.text))?.text ?? "";
    word = {
      ...word,
      ops: v2.historique.map((h) => h.resume),
      enregistre: e.ok, versions: versions.map((v) => v.version),
      essai,
      titreGardeSonStyle: relu.paragraphs[0]?.styleName === "Heading1",
      tableauConserve: relu.tables.length === 1 && relu.tables[0]!.rows === 3,
      paragraphes: relu.paragraphs.length,
      reussi: /6 mois/.test(essai) && !/3 mois/.test(essai) && relu.paragraphs[0]?.styleName === "Heading1" && relu.tables.length === 1 && versions.length === 2,
    };
  }

  const conso = await prisma.modelCallLog.aggregate({ where: { userId: u.id, at: { gte: debut } }, _sum: { costUsd: true }, _count: true });
  const bilan = { pptx, word, coutUsd: Number(conso._sum.costUsd ?? 0), appels: conso._count, dureeS: Math.round((Date.now() - debut.getTime()) / 1000) };
  console.log(JSON.stringify(bilan, null, 2));
  if (process.env.BANC_SORTIE) fs.writeFileSync(process.env.BANC_SORTIE, JSON.stringify(bilan, null, 2));

  await prisma.artifactSession.deleteMany({ where: { userId: u.id } });
  await prisma.driveNode.deleteMany({ where: { ownerId: u.id } });
  await prisma.assistantIaAcces.deleteMany({ where: { userId: u.id } });
  await prisma.$disconnect();
  if (!pptx.reussi || !word.reussi) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
