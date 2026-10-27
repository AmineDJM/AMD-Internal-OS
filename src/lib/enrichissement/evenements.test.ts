import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ABONNEMENT_PIECE_DEPOSEE, emettrePieceDeposee, lireChargePieceDeposee, TYPE_PIECE_DEPOSEE } from "./evenements";
import { correlationPiece, type PieceDeposeeInput } from "./depot";

/**
 * `PIECE_DEPOSEE` BOUT EN BOUT — avec la vraie base : un dépôt inscrit un fait, le même dépôt
 * n'en inscrit pas un second, un nouveau rattachement en inscrit un qui ne porte que lui.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Une empreinte propre à l'exécution : la corrélation suffit à isoler (et nettoyer) ces faits.
const SHA = (Date.now().toString(16) + "f".repeat(64)).slice(0, 64);
const depot = (o: Partial<PieceDeposeeInput> = {}): PieceDeposeeInput => ({
  blobId: "blob-test", empreinte: SHA, nomFichier: "passeport_benali.pdf", mime: "application/pdf", taille: 4096,
  source: "ADPRO", deposeParId: null, confidentialite: "CONFIDENTIAL",
  rattachements: [{ type: "AD_PRO_ITEM", id: "poste-test", role: "passeport" }], ...o,
});

suite("emettrePieceDeposee — le registre d'événements", () => {
  afterAll(async () => {
    await prisma.businessEvent.deleteMany({ where: { correlationId: correlationPiece(SHA) } }).catch(() => undefined);
  });

  it("inscrit le fait, puis ne le réinscrit pas, puis n'inscrit que le rattachement nouveau", async () => {
    const r1 = await emettrePieceDeposee(depot());
    expect(r1.statut).toBe("EMIS");

    const evt = await prisma.businessEvent.findFirst({ where: { correlationId: correlationPiece(SHA) } });
    expect(evt?.type).toBe(TYPE_PIECE_DEPOSEE);
    expect(evt?.entityType).toBe("AD_PRO_ITEM");
    expect(evt?.entityId).toBe("poste-test");
    const charge = lireChargePieceDeposee(evt?.payload);
    expect(charge?.nomFichier).toBe("*.pdf");

    expect((await emettrePieceDeposee(depot())).statut).toBe("DEJA_EMIS");

    const r3 = await emettrePieceDeposee(depot({
      rattachements: [
        { type: "AD_PRO_ITEM", id: "poste-test", role: "passeport" },
        { type: "CONVERSATION", id: "conv-test", role: "pièce-jointe" },
      ],
    }));
    expect(r3.statut).toBe("EMIS");
    if (r3.statut !== "EMIS") return;
    expect(r3.dejaEmis).toBe(1);
    expect(r3.rattachements).toEqual([{ type: "CONVERSATION", id: "conv-test", role: "pièce-jointe" }]);

    const second = await prisma.businessEvent.findUnique({ where: { id: r3.eventId } });
    // CONVERSATION n'est pas un `EntityType` : il n'est que dans `relatedRefs`.
    expect(second?.entityType).toBeNull();
    expect(second?.relatedRefs).toEqual(["CONVERSATION:conv-test"]);
    expect(await prisma.businessEvent.count({ where: { correlationId: correlationPiece(SHA) } })).toBe(2);
  });

  it("refuse sans rien écrire un dépôt sans empreinte réelle", async () => {
    const r = await emettrePieceDeposee(depot({ empreinte: "direct:drive/objet" }));
    expect(r.statut).toBe("REJETE");
  });
});

describe("l'abonnement prévu", () => {
  it("est décrit et NON branché", () => {
    expect(ABONNEMENT_PIECE_DEPOSEE.type).toBe(TYPE_PIECE_DEPOSEE);
    expect(ABONNEMENT_PIECE_DEPOSEE.branche).toBe(false);
  });
});
