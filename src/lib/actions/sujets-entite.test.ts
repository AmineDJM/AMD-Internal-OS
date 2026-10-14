import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
/** Le sélecteur d'entité de la barre supérieure (cookie) — la seule vue globale qui se restreint. */
let ENTITE_CHOISIE: string | null = null;
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => (ENTITE_CHOISIE ? { value: ENTITE_CHOISIE } : undefined) }),
  headers: () => new Headers(),
}));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { MODULE_LABELS, NAVIGATION } from "@/lib/labels";
import { getDossiers } from "@/lib/queries/dossiers";
import { createDossier } from "./dossier-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__sujets__";

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/** La lecture que la résolution fait d'un libellé : casse, accents et espaces ne distinguent rien. */
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Un cliquet juge le CODE, pas la prose qui le décrit (§118.79d, §118.88, §118.112b). */
function code(p: string): string {
  return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PILOTAGE › « PROJETS » DEVIENT « SUJETS », ET CHAQUE SUJET A SON ENTITÉ (§118.163).
 *
 * Décision de la Direction (30/09/2026) : « le module Projets dans la catégorie Pilotage, renomme
 * le Sujets » ; « fais en sorte que chaque projet soit associé à une société/entité, et donc
 * visible ». Deux faits, deux cliquets :
 *  - un NOM ne désigne qu'un module. « Projets » nommait deux entrées de menu (Pilotage et le
 *    registre BD) ; la résolution d'un libellé prenait la première, et c'est un ordre de fichier
 *    qui décidait quel module s'ouvrait au validateur d'une demande ;
 *  - la liste des sujets se compose à l'ENTITÉ en GARDANT les sujets sans entité : elle lisait
 *    `platformScope` seul, qui les exclut, et un sujet né sans société disparaissait de la liste
 *    de ses propres membres alors que sa fiche s'ouvrait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("Sujets — un nom, un module", () => {
  it("Pilotage s'appelle « Sujets » ; « Projets » ne nomme plus que le registre BD", () => {
    expect(MODULE_LABELS.DOSSIERS).toBe("Sujets");
    expect(MODULE_LABELS.BD_PROJECTS).toBe("Projets");
    const pilotage = NAVIGATION.find((n) => n.href === "/dossiers");
    expect(pilotage?.label).toBe("Sujets");
    expect(pilotage?.group).toBe("Pilotage");
  });

  it("aucun libellé de module n'est porté par deux modules", () => {
    const vus = new Map<string, string[]>();
    for (const [k, v] of Object.entries(MODULE_LABELS)) vus.set(norm(v), [...(vus.get(norm(v)) ?? []), k]);
    const doubles = [...vus].filter(([, ks]) => ks.length > 1);
    expect(doubles, "deux modules sous le même nom : la console et les écrans ne les distinguent plus").toEqual([]);
  });

  it("aucune entrée de menu ne porte le libellé d'une autre", () => {
    const vus = new Map<string, string[]>();
    for (const n of NAVIGATION) vus.set(norm(n.label), [...(vus.get(norm(n.label)) ?? []), n.href]);
    const doubles = [...vus].filter(([, hs]) => hs.length > 1);
    expect(doubles, "un libellé porté par deux entrées : la résolution d'une demande de validation prend la première").toEqual([]);
  });

  it("« Projets » et « Sujets » désignent chacun UN module, onglets compris", () => {
    for (const libelle of ["Projets", "Sujets"]) {
      const modules = new Set<string>();
      for (const n of NAVIGATION) {
        if (norm(n.label) === norm(libelle)) modules.add(n.module);
        for (const t of n.tabs ?? []) if (norm(t.label) === norm(libelle)) modules.add(t.module);
      }
      expect([...modules], `« ${libelle} »`).toHaveLength(1);
    }
  });

  it("les écrans des sujets ne parlent plus de « projet »", () => {
    const liste = code("src/app/(app)/dossiers/page.tsx");
    const fiche = code("src/app/(app)/dossiers/[id]/page.tsx");
    for (const [nom, src] of [["liste", liste], ["fiche", fiche]] as const) {
      expect(src, `${nom} : un sujet n'est pas un projet`).not.toMatch(/\bprojets?\b/i);
    }
    expect(liste).toContain("Nouveau sujet");
    expect(fiche).toContain("Retour aux sujets");
  });
});

