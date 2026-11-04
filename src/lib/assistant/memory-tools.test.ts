import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";
import { executePowerTool } from "./power-tools";
import { typedMemoryContext, expandQueryWithAliases } from "./memory-context";
import { createThread, appendExchange, searchOwnMessages, ensurePrimaryThread, getThreadMessages } from "@/lib/assistant-memory";

// I6 (décision 0070) : l'ancien moteur et ses fils (`AssistantThread`) se testent SOUS SON DRAPEAU — sans lui, ils sont
// gelés en lecture (moteur unique). Le drapeau est posé pour ce fichier seul, puis rendu.
const drapeauAncienMoteur = process.env.ADAM_ANCIEN_MOTEUR;
beforeAll(() => { process.env.ADAM_ANCIEN_MOTEUR = "1"; });
afterAll(() => { if (drapeauAncienMoteur === undefined) delete process.env.ADAM_ANCIEN_MOTEUR; else process.env.ADAM_ANCIEN_MOTEUR = drapeauAncienMoteur; });

/**
 * MÉMOIRE TYPÉE, DÉCISIONS, ENGAGEMENTS — l'aller-retour COMPLET contre la vraie base.
 *
 * On ne teste pas des mocks : on joue le chemin réel (outil → Prisma → relecture), y compris
 * l'expansion d'alias dans la recherche et le cloisonnement entre deux personnes.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__eaosb__${Date.now()}`;
let ceoId = "", otherId = "";

const asUser = (id: string, role: CurrentUser["role"]): CurrentUser => ({
  id, name: "T", email: `${id}@t.dz`, role,
  access: { modules: new Map(), rowGrants: new Map() } as unknown as EffectiveAccess,
  mustChangePassword: false,
});

suite("mémoire exécutive — aller-retour réel et cloisonnement", () => {
  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, passwordHash: "x", role: role as never } });
    const [c, o] = await Promise.all([mk("ceo", "DIRECTION"), mk("pm", "SALES_USER")]);
    ceoId = c.id; otherId = o.id;
  });

  afterAll(async () => {
    const users = [ceoId, otherId];
    await prisma.assistantMemoryItem.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await prisma.executiveDecision.deleteMany({ where: { ownerId: { in: users } } }).catch(() => {});
    await prisma.executiveCommitment.deleteMany({ where: { ownerId: { in: users } } }).catch(() => {});
    await prisma.assistantMessage.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await prisma.assistantThread.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("« retiens que pembro = Pembrolizumab » → contexte système + expansion de recherche", async () => {
    const ceo = asUser(ceoId, "DIRECTION");
    const r = await executePowerTool("remember", { alias: `${TAG}pembro`, target: "Pembrolizumab" }, ceo);
    expect(r).toContain("Pembrolizumab");

    // 1) Le contexte injecté au modèle porte l'alias… et le garde-fou « mémoire ≠ vérité ».
    const ctx = await typedMemoryContext(ceoId);
    expect(ctx).toContain(`${TAG}pembro = Pembrolizumab`);
    expect(ctx).toMatch(/JAMAIS la source de vérité/i);

    // 2) La recherche fédérée s'en sert : la requête est enrichie de la cible.
    const exp = await expandQueryWithAliases(ceoId, `où en est ${TAG}pembro ?`);
    expect(exp.query).toContain("Pembrolizumab");
    expect(exp.expansions).toHaveLength(1);

    // 3) …mais UNIQUEMENT pour son propriétaire.
    const other = await expandQueryWithAliases(otherId, `où en est ${TAG}pembro ?`);
    expect(other.expansions).toHaveLength(0);
  });

  it("re-retenir le même alias MET À JOUR au lieu de dupliquer ; « oublie » l'éteint", async () => {
    const ceo = asUser(ceoId, "DIRECTION");
    await executePowerTool("remember", { alias: `${TAG}pembro`, target: "Pembrolizumab (Keytruda)" }, ceo);
    const actives = await prisma.assistantMemoryItem.findMany({
      where: { userId: ceoId, active: true, content: { contains: `${TAG}pembro` } },
    });
    expect(actives).toHaveLength(1); // mis à jour, PAS dupliqué
    expect(actives[0].content).toContain("Keytruda");

    const gone = await executePowerTool("forget_memory", { reference: `${TAG}pembro` }, ceo);
    expect(gone).toContain("oublie");
    const exp = await expandQueryWithAliases(ceoId, `état de ${TAG}pembro`);
    expect(exp.expansions).toHaveLength(0); // l'alias éteint ne s'applique plus
  });

  it("list_memories ne montre JAMAIS la mémoire d'autrui", async () => {
    const ceo = asUser(ceoId, "DIRECTION");
    await executePowerTool("remember", { content: `${TAG} préfère les synthèses en trois points`, type: "REPORTING_PREFERENCE" }, ceo);

    const theirs = await executePowerTool("list_memories", {}, asUser(otherId, "SALES_USER"));
    expect(theirs).not.toContain(`${TAG} préfère`);

    const mine = await executePowerTool("list_memories", {}, ceo);
    expect(mine).toContain(`${TAG} préfère`);
  });

  it("décision : enregistrée, retrouvée par mots-clés, résultat consigné plus tard", async () => {
    const ceo = asUser(ceoId, "DIRECTION");
    const rec = await executePowerTool("record_decision", {
      title: `${TAG} Fournisseur B retenu pour les seringues`,
      problem: "Rupture récurrente chez le fournisseur A",
      options: ["Rester chez A", "Passer chez B", "Double sourcing"],
      decision: "Passer chez B dès le prochain appel d'offres",
      expected_outcome: "Zéro rupture sur 6 mois",
      review_on: "2027-01-15",
    }, ceo);
    expect(rec).toContain("n'exécute jamais");

    const found = await executePowerTool("list_decisions", { query: `${TAG} seringues` }, ceo);
    expect(found).toContain("Fournisseur B");
    expect(found).toContain("Double sourcing"); // les options écartées restent lisibles

    const upd = await executePowerTool("update_decision_outcome", {
      reference: `${TAG} Fournisseur B`,
      actual_outcome: "Une rupture en janvier — moins bien qu'attendu",
      lessons_learned: "Prévoir un stock tampon au changement de fournisseur",
    }, ceo);
    expect(upd).toContain("REVIEWED");

    const row = await prisma.executiveDecision.findFirst({ where: { ownerId: ceoId, title: { contains: `${TAG} Fournisseur B` } } });
    expect(row?.status).toBe("REVIEWED");
    expect(row?.actualOutcome).toContain("janvier");
    expect(row?.expectedOutcome).toContain("Zéro rupture"); // l'attendu N'EST PAS écrasé par le réel
  });

  it("le registre des décisions est fermé aux comptes non exécutifs — même en appel direct", async () => {
    const r = await executePowerTool("record_decision", { title: "forcé" }, asUser(otherId, "SALES_USER"));
    expect(r).toMatch(/ne vous est pas ouvert/i);
    expect(await prisma.executiveDecision.count({ where: { ownerId: otherId } })).toBe(0);
  });

  it("engagement : en retard il se VOIT (overdue_only), clos il porte sa preuve — sans aucune relance", async () => {
    const ceo = asUser(ceoId, "DIRECTION");
    const rec = await executePowerTool("record_commitment", {
      who: `${TAG} Fournisseur X`, what: "Livrer 500 boîtes", due_on: "2026-01-15",
      source: "E-mail du 3 janvier",
    }, ceo);
    expect(rec).toMatch(/aucune relance automatique/i);

    const late = await executePowerTool("list_commitments", { overdue_only: true }, ceo);
    expect(late).toContain(`${TAG} Fournisseur X`);
    expect(late).toContain('"enRetard":true');

    const closed = await executePowerTool("close_commitment", {
      reference: `${TAG} Fournisseur X`, outcome: "BROKEN", evidence: "Aucune livraison au 24 août",
    }, ceo);
    expect(closed).toContain("non tenu");

    const still = await executePowerTool("list_commitments", { overdue_only: true }, ceo);
    expect(still).not.toContain(`${TAG} Fournisseur X`); // clos = sorti des retards
  });

  it("recall_conversation ne fouille QUE ses propres archives ; le fil principal est unique et plafonné", async () => {
    const t = await createThread(ceoId, `${TAG} sujet insuline`);
    await appendExchange(ceoId, t, `${TAG} parlons du marché insuline en Algérie`, "Voici l'état du marché…");

    const mine = await searchOwnMessages(ceoId, `${TAG} parlons du marché insuline`);
    expect(mine.length).toBeGreaterThan(0);
    expect(await searchOwnMessages(otherId, `${TAG} parlons du marché insuline`)).toHaveLength(0);

    // Fil principal : deux appels rendent LE MÊME fil (pas de « chat n°47 »).
    const p1 = await ensurePrimaryThread(ceoId);
    const p2 = await ensurePrimaryThread(ceoId);
    expect(p1).toBe(p2);

    // Plafond : on ne recharge jamais tout — les `limit` DERNIERS messages seulement.
    for (let i = 0; i < 4; i++) await appendExchange(ceoId, p1, `q${i}`, `r${i}`);
    const capped = await getThreadMessages(ceoId, p1, 4);
    expect(capped).toHaveLength(4);
    expect(capped![3].content).toBe("r3"); // les plus RÉCENTS, dans l'ordre chronologique
  });
});
