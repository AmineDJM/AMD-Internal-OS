import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { ecrireCacheIntelligence, mettreEnCacheClauses } from "./index";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉSERVE NOCTURNE DES CLAUSES N'ÉCRIT QUE SA CLÉ.
 *
 * Le défaut : `mettreEnCacheClauses` lisait le `custom` de jusqu'à soixante engagements, puis
 * réécrivait chacun en RECOPIANT ce qu'il avait lu (`{ ...custom, intelligence }`), sans
 * condition. Une révision de la fabrique validée entre les deux — `custom.fabrique.version` passé
 * de N à N+1, montant, titre et fichier Drive avec — était DÉFAITE : `fabrique` revenait à N, et
 * la révision suivante reprenait un numéro de version déjà émis. Aucune erreur, aucun signal.
 *
 * Trois étages, et chacun a son témoin : l'ÉCRIVAIN (`ecrireCacheIntelligence` ne pose que
 * `intelligence`, sans dater la pièce), le VRAI point d'entrée (une révision validée PENDANT le
 * passage survit — la course est forcée, pas espérée), et le CODE (le passage ne réécrit plus
 * `custom` lui-même : un retour à l'ancienne écriture fait tomber le cliquet même si la course
 * venait à ne plus se jouer).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__cacheclauses__";
const TAG = `${PREFIXE}${Date.now()}`;

const lire = (id: string) => prisma.legalDocument.findUniqueOrThrow({ where: { id }, select: { custom: true, updatedAt: true } });

/**
 * Une pièce que la réserve ne lira JAMAIS d'elle-même : sans nœud Drive, aucun passage ne la
 * prend (`driveNodeId: { not: null }`). Le statut est indifférent à l'écrivain : ANNULÉE, pour
 * qu'aucune liste voisine de la base partagée ne la compte.
 */
const piece = async (suffixe: string, custom: Prisma.LegalDocumentCreateInput["custom"]) =>
  (await prisma.legalDocument.create({ data: { title: `${TAG} ${suffixe}`, status: "CANCELLED", custom }, select: { id: true } })).id;

async function nettoyer(prefixe: string) {
  await prisma.legalDocument.deleteMany({ where: { title: { startsWith: prefixe } } }).catch(() => {});
  // L'index de texte part avec son nœud (`onDelete: Cascade`).
  await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: prefixe } } }).catch(() => {});
}

