import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { addRegistration, createEvent, publicRegister, setRegistrationStatus, updateEvent } from "./actions-evenements";
import { addAdProItem } from "./actions-postes";
import { estStatutOrganisation, estTypeExterne, TYPES_EVENEMENT_EXTERNE } from "./domaine/evenements/externe";
import { STATUTS_MANUELS } from "./domaine/evenements/statut";
import { getPublicEvent } from "./infra/requetes/evenements";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉVÉNEMENTS AD & PRO SONT EXTERNES (Direction, 27/10).
 *
 * Nous ne les organisons pas : ni capacité, ni liste d'attente, ni inscription publique, ni états
 * d'organisation (« En préparation », « Inscriptions ouvertes », « Complet »). Rien n'est supprimé en
 * base — on cesse de les écrire et de les proposer. Le formulaire porte le TYPE externe et l'ORGANISATEUR.
 * Par les VRAIES actions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__evtexterne__${Date.now()}`;

describe("la règle pure", () => {
  it("cinq types externes — staff, webinaire, congrès, journée, autre ; les états d'organisation ne sont plus saisissables", () => {
    expect(TYPES_EVENEMENT_EXTERNE.map(([k]) => k)).toEqual(["HOSPITAL_STAFF", "WEBINAR", "CONGRESS", "SCIENTIFIC_DAY", "OTHER"]);
    expect(estTypeExterne("SEMINAR")).toBe(false);
    for (const s of ["PREPARATION", "REGISTRATION_OPEN", "FULL"]) {
      expect(estStatutOrganisation(s)).toBe(true);
      expect((STATUTS_MANUELS as readonly string[]).includes(s), s).toBe(false);
    }
  });
});

suite("Événements externes — par les actions", () => {
  let saId = "", nouveau = "", ancien = "", regId = "";
  let SA: CurrentUser;

  const base = (o: Record<string, string> = {}) => {
    const fd = new FormData();
    const champs: Record<string, string> = {
      name: `${TAG}Staff cardio`, type: "HOSPITAL_STAFF", scope: "NATIONAL", format: "PRESENTIAL",
      startDate: "2026-12-01", endDate: "2026-12-01", location: "Salle B", city: "Alger", country: "Algérie",
      specialty: "Cardiologie", doctor: "Dr Test", product: "Produit X", estimatedBudget: "50000", description: "Staff du service.",
      ...o,
    };
    for (const [k, v] of Object.entries(champs)) fd.set(k, v);
    fd.set("responsibleId", saId);
    return fd;
  };

  beforeAll(async () => {
    const sa = await prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    saId = sa.id;
    SA = { id: saId, name: sa.name, email: sa.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(saId, "SUPER_ADMIN"), mustChangePassword: false };
    // UN ANCIEN ÉVÉNEMENT, tel que la base le porte : organisé par nous, « Complet », avec une capacité.
    ancien = (await prisma.event.create({
      data: {
        name: `${TAG}Ancien`, type: "SEMINAR", status: "FULL", capacity: 80, startDate: new Date("2026-11-01"), endDate: new Date("2026-11-01"),
        location: "Hôtel", city: "Oran", country: "Algérie", specialty: "Cardiologie", doctor: "Dr Test", products: "Produit X",
        estimatedBudget: 40000, description: "Ancien.", responsibleId: saId,
      },
    })).id;
  }, 30_000);

  afterAll(async () => {
    await prisma.adProItem.deleteMany({ where: { eventId: { in: [nouveau, ancien].filter(Boolean) } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: saId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("CRÉER : le type doit être externe ; l'organisateur s'enregistre ; une capacité postée ne s'écrit plus", async () => {
    ACTOR = SA;
    const seminaire = await createEvent(base({ type: "SEMINAR", organizer: "SAC" }));
    expect(seminaire.ok === false && seminaire.error).toMatch(/staff, webinaire, congrès, journée, autre/);

    const r = await createEvent(base({ organizer: "Société algérienne de cardiologie", capacity: "100" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    nouveau = r.ok ? r.id! : "";
    const e = await prisma.event.findUniqueOrThrow({ where: { id: nouveau } });
    expect(e.organizer).toBe("Société algérienne de cardiologie");
    expect(e.capacity).toBeNull();
    expect(e.status).toBe("DRAFT");
  });

  it("CRÉER / MODIFIER : « En préparation », « Inscriptions ouvertes », « Complet » sont refusés, en le disant", async () => {
    ACTOR = SA;
    const cree = await createEvent(base({ name: `${TAG}Ouvert`, organizer: "X", status: "REGISTRATION_OPEN" }));
    expect(cree.ok === false && cree.error).toMatch(/nous ne les organisons pas/);
    for (const status of ["PREPARATION", "REGISTRATION_OPEN", "FULL"]) {
      const fd = base({ organizer: "Société algérienne de cardiologie", status });
      fd.set("id", nouveau);
      const r = await updateEvent(fd);
      expect(r.ok === false && r.error, status).toMatch(/nous ne les organisons pas/);
    }
    expect((await prisma.event.findUniqueOrThrow({ where: { id: nouveau } })).status).toBe("DRAFT");
  });

  it("UN ANCIEN ÉVÉNEMENT garde son état, son type et sa capacité : le formulaire qui les renvoie n'y touche pas", async () => {
    ACTOR = SA;
    const fd = base({ name: `${TAG}Ancien`, type: "SEMINAR", status: "FULL", city: "Oran", capacity: "500", organizer: "CHU Oran" });
    fd.set("id", ancien);
    const r = await updateEvent(fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const e = await prisma.event.findUniqueOrThrow({ where: { id: ancien } });
    expect(e.status, "rien n'est réécrit").toBe("FULL");
    expect(e.type).toBe("SEMINAR");
    expect(e.capacity, "la colonne reste, on ne l'écrit plus").toBe(80);
    expect(e.organizer).toBe("CHU Oran");
    // Le clore reste possible : c'est un état de VIE.
    const clos = base({ name: `${TAG}Ancien`, type: "SEMINAR", status: "COMPLETED", city: "Oran" });
    clos.set("id", ancien);
    expect((await updateEvent(clos)).ok).toBe(true);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: ancien } })).status).toBe("COMPLETED");
  });

  it("INSCRIPTION PUBLIQUE fermée — l'action refuse, la page ne propose plus de formulaire", async () => {
    const fd = new FormData();
    fd.set("eventId", nouveau); fd.set("firstName", "A"); fd.set("lastName", "B");
    const r = await publicRegister(fd);
    expect(r.ok === false && r.error).toMatch(/chez l'organisateur/);
    expect(await prisma.eventRegistration.count({ where: { eventId: nouveau } })).toBe(0);
    const pub = await getPublicEvent(nouveau);
    expect(pub?.open).toBe(false);
    expect(pub?.spotsLeft).toBeNull();
  });

  it("LISTE D'ATTENTE : ni à l'ajout, ni au changement de statut d'un participant", async () => {
    ACTOR = SA;
    const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
    const attente = await addRegistration(fd({ eventId: nouveau, firstName: "Salim", lastName: `${TAG}M`, status: "PENDING" }));
    expect(attente.ok === false && attente.error).toMatch(/liste d'attente/);
    expect((await addRegistration(fd({ eventId: nouveau, firstName: "Salim", lastName: `${TAG}M` }))).ok).toBe(true);
    regId = (await prisma.eventRegistration.findFirstOrThrow({ where: { eventId: nouveau } })).id;
    const r = await setRegistrationStatus(fd({ id: regId, status: "PENDING" }));
    expect(r.ok === false && r.error).toMatch(/liste d'attente/);
    expect((await prisma.eventRegistration.findUniqueOrThrow({ where: { id: regId } })).status).toBe("CONFIRMED");
    await prisma.eventRegistration.deleteMany({ where: { eventId: nouveau } });
  });

  it("UN POSTE ne s'ajoute pas sur un événement sans circuit — l'état d'organisation (« En préparation ») ne vaut pas prévalidation", async () => {
    ACTOR = SA;
    // Un événement sans circuit, posé « En préparation » avant la règle : la base le porte encore.
    await prisma.event.update({ where: { id: nouveau }, data: { status: "PREPARATION" } });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ parent: "EVENT", parentId: nouveau, label: `${TAG}Traiteur`, kind: "OTHER", amountEstimated: "10000" })) fd.set(k, v);
    const r = await addAdProItem(undefined, fd);
    expect(r.ok === false && r.error).toMatch(/^Les postes s'ajoutent après la prévalidation de la Direction Marketing/);
    expect(await prisma.adProItem.count({ where: { eventId: nouveau, label: `${TAG}Traiteur` } })).toBe(0);
  });
});
