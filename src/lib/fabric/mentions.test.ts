import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import {
  balayerMentions, dictionnaireCanonique, documentsLies, enregistrerMentions,
  extraireMentions, resoudreEntitesDe, viderCacheDictionnaire,
} from "@/lib/fabric/mentions";
import { indexDriveNodeText } from "@/lib/assistant/document-discovery";
import { POWER_TOOLS } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MENTIONS D'ENTITÉS (fabric F4) — le lien persisté, ET la preuve qu'il est BRANCHÉ.
 *
 * Le test-vedette est le FRANCHISSEMENT D'ALIAS par le vrai point d'entrée (§14) : un document
 * qui ne dit QUE le nom de marque, indexé par `indexDriveNodeText` (le même appel que la
 * production), doit sortir de `find_documents` quand on cherche la DCI — deux noms, un produit,
 * un lien. Ce cas-là, AUCUNE recherche texte ne peut le couvrir : c'est exactement ce que la
 * table `EntityMention` achète, et si quelqu'un débranche `enregistrerMentions` de l'ingestion,
 * ce test tombe — c'est le sabotage structurel de la tranche.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Nonce unique : le dictionnaire charge TOUTE la base — les fixtures ne doivent collisionner
// avec rien, ni entre deux exécutions de la suite.
const N = `zfab${Date.now().toString(36)}`;
const TAG = `__fabmen_${N}`;
const DCI = `${N}dcirine`; // ≥ 4 caractères, un seul « mot » replié
const MARQUE = `${N}truda`;
const LABO = `${N}labo pharma`;

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

