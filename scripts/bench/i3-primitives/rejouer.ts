/**
 * LOT I3 (décision 0065) — REJEU AU VRAI MODÈLE des cas témoins de l'audit AU2, par le CHEMIN DU PRODUIT (`jouerTour`),
 * primitives actives puis éteintes (`ADAM_PRIMITIVES=0`) : outils appelés, réponse, fichiers réellement écrits, coût.
 *
 * Base LOCALE seulement, semis propre (une société, des produits, des pharmacies, un Word), retiré à la fin.
 * `ADAM_SORTIE_INTERDITE=1` : rien ne sort. Budget : `I3_BUDGET_USD` (défaut 1).
 *
 *   NODE_USE_ENV_PROXY=1 OPENAI_API_KEY=sk-proxy ADAM_SORTIE_INTERDITE=1 \
 *     DATABASE_URL=postgresql://amd:amd@localhost:5432/amd_bench npx tsx scripts/bench/i3-primitives/rejouer.ts
 */
process.env.ASSISTANT_IA_PRICE_IN ||= "2";
process.env.ASSISTANT_IA_PRICE_OUT ||= "12";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { composerDocx, paragraphe } from "@/lib/artifact/factory/word";
import { sessionDe } from "@/modules/assistant-ia/api-banc";
import * as svc from "@/modules/assistant-ia/api";

// La base de banc LOCALE (`amd_bench`) : `src/lib/prisma.ts` refuse tout autre hôte, ou un nom sans « bench ».
process.env.ADAM_SORTIE_INTERDITE = "1";
const BUDGET = Number(process.env.I3_BUDGET_USD ?? "1");
const TAG = `i3r${Date.now().toString(36)}`;
const SORTIE = process.env.OUT ?? "docs/assistant/preuves/i3/rejeu-vrai-modele.json";

async function semer(): Promise<{ sa: CurrentUser; mot: string }> {
  const u = await prisma.user.create({ data: { email: `amine.${TAG}@adventum-bench.dz`, name: `Amine ${TAG}`, role: "SUPER_ADMIN", passwordHash: "x", isActive: true } });
  const societe = await prisma.company.create({ data: { name: `Adventum ${TAG}`, shortName: `ADV${TAG}` } });
  const produit = async (k: string, nom: string, status: string, segments: string[], classe: string) => {
    const p = await prisma.product.create({ data: { code: `${TAG}${k}`, canonicalName: nom, dci: nom.split(" ")[0]!, identityKey: `${TAG}${k}`, companyId: societe.id, lifecycle: "MARKETED" } });
    await prisma.regulatoryProduct.create({ data: { reference: `${TAG}-${k}`, dci: nom.split(" ")[0]!, status: status as never, therapeuticSegments: segments, therapeuticClass: classe, productId: p.id } });
  };
  await produit("A", "Amoxil 1 g", "DECISION_OBTAINED", ["Infectiologie"], "Pénicilline");
  await produit("Z", "Azitrom 500 mg", "CLOSED", ["Infectiologie"], "Macrolide");
  await produit("P", "Posaconazole 100 mg", "PRE_SUBMISSION", ["Infectiologie & Réanimation"], "Antifongique");
  await produit("R", "Rivaroxaban 20 mg", "DECISION_OBTAINED", ["Hématologie"], "Anticoagulant");
  for (const [i, n] of ["Ibn Sina", "El Amel", "Es Salam", "Centrale d'Alger"].entries()) {
    await prisma.medicalInstitution.create({ data: { name: `Pharmacie ${n}`, type: "PHARMACIE", sector: "PRIVE", wilaya: i < 3 ? "Oran" : "Alger", city: i < 3 ? "Oran" : "Alger", phone: `041 2${i} 33 44`, address: `${i + 1} rue de la Paix`, isActive: true } as never });
  }
  const sa = await sessionDe(u.id);
  const docx = composerDocx({ blocs: [paragraphe("Convocation au comité de direction"), paragraphe("Date : 14 octobre 2026"), paragraphe("Lieu : siège, Alger")], titre: "Convocation" }).octets;
  const b = await putBlob(docx);
  await enregistrerFichierDrive(sa, { parentId: null }, { blobId: b.blobId, size: b.size, sha256: b.sha256, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "Convocation comité.docx" });
  return { sa, mot: TAG };
}

