import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { referenceDeSerie } from "@/lib/refs";

/**
 * LE COMPTEUR D'UNE SÉRIE DE RÉFÉRENCES (audit 27/10/2026, DONNEES-12 / ADPRO-08).
 *
 *   - amorcé au maximum existant, il ne relit plus toutes les références à chaque création ;
 *   - cinq créations simultanées reçoivent cinq numéros distincts ;
 *   - une référence libérée par une suppression n'est JAMAIS redonnée — sans quoi la restauration de la ligne
 *     échouait sur la référence reprise (le banc `ad-pro-postes-flow › SUPPRIMER … RÉVERSIBLE` tombait par
 *     intermittence, et `paiement-montant-retrait-flow` sous la charge de la suite complète).
 * Série de banc : un préfixe propre au passage, sur une vraie table (`Directive`).
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const PREFIXE = `ZS${Date.now().toString(36).toUpperCase()}`;
const ANNEE = 2026;
const suivante = () => referenceDeSerie({
  modele: "Directive", prefixe: PREFIXE, annee: ANNEE,
  existantes: async () => (await prisma.directive.findMany({ where: { reference: { startsWith: `${PREFIXE}-${ANNEE}-` } }, select: { reference: true } })).map((r) => r.reference),
});

suite("referenceDeSerie — le compteur d'une série", () => {
  afterAll(async () => {
    await prisma.directive.deleteMany({ where: { reference: { startsWith: `${PREFIXE}-` } } }).catch(() => {});
    await prisma.serieReference.deleteMany({ where: { cle: `Directive:${PREFIXE}-${ANNEE}` } }).catch(() => {});
  });

  it("amorcé au maximum existant ; cinq créations simultanées, cinq numéros distincts", async () => {
    await prisma.directive.create({ data: { reference: `${PREFIXE}-${ANNEE}-041`, title: `${PREFIXE} amorce`, body: "-" } });
    const refs = await Promise.all(Array.from({ length: 5 }, suivante));
    expect(new Set(refs).size).toBe(5);
    expect([...refs].sort()).toEqual([42, 43, 44, 45, 46].map((n) => `${PREFIXE}-${ANNEE}-0${n}`));
  });

  it("une référence libérée par une suppression n'est jamais redonnée", async () => {
    const r = await suivante();
    await prisma.directive.create({ data: { reference: r, title: `${PREFIXE} supprimée`, body: "-" } });
    await prisma.directive.deleteMany({ where: { reference: r } });
    expect(await suivante()).not.toBe(r);
  });
});
