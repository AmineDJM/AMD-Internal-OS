import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { getCalendarEvents, getUpcomingEvents } from "@/lib/calendar";
import { getAdProEventsAsCalendar, projeterDemandeAdPro, toucheLaFenetre, type NatureAdProDatee } from "./calendrier";
import { joursCouverts, algiersInputToUtc } from "@/lib/calendar-tz";

/**
 * LES ÉVÉNEMENTS AD & PRO DANS L'AGENDA — lus sur leur demande, jamais recopiés.
 *
 * Trois choses à tenir : (1) les jours — une date sans heure est une journée entière, un congrès de
 * trois jours occupe trois cases ; (2) les droits — l'agenda ne montre rien que la liste Ad & Pro
 * ne montrerait pas, et chaque ligne montrée s'ouvre (la fiche l'accepte) ; (3) la source fait foi —
 * annulée, refusée ou supprimée, la demande disparaît ; déplacée, l'agenda suit.
 */

describe("projeterDemandeAdPro — la règle des jours", () => {
  const base = {
    nature: "CONGRESS_NATIONAL" as NatureAdProDatee, id: "c1", intitule: "Journées d'Oran", type: "Congrès · national",
    lieu: ["CHU Oran", "Oran", "Oran", null], demandeurId: "u1", demandeur: "Amel",
  };

  it("une date saisie sans heure (minuit UTC) est une journée entière, sur son jour", () => {
    const e = projeterDemandeAdPro({ ...base, debut: new Date("2031-03-12T00:00:00Z"), fin: null });
    expect(e.allDay).toBe(true);
    expect(e.ymd).toBe("2031-03-12");
    expect(e.endYmd).toBeUndefined();
    expect(e.timeLabel).toBe("");
    expect(e.location).toBe("CHU Oran, Oran");
    expect(e.source).toEqual({ kind: "AD_PRO", label: "Ad & Pro · Congrès · national", href: "/congress-national/c1" });
    expect(e.isOrganizer).toBe(false);
  });

  it("minuit d'Alger (23:00 UTC la veille) est aussi une journée entière — sur le bon jour", () => {
    const e = projeterDemandeAdPro({ ...base, debut: new Date("2031-03-11T23:00:00Z"), fin: null });
    expect(e.allDay).toBe(true);
    expect(e.ymd).toBe("2031-03-12");
  });

  it("sur plusieurs jours : `endYmd` porte le dernier jour, et la grille occupe chaque case", () => {
    const e = projeterDemandeAdPro({ ...base, debut: new Date("2031-03-12T00:00:00Z"), fin: new Date("2031-03-14T00:00:00Z") });
    expect(e.allDay).toBe(true);
    expect(e.endYmd).toBe("2031-03-14");
    expect(joursCouverts(e.ymd, e.endYmd)).toEqual(["2031-03-12", "2031-03-13", "2031-03-14"]);
  });

  it("avec une heure : heure d'Alger affichée, pas une journée entière", () => {
    const e = projeterDemandeAdPro({ ...base, nature: "EVENT", debut: new Date("2031-03-12T08:30:00Z"), fin: new Date("2031-03-12T16:00:00Z") });
    expect(e.allDay).toBe(false);
    expect(e.timeLabel).toBe("09:30");
    expect(e.endYmd).toBeUndefined();
    expect(e.source?.href).toBe("/events/c1");
  });

  it("une fin AVANT le début est ignorée (un seul jour), et une fin absurde ne fabrique pas cent cases", () => {
    const e = projeterDemandeAdPro({ ...base, debut: new Date("2031-03-12T00:00:00Z"), fin: new Date("2031-03-10T00:00:00Z") });
    expect(e.endAt).toBeNull();
    expect(e.endYmd).toBeUndefined();
    expect(joursCouverts("2031-01-01", "2032-01-01")).toHaveLength(62);
  });

  it("toucheLaFenetre : un congrès commencé avant la fenêtre et qui s'y termine en fait partie", () => {
    expect(toucheLaFenetre({ ymd: "2031-02-27", endYmd: "2031-03-02" }, "2031-03-01", "2031-03-31")).toBe(true);
    expect(toucheLaFenetre({ ymd: "2031-02-27", endYmd: "2031-02-28" }, "2031-03-01", "2031-03-31")).toBe(false);
    expect(toucheLaFenetre({ ymd: "2031-04-01" }, "2031-03-01", "2031-03-31")).toBe(false);
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__agendaadpro__";

async function acteur(id: string, role: SessionUser["role"]): Promise<SessionUser> {
  return { id, role, access: await getAccess(id, role) } as SessionUser;
}

suite("Agenda — les événements Ad & Pro (droits, entité, annulation)", () => {
  const u: Record<string, string> = {};
  let coA = "", coB = "";
  let natA = "", intlA = "", evtA = "", evtB = "";
  // Mars 2031, grille du lundi 24 février au dimanche 6 avril — loin de toute donnée réelle.
  const from = algiersInputToUtc("2031-02-24T00:00")!;
  const to = new Date(algiersInputToUtc("2031-04-06T00:00")!.getTime() + 86400000);
  const ids = (evts: { id: string }[]) => evts.map((e) => e.id).filter((id) => id.startsWith("adpro:"));
  const cle = (n: NatureAdProDatee, id: string) => `adpro:${n}:${id}`;

  beforeAll(async () => {
    await nettoyer();
    const [a, b] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG}Société A` } }),
      prisma.company.create({ data: { name: `${TAG}Société B` } }),
    ]);
    coA = a.id; coB = b.id;
    const mk = async (k: string, role: SessionUser["role"], companyId: string | null) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
      if (companyId) await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], companyId } });
    };
    await mk("kamA", "MEDICAL_DELEGATE", coA);
    await mk("kamB", "MEDICAL_DELEGATE", coA);
    await mk("kamSocB", "MEDICAL_DELEGATE", coB);
    await mk("coursier", "COORDINATOR", coA);

    natA = (await prisma.congressNational.create({ data: {
      name: `${TAG} Journées d'Oran`, companyId: coA, requesterId: u.kamA, city: "Oran", hostInstitution: "CHU Oran",
      date: new Date("2031-03-12T00:00:00Z"), endDate: new Date("2031-03-14T00:00:00Z"),
    } })).id;
    intlA = (await prisma.congressInternational.create({ data: {
      name: `${TAG} ESMO`, companyId: coA, requesterId: u.kamA, eventType: "SYMPOSIUM", city: "Barcelone", country: "Espagne",
      startDate: new Date("2031-02-27T00:00:00Z"), endDate: new Date("2031-03-02T00:00:00Z"),
    } })).id;
    evtA = (await prisma.event.create({ data: {
      name: `${TAG} Table ronde cardio`, companyId: coA, requesterId: u.kamB, type: "ROUND_TABLE", location: "Hôtel Sheraton", city: "Alger",
      startDate: new Date("2031-03-20T08:30:00Z"), endDate: new Date("2031-03-20T16:00:00Z"),
    } })).id;
    evtB = (await prisma.event.create({ data: {
      name: `${TAG} Staff de l'autre société`, companyId: coB, requesterId: u.kamSocB,
      startDate: new Date("2031-03-21T00:00:00Z"),
    } })).id;
  }, 120_000);

  afterAll(nettoyer, 120_000);

  async function nettoyer() {
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  it("PRÉMISSES : le délégué a les trois modules en portée « ses lignes » ; le coursier n'en a aucun", async () => {
    const kam = await acteur(u.kamA, "MEDICAL_DELEGATE");
    for (const m of ["CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENTS"] as const) expect(userCan(kam, m, "VIEW"), m).toBe(true);
    expect(kam.access.modules.get("CONGRESS_NATIONAL")?.scope).toBe("ASSIGNED");
    const coursier = await acteur(u.coursier, "COORDINATOR");
    for (const m of ["CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENTS"] as const) expect(userCan(coursier, m, "VIEW"), m).toBe(false);
  });

  it("le demandeur voit ses congrès dans l'agenda — dates, lieu, intitulé, lien vers la demande", async () => {
    const kamA = await acteur(u.kamA, "MEDICAL_DELEGATE");
    const evts = await getCalendarEvents(kamA, from, to);
    const nat = evts.find((e) => e.id === cle("CONGRESS_NATIONAL", natA));
    expect(nat).toMatchObject({
      title: `${TAG} Journées d'Oran`, allDay: true, ymd: "2031-03-12", endYmd: "2031-03-14",
      location: "CHU Oran, Oran", source: { kind: "AD_PRO", href: `/congress-national/${natA}` },
    });
    // Commencé AVANT la grille affichée, terminé dedans : il y est.
    expect(evts.find((e) => e.id === cle("CONGRESS_INTERNATIONAL", intlA))).toMatchObject({
      ymd: "2031-02-27", endYmd: "2031-03-02", location: "Barcelone, Espagne", source: { label: "Ad & Pro · Symposium · international" },
    });
    // L'événement d'un collègue de SA société : EVENTS n'a pas de portée de ligne (comme sa liste).
    expect(evts.find((e) => e.id === cle("EVENT", evtA))).toMatchObject({ allDay: false, timeLabel: "09:30", ymd: "2031-03-20" });
  });

  it("un autre délégué ne voit pas les congrès d'un collègue (portée de ligne)", async () => {
    const kamB = await acteur(u.kamB, "MEDICAL_DELEGATE");
    const vus = ids(await getCalendarEvents(kamB, from, to));
    expect(vus).not.toContain(cle("CONGRESS_NATIONAL", natA));
    expect(vus).not.toContain(cle("CONGRESS_INTERNATIONAL", intlA));
    expect(vus).toContain(cle("EVENT", evtA));
  });

  it("l'entité cloisonne : l'événement d'une autre société n'apparaît pas", async () => {
    const kamA = await acteur(u.kamA, "MEDICAL_DELEGATE");
    expect(ids(await getCalendarEvents(kamA, from, to))).not.toContain(cle("EVENT", evtB));
    const kamSocB = await acteur(u.kamSocB, "MEDICAL_DELEGATE");
    const vusB = ids(await getCalendarEvents(kamSocB, from, to));
    expect(vusB).toContain(cle("EVENT", evtB));
    expect(vusB).not.toContain(cle("EVENT", evtA));
  });

  it("sans module Ad & Pro, rien ; sans matrice de droits (appel interne), rien", async () => {
    const coursier = await acteur(u.coursier, "COORDINATOR");
    expect(await getAdProEventsAsCalendar(coursier, from, to)).toEqual([]);
    expect(await getAdProEventsAsCalendar({ id: u.kamA, role: "MEDICAL_DELEGATE" }, from, to)).toEqual([]);
  });

  it("tout ce que l'agenda montre s'ouvre : la fiche accepte chaque ligne (agenda ⊆ fiche)", async () => {
    for (const [k, role] of [["kamA", "MEDICAL_DELEGATE"], ["kamB", "MEDICAL_DELEGATE"], ["kamSocB", "MEDICAL_DELEGATE"]] as const) {
      const user = await acteur(u[k], role);
      for (const e of await getAdProEventsAsCalendar(user, from, to)) {
        if (!e.title.startsWith(TAG)) continue;
        const [, nature, id] = e.id.split(":") as [string, NatureAdProDatee, string];
        expect(await canAccessEntity(user, nature, id, "VIEW"), `${k} → ${e.title}`).toBe(true);
      }
    }
  });

  it("date modifiée : l'agenda suit la demande", async () => {
    await prisma.congressNational.update({ where: { id: natA }, data: { date: new Date("2031-03-25T00:00:00Z"), endDate: null } });
    const kamA = await acteur(u.kamA, "MEDICAL_DELEGATE");
    const nat = (await getCalendarEvents(kamA, from, to)).find((e) => e.id === cle("CONGRESS_NATIONAL", natA));
    expect(nat?.ymd).toBe("2031-03-25");
    expect(nat?.endYmd).toBeUndefined();
  });

  it("annulée, refusée ou supprimée : la demande disparaît de l'agenda", async () => {
    const kamA = await acteur(u.kamA, "MEDICAL_DELEGATE");
    await prisma.congressNational.update({ where: { id: natA }, data: { status: "CANCELLED" } });
    await prisma.congressInternational.update({ where: { id: intlA }, data: { requestStatus: "REJECTED" } });
    await prisma.event.update({ where: { id: evtA }, data: { status: "CANCELLED" } });
    let vus = ids(await getCalendarEvents(kamA, from, to));
    expect(vus).not.toContain(cle("CONGRESS_NATIONAL", natA));
    expect(vus).not.toContain(cle("CONGRESS_INTERNATIONAL", intlA));
    expect(vus).not.toContain(cle("EVENT", evtA));

    // Rétablie, elle revient — puis supprimée (corbeille comprise : la ligne n'existe plus), elle part.
    await prisma.congressNational.update({ where: { id: natA }, data: { status: "VALIDATED", requestStatus: "CANCELLED" } });
    expect(ids(await getCalendarEvents(kamA, from, to))).not.toContain(cle("CONGRESS_NATIONAL", natA));
    await prisma.congressNational.update({ where: { id: natA }, data: { requestStatus: "APPROVED" } });
    expect(ids(await getCalendarEvents(kamA, from, to))).toContain(cle("CONGRESS_NATIONAL", natA));
    await prisma.congressNational.delete({ where: { id: natA } });
    vus = ids(await getCalendarEvents(kamA, from, to));
    expect(vus).not.toContain(cle("CONGRESS_NATIONAL", natA));
  });

  it("« À venir » garde un événement EN COURS (commencé hier, fini demain)", async () => {
    const hier = new Date(Date.now() - 86400000);
    const demain = new Date(Date.now() + 86400000);
    const jour = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
    const enCours = await prisma.event.create({ data: {
      name: `${TAG} Congrès en cours`, companyId: coA, requesterId: u.kamA, startDate: jour(hier), endDate: jour(demain),
    } });
    const kamA = await acteur(u.kamA, "MEDICAL_DELEGATE");
    expect((await getUpcomingEvents(kamA, 50)).map((e) => e.id)).toContain(cle("EVENT", enCours.id));
  });
});