suite("Sujets — chacun a son entité, et la liste la respecte sans perdre les sujets sans entité", () => {
  let delegueId = "", directionId = "", autreId = "";
  let coA = "", coB = "", coC = "";
  let sansEntite = "", chezA = "", chezB = "";

  beforeAll(async () => {
    await nettoyer();
    const [a, b, c] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG}Société A` } }),
      prisma.company.create({ data: { name: `${TAG}Société B` } }),
      prisma.company.create({ data: { name: `${TAG}Société C` } }),
    ]);
    coA = a.id; coB = b.id; coC = c.id;
    const [d, dir, o] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}delegue`, email: `${TAG}delegue@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
      // Le SEUL rôle qui voit tout le groupe (`GROUP_WIDE_ROLES`) : c'est chez lui que le sélecteur
      // d'entité restreint quelque chose — la Direction, elle, relève de son entité comme tout salarié.
      prisma.user.create({ data: { name: `${TAG}direction`, email: `${TAG}direction@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
    ]);
    delegueId = d.id; directionId = dir.id; autreId = o.id;
    // L'entité d'APPARTENANCE : c'est elle qui cloisonne un salarié mono-entité.
    await prisma.employee.create({ data: { fullName: `${TAG}delegue`, userId: delegueId, companyId: coA } });
    // Une SECONDE entité ouverte nommément : c'est elle qui prouve que le choix est lu — choisir
    // l'entité d'appartenance ne distinguerait pas « choisie » de « déduite ».
    await prisma.userCompanyAccess.create({ data: { userId: delegueId, companyId: coC } });
    const mk = (titre: string, companyId: string | null, createdById: string) =>
      prisma.dossier.create({ data: { reference: `${TAG}${titre}`, title: `${TAG}${titre}`, companyId, createdById } });
    const [s0, sa, sb] = await Promise.all([
      mk("sans-entite", null, delegueId),
      mk("chez-A", coA, delegueId),
      mk("chez-B", coB, autreId),
    ]);
    sansEntite = s0.id; chezA = sa.id; chezB = sb.id;
  }, 120_000);

  afterAll(async () => { ENTITE_CHOISIE = null; await nettoyer(); }, 120_000);

  async function nettoyer() {
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { OR: [{ reference: { startsWith: TAG } }, { title: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  it("PRÉMISSES : le délégué voit SES sujets ; le Super Admin les voit tous", async () => {
    ENTITE_CHOISIE = null;
    const d = await acteur(delegueId, "MEDICAL_DELEGATE");
    expect(d.access.modules.get("DOSSIERS")?.scope).toBe("ASSIGNED");
    const dir = await acteur(directionId, "SUPER_ADMIN");
    expect(dir.access.modules.get("DOSSIERS")?.scope).toBe("ALL");
  });

  it("un sujet SANS entité reste dans la liste de son créateur cloisonné — la fiche s'ouvrait, la liste le cachait", async () => {
    ENTITE_CHOISIE = null;
    const ids = (await getDossiers(await acteur(delegueId, "MEDICAL_DELEGATE"))).map((x) => x.id);
    expect(ids).toContain(sansEntite);
    expect(ids).toContain(chezA);
  });

  it("le Super Admin qui choisit une entité voit ses sujets, et ceux qui n'en ont pas — pas ceux d'une autre", async () => {
    ENTITE_CHOISIE = null;
    const tout = (await getDossiers(await acteur(directionId, "SUPER_ADMIN"))).map((x) => x.id);
    expect(tout, "sans entité choisie, la vue globale voit tout le groupe").toEqual(expect.arrayContaining([sansEntite, chezA, chezB]));
    ENTITE_CHOISIE = coA;
    const chezEux = (await getDossiers(await acteur(directionId, "SUPER_ADMIN"))).map((x) => x.id);
    ENTITE_CHOISIE = null;
    expect(chezEux, "un sujet de l'entité choisie").toContain(chezA);
    expect(chezEux, "un sujet sans entité n'est le secret d'aucune société").toContain(sansEntite);
    expect(chezEux, "un sujet d'une AUTRE entité reste chez elle").not.toContain(chezB);
  });

  it("la liste porte l'entité de chaque sujet, pour que l'écran l'affiche", async () => {
    ENTITE_CHOISIE = null;
    const lignes = await getDossiers(await acteur(delegueId, "MEDICAL_DELEGATE"));
    expect(lignes.find((x) => x.id === chezA)?.company?.id).toBe(coA);
    expect(lignes.find((x) => x.id === sansEntite)?.company).toBeNull();
  });

  it("créer un sujet : l'entité choisie, seulement parmi celles qu'on voit ; sans choix, celle où l'on travaille", async () => {
    ENTITE_CHOISIE = null;
    ACTEUR = await acteur(delegueId, "MEDICAL_DELEGATE");
    expect(userCan(ACTEUR, "DOSSIERS", "CREATE")).toBe(true);

    const interdit = new FormData();
    interdit.set("title", `${TAG}chez B par formulaire forgé`);
    interdit.set("companyId", coB);
    const refus = await createDossier(undefined, interdit);
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/entité ne vous est pas ouverte/);
    expect(await prisma.dossier.count({ where: { title: `${TAG}chez B par formulaire forgé` } }), "rien n'a été écrit").toBe(0);

    const choisi = new FormData();
    choisi.set("title", `${TAG}chez C choisi`);
    choisi.set("companyId", coC);
    const ok = await createDossier(undefined, choisi);
    expect(ok.ok).toBe(true);
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: ok.id! } })).companyId, "l'entité CHOISIE, pas celle d'appartenance").toBe(coC);

    const sansChoix = new FormData();
    sansChoix.set("title", `${TAG}sans choix`);
    const ok2 = await createDossier(undefined, sansChoix);
    expect(ok2.ok).toBe(true);
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: ok2.id! } })).companyId, "l'entité d'appartenance").toBe(coA);
  });
});

