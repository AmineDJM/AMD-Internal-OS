import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireModule: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { repriseLieuxWilaya } from "./lieux-wilaya";
import { repriseAdresses } from "./adresses";
import { reprisePointsDeContact } from "./points-de-contact";
import { REPRISES, trouverReprise } from ".";
import type { Reprise } from "../../domaine/reprises/types";
import { reposerWilayaCode } from "@/modules/lieux/api";
import { apercuReprise, executerReprise } from "@/lib/actions/refonte-reprise-actions";
import { reglerDoubleEcritureLieux } from "@/lib/actions/lieux-actions";
import { creerFournisseurAnnuaire, modifierFournisseurAnnuaire } from "@/lib/actions/fournisseurs-annuaire-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__v2lieux__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT V2-D « LIEUX ET COORDONNÉES », SUR UNE VRAIE BASE.
 *
 *  - la reprise « lieux-wilaya » rattache, liste l'ambigu, n'écrase pas `updatedAt`, et REJOUÉE ne change rien ;
 *  - les reprises « adresses » et « points-de-contact » ne créent que pour les titulaires existants, une ligne par
 *    chose réelle, et rejouées n'ajoutent rien — puis rattrapent une fiche dont la Personne est créée APRÈS ;
 *  - la double écriture pose le code à la saisie, et l'interrupteur la coupe ;
 *  - la porte des reprises : Super Admin seul, chaque geste au journal.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Exécute une reprise jusqu'au bout, par lots ; rend le cumul. */
async function jusquAuBout(r: Reprise, taille = 5000) {
  let suite: string | null = null;
  const total = { lues: 0, creees: 0, liees: 0, ignorees: 0, erreurs: [] as string[] };
  do {
    const b = await r.executer({ taille, apresId: suite });
    total.lues += b.lues; total.creees += b.creees; total.liees += b.liees; total.ignorees += b.ignorees;
    total.erreurs.push(...b.erreurs);
    suite = b.suite;
  } while (suite);
  return total;
}

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false } as CurrentUser;
}

