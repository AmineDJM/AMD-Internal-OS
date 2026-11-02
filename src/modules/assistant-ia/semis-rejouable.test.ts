import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { retirerAudit, semerAudit } from "./infra/testing/audit/semis";

/**
 * LE SEMIS DU BANC D'AUDIT EST REJOUABLE (décision 0050, signalé par T3 le 02/11) — le banc réel ressème avant chaque
 * passage (`retirerAudit` puis `semerAudit`, même étiquette, même base). Mesuré : la référence unique des demandes Ad & Pro
 * du semis transverse faisait échouer le second semis, et T3 a dû purger `amd_bench` à la main. Exigé, pour TOUS les
 * domaines : semer, retirer, semer à nouveau sans erreur — et après le dernier retrait, plus aucun compte de l'étiquette.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const ETIQUETTE = `-r${Date.now().toString(36)}`;
const depots = { putBlob, enregistrerFichierDrive };

suite("Le semis du banc d'audit — rejouable deux fois de suite sur la même base", () => {
  afterAll(async () => { await retirerAudit(ETIQUETTE); }, 120_000);

  it("semer → retirer → semer → retirer : aucune erreur, aucun résidu de l'étiquette", async () => {
    const premier = await semerAudit(ETIQUETTE, depots);
    await retirerAudit(ETIQUETTE);
    const second = await semerAudit(ETIQUETTE, depots);
    expect(Object.keys(second.pieces).sort()).toEqual(Object.keys(premier.pieces).sort());
    await retirerAudit(ETIQUETTE);
    expect(await prisma.user.count({ where: { email: { endsWith: `${ETIQUETTE}@adventum-audit.dz` } } })).toBe(0);
    expect(await prisma.adProOtherRequest.count({ where: { reference: { contains: ETIQUETTE } } })).toBe(0);
  }, 300_000);
});
