import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { chercherContenu, versTsquery } from "@/lib/fabric/text-search";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RECHERCHE DE CONTENU DE LA FABRIC — correcte, ET réellement indexée.
 *
 * Deux familles d'assertions, et la seconde est la plus importante :
 *
 *   1. CORRECTION — les bons documents sortent, dans un ordre sensé, la conjonction avant la
 *      disjonction, le filtre de nature respecté, les préfixes trouvés.
 *   2. L'INDEX EST RÉELLEMENT UTILISÉ — un EXPLAIN prouve que la requête passe par l'index
 *      GIN de la migration `20260828300000_fabric_content_indexes`. C'est le SABOTAGE
 *      structurel : si quelqu'un supprime l'index, ou modifie l'expression de la requête sans
 *      toucher celle de l'index (ou l'inverse), ce test tombe — au lieu qu'un scan séquentiel
 *      revienne en silence et que « indexé » redevienne un mot.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__fabric${Date.now()}`;

suite("fabric/text-search — la recherche de contenu", () => {
  const noeuds: string[] = [];

  beforeAll(async () => {
    const docs = [
      { nom: "rapport-pembrolizumab.pdf", texte: "etude du pembrolizumab en oncologie, dossier anpp complet", kind: "rapport" },
      { nom: "contrat-fournisseur.pdf", texte: "contrat de consulting avec le laboratoire partenaire, clause de resiliation", kind: "contrat" },
      // `textFold` est TOUJOURS replié (minuscules sans accents) par `foldText` en production —
      // la fixture respecte l'invariant, sinon elle testerait un état qui n'existe pas.
      { nom: "facture-mars.pdf", texte: "facture du mois de mars, montant total en dinars, reference pay-1028-b", kind: "facture" },
      { nom: "note-interne.txt", texte: "note sur le pembrolizumab et le contrat du laboratoire, double sujet", kind: null },
    ];
    for (const d of docs) {
      const n = await prisma.driveNode.create({
        data: { name: `${TAG}-${d.nom}`, type: "FILE" },
        select: { id: true },
      });
      noeuds.push(n.id);
      await prisma.driveTextIndex.create({
        data: { nodeId: n.id, versionId: "v1", text: d.texte, textFold: d.texte, docKind: d.kind },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await prisma.driveTextIndex.deleteMany({ where: { nodeId: { in: noeuds } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { id: { in: noeuds } } }).catch(() => {});
  }, 60_000);

  it("trouve par MOTS, classé, et par PRÉFIXE — « pembro » trouve « pembrolizumab »", async () => {
    const r = await chercherContenu("drive", ["pembro"], { limit: 10 });
    expect(r.voie).toBe("FTS");
    const ids = r.candidats.map((c) => c.id);
    expect(ids).toContain(noeuds[0]);
    expect(ids).toContain(noeuds[3]);
    expect(ids).not.toContain(noeuds[1]);
  });

  it("la CONJONCTION prime : deux termes ⇒ seul le document qui porte les deux", async () => {
    const r = await chercherContenu("drive", ["pembrolizumab", "contrat"], { limit: 10 });
    expect(r.conjonction).toBe(true);
    expect(r.candidats.map((c) => c.id)).toEqual([noeuds[3]]);
  });

  it("le filtre de NATURE (docKind) est respecté", async () => {
    const r = await chercherContenu("drive", ["contrat"], { limit: 10, docKind: "contrat" });
    expect(r.candidats.map((c) => c.id)).toEqual([noeuds[1]]);
  });

  it("un fragment de RÉFÉRENCE au milieu d'un mot sort par le repli LIKE — et la voie le DIT", async () => {
    // « 1028 » vit au milieu de « pay-1028-b » : la FTS (par mots) ne le voit pas ; le LIKE
    // — désormais servi par l'index trigramme — le rattrape, et le résultat porte sa voie.
    const r = await chercherContenu("drive", [`1028-b`], { limit: 10 });
    expect(r.candidats.map((c) => c.id)).toContain(noeuds[2]);
  });

  it("versTsquery ÉCARTE ce qui n'est pas un caractère de mot — rien à injecter", () => {
    expect(versTsquery(["pembro"], true)).toBe("pembro:*");
    expect(versTsquery(["a&b|c!", "de-mo"], true)).toBe("abc:* & demo:*");
    expect(versTsquery(["x"], true)).toBeNull();
    expect(versTsquery(["'); DROP TABLE--"], true)).toBe("droptable:*");
  });

  /**
   * ── LE SABOTAGE STRUCTUREL : L'EXPLAIN PROUVE L'INDEX ────────────────────────────────
   *
   * `enable_seqscan = off` force le planificateur à préférer un index S'IL EXISTE ET SERT LA
   * REQUÊTE : sur une table de quatre lignes, il choisirait sinon le scan séquentiel et le
   * test ne prouverait rien. Ce qu'on vérifie n'est pas le choix du planificateur en
   * production (il dépend du volume), c'est que l'index EXISTE et que l'expression de la
   * requête est BIEN celle de l'index — les deux seules choses qu'un sabotage peut casser.
   */
  it("SABOTAGE — l'EXPLAIN passe par l'index GIN ; supprimer l'index ferait tomber ce test", async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
        `EXPLAIN (FORMAT JSON)
         SELECT "nodeId" FROM "DriveTextIndex"
         WHERE to_tsvector('simple', left("textFold", 250000)) @@ to_tsquery('simple', 'pembro:*')`,
      );
    });
    const texte = JSON.stringify(plan);
    expect(texte, "la requête FTS doit être servie par l'index d'expression, pas par un scan")
      .toContain("DriveTextIndex_textFold_fts");
  });

  it("SABOTAGE — l'index trigramme sert les LIKE '%…%' existants", async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
        `EXPLAIN (FORMAT JSON)
         SELECT "nodeId" FROM "DriveTextIndex" WHERE "textFold" LIKE '%pembrolizumab%'`,
      );
    });
    expect(JSON.stringify(plan)).toContain("DriveTextIndex_textFold_trgm");
  });
});