suite("la réserve des clauses n'écrit que `custom.intelligence`", () => {
  // Le résidu d'un passage interrompu porterait encore une date future (voir plus bas) et serait
  // lu à la place du nôtre : on retire tout ce que ce banc a pu laisser, AVANT de semer.
  beforeAll(async () => { await nettoyer(PREFIXE); });
  afterAll(async () => { await nettoyer(TAG); });

  it("ÉCRIVAIN : n'écrit QUE la clé `intelligence` — `fabrique` et les champs de l'administrateur restent, et `updatedAt` ne bouge pas", async () => {
    const id = await piece("pièce émise", { fabrique: { version: 2 }, autre: 1 });
    const avant = await lire(id);
    expect(await ecrireCacheIntelligence(id, { x: 1 })).toBe(1);
    const apres = await lire(id);
    expect(apres.custom).toEqual({ fabrique: { version: 2 }, autre: 1, intelligence: { x: 1 } });
    // Une réserve n'est pas une modification de la pièce : la dater ferait croire au verrou de
    // signature d'un BC (`updatedAt: etat.majLe`) qu'elle a changé sous les yeux du signataire.
    expect(apres.updatedAt.getTime()).toBe(avant.updatedAt.getTime());
    // Une seconde réserve REMPLACE la première, et rien d'autre.
    await ecrireCacheIntelligence(id, { x: 2 });
    expect((await lire(id)).custom).toEqual({ fabrique: { version: 2 }, autre: 1, intelligence: { x: 2 } });
  });

  it("ÉCRIVAIN : un `custom` absent, `null` ou qui n'est pas un objet repart d'un objet vide — comme l'écriture d'avant", async () => {
    const cas: [string, Prisma.LegalDocumentCreateInput["custom"]][] = [["sans custom", undefined], ["custom null", Prisma.JsonNull], ["custom tableau", [1, 2]]];
    for (const [suffixe, custom] of cas) {
      const id = await piece(suffixe, custom);
      expect(await ecrireCacheIntelligence(id, { x: 1 }), suffixe).toBe(1);
      expect((await lire(id)).custom, suffixe).toEqual({ intelligence: { x: 1 } });
    }
  });

  it("ÉCRIVAIN : une valeur non sérialisable n'écrit RIEN — `jsonb_set` est strict, et un NULL effacerait `custom` tout entier", async () => {
    const id = await piece("valeur indéfinie", { fabrique: { version: 3 }, autre: 1 });
    await expect(ecrireCacheIntelligence(id, undefined)).rejects.toThrow(/rien n'est écrit/);
    expect((await lire(id)).custom).toEqual({ fabrique: { version: 3 }, autre: 1 });
  });

  it("VRAI POINT D'ENTRÉE : une révision validée PENDANT le passage survit à la réserve — `fabrique` reste à N+1, `updatedAt` reste celui de la révision", async () => {
    // Le décor que la réserve lit : un engagement ACTIF, rattaché à un nœud Drive dont le texte est
    // indexé (elle ne lit de l'index que `nodeId`, `versionId` et `text`).
    const node = await prisma.driveNode.create({ data: { name: `${TAG} BC-0042.docx`, type: "FILE" }, select: { id: true } });
    const versionId = `${TAG}-v1`;
    const texte = "Article 9 — Pénalités. Tout retard de livraison donnera lieu à une pénalité de 1 % du montant par jour de retard.";
    await prisma.driveTextIndex.create({ data: { nodeId: node.id, versionId, text: texte, textFold: texte.toLowerCase() } });
    // DATÉE DANS LE FUTUR : la réserve lit les engagements les plus récemment modifiés d'abord ;
    // avec `limite = 1`, ce passage ne lit QUE cette pièce et ne touche aucune ligne des bancs
    // voisins de la base partagée.
    const id = (await prisma.legalDocument.create({
      data: { title: `${TAG} BC révisé`, status: "ACTIVE", driveNodeId: node.id, custom: { fabrique: { version: 1 }, autre: 1 }, updatedAt: new Date("2999-01-01T00:00:00.000Z") },
      select: { id: true },
    })).id;

    // LA COURSE, FORCÉE : la révision (même écriture conditionnelle que la fabrique, §118.194) se
    // valide APRÈS que le passage a lu les pièces et AVANT qu'il n'écrive — exactement là où
    // l'ancienne écriture la défaisait. Sans cela, le banc espérerait un entrelacement (§118.65).
    // Un objet, pas un `let` : TypeScript ne suit pas une affectation faite dans un rappel.
    const revision: { le: Date | null } = { le: null };
    const lireIndex = prisma.driveTextIndex.findMany.bind(prisma.driveTextIndex) as (args: unknown) => Promise<unknown>;
    const espion = vi.spyOn(prisma.driveTextIndex, "findMany").mockImplementationOnce((async (args: unknown) => {
      const revise = await prisma.legalDocument.updateMany({
        where: { id, custom: { path: ["fabrique", "version"], equals: 1 } },
        data: { custom: { fabrique: { version: 2 }, autre: 1 } },
      });
      expect(revise.count, "la révision concurrente devait passer sa condition de version").toBe(1);
      revision.le = (await lire(id)).updatedAt;
      return lireIndex(args);
    }) as never);
    try {
      const r = await mettreEnCacheClauses(1);
      expect(revision.le, "la révision n'a pas eu lieu pendant le passage : le banc ne mesure rien").not.toBeNull();
      expect(r).toEqual({ examines: 1, misAJour: 1, sansTexte: 0 });
      const apres = await lire(id);
      const custom = apres.custom as { fabrique?: unknown; autre?: unknown; intelligence?: { versionId?: string; clauses?: unknown[] } };
      expect(custom.fabrique, "la réserve a défait la révision validée pendant le passage").toEqual({ version: 2 });
      expect(custom.autre).toBe(1);
      expect(custom.intelligence?.versionId).toBe(versionId);
      expect(Array.isArray(custom.intelligence?.clauses)).toBe(true);
      expect(apres.updatedAt.getTime(), "la réserve a daté la pièce").toBe(revision.le?.getTime());
    } finally {
      espion.mockRestore();
      // Retirée tout de suite : un engagement ACTIF et indexé ne doit pas rester visible des
      // passages de la réserve des bancs voisins plus longtemps que la mesure.
      await prisma.legalDocument.deleteMany({ where: { id } }).catch(() => {});
      await retirerNoeudsDriveEtContenu({ where: { id: node.id } }).catch(() => {});
    }
  });
});

/**
 * LE CLIQUET, DANS LE CODE : la course ci-dessus prouve le comportement d'aujourd'hui ; ceci
 * empêche qu'on revienne à l'écriture qui recopie un instantané — même par un chemin que la
 * course ne jouerait pas (un `$executeRaw` qui pose l'objet entier, une écriture Prisma de plus).
 */
describe("la réserve des clauses — le passage ne réécrit plus `custom` lui-même", () => {
  const source = readFileSync(join(process.cwd(), "src/platform/in-process/intelligence/index.ts"), "utf8");
  const sansCommentaires = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const corps = (nom: string): string => {
    const debut = source.indexOf(`export async function ${nom}(`);
    expect(debut, `${nom} introuvable dans le pont d'intelligence`).toBeGreaterThanOrEqual(0);
    const fin = source.indexOf("\n}\n", debut);
    expect(fin, `fin de ${nom} introuvable`).toBeGreaterThan(debut);
    return sansCommentaires(source.slice(debut, fin));
  };

  it("mettreEnCacheClauses : aucun objet écrit dans `custom`, aucun instantané recopié, aucune écriture Prisma — elle passe par ecrireCacheIntelligence", () => {
    const c = corps("mettreEnCacheClauses");
    expect(c).not.toMatch(/custom\s*:\s*\{/);
    expect(c).not.toMatch(/\.\.\.\s*(?:custom|d\.custom|snapshot)\b/);
    expect(c).not.toMatch(/legalDocument\s*\.\s*(?:update|updateMany|upsert)\s*\(/);
    expect(c).not.toMatch(/\$executeRaw/);
    expect(c).toMatch(/ecrireCacheIntelligence\(\s*d\.id\s*,/);
  });

  it("ecrireCacheIntelligence : la seule clé `intelligence` par `jsonb_set`, en SQL paramétré, sans dater la pièce", () => {
    const c = corps("ecrireCacheIntelligence");
    expect(c).toMatch(/\$executeRaw`/);
    expect(c).not.toMatch(/executeRawUnsafe/);
    expect(c).toMatch(/jsonb_set\(/);
    expect(c).toMatch(/'\{intelligence\}'/);
    expect(c).not.toMatch(/updatedAt/);
  });
});
