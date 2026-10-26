import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, peutVoirAdam, REFUS_ADAM, type SessionUser } from "@/lib/rbac";
import { executeAssistantAction, assistantChat } from "@/lib/actions/assistant-actions";
import { setAdamMailPolicy } from "@/lib/actions/adam-settings-actions";
import { agirSurCarte } from "@/platform/in-process/inbox/actions";
import { getCommunicationPolicy } from "@/lib/comms/policy";
import { lireArguments, sansCommentaires } from "@/lib/actions/contrat";
import { CONTRATS_ACTIONS } from "@/lib/actions/contrat.genere";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADAM N'EST VISIBLE QUE DU SUPER ADMIN (§118.153) — par les VRAIS points d'entrée.
 *
 * Décision de la Direction (09/2026) : « Adam ne doit être visible par personne sauf le super
 * admin ; Adam en tant que chief of staff est en pause de développement. » Adam n'est pas UNE
 * page : c'est un menu, deux pages, un bureau et ses sous-pages, deux routes d'API, la voix, le
 * brief du matin, des boutons « demander au Chief » posés sur des fiches de l'ERP, un onglet de
 * la barre mobile, et une quinzaine d'actions serveur. Masquer l'écran et laisser une action
 * serveur ouverte ferait une porte fermée à côté d'une porte ouverte (§118.71) : une action
 * serveur est un point d'entrée public, appelable sans passer par l'écran.
 *
 * Les acteurs sans vue sont la DIRECTION — le cas qui trompe, parce qu'elle voit TOUT le reste
 * de l'ERP et portait le module CHIEF_OF_STAFF. Une garde éprouvée avec un délégué passerait au
 * vert pour la mauvaise raison (il n'avait déjà pas le module, §118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const lire = (chemin: string) => readFileSync(join(process.cwd(), chemin), "utf8");
/** Le corps de chaque `export async function` d'un fichier, commentaires retirés (§118.79d). */
function corpsExportes(source: string): Map<string, string> {
  const code = sansCommentaires(source);
  const out = new Map<string, string>();
  const re = /^export async function (\w+)\s*\(/gm;
  const debuts = [...code.matchAll(re)].map((m) => ({ nom: m[1]!, i: m.index! }));
  debuts.forEach((d, k) => out.set(d.nom, code.slice(d.i, k + 1 < debuts.length ? debuts[k + 1]!.i : code.length)));
  return out;
}

describe("peutVoirAdam — le rôle PRINCIPAL de Super Admin, et lui seul", () => {
  it("Super Admin oui ; Direction, Directeur Général, délégué non", () => {
    expect(peutVoirAdam({ role: "SUPER_ADMIN" })).toBe(true);
    expect(peutVoirAdam({ role: "DIRECTION" })).toBe(false);
    expect(peutVoirAdam({ role: "GENERAL_MANAGER" })).toBe(false);
    expect(peutVoirAdam({ role: "MEDICAL_DELEGATE" })).toBe(false);
  });

  it("une casquette SECONDAIRE de Super Admin ne suffit pas — voir Adam ne se prête pas", () => {
    expect(peutVoirAdam({ role: "DIRECTION", secondaryRole: "SUPER_ADMIN" })).toBe(false);
  });
});

describe("les portes d'Adam lisent la règle (points d'appel, §118.49)", () => {
  it("les deux pages et le SEGMENT du bureau refusent avant tout chargement", () => {
    const assistant = sansCommentaires(lire("src/app/(app)/assistant/page.tsx"));
    const garde = assistant.indexOf("if (!peutVoirAdam(user)) notFound();");
    expect(garde, "/assistant doit refuser qui ne voit pas Adam").toBeGreaterThan(0);
    // `/assistant` ne charge plus de brief : il mène au bureau d'Adam. La garde passe AVANT la redirection —
    // sinon un compte refusé apprendrait par la redirection où vit l'assistant (audit 2026-10-24, R3).
    expect(garde, "la garde passe AVANT la redirection").toBeLessThan(assistant.indexOf("redirect("));
    expect(sansCommentaires(lire("src/app/(app)/chief-of-staff/page.tsx"))).toContain("if (!peutVoirAdam(user)) notFound();");
    // Le SEGMENT passe par la porte du PONT (la règle lue en direct coûtait deux franchissements
    // de frontière) : on exige l'APPEL dans le gabarit ET la garde dans la porte — vérifier l'un
    // sans l'autre ne prouverait rien (§118.49).
    const gabarit = sansCommentaires(lire("src/app/(app)/chief-of-staff/layout.tsx"));
    expect(gabarit.indexOf("await exigerAdamVisible();"), "le gabarit appelle la porte AVANT de rendre").toBeGreaterThan(0);
    expect(gabarit.indexOf("await exigerAdamVisible();")).toBeLessThan(gabarit.indexOf("{children}"));
    const porte = sansCommentaires(lire("src/platform/in-process/visibilite-adam.ts"));
    expect(porte).toMatch(/export async function exigerAdamVisible\(\) \{\s*const user = await requireUser\(\);\s*if \(!peutVoirAdam\(user\)\) notFound\(\);/);
  });

  it("les routes d'API de la conversation et de la dictée répondent 403", () => {
    for (const f of ["src/app/api/assistant/stream/route.ts", "src/app/api/assistant/transcribe/route.ts"]) {
      expect(sansCommentaires(lire(f)), f).toMatch(/!peutVoirAdam\(user\)\)\s*return[^;]*status: 403/);
    }
  });

  it("le brief du matin n'est composé — donc payé — que pour qui voit Adam", () => {
    expect(sansCommentaires(lire("src/app/(app)/aujourdhui/page.tsx"))).toContain("proactive && peutVoirAdam(user) ? await getDailyBrief(user)");
  });

  it("tout écran de l'ERP qui pose « Demander au Chief » le conditionne à la règle", () => {
    const racine = join(process.cwd(), "src");
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const n of readdirSync(d)) {
        const c = join(d, n);
        if (statSync(c).isDirectory()) parcourir(c);
        else if (n.endsWith(".tsx") && !n.endsWith(".test.tsx")) fichiers.push(c);
      }
    };
    parcourir(racine);
    const poseurs = fichiers.filter((f) => !f.endsWith("ask-chief.tsx") && sansCommentaires(readFileSync(f, "utf8")).includes("<AskChief"));
    // PLANCHER : sans poseur trouvé, le cas serait vert sans rien garder (§118.17).
    expect(poseurs.length).toBeGreaterThanOrEqual(2);
    for (const f of poseurs) expect(sansCommentaires(readFileSync(f, "utf8")), f).toContain("peutVoirAdam(user) &&");
  });

  it("CHAQUE action serveur de la conversation lit la règle — sauf les gestes qui RÉDUISENT, nommés", () => {
    // Annuler une carte, supprimer un fil, effacer sa mémoire : ils ne font que retirer ce qui
    // appartient déjà à la personne (§118.15), et leur seul écran est déjà fermé. Les fermer
    // aussi retiendrait des données qu'elle ne pourrait plus effacer.
    const REDUCTEURS = new Set(["cancelAssistantAction", "deleteMyAssistantThread", "forgetMyAssistantMemory"]);
    const corps = corpsExportes(lire("src/lib/actions/assistant-actions.ts"));
    expect(corps.size, "PLANCHER : le découpage doit trouver les actions").toBeGreaterThanOrEqual(10);
    const sansGarde = [...corps].filter(([, c]) => !c.includes("peutVoirAdam(user)")).map(([n]) => n).sort();
    expect(sansGarde).toEqual([...REDUCTEURS].sort());
  });

  it("les réglages d'Adam et sa boîte de décision exigent la même règle", () => {
    const reglages = sansCommentaires(lire("src/lib/actions/adam-settings-actions.ts"));
    const garde = reglages.slice(reglages.indexOf("async function requireChief"), reglages.indexOf("export async function setAdamMailPolicy"));
    expect(garde).toContain("if (!peutVoirAdam(user)) return { error: REFUS_ADAM, user: null };");
    expect(reglages, "l'ancienne porte (vue globale) ne doit pas survivre à côté").not.toContain("hasGlobalView");
    const boite = sansCommentaires(lire("src/platform/in-process/inbox/actions.ts"));
    const i = boite.indexOf("if (!peutVoirAdam(user)) return { ok: false, message: REFUS_ADAM };");
    expect(i).toBeGreaterThan(0);
    expect(i, "la règle passe AVANT tout geste").toBeLessThan(boite.indexOf("estGesteValide(geste)"));
  });
});