suite("fabric/mentions — entités canoniques & liens persistés", () => {
  let produitId = "";
  let ownerId = "";
  const noeuds: string[] = [];
  let employeId = "";

  const creerNoeud = async (nom: string): Promise<string> => {
    const n = await prisma.driveNode.create({
      data: { name: nom, type: "FILE", ownerId, size: 10 },
      select: { id: true },
    });
    noeuds.push(n.id);
    return n.id;
  };

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: `${TAG}o`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "DIRECTION" },
    });
    ownerId = owner.id;
    // L'ENTITÉ CANONIQUE : un produit qui porte LES DEUX noms — c'est lui, le pont d'alias.
    const p = await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-REG`, dci: DCI, brandName: MARQUE, partnerLab: LABO },
      select: { id: true },
    });
    produitId = p.id;
    const e = await prisma.employee.create({
      data: { fullName: `${N}ilyes ${N}benali`, isActive: true },
      select: { id: true },
    });
    employeId = e.id;
    // Le cache du dictionnaire a 5 min de TTL : sans purge, les fixtures seraient invisibles.
    viderCacheDictionnaire();
  }, 60_000);

  afterAll(async () => {
    await prisma.driveTextIndex.deleteMany({ where: { nodeId: { in: noeuds } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { id: { in: noeuds } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { id: produitId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: employeId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {});
    viderCacheDictionnaire();
  }, 60_000);

  it("le dictionnaire : DCI et marque mènent au MÊME entityId ; personne = nom COMPLET seulement", async () => {
    const dict = await dictionnaireCanonique();
    const produit = dict.find((d) => d.type === "PRODUIT" && d.id === produitId);
    expect(produit).toBeTruthy();
    expect(produit!.cles).toContain(DCI);
    expect(produit!.cles).toContain(MARQUE);

    const personne = dict.find((d) => d.type === "PERSONNE" && d.id === employeId);
    expect(personne).toBeTruthy();
    // Le nom complet est LA clé — jamais le prénom seul : « ilyes » dans un texte ne désigne
    // personne en particulier, et un lien faux vaut moins que pas de lien.
    expect(personne!.cles).toEqual([`${N}ilyes ${N}benali`]);

    const labo = dict.find((d) => d.type === "ORGANISATION" && d.id === `lab:${LABO}`);
    expect(labo).toBeTruthy();
  });

  it("extraireMentions : frontières de MOTS strictes, occurrences comptées sur toutes les clés", () => {
    const entites = [
      { type: "PRODUIT" as const, id: "p1", label: "Truda", cles: [DCI, MARQUE] },
    ];
    // Deux clés du même produit dans le texte ⇒ UNE mention, occurrences cumulées.
    const deux = extraireMentions(`dossier ${DCI} et retour sur ${MARQUE}.`, entites);
    expect(deux).toEqual([{ type: "PRODUIT", id: "p1", label: "Truda", occurrences: 2 }]);
    // Au MILIEU d'un mot : pas une mention — la frontière n'est pas décorative.
    expect(extraireMentions(`abc${DCI}xyz sans rien`, entites)).toEqual([]);
    // En début et fin de texte, avec ponctuation : trouvé.
    expect(extraireMentions(`${MARQUE}, puis (${DCI})`, entites)[0]?.occurrences).toBe(2);
  });

  it("enregistrerMentions : remplacement TOTAL — une mention disparue du texte disparaît de la table", async () => {
    const nodeId = await creerNoeud(`${TAG}_v1.txt`);
    await prisma.driveTextIndex.create({
      data: { nodeId, versionId: "v1", text: "x", textFold: `note sur ${MARQUE} uniquement` },
    });
    await enregistrerMentions(nodeId, `note sur ${MARQUE} uniquement`);
    const avant = await prisma.entityMention.findMany({ where: { nodeId } });
    expect(avant.map((m) => m.entityId)).toEqual([produitId]);

    // Nouvelle version SANS la mention : un upsert seul laisserait le lien fantôme.
    await enregistrerMentions(nodeId, "note reecrite, plus aucun produit cite");
    expect(await prisma.entityMention.count({ where: { nodeId } })).toBe(0);
    // `mentionsAt` posé quand même : « extrait, rien trouvé » n'est pas « jamais extrait ».
    const idx = await prisma.driveTextIndex.findUnique({ where: { nodeId }, select: { mentionsAt: true } });
    expect(idx?.mentionsAt).not.toBeNull();
  });

  it("balayerMentions : le rattrapage draine `mentionsAt: null` — les fichiers d'AVANT l'extraction", async () => {
    const nodeId = await creerNoeud(`${TAG}_legacy.txt`);
    // Créé DIRECTEMENT (comme les index d'avant F4) : pas d'extraction, mentionsAt reste null.
    await prisma.driveTextIndex.create({
      data: { nodeId, versionId: "v1", text: "x", textFold: `ancien dossier ${DCI} jamais extrait` },
    });
    const r = await balayerMentions(40);
    expect(r.traites).toBeGreaterThanOrEqual(1);
    const idx = await prisma.driveTextIndex.findUnique({ where: { nodeId }, select: { mentionsAt: true } });
    expect(idx?.mentionsAt).not.toBeNull();
    const mentions = await prisma.entityMention.findMany({ where: { nodeId } });
    expect(mentions.map((m) => m.entityId)).toContain(produitId);
  });

  it("documentsLies : trié par occurrences — dix citations avant une citation d'annexe", async () => {
    const [beaucoup, peu] = await Promise.all([
      creerNoeud(`${TAG}_central.txt`), creerNoeud(`${TAG}_annexe1.txt`),
    ]);
    await prisma.driveTextIndex.create({ data: { nodeId: beaucoup, versionId: "v1", text: "x", textFold: `${DCI} ${DCI} ${DCI} partout` } });
    await prisma.driveTextIndex.create({ data: { nodeId: peu, versionId: "v1", text: "x", textFold: `une annexe cite ${MARQUE} une fois` } });
    await enregistrerMentions(beaucoup, `${DCI} ${DCI} ${DCI} partout`);
    await enregistrerMentions(peu, `une annexe cite ${MARQUE} une fois`);
    const lies = await documentsLies("PRODUIT", produitId, { limit: 50 });
    const pos = (id: string) => lies.findIndex((l) => l.nodeId === id);
    expect(pos(beaucoup)).toBeGreaterThanOrEqual(0);
    expect(pos(peu)).toBeGreaterThanOrEqual(0);
    expect(pos(beaucoup)).toBeLessThan(pos(peu));
  });

  it("resoudreEntitesDe : la requête qui NOMME l'entité la résout — exactement, jamais flou", async () => {
    const parDci = await resoudreEntitesDe(`tout ce qui concerne ${DCI} cette semaine`);
    expect(parDci.map((e) => e.id)).toContain(produitId);
    const parMarque = await resoudreEntitesDe(`le dossier ${MARQUE}, en urgence`);
    expect(parMarque.map((e) => e.id)).toContain(produitId);
    // Un fragment du nom n'est PAS le nom : pas de résolution partielle silencieuse.
    const fragment = await resoudreEntitesDe(`analyse ${DCI.slice(0, -3)} incomplete`);
    expect(fragment.map((e) => e.id)).not.toContain(produitId);
  });

  /**
   * ── LE TEST-VEDETTE : FRANCHISSEMENT D'ALIAS PAR LE VRAI POINT D'ENTRÉE (§14) ─────────
   *
   * Le document ne dit QUE la marque ; la recherche dit la DCI. Zéro terme commun — le
   * lexical ne peut pas le trouver, le sémantique n'a pas de vecteurs ici. S'il sort, c'est
   * par le SEUL chemin possible : ingestion réelle (`indexDriveNodeText`) → extraction →
   * `EntityMention` → `find_documents` (2-ter). Débrancher `enregistrerMentions` de
   * l'ingestion fait tomber ce test — c'est le SABOTAGE structurel de la tranche.
   */
  it("ALIAS — un document qui ne dit QUE la marque sort quand on cherche la DCI, confiance « ENTITÉ »", async () => {
    const nodeId = await creerNoeud(`${TAG}_scan_0091.pdf`);
    // Le VRAI point d'entrée de l'ingestion — pas un état injecté à la main.
    await indexDriveNodeText(nodeId, "v1", `Compte rendu de reunion : le lancement de ${MARQUE} est confirme au T3.`, null, `${TAG}_scan_0091.pdf`);

    const exec = userWith({ DRIVE: ["VIEW"] }, "DIRECTION", ownerId);
    const tool = POWER_TOOLS.find((t) => t.def.name === "find_documents")!;
    const out = JSON.parse(await tool.run({ query: DCI, max_reads: 0 }, exec));
    const hit = (out.resultats as { driveNodeId: string; confiance: string; entiteLiee?: string }[])
      .find((r) => r.driveNodeId === nodeId);
    expect(hit, "le document lié par l'entité doit sortir alors qu'il ne porte AUCUN terme de la requête").toBeTruthy();
    expect(hit!.confiance).toMatch(/^ENTITÉ \(lié à/);
    expect(hit!.entiteLiee).toBe(MARQUE);
  });

  it("ACL — le lien d'entité ne contourne pas les droits : sans accès au nœud, pas de résultat", async () => {
    // Même requête, mais un utilisateur dont le droit Drive est limité à SES fichiers
    // (scope OWN, pas propriétaire, aucun partage) : `resolveDriveAccess` rend NONE, et le
    // candidat sorti de la table `EntityMention` doit être écarté nœud par nœud.
    const etranger = await prisma.user.create({
      data: { name: `${TAG}x`, email: `${TAG}x@t.dz`, passwordHash: "x", role: "SALES_USER" },
    });
    try {
      const exec: CurrentUser = {
        id: etranger.id, name: "Étranger", email: `${TAG}x@t.dz`, role: "SALES_USER",
        access: {
          modules: new Map([["DRIVE", { module: "DRIVE" as Module, actions: new Set(["VIEW"] as Action[]), scope: "OWN" as const }]]),
          rowGrants: new Map(),
        } as unknown as EffectiveAccess,
        mustChangePassword: false,
      };
      const tool = POWER_TOOLS.find((t) => t.def.name === "find_documents")!;
      const out = JSON.parse(await tool.run({ query: DCI, max_reads: 0 }, exec));
      const ids = (out.resultats as { driveNodeId: string }[]).map((r) => r.driveNodeId);
      for (const n of noeuds) expect(ids).not.toContain(n);
    } finally {
      await prisma.user.delete({ where: { id: etranger.id } }).catch(() => {});
    }
  });

  /**
   * Le RATTRAPAGE a un appelant de production (§14 : une capacité sans appelant réel
   * n'existe pas). Son comportement est prouvé fonctionnellement ci-dessus ; ici on épingle
   * le BRANCHEMENT — dérouler le battement entier en test tirerait tout l'ERP pour vérifier
   * une ligne. Si quelqu'un retire l'appel du battement, ce test le dit.
   */
  it("SABOTAGE — balayerMentions est appelé par le battement (scheduled.ts), pas seulement par ses tests", () => {
    const src = readFileSync("src/lib/scheduled.ts", "utf8");
    expect(src).toMatch(/executer:\s*balayerMentions\b/); // une ligne de la table des tâches (V2-F)
    expect(src).toContain('from "@/lib/fabric"');
  });
});