suite("Validation — un libellé réemployé n'ouvre pas le module qu'il nomme aujourd'hui", () => {
  let lecteurId = "", demandeurId = "";

  beforeAll(async () => {
    await nettoyer();
    const [l, d] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}lecteur`, email: `${TAG}lecteur@t.dz`, role: "VIEWER", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}demandeur`, email: `${TAG}demandeur@t.dz`, role: "VIEWER", passwordHash: "x" } }),
    ]);
    lecteurId = l.id; demandeurId = d.id;
  }, 60_000);

  afterAll(nettoyer, 60_000);

  async function nettoyer() {
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }

  /** Une demande EN ATTENTE sur le lecteur, avec ce libellé et ce lien — puis l'accès qu'il en tire. */
  async function accesAvec(module: string, link: string | null) {
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.validationRequest.create({
      data: {
        reference: `${TAG}VAL-${Math.random().toString(36).slice(2, 8)}`,
        module, title: `${TAG}à décider`, link, requesterId: demandeurId, status: "PENDING", currentOrder: 1,
        steps: { create: [{ order: 1, validatorId: lecteurId, status: "PENDING" }] },
      },
    });
    return getAccess(lecteurId, "VIEWER");
  }

  it("PRÉMISSE : sans demande, le lecteur n'a pas le registre BD", async () => {
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } });
    const a = await getAccess(lecteurId, "VIEWER");
    expect(a.modules.has("BD_PROJECTS")).toBe(false);
  });

  it("« Projets » + un lien vers un SUJET : c'est le lien qui dit ce qu'on décide", async () => {
    const a = await accesAvec("Projets", "/dossiers/abc");
    expect(a.modules.has("BD_PROJECTS"), "le registre BD n'a rien à voir avec ce sujet").toBe(false);
  });

  it("« Projets » SANS lien : ni l'un ni l'autre sur la foi du nom — un nom réemployé ne dit plus rien", async () => {
    const a = await accesAvec("Projets", null);
    expect(a.modules.has("BD_PROJECTS"), "élargir le registre BD au validateur d'un ancien sujet").toBe(false);
    expect(a.modules.get("VALIDATIONS")?.actions.has("VIEW"), "il peut toujours décider").toBe(true);
  });

  it("« Projets » + un lien vers le REGISTRE : l'accès temporaire en lecture, comme toute validation", async () => {
    const a = await accesAvec("Projets", "/business-development/projets");
    expect(a.modules.get("BD_PROJECTS")?.actions.has("VIEW")).toBe(true);
    expect(a.modules.get("BD_PROJECTS")?.actions.has("UPDATE"), "toujours en LECTURE seule").toBe(false);
  });

  it("un libellé et un lien qui désignent deux modules : le lien l'emporte, quel que soit le nom", async () => {
    // Le cas qui ne passe PAS par le libellé réemployé : sans la règle « le lien l'emporte », le
    // nom seul décidait, et le validateur recevait un module sans rapport avec ce qu'il décide.
    const legal = NAVIGATION.find((n) => n.module === "LEGAL");
    const a = await accesAvec(legal!.label, "/business-development/projets");
    expect(a.modules.get("BD_PROJECTS")?.actions.has("VIEW"), "le lien désigne le registre").toBe(true);
    expect(a.modules.has("LEGAL"), "le nom ne décide plus seul").toBe(false);
  });

  it("un libellé qui n'a jamais changé de sens garde sa lecture par le nom", async () => {
    // Un module que le lecteur n'a PAS : sinon l'assertion serait vraie sans rien mesurer (§118.17).
    const legal = NAVIGATION.find((n) => n.module === "LEGAL");
    expect(legal, "l'entrée Legal existe").toBeDefined();
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } });
    expect((await getAccess(lecteurId, "VIEWER")).modules.has("LEGAL"), "PRÉMISSE : pas de Legal sans demande").toBe(false);
    const a = await accesAvec(legal!.label, null);
    expect(a.modules.get("LEGAL")?.actions.has("VIEW")).toBe(true);
  });
});