describe("aucune action serveur ne reçoit l'identité de son acteur en argument", () => {
  it("PRÉMISSE : la dérivation des contrats reconnaît ce cas — sinon le cliquet est désarmé", () => {
    const l = lireArguments("userId: string, texte: string");
    expect("refus" in l ? l.refus : "").toMatch(/identité de l'ACTEUR/);
  });

  it("zéro dans le parc — `rememberExchange` a quitté le fichier « use server »", () => {
    const fautives = CONTRATS_ACTIONS.filter((c) => /identité de l'ACTEUR/.test(c.illisible ?? "")).map((c) => c.id);
    expect(fautives).toEqual([]);
    const module = lire("src/lib/memoire-echange.ts");
    expect(module.trimStart().startsWith('"use server"'), "l'écriture d'un échange n'est PAS une action serveur").toBe(false);
    expect(module).toContain("export async function rememberExchange(");
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__adamvis__";
async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/** Une opération qui n'existe pas : si la garde laisse passer, la réponse le DIT, sans effet. */
const OP_FANTOME = { kind: "domain_op", tool: "__inexistant__", op: "rien", args: {}, opLabel: "rien" } as never;

suite("les actions serveur d'Adam, appelées sans passer par l'écran", () => {
  const u: Record<string, string> = {};

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
    u.dir = (await prisma.user.create({ data: { name: `${TAG} dir`, email: `${TAG}dir@t.dz`, role: "DIRECTION", passwordHash: "x" } })).id;
    u.sa = (await prisma.user.create({ data: { name: `${TAG} sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  });

  it("exécuter une carte : refusé à la Direction, la garde laisse passer le Super Admin", async () => {
    ACTOR = await acteur(u.dir, "DIRECTION");
    expect(await executeAssistantAction(OP_FANTOME)).toEqual({ ok: false, error: REFUS_ADAM });
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    const sa = await executeAssistantAction(OP_FANTOME);
    expect(sa.ok).toBe(false);
    expect(sa.error, "le Super Admin atteint l'exécuteur, qui refuse l'opération fantôme").toMatch(/Opération inconnue/);
  });

  it("la conversation : refusée à la Direction AVANT tout appel de modèle", async () => {
    ACTOR = await acteur(u.dir, "DIRECTION");
    const r = await assistantChat([{ role: "user", content: "Bonjour" }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(REFUS_ADAM);
  });

  it("la boîte de décision : refusée à la Direction ; le Super Admin atteint la validation du geste", async () => {
    ACTOR = await acteur(u.dir, "DIRECTION");
    expect(await agirSurCarte({ kind: "__inconnu__" } as never)).toEqual({ ok: false, message: REFUS_ADAM });
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    expect((await agirSurCarte({ kind: "__inconnu__" } as never)).message).toMatch(/Geste inconnu/);
  });

  it("les réglages : refusés à la Direction ; le Super Admin passe (politique INCHANGÉE — rien n'est écrit)", async () => {
    const actuelle = (await getCommunicationPolicy()).mailSendPolicy;
    ACTOR = await acteur(u.dir, "DIRECTION");
    expect(await setAdamMailPolicy(actuelle)).toEqual({ ok: false, error: REFUS_ADAM });
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    expect(await setAdamMailPolicy(actuelle)).toEqual({ ok: true });
    expect((await getCommunicationPolicy()).mailSendPolicy).toBe(actuelle);
  });
});
