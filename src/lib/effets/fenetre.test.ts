// EN PREMIER, comme le worker : le contexte asynchrone de Next, réel hors de son serveur.
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { personneDuGeste } from "@/lib/contexte-geste";
import type { CurrentUser } from "@/lib/session";
import { sendSmartEmail } from "@/lib/mail-smart";
import { sendPushToUser } from "@/lib/push";
import { journaliserGeste } from "./journal";
import { annulerGeste, planDAnnulation } from "./annulation";
import { retablirGeste } from "./retablissement";
import { gesteReversible, gestesRecents } from "./ecran";
import {
  annulerEffetSortant, borneFenetre, deCharge, delaiFenetre, differerEffetSortant, enCharge, enregistrerExecuteur,
  executerEffetsSortantsDus, FENETRE_DEFAUT_SECONDES, retablirEffetSortant,
} from "./fenetre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FENÊTRE D'ANNULATION DES EFFETS SORTANTS (K10b, décision 0035) — contre la base locale, aucun `vi.mock`.
 *
 * Un courriel envoyé sous un geste réversible n'est PAS parti : il attend sa fenêtre. Annulé dedans, rien ne sort
 * (`fetch` espionné : zéro appel). La fenêtre passée, le worker l'exécute une seule fois ; annulé ensuite, il est
 * COMPENSÉ par un rectificatif — lui-même différé, donc annulable. Une annulation se rétablit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__fen__${Date.now()}`;
let moi: CurrentUser;
let autre: CurrentUser;
const partis: unknown[] = [];

const courriel = (sujet: string) => sendSmartEmail({ to: [`dest-${TAG}@exemple.dz`], subject: `${TAG} ${sujet}`, text: "corps" });
const ligneDe = (id: string) => prisma.effetSortantDiffere.findUniqueOrThrow({ where: { id } });
const envoisDuGeste = (gesteId: string) => prisma.effetSortantDiffere.findMany({ where: { gesteId } });
const plusTard = () => new Date(Date.now() + 3_600_000);

suite("la fenêtre d'annulation des effets sortants (K10b)", () => {
  beforeAll(async () => {
    const a = await prisma.user.create({ data: { name: `${TAG}Moi`, email: `${TAG}m@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } });
    const b = await prisma.user.create({ data: { name: `${TAG}Autre`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } });
    moi = (await personneDuGeste(a.id))!;
    autre = (await personneDuGeste(b.id))!;
    // Le transport de test : on compte ce qui « part », sans réseau.
    enregistrerExecuteur("courriel.api", {
      executer: async (c) => { partis.push(c); },
      compensation: async (c, _l, motif) => ({ charge: { ...(c as object), subject: `Rectificatif ${motif ?? ""}` }, phrase: "un rectificatif part au destinataire", apercu: "rectificatif" }),
    });
    enregistrerExecuteur("push", { executer: async (c) => { partis.push(c); }, sansCompensation: "la notification poussée s'est affichée" });
  });
  afterAll(async () => {
    const ids = [moi?.id, autre?.id].filter(Boolean) as string[];
    await prisma.effetSortantDiffere.deleteMany({ where: { principalId: { in: ids } } });
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("la charge garde les octets et les dates ; le délai est borné et vaut 120 s par défaut", async () => {
    const c = enCharge({ pj: Buffer.from("PDF"), d: new Date("2026-10-31T10:00:00Z"), x: undefined });
    expect(JSON.parse(JSON.stringify(c))).toEqual({ pj: { $octets64: Buffer.from("PDF").toString("base64") }, d: "2026-10-31T10:00:00.000Z" });
    expect((deCharge<{ pj: Buffer }>(c).pj).toString()).toBe("PDF");
    expect(borneFenetre(0)).toBe(10);
    expect(borneFenetre(99_999)).toBe(900);
    expect(FENETRE_DEFAUT_SECONDES).toBe(120);
    expect(await delaiFenetre()).toBeGreaterThanOrEqual(10);
  });

  it("sous un geste réversible, le courriel ATTEND : rien ne sort, la ligne est liée au geste et au journal", async () => {
    const fetchEspion = vi.spyOn(globalThis, "fetch");
    const { resultat, gesteId } = await journaliserGeste(moi, { origine: "ecran", libelle: "envoi" }, () => courriel("attend"));
    expect(resultat.ok).toBe(true);
    expect(resultat.providerId).toMatch(/^differe:/);
    expect(fetchEspion).not.toHaveBeenCalled();
    fetchEspion.mockRestore();
    const [l] = await envoisDuGeste(gesteId!);
    expect(l).toMatchObject({ statut: "EN_ATTENTE", acte: "COURRIEL", type: "courriel.api", principalId: moi.id });
    expect(l!.executeLe.getTime()).toBeGreaterThan(Date.now() + 5_000);
    const effet = await prisma.assistantEffet.findFirstOrThrow({ where: { gesteId: gesteId!, type: "EXTERNE" } });
    expect(effet.effetSortantId).toBe(l!.id);
    // Le plan le dit AVANT le clic : il ne partira pas.
    const plan = await planDAnnulation(gesteId!, moi);
    expect("refus" in plan ? null : plan.details[0]?.issue).toBe("ANNULE");
  });

  it("annulé dans la fenêtre : RIEN n'est parti, l'audit le garde, le worker ne l'envoie jamais", async () => {
    const { gesteId } = await journaliserGeste(moi, { origine: "ecran", libelle: "envoi annulé" }, () => courriel("annule"));
    const r = await annulerGeste(gesteId!, moi);
    if ("refus" in r) throw new Error(r.refus);
    expect(r.details.map((d) => d.issue)).toEqual(["ANNULE"]);
    expect(r.details[0]!.pourquoi).toMatch(/rien n'est parti/);
    const [l] = await envoisDuGeste(gesteId!);
    expect(l).toMatchObject({ statut: "ANNULE", annuleParId: moi.id });
    const avant = partis.length;
    await executerEffetsSortantsDus({ maintenant: plusTard(), ids: [l!.id] });
    expect(partis.length).toBe(avant);
    expect(await prisma.auditLog.count({ where: { actorId: moi.id, entityId: l!.id, summary: { contains: "rien n'est parti" } } })).toBe(1);
  });

  it("une annulation se RÉTABLIT : l'envoi repart pour une fenêtre neuve, et se ré-annule", async () => {
    const { gesteId } = await journaliserGeste(moi, { origine: "ecran", libelle: "envoi rétabli" }, () => courriel("retabli"));
    await annulerGeste(gesteId!, moi);
    const re = await retablirGeste(gesteId!, moi);
    if ("refus" in re) throw new Error(re.refus);
    expect(re.details.map((d) => d.issue)).toEqual(["ANNULE"]);
    const [l] = await envoisDuGeste(gesteId!);
    expect(l!.statut).toBe("EN_ATTENTE");
    expect(l!.executeLe.getTime()).toBeGreaterThan(Date.now() + 5_000);
    const encore = await annulerGeste(gesteId!, moi);
    expect("refus" in encore ? encore.refus : encore.details[0]!.issue).toBe("ANNULE");
    expect((await ligneDe(l!.id)).statut).toBe("ANNULE");
  });

  it("la fenêtre passée, le worker l'envoie UNE fois ; annulé après : COMPENSÉ par un rectificatif annulable — jamais « effacé »", async () => {
    const { gesteId } = await journaliserGeste(moi, { origine: "ecran", libelle: "envoi parti" }, () => courriel("parti"));
    const [l] = await envoisDuGeste(gesteId!);
    const avant = partis.length;
    await executerEffetsSortantsDus({ maintenant: plusTard(), ids: [l!.id] });
    await executerEffetsSortantsDus({ maintenant: plusTard(), ids: [l!.id] });
    expect(partis.length).toBe(avant + 1);
    expect((await ligneDe(l!.id)).statut).toBe("PARTI");
    const r = await annulerGeste(gesteId!, moi);
    if ("refus" in r) throw new Error(r.refus);
    expect(r.details[0]).toMatchObject({ issue: "COMPENSE" });
    expect(r.details[0]!.pourquoi).toMatch(/n'est pas effacé chez son destinataire/);
    const apres = await ligneDe(l!.id);
    expect(apres.statut).toBe("COMPENSE");
    const rectId = /\[([a-z0-9]+)\]$/.exec(apres.compensation ?? "")![1]!;
    expect((await ligneDe(rectId)).statut).toBe("EN_ATTENTE");
    // Rétablir le geste retient le rectificatif encore en fenêtre.
    const re = await retablirGeste(gesteId!, moi);
    if ("refus" in re) throw new Error(re.refus);
    expect((await ligneDe(rectId)).statut).toBe("ANNULE");
  });

  it("une poussée partie ne se compense pas : la phrase le dit (IMPOSSIBLE), sans mentir", async () => {
    const { gesteId } = await journaliserGeste(moi, { origine: "ecran", libelle: "poussée" }, () => sendPushToUser(autre.id, { title: `${TAG} push` }));
    const [l] = await envoisDuGeste(gesteId!);
    expect(l).toMatchObject({ type: "push", statut: "EN_ATTENTE" });
    await executerEffetsSortantsDus({ maintenant: plusTard(), ids: [l!.id] });
    const r = await annulerEffetSortant(l!.id, moi);
    expect(r).toMatchObject({ ok: false, issue: "IMPOSSIBLE" });
    expect(r.message).toMatch(/s'est affichée/);
  });

  it("seule la personne (ou le Super Admin) annule ; la course annulation / départ n'a qu'un gagnant", async () => {
    const p = await differerEffetSortant({ type: "courriel.api", acte: "COURRIEL", cible: "x@y.dz", charge: { to: ["x@y.dz"], subject: "s", text: "t" }, principalId: moi.id, delaiSecondes: 0 });
    expect((await annulerEffetSortant(p.id, autre)).issue).toBe("REFUS");
    const [depart, annulation] = await Promise.all([executerEffetsSortantsDus({ ids: [p.id], maintenant: plusTard() }), annulerEffetSortant(p.id, moi, { compenser: false })]);
    const statut = (await ligneDe(p.id)).statut;
    if (statut === "ANNULE") expect(depart.partis).toBe(0);
    else { expect(statut).toBe("PARTI"); expect(annulation.issue).not.toBe("ANNULE"); }
    expect((await retablirEffetSortant(p.id, autre)).issue).toBe("REFUS");
  });

  it("le geste d'ÉCRAN réversible : l'action rend ce qu'elle rendait, la barre le propose", async () => {
    const r = await gesteReversible(moi, { capaciteId: "test:envoi", libelle: `${TAG} geste d'écran` }, () => courriel("ecran"));
    expect(r.ok).toBe(true);
    const recents = await gestesRecents(moi);
    expect(recents.find((g) => g.libelle === `${TAG} geste d'écran`)).toBeTruthy();
  });
});
