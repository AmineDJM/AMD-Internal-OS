import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { recordArtifact, cleanupRun, verifyClean } from "./manifest";
import { seedSyntheticUsers } from "./synthetic";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `mftest_${crypto.randomBytes(4).toString("hex")}`;

suite("Test Center — manifeste : nettoyage garanti + invariant de sûreté", () => {
  const created: string[] = []; // à supprimer nous-mêmes en fin de test

  afterAll(async () => {
    // Filet de sécurité : on nettoie NOS propres traces (jamais celles d'autrui).
    await prisma.testRun.deleteMany({ where: { initiatedById: TAG } }).catch(() => {});
    if (created.length) await retirerComptesEtSemis({ where: { id: { in: created } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { contains: `@${TAG}.invalid` } } }).catch(() => {});
  });

  it("supprime les ressources du manifeste et vérifie leur absence, SANS toucher une donnée hors-manifeste", async () => {
    const run = await prisma.testRun.create({ data: { mode: "SAFE_SYNTHETIC_TEST", environment: "development", initiatedById: TAG, cleanupStatus: "PENDING" }, select: { id: true } });

    // 1) Un « leurre » : un utilisateur PRÉEXISTANT dont le nom contient « QA test » —
    //    il ne figure PAS au manifeste, il ne doit JAMAIS être supprimé.
    const decoy = await prisma.user.create({
      data: { email: `decoy_qa_test@${TAG}.invalid`, name: "QA TEST leurre (à préserver)", passwordHash: bcrypt.hashSync("x", 4), role: "VIEWER", isActive: false },
      select: { id: true },
    });
    created.push(decoy.id);

    // 2) Ressources synthétiques du run (inscrites au manifeste).
    const synth = await seedSyntheticUsers(run.id, ["VIEWER", "SALES_USER"]);
    expect(synth.length).toBe(2);

    // 3) Nettoyage : supprime EXACTEMENT les 2 ressources du manifeste.
    const clean = await cleanupRun(run.id);
    expect(clean.errors).toBe(0);
    expect(clean.deleted).toBe(2);

    // 4) Vérification post-nettoyage : plus aucune ressource du run.
    const verify = await verifyClean(run.id);
    expect(verify.clean).toBe(true);
    for (const u of synth) expect(await prisma.user.count({ where: { id: u.id } })).toBe(0);

    // 5) INVARIANT ABSOLU : le leurre hors-manifeste est INTACT.
    expect(await prisma.user.count({ where: { id: decoy.id } })).toBe(1);

    await prisma.testRun.delete({ where: { id: run.id } }).catch(() => {}); // supprime le run + ses artefacts (cascade)
  });

  it("ne supprime jamais un modèle non pris en charge (refus par sécurité)", async () => {
    const run = await prisma.testRun.create({ data: { mode: "SAFE_SYNTHETIC_TEST", environment: "development", initiatedById: TAG }, select: { id: true } });
    // Artefact pointant vers un modèle inconnu : le nettoyage doit REFUSER (erreur), pas deviner.
    await recordArtifact(run.id, { resourceType: "mystery", model: "unknownModel", recordId: "nope", deleteMethod: "prisma" });
    const clean = await cleanupRun(run.id);
    expect(clean.errors).toBe(1);
    expect(clean.details[0].result).toContain("refus");
    await prisma.testRun.delete({ where: { id: run.id } }).catch(() => {});
  });
});