suite("reprises V2-D — lieux et coordonnées", () => {
  const ids = { personne: "", personneTard: "", organisation: "", medecins: [] as string[], supplier: "", contact: "", admin: "", delegue: "" };
  let interrupteurAvant = true;

  beforeAll(async () => {
    interrupteurAvant = (await prisma.appSetting.findUnique({ where: { id: "global" }, select: { lieuxDoubleEcriture: true } }))?.lieuxDoubleEcriture ?? true;
    const p = await prisma.personne.create({ data: { nom: `${TAG}Benali`, nomReplie: `${TAG}benali` } });
    const o = await prisma.organisation.create({ data: { raisonSociale: `${TAG}Labo`, nomReplie: `${TAG}labo` } });
    ids.personne = p.id; ids.organisation = o.id;
    const mk = (data: Record<string, unknown>) => prisma.medicalDoctor.create({ data: { name: `${TAG}${data.name ?? "x"}`, ...data, }, select: { id: true } });
    const m = await Promise.all([
      mk({ name: "oran", wilaya: "Oran", personneId: p.id, address: "12 rue Larbi Ben M'hidi", postalCode: "31000", phone: "0555 12 34 56 / 041 23 45 67", email: "Dr.Benali@Exemple.dz" }),
      mk({ name: "ville", city: "Blida" }),
      mk({ name: "ambigu", wilaya: "Oran / Alger" }),
      mk({ name: "vide" }),
      mk({ name: "boussaada", city: "Bou Saâda" }),
    ]);
    ids.medecins = m.map((x) => x.id);
    ids.supplier = (await prisma.supplier.create({ data: { name: `${TAG}Fournisseur`, organisationId: o.id, city: "Hyderabad", country: "Inde", address: "Plot 4, Hyderabad", website: "https://www.labo.example.com", phone: "illisible" } })).id;
    ids.contact = (await prisma.companyContact.create({ data: { name: `${TAG}Partenaire`, organisationId: o.id, wilaya: "Sétif", address: "Zone industrielle", phone: "036 12 34 56", phoneAlt: "0661 23 45 67", email: "contact@labo.dz" } })).id;
    ids.personneTard = (await prisma.personne.create({ data: { nom: `${TAG}Tard`, nomReplie: `${TAG}tard` } })).id;
    const mkUser = (s: string, role: SessionUser["role"]) => prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    ids.admin = (await mkUser("admin", "SUPER_ADMIN")).id;
    ids.delegue = (await mkUser("delegue", "MEDICAL_DELEGATE")).id;
  });

  afterAll(async () => {
    await prisma.appSetting.updateMany({ where: { id: "global" }, data: { lieuxDoubleEcriture: interrupteurAvant } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ids.admin, ids.delegue] } } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.personne.deleteMany({ where: { nom: { startsWith: TAG } } });
    await prisma.organisation.deleteMany({ where: { raisonSociale: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  });

  it("le registre suit le contrat : clés uniques, l'ordre de lancement", () => {
    const cles = REPRISES.map((r) => r.cle);
    expect(new Set(cles).size, "clés uniques").toBe(cles.length);
    // Les lieux après les organisations (adresses et coordonnées s'y rattachent), dans leur ordre propre.
    expect(cles.filter((c) => ["lieux-wilaya", "adresses", "points-de-contact"].includes(c))).toEqual(["lieux-wilaya", "adresses", "points-de-contact"]);
    expect(cles.indexOf("organisations")).toBeLessThan(cles.indexOf("adresses"));
    expect(trouverReprise("adresses")).toBe(repriseAdresses);
    expect(trouverReprise("inconnue")).toBeNull();
  });

  it("lieux-wilaya : l'aperçu n'écrit rien", async () => {
    const b = await repriseLieuxWilaya.apercu();
    expect(b.lues).toBeGreaterThanOrEqual(5);
    expect(b.erreurs.some((e) => e.includes(ids.medecins[2]) && e.includes("plusieurs wilayas"))).toBe(true);
    const fiches = await prisma.medicalDoctor.findMany({ where: { id: { in: ids.medecins } }, select: { wilayaCode: true } });
    expect(fiches.every((f) => f.wilayaCode === null)).toBe(true);
  });

  it("lieux-wilaya : rattache, liste l'ambigu, ne touche ni au texte ni à updatedAt ; rejouée, ne change rien", async () => {
    const avant = await prisma.medicalDoctor.findMany({ where: { id: { in: ids.medecins } }, select: { id: true, updatedAt: true } });
    const b = await jusquAuBout(repriseLieuxWilaya, 2);
    expect(b.erreurs.some((e) => e.includes(ids.medecins[2]))).toBe(true);
    const apres = await prisma.medicalDoctor.findMany({ where: { id: { in: ids.medecins } }, select: { id: true, wilaya: true, wilayaCode: true, updatedAt: true } });
    const par = new Map(apres.map((a) => [a.id, a]));
    expect(ids.medecins.map((id) => par.get(id)!.wilayaCode)).toEqual(["31", "09", null, null, "68"]);
    expect(par.get(ids.medecins[0])!.wilaya).toBe("Oran");
    for (const a of avant) expect(par.get(a.id)!.updatedAt.getTime()).toBe(a.updatedAt.getTime());
    expect((await prisma.companyContact.findUniqueOrThrow({ where: { id: ids.contact } })).wilayaCode).toBe("19");
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: ids.supplier } })).wilayaCode).toBeNull();

    const rejouee = await jusquAuBout(repriseLieuxWilaya);
    expect(rejouee.liees).toBe(0);
  });

  it("adresses + points-de-contact : une ligne par chose réelle, pour les seuls titulaires existants ; rejouées, rien de plus", async () => {
    const a1 = await jusquAuBout(repriseAdresses);
    const p1 = await jusquAuBout(reprisePointsDeContact);
    expect(a1.erreurs.some((e) => e.includes(ids.supplier) && e.includes("étranger"))).toBe(true);
    expect(p1.erreurs.some((e) => e.includes(ids.supplier) && e.includes("illisible"))).toBe(true);

    const adrP = await prisma.adresse.findMany({ where: { personneId: ids.personne } });
    expect(adrP).toHaveLength(1);
    expect(adrP[0]).toMatchObject({ ligne1: "12 rue Larbi Ben M'hidi", wilayaCode: "31", codePostal: "31000", type: "AUTRE", source: `IMPORT:MedicalDoctor:${ids.medecins[0]}` });
    const adrO = await prisma.adresse.findMany({ where: { organisationId: ids.organisation } });
    expect(adrO.map((a) => [a.ligne1, a.wilayaCode, a.type])).toEqual([["Zone industrielle", "19", "SIEGE"]]);

    const ptsP = await prisma.pointDeContact.findMany({ where: { personneId: ids.personne }, orderBy: { valeurNormalisee: "asc" } });
    expect(ptsP.map((p) => [p.type, p.valeurNormalisee])).toEqual([["TELEPHONE", "+21341234567"], ["TELEPHONE", "+213555123456"], ["EMAIL", "dr.benali@exemple.dz"]]);
    const ptsO = await prisma.pointDeContact.findMany({ where: { organisationId: ids.organisation } });
    expect(ptsO.map((p) => p.valeurNormalisee).sort()).toEqual(["+21336123456", "+213661234567", "contact@labo.dz", "labo.example.com"]);
    expect(ptsO.find((p) => p.valeurNormalisee === "+213661234567")?.libelle).toBe("Secondaire");

    const a2 = await jusquAuBout(repriseAdresses);
    const p2 = await jusquAuBout(reprisePointsDeContact);
    expect(a2.creees).toBe(0);
    expect(p2.creees).toBe(0);
    expect(await prisma.adresse.count({ where: { OR: [{ personneId: ids.personne }, { organisationId: ids.organisation }] } })).toBe(2);
  });

  it("rejouable après les lots Personnes : une fiche rattachée plus tard est reprise au passage suivant", async () => {
    const tard = await prisma.medicalDoctor.create({ data: { name: `${TAG}tard`, phone: "0770 11 22 33", address: "Cité 500 logements, Batna" } });
    const avant = await reprisePointsDeContact.apercu();
    expect(avant.erreurs.some((e) => /sans Personne ni Organisation/.test(e))).toBe(true);
    await prisma.medicalDoctor.update({ where: { id: tard.id }, data: { personneId: ids.personneTard } });
    await jusquAuBout(repriseAdresses);
    await jusquAuBout(reprisePointsDeContact);
    expect((await prisma.pointDeContact.findMany({ where: { personneId: ids.personneTard } })).map((p) => p.valeurNormalisee)).toEqual(["+213770112233"]);
    expect((await prisma.adresse.findFirstOrThrow({ where: { personneId: ids.personneTard } })).wilayaCode).toBe("05");
  });

  it("double écriture : le code suit le texte, l'interrupteur la coupe", async () => {
    const id = ids.medecins[3];
    await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", lieuxDoubleEcriture: true }, update: { lieuxDoubleEcriture: true } });
    await prisma.medicalDoctor.update({ where: { id }, data: { wilaya: "Tlemcen" } });
    await reposerWilayaCode("MedicalDoctor", id);
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id } })).wilayaCode).toBe("13");
    // Le texte devenu ambigu remet le code à nul : il ne contredit jamais la saisie.
    await prisma.medicalDoctor.update({ where: { id }, data: { wilaya: "Tlemcen, Oran" } });
    await reposerWilayaCode("MedicalDoctor", [id]);
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id } })).wilayaCode).toBeNull();

    await prisma.appSetting.update({ where: { id: "global" }, data: { lieuxDoubleEcriture: false } });
    await prisma.medicalDoctor.update({ where: { id }, data: { wilaya: "Tlemcen" } });
    await reposerWilayaCode("MedicalDoctor", id);
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id } })).wilayaCode).toBeNull();
    await prisma.appSetting.update({ where: { id: "global" }, data: { lieuxDoubleEcriture: true } });
  });

  it("double écriture par le vrai formulaire : l'annuaire des fournisseurs", async () => {
    ACTEUR = await actorFor(ids.admin, "SUPER_ADMIN");
    const f = new FormData();
    f.set("name", `${TAG}Imprimerie du Centre`); f.set("city", "Boumerdès");
    const r = await creerFournisseurAnnuaire(f);
    expect(r.ok).toBe(true);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: r.id! } })).wilayaCode).toBe("35");
    const g = new FormData();
    g.set("id", r.id!); g.set("name", `${TAG}Imprimerie du Centre`); g.set("city", "Lyon"); g.set("country", "France");
    expect((await modifierFournisseurAnnuaire(g)).ok).toBe(true);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: r.id! } })).wilayaCode).toBeNull();
  });

  it("la porte : Super Admin seul ; aperçu et lot au journal, le lot avec son curseur", async () => {
    ACTEUR = await actorFor(ids.delegue, "MEDICAL_DELEGATE");
    expect((await apercuReprise("lieux-wilaya")).ok).toBe(false);
    expect((await executerReprise("lieux-wilaya", null)).ok).toBe(false);
    expect((await reglerDoubleEcritureLieux(false)).ok).toBe(false);

    ACTEUR = await actorFor(ids.admin, "SUPER_ADMIN");
    expect((await executerReprise("inconnue", null)).ok).toBe(false);
    const ap = await apercuReprise("lieux-wilaya");
    expect(ap.ok && ap.bilan.lues).toBeGreaterThan(0);
    const lot = await executerReprise("lieux-wilaya", null);
    expect(lot.ok).toBe(true);
    const journal = await prisma.auditLog.findMany({ where: { actorId: ids.admin, module: "Refonte des données", field: "lieux-wilaya" }, orderBy: { createdAt: "asc" } });
    // Le journal garde UNE ligne par lot exécuté (l'aperçu n'écrit rien), son bilan en JSON avec le curseur suivant.
    expect(journal.map((j) => j.action)).toEqual(["IMPORT"]);
    expect(lot.ok && (JSON.parse(journal[0].newValue ?? "{}") as { suite?: string | null }).suite).toBe(lot.ok ? lot.bilan.suite ?? undefined : false);
  });
});
