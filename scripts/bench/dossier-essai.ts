/**
 * ESSAI RÉEL DU DÉPÔT DE DOSSIER (lot J11, décision 0030) — un tour court, par le chemin du produit (`jouerTour`), au vrai
 * modèle : « classe ce dossier par module CTD et dis-moi ce qui manque ».
 *
 * Ce qu'il vérifie : le modèle choisit `lire_dossier_depose` (et ne relit pas les fichiers un à un), rapporte le classement
 * et les pièces manquantes. Base LOCALE seulement (`BENCH_DATABASE_URL`) ; le dossier (24 fichiers texte) entre par les
 * vraies portes et est lu par la Bibliothèque avec l'embedder FAUX ; comptes et corpus effacés à la fin ; un seul tour.
 *
 *   npm run bench:live -- scripts/bench/dossier-essai.ts
 */
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { creerArborescenceDrive } from "@/lib/drive/arborescence";
import { embedderDeterministe, traiterFile } from "@/modules/bibliotheque/api";
import { jouerTour, ouvrirLotDossier } from "@/modules/assistant-ia/api";

const TAG = `__essai_dossier_${Date.now().toString(36)}_`;
const FICHIERS: [string, string][] = [
  ["Module 1/Lettre de demande.txt", "Lettre de demande d'enregistrement adressée à l'ANPP."],
  ["Module 1/RCP Amlodipine.txt", "Résumé des caractéristiques du produit."],
  ["Module 1/Notice.txt", "Notice patient."],
  ["Module 1/Certificat GMP.txt", "Certificate of GMP compliance."],
  ["Module 2/QOS.txt", "Quality overall summary."],
  ["Module 3/3.2.S/3.2.S.2 Manufacture.txt", "Manufacture of the drug substance."],
  ["Module 3/3.2.S/3.2.S.4 Specification.txt", "Specification of the drug substance."],
  ["Module 3/3.2.S/3.2.S.7 Stability.txt", "Stability of the drug substance."],
  ["Module 3/3.2.P/3.2.P.1 Composition.txt", "Description and composition of the finished product."],
  ["Module 3/3.2.P/3.2.P.3 Batch formula.txt", "Batch formula and manufacturing process."],
  ["Module 3/3.2.P/3.2.P.5 Specifications.txt", "Specifications of the finished product."],
  ["Module 3/3.2.P/3.2.P.7 Container closure.txt", "Blister PVC/Alu."],
  ["Module 5/Bioequivalence report.txt", "Bioequivalence study: Cmax, AUC within 80-125%."],
  ["Divers/scan_0007.txt", "Stability study of the finished product, zone IVb, shelf life 24 months."],
  ["Divers/IMG_2231.txt", "Photo."],
];

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Base locale seulement.");
  const u = await prisma.user.create({ data: { name: `Admin ${TAG}`, email: `${TAG}sa@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  let racineId: string | null = null;
  try {
    const access = await getAccess(u.id, u.role);
    const user = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
    const fichiers = FICHIERS.map(([c, t]) => ({ chemin: `Dossier Amlodipine/${c}`, octets: Buffer.from(`${t} ${TAG}`, "utf8") }));
    const lot = await ouvrirLotDossier(user, { fichiers: fichiers.map((f) => ({ chemin: f.chemin, taille: f.octets.length })), mode: "DOSSIER" }, {
      creerArborescence: ({ ownerId, parentId, paths }) => creerArborescenceDrive({ ownerId, parentId, spaceId: null, paths }),
    });
    if (!lot.ok) throw new Error(lot.error);
    racineId = lot.racineId;
    for (const f of fichiers) {
      const relatif = f.chemin.split("/").slice(1).join("/");
      const dir = relatif.slice(0, relatif.lastIndexOf("/"));
      const b = await putBlob(f.octets);
      await enregistrerFichierDrive(user, { parentId: lot.map[dir] ?? lot.racineId }, { blobId: b.blobId, size: b.size, mimeType: "text/plain", name: relatif.split("/").pop()!, sha256: b.sha256 });
    }
    await traiterFile({ max: 50, budgetMs: 30_000, parallele: 2, deps: { embed: embedderDeterministe() } });

    const t0 = Date.now();
    const r = await jouerTour(user, {
      texte: `Dossier déposé : « ${lot.nom} » — ${fichiers.length} fichiers, recréé dans mon Drive (/drive/${lot.racineId}).\n\nClasse ces fichiers par module CTD et dis-moi quelles pièces manquent.`,
      pieces: [], historique: [],
    });
    const ms = Date.now() - t0;
    const appels = await prisma.modelCallLog.findMany({ where: { userId: u.id }, select: { inputTokens: true, outputTokens: true, costUsd: true } });
    console.info(JSON.stringify({
      ok: r.ok, ms, outils: r.ok ? r.outilsAppeles : [], texte: r.ok ? r.content.slice(0, 1500) : r.error,
      appels: appels.length, entree: appels.reduce((s, a) => s + (a.inputTokens ?? 0), 0), sortie: appels.reduce((s, a) => s + (a.outputTokens ?? 0), 0),
      coutUsd: appels.reduce((s, a) => s + Number(a.costUsd ?? 0), 0),
    }, null, 2));
  } finally {
    if (racineId) await prisma.driveNode.deleteMany({ where: { id: racineId } }).catch(() => {});
    await prisma.assistantIaDepotDossier.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.modelCallLog.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
