import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * SÉMANTIQUE DRIVE + BANC RECALL — mesuré HONNÊTEMENT :
 *
 * Ces tests mesurent le MÉCANISME (fusion lexical → repli sémantique, cache, ACL en aval)
 * avec un embedder DÉTERMINISTE injecté par mock : un « dictionnaire » qui place les
 * synonymes connus des fixtures sur le même vecteur. Ils prouvent que le pipeline retrouve
 * par le SENS ce que le lexical rate — ils ne prouvent PAS la qualité des vecteurs OpenAI
 * réels : ce Recall-là se mesure en production (clé requise) et reste NOT YET MEASURED.
 */

// Embedder-dictionnaire : chaque « concept » a un axe ; un texte pointe vers l'axe de son
// concept. Déterministe, sans réseau — les tests du mécanisme n'attendent pas une API.
const CONCEPTS: [string[], number[]][] = [
  [["duree de conservation", "shelf life", "stabilite du produit"], [1, 0, 0, 0]],
  [["bon de commande", "purchase order"], [0, 1, 0, 0]],
  [["facture", "invoice", "montant ttc"], [0, 0, 1, 0]],
];
function dictEmbed(texts: string[]): Promise<number[][] | null> {
  return Promise.resolve(texts.map((raw) => {
    const t = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    for (const [keys, vec] of CONCEPTS) if (keys.some((k) => t.includes(k))) return vec;
    return [0, 0, 0, 1]; // hors-sujet
  }));
}

vi.mock("@/lib/openai-luna", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/openai-luna")>();
  return { ...mod, lunaEmbed: (texts: string[]) => dictEmbed(texts) };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { POWER_TOOLS } from "./power-tools";
import { indexDriveNodeText } from "./document-discovery";
import { driveSemanticCandidates, embedDriveBacklog, resetDriveSemanticCache } from "./semantic-drive";

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

const TAG = `__sem__${Date.now()}`;
let ownerId = "";
let shelfNodeId = "";

suite("sémantique Drive — le sens retrouve ce que le lexical rate (embedder déterministe)", () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({ data: { name: `${TAG}o`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    ownerId = owner.id;
    // Trois documents MAL NOMMÉS : le contenu seul dit ce qu'ils sont.
    const mk = (name: string) => prisma.driveNode.create({ data: { name, type: "FILE", ownerId, size: 10 } });
    const [a, b, c] = await Promise.all([mk(`${TAG}_scan1.pdf`), mk(`${TAG}_scan2.pdf`), mk(`${TAG}_scan3.pdf`)]);
    shelfNodeId = a.id;
    await indexDriveNodeText(a.id, "v1", "Report on shelf life of the finished product, 24 months at 25C.", null, a.name);
    await indexDriveNodeText(b.id, "v1", "Purchase order for ten laptops. Bon de commande numero 55.", null, b.name);
    await indexDriveNodeText(c.id, "v1", "Compte rendu de reunion hebdomadaire du service.", null, c.name);
    // Vectorisation de rattrapage — la phase 3 du sweep, ici avec l'embedder-dictionnaire.
    resetDriveSemanticCache();
    const embedded = await embedDriveBacklog(50, dictEmbed);
    expect(embedded).toBeGreaterThanOrEqual(3);
  });

  afterAll(async () => {
    await prisma.driveTextIndex.deleteMany({ where: { node: { owner: { email: { startsWith: TAG } } } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    resetDriveSemanticCache();
  });

  it("« durée de conservation » (FR) retrouve le document « shelf life » (EN) — zéro terme commun", async () => {
    resetDriveSemanticCache();
    const hits = await driveSemanticCandidates("durée de conservation du produit fini", 5, dictEmbed);
    expect(hits[0]?.nodeId).toBe(shelfNodeId);
    expect(hits[0]?.score).toBeGreaterThan(0.9);
  });

  it("find_documents replie sur le SENS quand le lexical n'a rien — confiance « SENS », couverture honnête", async () => {
    resetDriveSemanticCache();
    const exec = userWith({ DRIVE: ["VIEW"] }, "DIRECTION", ownerId);
    const tool = POWER_TOOLS.find((t) => t.def.name === "find_documents")!;
    const out = JSON.parse(await tool.run({ query: "durée de conservation", max_reads: 0 }, exec));
    const hit = (out.resultats as { nom: string; confiance: string }[]).find((r) => r.nom === `${TAG}_scan1.pdf`);
    expect(hit).toBeTruthy();
    expect(hit!.confiance).toMatch(/^SENS/);
    expect(JSON.stringify(out.couverture.sourcesInterrogees)).toMatch(/SÉMANTIQUE/);
  });

  it("BANC RECALL@5 (fixtures synthétiques) : hybride ≥ lexical, gain mesuré — jamais affirmé", async () => {
    resetDriveSemanticCache();
    // Requêtes SYNONYMES (le lexical ne peut pas les trouver) + une requête lexicale directe.
    const bench: { query: string; expected: string }[] = [
      { query: "durée de conservation", expected: `${TAG}_scan1.pdf` }, // EN dans le doc
      { query: "purchase order", expected: `${TAG}_scan2.pdf` }, // présent : lexical OK
      { query: "stabilité du produit", expected: `${TAG}_scan1.pdf` }, // synonyme
    ];
    const exec = userWith({ DRIVE: ["VIEW"] }, "DIRECTION", ownerId);
    const tool = POWER_TOOLS.find((t) => t.def.name === "find_documents")!;

    let lexicalHits = 0;
    let hybridHits = 0;
    for (const b of bench) {
      const out = JSON.parse(await tool.run({ query: b.query, max_reads: 0 }, exec));
      // La base est PARTAGÉE avec les bancs voisins (leurs « BC imprimerie Atlas », « Facture CHU »… sont visibles d'un compte
      // DIRECTION) : le rang se mesure parmi les fixtures DE CE BANC, sinon le rappel dépend de l'ordre de la suite (05/11).
      const top5 = (out.resultats as { nom: string; confiance: string }[]).filter((r) => r.nom.startsWith(TAG)).slice(0, 5);
      if (top5.some((r) => r.nom === b.expected)) hybridHits += 1;
      if (top5.some((r) => r.nom === b.expected && !r.confiance.startsWith("SENS"))) lexicalHits += 1;
    }
    const lexicalRecall = lexicalHits / bench.length;
    const hybridRecall = hybridHits / bench.length;
    console.info("[bench] Recall@5 (fixtures synthétiques, embedder déterministe)", { lexicalRecall, hybridRecall });
    expect(hybridRecall).toBeGreaterThan(lexicalRecall); // le gain se MESURE ici
    expect(hybridRecall).toBe(1); // sur ces fixtures, l'hybride retrouve tout
    // HONNÊTETÉ : ceci mesure le MÉCANISME. Le Recall avec les vrais vecteurs OpenAI sur le
    // vrai Drive = NOT YET MEASURED (exige la clé et le corpus de production).
  });
});
