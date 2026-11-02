import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { journal, reinitialiserJournal, remplacerEcrivain } from "@/lib/journal";
import { alerterIncidentsRepetes, FENETRE_MS, incidentsAAlerter, RAPPEL_MS, SEUIL, texteAlerte, verserCompteurs } from "./incidents-repetes";

let dbOk = false;
try {
  await prisma.$queryRaw`SELECT 1 FROM "IncidentRepete" LIMIT 1`;
  dbOk = true;
} catch {
  dbOk = false;
}
const suite = dbOk ? describe : describe.skip;

const PREFIXE = `test-incidents-${process.pid}-${Date.now()}`;

describe("incidents répétés — qui alerter (pur)", () => {
  const t = new Date("2026-10-28T10:00:00Z");
  const ligne = (o: Partial<{ evenement: string; compteFenetre: number; fenetreDebut: Date; notifieA: Date | null }>) => ({
    evenement: "e", compteFenetre: SEUIL, fenetreDebut: new Date(t.getTime() - 60_000), dernierMessage: null, notifieA: null, ...o,
  });

  it("au seuil dans la fenêtre : oui ; sous le seuil, fenêtre échue ou déjà signalé récemment : non", () => {
    expect(incidentsAAlerter([ligne({})], t)).toHaveLength(1);
    expect(incidentsAAlerter([ligne({ compteFenetre: SEUIL - 1 })], t)).toHaveLength(0);
    expect(incidentsAAlerter([ligne({ fenetreDebut: new Date(t.getTime() - FENETRE_MS - 1) })], t)).toHaveLength(0);
    expect(incidentsAAlerter([ligne({ notifieA: new Date(t.getTime() - 60_000) })], t)).toHaveLength(0);
    expect(incidentsAAlerter([ligne({ notifieA: new Date(t.getTime() - RAPPEL_MS) })], t)).toHaveLength(1);
  });

  it("une notification agrégée : le plus fréquent d'abord, la liste bornée", () => {
    const l = Array.from({ length: 10 }, (_, i) => ligne({ evenement: `e${i}`, compteFenetre: SEUIL + i }));
    const a = incidentsAAlerter(l, t);
    expect(a[0].evenement).toBe("e9");
    const { title, body } = texteAlerte(a);
    expect(title).toContain("10 erreurs");
    expect(body).toContain("… et 2 autre(s).");
  });
});

suite("incidents répétés — versement et alerte (base réelle)", () => {
  let restaurer: () => void = () => undefined;
  beforeEach(() => {
    reinitialiserJournal();
    restaurer();
    restaurer = remplacerEcrivain(() => undefined);
  });
  afterAll(async () => {
    restaurer();
    await prisma.incidentRepete.deleteMany({ where: { evenement: { startsWith: PREFIXE } } });
    await prisma.notification.deleteMany({ where: { link: "/admin/diagnostic", body: { contains: PREFIXE } } });
  });

  it("deux versements s'ADDITIONNENT dans la fenêtre (deux processus ne s'écrasent pas)", async () => {
    const ev = `${PREFIXE}.addition`;
    journal.erreur(ev, {}, "x");
    journal.erreur(ev, {}, "x");
    await verserCompteurs();
    journal.erreur(ev, {}, "y");
    await verserCompteurs();
    const l = await prisma.incidentRepete.findUniqueOrThrow({ where: { evenement: ev } });
    expect(l.total).toBe(3);
    expect(l.compteFenetre).toBe(3);
    expect(l.dernierMessage).toBe("y");
  });

  it("une fenêtre échue repart de zéro, le total continue", async () => {
    const ev = `${PREFIXE}.fenetre`;
    await prisma.incidentRepete.create({ data: { evenement: ev, total: 40, compteFenetre: 40, fenetreDebut: new Date(Date.now() - FENETRE_MS - 60_000) } });
    journal.erreur(ev, {}, "x");
    await verserCompteurs();
    const l = await prisma.incidentRepete.findUniqueOrThrow({ where: { evenement: ev } });
    expect(l.total).toBe(41);
    expect(l.compteFenetre).toBe(1);
  });

  it("base injoignable : le lot est restitué, rien n'est perdu", async () => {
    const ev = `${PREFIXE}.restitue`;
    journal.erreur(ev, {}, "x");
    const espion = vi.spyOn(prisma, "$executeRaw").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await verserCompteurs()).toBe(0);
    espion.mockRestore();
    expect(await verserCompteurs()).toBe(1);
    expect((await prisma.incidentRepete.findUniqueOrThrow({ where: { evenement: ev } })).total).toBe(1);
  });

  it("au seuil : UNE alerte, puis le silence jusqu'au rappel", async () => {
    const ev = `${PREFIXE}.alerte`;
    for (let i = 0; i < SEUIL; i++) journal.erreur(ev, {}, `x${i}`);
    const avant = await prisma.notification.count({ where: { link: "/admin/diagnostic" } });
    const r1 = await alerterIncidentsRepetes();
    expect(r1.alertes).toBeGreaterThanOrEqual(1);
    const l = await prisma.incidentRepete.findUniqueOrThrow({ where: { evenement: ev } });
    expect(l.notifieA).not.toBeNull();
    for (let i = 0; i < SEUIL; i++) journal.erreur(ev, {}, `z${i}`);
    await alerterIncidentsRepetes();
    const apres = await prisma.incidentRepete.findUniqueOrThrow({ where: { evenement: ev } });
    expect(apres.notifieA?.getTime()).toBe(l.notifieA?.getTime());
    const superAdmins = await prisma.user.count({ where: { role: "SUPER_ADMIN", isActive: true } });
    if (superAdmins > 0) {
      expect(await prisma.notification.count({ where: { link: "/admin/diagnostic" } })).toBeGreaterThan(avant);
    }
  });
});