async function retirer(sa: CurrentUser) {
  await prisma.driveNode.deleteMany({ where: { OR: [{ ownerId: sa.id }, { space: { accessUserIds: { has: sa.id } } }] } }).catch(() => {});
  await prisma.driveSpace.deleteMany({ where: { accessUserIds: { has: sa.id } } }).catch(() => {});
  await prisma.medicalInstitution.deleteMany({ where: { name: { in: ["Pharmacie Ibn Sina", "Pharmacie El Amel", "Pharmacie Es Salam", "Pharmacie Centrale d'Alger"] } } });
  await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } });
  await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.company.deleteMany({ where: { name: { contains: TAG } } });
}

const DEMANDES = [
  { id: "PRODUITS", texte: "Quels sont nos produits commercialisés en infectiologie ?" },
  { id: "ANNUAIRE", texte: "Copie l'annuaire des pharmacies d'Oran en Excel, ajoute une colonne statut et range-le dans ton Drive." },
  { id: "WORD", texte: "Convertis le Word « Convocation comité » en PDF et remplace la date par le 20 novembre 2026." },
];

async function conso(userId: string, depuis: Date) {
  const l = await prisma.modelCallLog.aggregate({ where: { userId, at: { gte: depuis } }, _sum: { costUsd: true }, _count: true });
  return { coutUsd: Number(l._sum.costUsd ?? 0), appels: l._count };
}

async function main() {
  const { sa } = await semer();
  const resultats: unknown[] = [];
  let total = 0;
  try {
    for (const mode of ["primitives", "avant"] as const) {
      if (mode === "avant") process.env.ADAM_PRIMITIVES = "0"; else delete process.env.ADAM_PRIMITIVES;
      for (const d of DEMANDES) {
        if (total > BUDGET) { resultats.push({ mode, id: d.id, saute: "budget atteint" }); continue; }
        const debut = new Date();
        const t0 = Date.now();
        const r = await svc.jouerTour(sa, { texte: d.texte, pieces: [], historique: [] }).catch((e) => ({ ok: false as const, error: String(e) }));
        const c = await conso(sa.id, debut);
        total += c.coutUsd;
        const fichiers = await prisma.driveNode.findMany({
          where: { type: "FILE", isTrashed: false, updatedAt: { gte: debut }, OR: [{ ownerId: sa.id }, { space: { accessUserIds: { has: sa.id } } }] },
          select: { name: true, parent: { select: { name: true } }, space: { select: { name: true } }, _count: { select: { versions: true } } },
        });
        resultats.push({
          mode, id: d.id, demande: d.texte, ms: Date.now() - t0, ...c,
          ...(r.ok ? { reponse: r.content, outils: r.outilsAppeles } : { erreur: (r as { error: string }).error }),
          fichiers: fichiers.map((f) => ({ nom: f.name, dossier: f.parent?.name ?? null, espace: f.space?.name ?? "Mon Drive", versions: f._count.versions })),
        });
        console.log(`${mode} ${d.id} · ${c.appels} appels · ${c.coutUsd.toFixed(4)} $ · ${r.ok ? (r.outilsAppeles ?? []).join(", ") : "ERREUR"}`);
        fs.mkdirSync(SORTIE.replace(/\/[^/]+$/, ""), { recursive: true });
        fs.writeFileSync(SORTIE, JSON.stringify({ modele: process.env.ASSISTANT_IA_MODEL ?? "(défaut du produit)", coutTotalUsd: total, resultats }, null, 2));
      }
    }
  } finally {
    await retirer(sa);
    console.log(`coût total ${total.toFixed(4)} $ → ${SORTIE}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
