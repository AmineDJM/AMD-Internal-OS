import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { POWER_TOOLS } from "./power-tools";
import { indexDriveNodeText } from "./document-discovery";
import { runDriveIngestionSweep } from "./drive-ingestion";

/**
 * GOLDEN RÉGRESSION — DÉCOUVERTE DOCUMENTAIRE (§150) : un document MAL NOMMÉ, jamais
 * explicitement lu, mais indexé par l'ingestion, doit se retrouver par son CONTENU — avec sa
 * NATURE détectée. Et l'ingestion planifiée ne repasse pas éternellement sur un fichier
 * illisible (index-témoin).
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name: "PDG", email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ing__${Date.now()}`;
let ceoId = "";
let nodeId = "";
let orphanNodeId = "";

suite("ingestion Drive — le contenu rend trouvable ce que le nom cache", () => {
  beforeAll(async () => {
    const ceo = await prisma.user.create({ data: { name: `${TAG}ceo`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    ceoId = ceo.id;
    // Un scan MAL NOMMÉ dans le Drive personnel du PDG — le nom ne dit rien du contenu.
    const node = await prisma.driveNode.create({
      data: { name: "scan_0234.pdf", type: "FILE", ownerId: ceoId, size: 1000, mimeType: "application/pdf" },
    });
    nodeId = node.id;
    // L'ingestion l'a indexé (on simule le résultat d'extraction — le chemin réel passe par
    // ensureNodeIndexed, testé plus bas sur le cas « blob indisponible »).
    await indexDriveNodeText(
      nodeId, "v-test-1",
      `Contrat de travail conclu en CDI entre Adventum Pharma et M. ${TAG}Benali, engagé en qualité de chargé des affaires réglementaires. Période d'essai de six mois.`,
      null, "scan_0234.pdf",
    );
    // Un second fichier SANS blob lisible : l'ingestion doit poser un index-témoin, pas boucler.
    const blob = await prisma.fileBlob.create({
      data: { sha256: `${TAG}-missing`, size: 10, iv: Buffer.from("0123456789ab"), storageKey: `${TAG}/absent` },
    });
    const orphan = await prisma.driveNode.create({
      data: { name: `${TAG}_illisible.pdf`, type: "FILE", ownerId: ceoId, size: 10 },
    });
    orphanNodeId = orphan.id;
    await prisma.fileVersion.create({ data: { nodeId: orphanNodeId, blobId: blob.id, version: 1, size: 10 } });
  });

  afterAll(async () => {
    await prisma.driveTextIndex.deleteMany({ where: { nodeId: { in: [nodeId, orphanNodeId] } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { id: { in: [nodeId, orphanNodeId] } } }).catch(() => {});
    await prisma.fileBlob.deleteMany({ where: { sha256: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("§150 — « scan_0234.pdf » se retrouve par CONTENU via find_documents, avec sa nature détectée", async () => {
    const exec = userWith({ DRIVE: ["VIEW"], CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION", ceoId);
    const tool = POWER_TOOLS.find((t) => t.def.name === "find_documents")!;
    const out = JSON.parse(await tool.run({ query: `contrat ${TAG}Benali`, max_reads: 1 }, exec));
    const hit = (out.resultats as { nom: string; confiance: string; typeDetecte?: string; preuve?: string }[])
      .find((r) => r.nom === "scan_0234.pdf");
    expect(hit).toBeTruthy();
    expect(hit!.confiance).toBe("HAUTE"); // les termes sont DANS le contenu indexé
    expect(hit!.typeDetecte).toBe("Contrat de travail");
    expect(hit!.preuve).toMatch(/Contrat de travail/i);
  });

  it("le filtre par NATURE (kind) restreint aux documents classés ainsi", async () => {
    const exec = userWith({ DRIVE: ["VIEW"] }, "DIRECTION", ceoId);
    const tool = POWER_TOOLS.find((t) => t.def.name === "find_documents")!;
    const hitOk = JSON.parse(await tool.run({ query: `${TAG}Benali`, kind: "employment_contract", max_reads: 1 }, exec));
    expect((hitOk.resultats ?? []).some((r: { nom: string }) => r.nom === "scan_0234.pdf")).toBe(true);
    // La même recherche filtrée « facture » ne doit PAS remonter le contrat par le contenu.
    const miss = await tool.run({ query: `${TAG}Benali`, kind: "invoice", max_reads: 1 }, exec);
    const parsed = typeof miss === "string" && miss.startsWith("{") ? JSON.parse(miss) : null;
    const contentHit = parsed?.resultats?.find((r: { nom: string; confiance: string }) => r.nom === "scan_0234.pdf" && r.confiance !== "FAIBLE");
    expect(contentHit ?? null).toBeNull();
  });

  it("l'ingestion pose un INDEX-TÉMOIN sur un fichier illisible — et ne le repasse pas en boucle", async () => {
    const first = await runDriveIngestionSweep(50);
    expect(first.indexed).toBeGreaterThanOrEqual(1); // le fichier orphelin a été traité
    const row = await prisma.driveTextIndex.findUnique({ where: { nodeId: orphanNodeId } });
    expect(row).toBeTruthy();
    expect(row!.text).toBe("");
    expect(row!.note).toBeTruthy(); // la RAISON est gardée (« contenu indisponible »)
    // Second passage : plus aucun candidat non indexé parmi nos fixtures.
    const remaining = await prisma.driveNode.count({ where: { id: { in: [nodeId, orphanNodeId] }, textIndex: null } });
    expect(remaining).toBe(0);
    /*
     * LE PLAFOND RÉPOND À « EST-IL BLOQUÉ ? », JAMAIS À « EST-IL LENT ? » (§118.124b).
     *
     * Mesuré à nouveau, parce que les 20 s posées la dernière fois n'ont pas tenu : ce cas SEUL
     * fait **140, 143, 144 et 144 ms** sur quatre lectures, et le fichier entier 638 ms à chaud —
     * mais 20 438 ms au premier lancement après un démarrage du cluster Postgres, qui rejoue son
     * journal (le même écart que §118.141g). Sous 772 fichiers et QUATRE cœurs, il a dépassé les
     * 20 s : un cas qui travaille 140 ms et attend 20 s ne mesure pas son propre coût, il mesure
     * la contention de la base EN PLUS de celle du processeur.
     *
     * On ne relève donc pas le plafond GLOBAL — il garderait 8 869 tests moins sévèrement pour en
     * réparer un (§118.16). Rien n'est masqué : un balayage qui ne rend jamais la main échoue
     * toujours, un peu plus tard, et la BOUCLE — le vrai risque de ce cas — est mesurée par
     * `remaining`, pas par le temps.
     */
  }, 60_000);

  it("débrayage : ASSISTANT_DRIVE_INGESTION=off → aucun travail", async () => {
    const prev = process.env.ASSISTANT_DRIVE_INGESTION;
    process.env.ASSISTANT_DRIVE_INGESTION = "off";
    try {
      expect(await runDriveIngestionSweep(50)).toEqual({ indexed: 0, refreshed: 0 });
    } finally {
      if (prev === undefined) delete process.env.ASSISTANT_DRIVE_INGESTION;
      else process.env.ASSISTANT_DRIVE_INGESTION = prev;
    }
  });
});
