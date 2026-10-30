import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { modeleFactice } from "../testing/modele-factice";
import { effacerJournalDe } from "../testing/journal";
import { remplacerModelesPourTests } from "../generer";
import { borner as bornerRevelee } from "../../domaine/filtre-confidentialite";
import { compacterFil } from "./resume";

/**
 * LE RÉSUMÉ ROULANT SUR LA VRAIE BASE (J4) — au faux modèle.
 *
 * Ce qu'on prouve : aucune valeur sensible ne part au modèle (IBAN saisi, salaire révélé à l'écran) ni n'est gardée
 * (un résumé qui en contiendrait est filtré) ; la compaction est IDEMPOTENTE (deux passages, un seul appel) ;
 * « nouvelle conversation » l'efface.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__resume_${Date.now().toString(36)}_`;
const IBAN = "DZ58 0021 0001 1234 5678 9012";
let userId = "";
let filId = "";

suite("résumé roulant du fil (J4)", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}u`, email: `${TAG}u@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    userId = u.id;
    const fil = await prisma.assistantIaFil.create({ data: { userId, depuisLe: new Date(Date.now() - 3_600_000) } });
    filId = fil.id;
    for (let i = 0; i < 9; i++) {
      const quand = new Date(Date.now() - 3_000_000 + i * 60_000);
      const q = await prisma.assistantIaTour.create({
        data: { filId, userId, role: "user", etat: "TRAITE", createdAt: quand, contenu: i === 0 ? `Mon IBAN est ${IBAN}, note-le.` : `Question ${i} sur le dossier REG-2026-90${i}.` },
      });
      await prisma.assistantIaTour.create({
        data: { filId, userId, role: "assistant", etat: "TERMINE", repondA: q.id, createdAt: new Date(quand.getTime() + 1_000), contenu: i === 1 ? `Le salaire d'Assia est de ${bornerRevelee("165 000 DZD")}.` : `Réponse ${i}.` },
      });
    }
  });

  afterAll(async () => {
    remplacerModelesPourTests(null);
    await effacerJournalDe([userId]);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("résume les échanges sortis de la fenêtre, sans jamais une valeur sensible — et une seule fois", async () => {
    const { modele, promptsRecus, toursJoues } = modeleFactice([{ texte: `- La personne a donné son IBAN ${IBAN}.\n- Dossiers REG-2026-901 à 904 consultés.` }]);
    remplacerModelesPourTests([modele]);
    expect(await compacterFil(filId)).toEqual({ fait: true });
    const envoye = JSON.stringify(promptsRecus);
    expect(envoye).not.toContain("DZ58");
    expect(envoye).not.toContain("165 000");
    expect(envoye).toContain("REG-2026-901");
    const fil = await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: filId } });
    expect(fil.resume).toContain("REG-2026-901");
    expect(fil.resume).not.toContain("DZ58");
    expect(fil.resumeJusquA).not.toBeNull();

    // IDEMPOTENT : un second passage, sans échange nouveau, n'appelle pas le modèle et ne change rien.
    expect(await compacterFil(filId)).toEqual({ fait: false, raison: "rien à résumer" });
    expect(toursJoues()).toBe(1);
    expect((await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: filId } })).resume).toBe(fil.resume);
  });

  it("« nouvelle conversation » efface le résumé", async () => {
    const { nouvelleConversation } = await import("./service");
    expect(await nouvelleConversation(userId)).toEqual({ ok: true });
    const fil = await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: filId } });
    expect([fil.resume, fil.resumeJusquA, fil.resumeLe]).toEqual([null, null, null]);
  });
});
