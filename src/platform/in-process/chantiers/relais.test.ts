import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET, POST } from "@/app/api/dev/relais/ordres/route";
import { interpreter, jetonRelaisValide, lireAuthStatus, lireSortieCreation } from "@/platform/dev/relais";
import { creerAgentDeveloppeur } from "./agent-routines";
import { enfilerOrdre, rendreOrdre, tirerOrdre } from "./relais";

/**
 * LE RELAIS CLAUDE CODE (lot C2, décision 0041 § 3 bis) : lecture des sorties de la CLI (documentées le 01/11/2026),
 * file d'ordres idempotente, tirage atomique, balayage, route protégée par le jeton du relais.
 */

const JETON = "relais-de-test-0123456789abcdefghijkl";
const uniq = () => `test-relais-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ETAT = { version: "2.1.300 (Claude Code)", authStatus: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), authCode: 0 };

afterAll(async () => {
  await prisma.claudeRelaisOrdre.deleteMany({ where: { cleIdempotence: { startsWith: "test-relais-" } } });
  await prisma.claudeRelaisEtat.deleteMany({ where: { id: "relais" } });
});

/** Vide la file des ordres d'autres tests encore en attente, pour que le tirage prenne le nôtre. */
const viderFile = () => prisma.claudeRelaisOrdre.updateMany({ where: { statut: { in: ["EN_ATTENTE", "EN_COURS"] } }, data: { statut: "ECHEC" } });

describe("lecture des sorties de la CLI", () => {
  it("MESSAGE : le JSON documenté {ok, session_id, url} / {ok:false, error} ; erreur de configuration sur stderr", () => {
    const ok = interpreter("MESSAGE", { id: "o", code: 0, stdout: '{"ok":true,"session_id":"session_01ABCDEFGH","url":"https://claude.ai/code/session_01ABCDEFGH"}\n', stderr: "", delaiDepasse: false });
    expect(ok).toEqual({ statut: "FAIT", sessionId: "session_01ABCDEFGH", url: "https://claude.ai/code/session_01ABCDEFGH", erreur: null });
    const archivee = interpreter("MESSAGE", { id: "o", code: 1, stdout: '{"ok":false,"session_id":"session_01ABCDEFGH","error":"cloud session session_01ABCDEFGH is archived and cannot accept new messages"}', stderr: "", delaiDepasse: false });
    expect(archivee).toMatchObject({ statut: "ECHEC", erreur: expect.stringContaining("archived") });
    const politique = interpreter("MESSAGE", { id: "o", code: 1, stdout: "", stderr: "Error: Cloud sessions are disabled by your organization's policy.", delaiDepasse: false });
    expect(politique).toMatchObject({ statut: "ECHEC", erreur: expect.stringContaining("disabled") });
  });

  it("CREER : l'identifiant lu dans la sortie texte ; sans identifiant ou délai dépassé → INCERTAIN ; git en échec → ECHEC", () => {
    expect(lireSortieCreation("Cloning…\nView: https://claude.ai/code/session_01DiUkqY2kzbUbDmW1w96rfi?from=cli&m=0")).toEqual({ sessionId: "session_01DiUkqY2kzbUbDmW1w96rfi", url: "https://claude.ai/code/session_01DiUkqY2kzbUbDmW1w96rfi" });
    expect(interpreter("CREER", { id: "o", code: 0, stdout: "Session ID: session_01DiUkqY2kzbUbDmW1w96rfi", stderr: "", delaiDepasse: false })).toMatchObject({ statut: "FAIT" });
    expect(interpreter("CREER", { id: "o", code: 0, stdout: "terminé", stderr: "", delaiDepasse: false })).toMatchObject({ statut: "INCERTAIN" });
    expect(interpreter("CREER", { id: "o", code: null, stdout: "", stderr: "", delaiDepasse: true })).toMatchObject({ statut: "INCERTAIN" });
    expect(interpreter("CREER", { id: "o", code: 1, stdout: "", stderr: "", delaiDepasse: false, avantClaude: "git push : refusé" })).toMatchObject({ statut: "ECHEC" });
  });

  it("claude auth status : connecté seulement par claude.ai (code 0) ; jeton du relais en temps constant", () => {
    expect(lireAuthStatus(JSON.stringify({ authMethod: "claude.ai" }), 0)).toEqual({ authMethod: "claude.ai", connecte: true });
    expect(lireAuthStatus(JSON.stringify({ authMethod: "api_key" }), 0)).toEqual({ authMethod: "api_key", connecte: false });
    expect(lireAuthStatus(JSON.stringify({ authMethod: "none" }), 1)).toEqual({ authMethod: "none", connecte: false });
    expect(jetonRelaisValide(`Bearer ${JETON}`, JETON)).toBe(true);
    expect(jetonRelaisValide(`Bearer ${JETON}x`, JETON)).toBe(false);
    expect(jetonRelaisValide(`Bearer court`, "court")).toBe(false);
    expect(jetonRelaisValide(null, JETON)).toBe(false);
  });
});

describe("la file d'ordres", () => {
  it("même clé = un seul ordre ; tirage atomique ; conclusion unique ; texte effacé", async () => {
    await viderFile();
    const cle = uniq();
    const a = await enfilerOrdre({ type: "MESSAGE", cleIdempotence: cle, texte: "reprends le test X", sessionCible: "session_01ABCDEFGH" });
    const b = await enfilerOrdre({ type: "MESSAGE", cleIdempotence: cle, texte: "reprends le test X", sessionCible: "session_01ABCDEFGH" });
    expect([a.deja, b.deja, b.ordreId]).toEqual([false, true, a.ordreId]);
    const [t1, t2] = await Promise.all([tirerOrdre(ETAT), tirerOrdre(ETAT)]);
    expect([t1, t2].filter(Boolean)).toHaveLength(1);
    expect((t1 ?? t2)).toMatchObject({ id: a.ordreId, type: "MESSAGE", sessionId: "session_01ABCDEFGH", texte: "reprends le test X" });
    const sortie = { id: a.ordreId, code: 0, stdout: '{"ok":true,"session_id":"session_01ABCDEFGH","url":"https://claude.ai/code/session_01ABCDEFGH"}', stderr: "", delaiDepasse: false };
    expect(await rendreOrdre(sortie)).toMatchObject({ statut: "FAIT", sessionId: "session_01ABCDEFGH" });
    expect(await rendreOrdre(sortie)).toBeNull();
    expect((await prisma.claudeRelaisOrdre.findUnique({ where: { id: a.ordreId } }))?.texte).toBe("");
    expect(await prisma.claudeRelaisEtat.findUnique({ where: { id: "relais" } })).toMatchObject({ authMethod: "claude.ai", connecte: true });
  });

  it("balayage : EN_COURS sans résultat → INCERTAIN (clé bloquée) ; jamais tiré → ECHEC (clé re-lançable)", async () => {
    await viderFile();
    const enCours = await enfilerOrdre({ type: "MESSAGE", cleIdempotence: uniq(), texte: "x", sessionCible: "session_01ABCDEFGH" });
    await tirerOrdre(ETAT);
    const cleVieille = uniq();
    const vieux = await enfilerOrdre({ type: "MESSAGE", cleIdempotence: cleVieille, texte: "y", sessionCible: "session_01ABCDEFGH" }, new Date(Date.now() - 2 * 3_600_000));
    await prisma.claudeRelaisOrdre.update({ where: { id: enCours.ordreId }, data: { prisLe: new Date(Date.now() - 3_600_000) } });
    await tirerOrdre(ETAT);
    const [l1, l2] = await Promise.all([prisma.claudeRelaisOrdre.findUnique({ where: { id: enCours.ordreId } }), prisma.claudeRelaisOrdre.findUnique({ where: { id: vieux.ordreId } })]);
    expect([l1?.statut, l2?.statut]).toEqual(["INCERTAIN", "ECHEC"]);
    expect(await enfilerOrdre({ type: "MESSAGE", cleIdempotence: cleVieille, texte: "y", sessionCible: "session_01ABCDEFGH" })).toMatchObject({ deja: false, statut: "EN_ATTENTE" });
  });

  it("l'agent refuse sans jeton, ou relais hors ligne ; enfile quand le relais est vu", async () => {
    await viderFile();
    expect(await creerAgentDeveloppeur({ env: {} }).envoyerMessage({ sessionId: "session_01ABCDEFGH", texte: "x", cleIdempotence: uniq() })).toMatchObject({ ok: false, erreur: { code: "NON_CONFIGURE" } });
    const agent = creerAgentDeveloppeur({ env: { CLAUDE_RELAIS_TOKEN: JETON } });
    await prisma.claudeRelaisEtat.upsert({ where: { id: "relais" }, create: { id: "relais", vuLe: new Date(Date.now() - 600_000) }, update: { vuLe: new Date(Date.now() - 600_000) } });
    expect(await agent.lancerParCli({ depot: "adventum/banc", branche: "claude/x", texte: "x", cleIdempotence: uniq() })).toMatchObject({ ok: false, erreur: { code: "INDISPONIBLE" } });
    expect(await agent.envoyerMessage({ sessionId: "pas-une-session", texte: "x", cleIdempotence: uniq() })).toMatchObject({ ok: false, erreur: { code: "INVALIDE" } });
    await tirerOrdre(ETAT);
    const r = await agent.lancerParCli({ depot: "adventum/banc", branche: "claude/x", texte: "x", cleIdempotence: uniq() });
    expect(r).toMatchObject({ ok: true, valeur: { type: "CREER", statut: "EN_ATTENTE", deja: false } });
    expect(await agent.relais()).toMatchObject({ configure: true, vivant: true, connecte: true });
  });
});

describe("la route du relais", () => {
  it("503 sans jeton posé, 401 jeton faux ; tirage puis rendu → fait DEV_SESSION au registre", async () => {
    await viderFile();
    const avant = process.env.CLAUDE_RELAIS_TOKEN;
    const url = "http://local/api/dev/relais/ordres";
    try {
      delete process.env.CLAUDE_RELAIS_TOKEN;
      expect((await GET(new Request(url, { headers: { authorization: `Bearer ${JETON}` } }))).status).toBe(503);
      process.env.CLAUDE_RELAIS_TOKEN = JETON;
      expect((await GET(new Request(url, { headers: { authorization: "Bearer faux-faux-faux-faux-faux-faux" } }))).status).toBe(401);
      const o = await enfilerOrdre({ type: "MESSAGE", cleIdempotence: uniq(), texte: "corrige", sessionCible: "session_01ROUTETEST", missionId: null });
      const tire = await GET(new Request(`${url}?version=2.1.300&authCode=0&authStatus=${encodeURIComponent(ETAT.authStatus)}`, { headers: { authorization: `Bearer ${JETON}` } }));
      expect(await tire.json()).toMatchObject({ ordre: { id: o.ordreId, type: "MESSAGE" } });
      const rendu = await POST(new Request(url, { method: "POST", headers: { authorization: `Bearer ${JETON}` }, body: JSON.stringify({ id: o.ordreId, code: 0, stdout: '{"ok":true,"session_id":"session_01ROUTETEST","url":"https://claude.ai/code/session_01ROUTETEST"}', stderr: "", delaiDepasse: false }) }));
      expect(await rendu.json()).toEqual({ ok: true, conclu: true });
    } finally {
      if (avant === undefined) delete process.env.CLAUDE_RELAIS_TOKEN; else process.env.CLAUDE_RELAIS_TOKEN = avant;
    }
    const evt = await prisma.businessEvent.findFirst({ where: { type: "DEV_SESSION", relatedRefs: { has: "SESSION:session_01ROUTETEST" } }, orderBy: { createdAt: "desc" } });
    expect(evt).toMatchObject({ sourceDomain: "DEV" });
    await prisma.businessEvent.deleteMany({ where: { type: "DEV_SESSION", relatedRefs: { has: "SESSION:session_01ROUTETEST" } } });
  });
});
