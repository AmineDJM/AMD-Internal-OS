import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉPÔT DE DOSSIER, CONTRE LA VRAIE BASE (lot J11, décision 0030).
 *
 *   • un dossier déposé RECRÉE son arborescence dans le Drive personnel : racine nommée, sous-dossiers ;
 *   • chaque fichier entre par le dépôt du Drive → une pièce inscrite à la Bibliothèque, dans SON dossier ;
 *   • la même liste redéposée REPREND le lot : seuls les fichiers absents repartent ;
 *   • l'état suit la Bibliothèque (lus, échoués, en file) ; l'assistant classe le dossier par module CTD et nomme
 *     les pièces manquantes, sans relire les fichiers ; jamais le lot d'un autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { creerArborescenceDrive } from "@/lib/drive/arborescence";
import { embedderDeterministe, traiterFile } from "@/modules/bibliotheque/api";
import { etatDesLots, ouvrirLotDossier } from "./infra/depot-dossier";
import { lectureDossierDepose } from "./infra/lecture-dossier";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iadossier_${Date.now().toString(36)}_`;
let moi: CurrentUser;
let autre: CurrentUser;
const ports = { creerArborescence: ({ ownerId, parentId, paths }: { ownerId: string; parentId: string; paths: readonly string[] }) => creerArborescenceDrive({ ownerId, parentId, spaceId: null, paths }) };

async function compte(nom: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access, mustChangePassword: false } as unknown as CurrentUser;
}

const DOSSIER = [
  ["Dossier X/Module 1/Lettre de demande.txt", "Lettre de demande d'enregistrement."],
  ["Dossier X/Module 1/RCP.txt", "Résumé des caractéristiques du produit."],
  ["Dossier X/Module 3/3.2.P/3.2.P.5 Control.txt", "Specifications of the finished product."],
  ["Dossier X/Module 3/3.2.P/scan_001.txt", "Stability study of the finished product, shelf life 24 months."],
  ["Dossier X/divers.txt", "Rien de particulier."],
].map(([chemin, texte]) => ({ chemin: chemin!, octets: Buffer.from(`${texte} ${TAG}`, "utf8") }));

async function deposer(user: CurrentUser, lot: { racineId: string; map: Record<string, string> }, fichiers: typeof DOSSIER) {
  for (const f of fichiers) {
    const relatif = f.chemin.split("/").slice(1).join("/");
    const dir = relatif.includes("/") ? relatif.slice(0, relatif.lastIndexOf("/")) : "";
    const b = await putBlob(f.octets);
    await enregistrerFichierDrive(user, { parentId: dir ? lot.map[dir] : lot.racineId }, { blobId: b.blobId, size: b.size, mimeType: "text/plain", name: relatif.split("/").pop()!, sha256: b.sha256 });
  }
}

suite("le dépôt de dossier (J11)", () => {
  beforeAll(async () => { moi = await compte("Moi"); autre = await compte("Autre"); });
  afterAll(async () => {
    const lots = await prisma.assistantIaDepotDossier.findMany({ where: { userId: { in: [moi?.id, autre?.id].filter(Boolean) as string[] } }, select: { racineId: true } });
    await prisma.driveNode.deleteMany({ where: { id: { in: lots.map((l) => l.racineId) } } }).catch(() => {});
    await prisma.assistantIaDepotDossier.deleteMany({ where: { userId: { in: [moi?.id, autre?.id].filter(Boolean) as string[] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("recrée l'arborescence ; chaque fichier, dans SON dossier, devient une pièce de la Bibliothèque ; la reprise ne renvoie que le manque", async () => {
    const liste = DOSSIER.map((f) => ({ chemin: f.chemin, taille: f.octets.length }));
    const lot = await ouvrirLotDossier(moi, { fichiers: liste, mode: "DOSSIER" }, ports);
    if (!lot.ok) throw new Error(lot.error);
    expect(lot.nom).toBe("Dossier X");
    expect(Object.keys(lot.map).sort()).toEqual(["Module 1", "Module 3", "Module 3/3.2.P"]);
    const racine = await prisma.driveNode.findUniqueOrThrow({ where: { id: lot.racineId } });
    expect(racine).toMatchObject({ parentId: null, ownerId: moi.id, type: "FOLDER", spaceId: null });

    // Une COUPURE : seuls 2 fichiers sont arrivés.
    await deposer(moi, lot, DOSSIER.slice(0, 2));
    const reprise = await ouvrirLotDossier(moi, { fichiers: [...liste].reverse(), mode: "DOSSIER" }, ports);
    if (!reprise.ok) throw new Error(reprise.error);
    expect(reprise).toMatchObject({ repris: true, lotId: lot.lotId, racineId: lot.racineId });
    expect(reprise.deja.map((d) => d.relatif).sort()).toEqual(["Module 1/Lettre de demande.txt", "Module 1/RCP.txt"]);
    await deposer(moi, reprise, DOSSIER.slice(2));

    const p5 = await prisma.driveNode.findFirstOrThrow({ where: { name: "3.2.P.5 Control.txt", ownerId: moi.id }, select: { id: true, parentId: true } });
    expect(p5.parentId).toBe(lot.map["Module 3/3.2.P"]);
    expect(await prisma.bibliothequeFiche.count({ where: { cles: { has: `DRIVE_NODE:${p5.id}` } } })).toBe(1);

    // L'état suit la Bibliothèque : tout en file, puis lu.
    let [e] = await etatDesLots(moi, { lotId: lot.lotId });
    expect(e).toMatchObject({ annonces: 5, televerses: 5, enFile: 5, lus: 0 });
    const noeuds = (await prisma.driveNode.findMany({ where: { ownerId: moi.id, type: "FILE" }, select: { id: true } })).map((n) => `DRIVE_NODE:${n.id}`);
    const pieces = (await prisma.bibliothequeFiche.findMany({ where: { cles: { hasSome: noeuds } }, select: { pieceId: true } })).map((f) => f.pieceId);
    await traiterFile({ seulement: pieces, max: 10, deps: { embed: embedderDeterministe() } });
    [e] = await etatDesLots(moi, { lotId: lot.lotId });
    expect(e).toMatchObject({ lus: 5, enFile: 0 });
  });

  it("l'assistant classe le dossier par module CTD et nomme ce qui manque — jamais le dossier d'un autre", async () => {
    const r = JSON.parse(await lectureDossierDepose(moi).run({ analyse: "ctd" }, moi));
    expect(r.dossier).toBe("Dossier X");
    expect(r.parModule).toMatchObject({ "Module 1": 2, "Module 3": 2 });
    expect(r.sections.map((s: { section: string }) => s.section)).toEqual(expect.arrayContaining(["1.0", "1.3.1", "3.2.P.5", "3.2.P.8"]));
    expect(r.nonClassees).toEqual(["divers.txt"]);
    expect(r.manquantes.map((m: { code: string }) => m.code)).toEqual(expect.arrayContaining(["1.2", "3.2.S.4", "5.3.1"]));
    expect(r.manquantes.map((m: { code: string }) => m.code)).not.toContain("3.2.P.8");
    expect(JSON.parse(await lectureDossierDepose(autre).run({ analyse: "ctd" }, autre)).statut).toBe("VIDE");
    expect(JSON.parse(await lectureDossierDepose(moi).run({ analyse: "etat" }, autre)).statut).toBe("REFUS");
  });
});
