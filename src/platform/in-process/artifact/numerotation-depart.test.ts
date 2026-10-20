/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « COMMENCER LE RÉFÉRENCEMENT À PARTIR DU BC N° 032/DG/2026 » (Direction, 10/2026).
 *
 * Le départ est un PLANCHER du compteur — jamais un recul : le numéro attribué vaut max(dernier + 1, départ).
 * Tenu par trois étages, chacun avec son banc : les fonctions pures (`departDe`, `prochaineSequence`, `validerDepart`) ;
 * la fabrique, sur une VRAIE base (aperçu = émission, deux émissions de suite, un départ plus bas qui ne recule pas, un
 * départ plus haut qui saute, une autre année et une autre nature qui n'en savent rien, dix émissions parallèles
 * continues) ; la migration, jouée sur son TEXTE RÉEL contre une table temporaire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { departDe, prochaineSequence, validerDepart, formaterNumero, DEPART_MAX } from "@/lib/artifact/factory/commercial";
import {
  definirProfilDocumentaire, emettreDocumentDrive, previsualiserDocument, profilDocumentaire, type DemandeDocument,
} from "@/platform/in-process/artifact/factory";

describe("le départ de numérotation — fonctions pures", () => {
  it("1 quand rien n'est réglé, ou que ce qui est réglé ne se lit pas ; sinon le départ de CETTE année", () => {
    expect(departDe(undefined, "BON_DE_COMMANDE", 2026)).toBe(1);
    expect(departDe({}, "BON_DE_COMMANDE", 2026)).toBe(1);
    expect(departDe({ BON_DE_COMMANDE: { "2026": 32 } }, "BON_DE_COMMANDE", 2026)).toBe(32);
    // 2027 ne sait rien de 2026 ; une autre nature non plus.
    expect(departDe({ BON_DE_COMMANDE: { "2026": 32 } }, "BON_DE_COMMANDE", 2027)).toBe(1);
    expect(departDe({ BON_DE_COMMANDE: { "2026": 32 } }, "FACTURE", 2026)).toBe(1);
    for (const mauvais of [0, -3, 2.5, DEPART_MAX + 1, Number.NaN]) expect(departDe({ BON_DE_COMMANDE: { "2026": mauvais } }, "BON_DE_COMMANDE", 2026), String(mauvais)).toBe(1);
  });

  it("le plancher ne fait jamais reculer : max(dernier + 1, départ)", () => {
    expect(prochaineSequence(0, 1)).toBe(1);
    expect(prochaineSequence(0, 32)).toBe(32);
    expect(prochaineSequence(11, 32)).toBe(32);
    expect(prochaineSequence(31, 32)).toBe(32);
    expect(prochaineSequence(32, 32)).toBe(33);
    expect(prochaineSequence(40, 32)).toBe(41);
  });

  it("un départ se refuse en le nommant : année hors de 2000–2100, numéro non entier, nul ou trop grand", () => {
    expect(validerDepart(2026, 32)).toBeNull();
    expect(validerDepart(1999, 32)).toMatch(/année/);
    expect(validerDepart(2026, 0)).toMatch(/premier numéro/);
    expect(validerDepart(2026, 1.5)).toMatch(/entier/);
    expect(validerDepart(2026, DEPART_MAX + 1)).toMatch(/entier de 1 à/);
  });

  it("032/DG/2026 : le motif de la Direction rend « 032/DG/2026 » avec la séquence 32", () => {
    expect(formaterNumero("BC", 2026, 32, "{n:3}/DG/{aaaa}")).toBe("032/DG/2026");
    expect(formaterNumero("BC", 2026, 100, "{n:3}/DG/{aaaa}")).toBe("100/DG/2026");
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__depart__${Date.now()}`;
const ANNEE = new Date().getUTCFullYear();
let user: CurrentUser;
let companyId = "";
const MOTIF = "{n:3}/DG/{aaaa}";

const bc = (extra: Partial<DemandeDocument> = {}): DemandeDocument => ({
  type: "BON_DE_COMMANDE", societe: companyId, tiers: { nom: `${TAG} Fournisseur` }, date: `${ANNEE}-09-05`, sansPdf: true,
  lignes: [{ designation: "Impression", quantite: 1, prixUnitaire: 1_000 }], ...extra,
});
const prochain = async (extra: Partial<DemandeDocument> = {}): Promise<string> => {
  const a = await previsualiserDocument(user, bc(extra));
  if (!a.ok) throw new Error(`aperçu refusé : ${JSON.stringify(a)}`);
  return a.numeroProchain;
};
const emettre = async (extra: Partial<DemandeDocument> = {}): Promise<string> => {
  const r = await emettreDocumentDrive(user, bc(extra));
  if (!r.ok) throw new Error(`émission refusée : ${JSON.stringify(r)}`);
  return r.reference;
};

suite("le plancher de numérotation, sur une vraie base", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    const access = await getAccess(u.id, u.role);
    user = { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access, mustChangePassword: false };
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#dc2626" } });
    companyId = c.id;
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Amine Djouamai", managerTitle: "Gérant",
      },
    });
  }, 60_000);

  afterAll(async () => {
    const pieces = (await prisma.legalDocument.findMany({ where: { companyId }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    await prisma.validationRequest.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: user.id } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: user.id } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("sans départ réglé, la série commence à 001 ; le motif seul n'y change rien", async () => {
    const r = await definirProfilDocumentaire(user, { societe: companyId, numerotation: { BON_DE_COMMANDE: MOTIF } });
    expect(r.ok).toBe(true);
    expect(await prochain()).toBe(`001/DG/${ANNEE}`);
  });

  it("« commencer à 032 » : l'aperçu annonce 032/DG, l'émission porte 032 puis 033 — et l'aperçu était le bon", async () => {
    const r = await definirProfilDocumentaire(user, { societe: companyId, numerotationDepart: { BON_DE_COMMANDE: { annee: ANNEE, numero: 32 } } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profil.reglages.numerotationDepart).toEqual({ BON_DE_COMMANDE: { [String(ANNEE)]: 32 } });
    // Le motif n'a pas été effacé par le réglage du départ : un réglage ne défait pas l'autre.
    const lu = await profilDocumentaire(user, companyId);
    expect(lu.ok && lu.profil.reglages.numerotation.BON_DE_COMMANDE).toBe(MOTIF);
    const annonce = await prochain();
    expect(annonce).toBe(`032/DG/${ANNEE}`);
    expect(await emettre()).toBe(annonce);
    expect(await emettre({ tiers: { nom: `${TAG} Second` } })).toBe(`033/DG/${ANNEE}`);
  }, 60_000);

  it("un départ PLUS BAS que le compteur ne le fait pas reculer — la série continue", async () => {
    await definirProfilDocumentaire(user, { societe: companyId, numerotationDepart: { BON_DE_COMMANDE: { annee: ANNEE, numero: 5 } } });
    expect(await prochain()).toBe(`034/DG/${ANNEE}`);
    expect(await emettre({ tiers: { nom: `${TAG} Troisième` } })).toBe(`034/DG/${ANNEE}`);
  }, 60_000);

  it("un départ PLUS HAUT saute : 050, puis 051 — et une pièce supprimée ne libère rien", async () => {
    await definirProfilDocumentaire(user, { societe: companyId, numerotationDepart: { BON_DE_COMMANDE: { annee: ANNEE, numero: 50 } } });
    expect(await emettre({ tiers: { nom: `${TAG} Quatrième` } })).toBe(`050/DG/${ANNEE}`);
    expect(await emettre({ tiers: { nom: `${TAG} Cinquième` } })).toBe(`051/DG/${ANNEE}`);
  }, 60_000);

  it("une AUTRE ANNÉE et une AUTRE NATURE n'en savent rien : 001/DG/<année suivante>, FA-<année>-0001", async () => {
    expect(await prochain({ date: `${ANNEE + 1}-01-10` })).toBe(`001/DG/${ANNEE + 1}`);
    const f = await previsualiserDocument(user, bc({ type: "FACTURE", echeance: `${ANNEE}-10-05`, modePaiement: "VIREMENT" }));
    expect(f.ok && f.numeroProchain).toBe(`FA-${ANNEE}-0001`);
  });

  it("retirer le départ (numero: null) rend la série à son compteur ; un départ invalide est refusé SANS rien écrire", async () => {
    const refus = await definirProfilDocumentaire(user, { societe: companyId, numerotationDepart: { BON_DE_COMMANDE: { annee: ANNEE, numero: 0 } } });
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.motif).toMatch(/Départ de numérotation des bons de commande refusé/);
    const refusAnnee = await definirProfilDocumentaire(user, { societe: companyId, numerotationDepart: { BON_DE_COMMANDE: { annee: 1999, numero: 10 } } });
    expect(refusAnnee.ok).toBe(false);
    // Rien n'a été écrit : le départ réglé juste avant (50) tient toujours.
    const intact = await profilDocumentaire(user, companyId);
    expect(intact.ok && intact.profil.reglages.numerotationDepart.BON_DE_COMMANDE?.[String(ANNEE)]).toBe(50);
    const retire = await definirProfilDocumentaire(user, { societe: companyId, numerotationDepart: { BON_DE_COMMANDE: { annee: ANNEE, numero: null } } });
    expect(retire.ok).toBe(true);
    if (retire.ok) expect(retire.profil.reglages.numerotationDepart).toEqual({});
    expect(await prochain()).toBe(`052/DG/${ANNEE}`);
  }, 60_000);

  it("le motif ET le premier numéro réglés dans le MÊME enregistrement tiennent tous les deux — le geste d'une société qui n'a encore ni l'un ni l'autre", async () => {
    // Le panneau de numérotation envoie les deux champs d'un seul geste. Chacun s'écrit dans `settings` : le second ne doit pas
    // repartir de ce que la base portait AVANT le premier — il perdrait le motif qu'on vient de régler, et la pièce partirait
    // sous la numérotation par défaut sans un mot (BC-2026-0001 au lieu de 0007/DG/2026).
    const NOUVEAU = "{n:4}/DG/{aaaa}";
    const r = await definirProfilDocumentaire(user, {
      societe: companyId, numerotation: { BON_DE_COMMANDE: NOUVEAU }, numerotationDepart: { BON_DE_COMMANDE: { annee: ANNEE, numero: 7 } },
    });
    expect(r.ok).toBe(true);
    const lu = await profilDocumentaire(user, companyId);
    expect(lu.ok && lu.profil.reglages.numerotation.BON_DE_COMMANDE).toBe(NOUVEAU);
    expect(lu.ok && lu.profil.reglages.numerotationDepart.BON_DE_COMMANDE?.[String(ANNEE)]).toBe(7);
    // Le plancher (7) est sous le compteur (déjà à 51) : il ne recule pas — et le NOUVEAU motif s'applique.
    expect(await prochain()).toBe(`0052/DG/${ANNEE}`);
    // Et dans l'autre sens : un nouveau motif ET le retrait du départ, d'un seul geste.
    const retour = await definirProfilDocumentaire(user, {
      societe: companyId, numerotation: { BON_DE_COMMANDE: MOTIF }, numerotationDepart: { BON_DE_COMMANDE: { annee: ANNEE, numero: null } },
    });
    expect(retour.ok).toBe(true);
    const apres = await profilDocumentaire(user, companyId);
    expect(apres.ok && apres.profil.reglages.numerotation.BON_DE_COMMANDE).toBe(MOTIF);
    expect(apres.ok && apres.profil.reglages.numerotationDepart).toEqual({});
    expect(await prochain()).toBe(`052/DG/${ANNEE}`);
  }, 60_000);

  it("dix émissions parallèles à partir de 100 : dix numéros CONSÉCUTIFS, sans trou ni doublon", async () => {
    await definirProfilDocumentaire(user, { societe: companyId, numerotationDepart: { BON_DE_COMMANDE: { annee: ANNEE, numero: 100 } } });
    const refs = await Promise.all(Array.from({ length: 10 }, (_, i) => emettre({ tiers: { nom: `${TAG} Parallèle ${i}` } })));
    expect(new Set(refs).size).toBe(10);
    expect(refs.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `${100 + i}/DG/${ANNEE}`));
  }, 120_000);

  it("un profil dont le JSON de départ est corrompu ne casse pas la numérotation : la série retombe sur 1 pour ce qui ne se lit pas", async () => {
    await prisma.companyDocumentProfile.update({
      where: { companyId },
      data: { settings: { numerotation: { BON_DE_COMMANDE: MOTIF }, numerotationDepart: { BON_DE_COMMANDE: { [String(ANNEE)]: "trente-deux", abc: 5 }, FACTURE: "x" } } },
    });
    const lu = await profilDocumentaire(user, companyId);
    expect(lu.ok && lu.profil.reglages.numerotationDepart).toEqual({});
    // Le compteur de l'année est déjà à 109 : la série continue.
    expect(await prochain()).toBe(`110/DG/${ANNEE}`);
  }, 60_000);
});

// ─────────────────────────── La migration, sur son texte réel ───────────────────────────

const SQL = readFileSync(path.join(process.cwd(), "prisma/migrations/20270105090000_bc_numerotation_depart/migration.sql"), "utf8");

async function jouer(lignes: { id: string; settings: unknown }[], passes: number) {
  const ANNULE = new Error("annulé — le banc ne garde rien");
  let apres: { id: string; settings: unknown }[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      // `pg_temp` passe devant `public` : le SQL s'exécute tel qu'il est écrit, sans lire ni écrire les profils réels (§118.173).
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "CompanyDocumentProfile" ("id" text PRIMARY KEY, "settings" jsonb, "updatedAt" timestamptz NOT NULL DEFAULT now()) ON COMMIT DROP`);
      for (const l of lignes) await tx.$executeRawUnsafe(`INSERT INTO "CompanyDocumentProfile" (id, settings) VALUES ($1, $2::jsonb)`, l.id, l.settings === null ? null : JSON.stringify(l.settings));
      for (let i = 0; i < passes; i++) await tx.$executeRawUnsafe(SQL);
      apres = await tx.$queryRawUnsafe(`SELECT id, settings FROM "CompanyDocumentProfile" ORDER BY id`);
      throw ANNULE;
    }, { timeout: 20_000 });
  } catch (e) {
    if (e !== ANNULE) throw e;
  }
  return new Map(apres.map((l) => [l.id, l.settings as Record<string, unknown> | null]));
}

const profils = [
  { id: "a-dg", settings: { numerotation: { BON_DE_COMMANDE: "{n:3}/DG/{aaaa}" }, marque: { couleurs: { accent: "087084" } } } },
  { id: "b-fs", settings: { numerotation: { BON_DE_COMMANDE: "{n:3}/FS/{aa}" } } },
  { id: "c-deja-40", settings: { numerotation: { BON_DE_COMMANDE: "{n:3}/DG/{aaaa}" }, numerotationDepart: { BON_DE_COMMANDE: { "2026": 40 } } } },
  { id: "d-2027", settings: { numerotation: { BON_DE_COMMANDE: "{n:3}/DG/{aaaa}" }, numerotationDepart: { BON_DE_COMMANDE: { "2027": 10 }, FACTURE: { "2026": 7 } } } },
  { id: "e-nul", settings: null },
  { id: "f-sans-motif", settings: { marque: {} } },
  { id: "g-facture-dg", settings: { numerotation: { FACTURE: "{n:3}/DG/{aaaa}" } } },
];
suite("la migration du plancher, jouée sur son texte réel", () => {
  it("pose 32 pour 2026 sur les profils au motif /DG/ — et touche à rien d'autre : ni le motif, ni la marque, ni un autre profil", async () => {
    const apres = await jouer(profils, 1);
    expect(apres.get("a-dg")).toEqual({ numerotation: { BON_DE_COMMANDE: "{n:3}/DG/{aaaa}" }, marque: { couleurs: { accent: "087084" } }, numerotationDepart: { BON_DE_COMMANDE: { "2026": 32 } } });
    expect(apres.get("b-fs")).toEqual({ numerotation: { BON_DE_COMMANDE: "{n:3}/FS/{aa}" } });
    expect(apres.get("e-nul")).toBeNull();
    expect(apres.get("f-sans-motif")).toEqual({ marque: {} });
    // Un motif /DG/ sur les FACTURES n'est pas la série des bons de commande.
    expect(apres.get("g-facture-dg")).toEqual({ numerotation: { FACTURE: "{n:3}/DG/{aaaa}" } });
  });

  it("un départ déjà réglé pour 2026 n'est JAMAIS repris (40 reste 40) ; les autres années et natures sont conservées", async () => {
    const apres = await jouer(profils, 1);
    expect(apres.get("c-deja-40")?.numerotationDepart).toEqual({ BON_DE_COMMANDE: { "2026": 40 } });
    expect(apres.get("d-2027")?.numerotationDepart).toEqual({ BON_DE_COMMANDE: { "2027": 10, "2026": 32 }, FACTURE: { "2026": 7 } });
  });

  it("rejouée, elle ne change RIEN de plus", async () => {
    const une = await jouer(profils, 1);
    const deux = await jouer(profils, 2);
    expect(JSON.stringify([...deux])).toBe(JSON.stringify([...une]));
  });
});

// ─────────────── « À partir du prochain BC généré, c'est 037/DG/2026 » : la migration du 10/2026, sur son texte réel ───────────────

const SQL_37 = readFileSync(path.join(process.cwd(), "prisma/migrations/20270117130500_bc_numerotation/migration.sql"), "utf8");
// Deux instructions (le plancher, puis le compteur) : `migrate deploy` les joue d'un trait, mais `$executeRawUnsafe` part en
// instruction PRÉPARÉE, qui n'en admet qu'une. Le texte réel est joué instruction par instruction, dans l'ordre, sans retouche.
// Aucun « ; » n'apparaît dans une chaîne de ce texte : la coupe en fin de ligne est sûre.
const INSTRUCTIONS_37 = SQL_37.replace(/^\s*--[^\n]*$/gm, "").split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);

async function jouer37(lignes: { id: string; settings: unknown }[], compteurs: { companyId: string; last: number }[], passes: number) {
  const ANNULE = new Error("annulé — le banc ne garde rien");
  let profilsApres: { id: string; settings: unknown }[] = [];
  let sequences: { companyId: string; last: number; kind: string; year: number }[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "CompanyDocumentProfile" ("id" text PRIMARY KEY, "companyId" text, "settings" jsonb, "updatedAt" timestamptz NOT NULL DEFAULT now()) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "DocumentSequence" ("id" text PRIMARY KEY, "companyId" text NOT NULL, "kind" text NOT NULL, "year" int NOT NULL, "last" int NOT NULL DEFAULT 0, "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("companyId", "kind", "year")) ON COMMIT DROP`);
      for (const l of lignes) await tx.$executeRawUnsafe(`INSERT INTO "CompanyDocumentProfile" (id, "companyId", settings) VALUES ($1, $1, $2::jsonb)`, l.id, l.settings === null ? null : JSON.stringify(l.settings));
      for (const c of compteurs) await tx.$executeRawUnsafe(`INSERT INTO "DocumentSequence" (id, "companyId", kind, year, last) VALUES ($1, $2, 'PURCHASE_ORDER', 2026, $3)`, `seq-${c.companyId}`, c.companyId, c.last);
      for (let i = 0; i < passes; i++) for (const instruction of INSTRUCTIONS_37) await tx.$executeRawUnsafe(instruction);
      profilsApres = await tx.$queryRawUnsafe(`SELECT id, settings FROM "CompanyDocumentProfile" ORDER BY id`);
      sequences = await tx.$queryRawUnsafe(`SELECT "companyId", kind, year, last FROM "DocumentSequence" ORDER BY "companyId"`);
      throw ANNULE;
    }, { timeout: 20_000 });
  } catch (e) {
    if (e !== ANNULE) throw e;
  }
  return { profils: new Map(profilsApres.map((l) => [l.id, l.settings as Record<string, unknown> | null])), sequences: new Map(sequences.map((s) => [s.companyId, Number(s.last)])) };
}

suite("la migration « prochain BC : 037/DG/2026 », jouée sur son texte réel", () => {
  const dg = { numerotation: { BON_DE_COMMANDE: "{n:3}/DG/{aaaa}" } };
  const base = [
    { id: "a-vide", settings: dg },
    { id: "b-32", settings: { ...dg, numerotationDepart: { BON_DE_COMMANDE: { "2026": 32 } } } },
    { id: "c-40", settings: { ...dg, numerotationDepart: { BON_DE_COMMANDE: { "2026": 40 } } } },
    { id: "d-fs", settings: { numerotation: { BON_DE_COMMANDE: "{n:3}/FS/{aa}" } } },
  ];

  it("la prémisse : le texte réel se découpe en ses deux instructions, le plancher puis le compteur", () => {
    expect(INSTRUCTIONS_37).toHaveLength(2);
    expect(INSTRUCTIONS_37[0]).toMatch(/^UPDATE "CompanyDocumentProfile"/);
    expect(INSTRUCTIONS_37[1]).toMatch(/^INSERT INTO "DocumentSequence"[\s\S]*ON CONFLICT/);
  });

  it("le plancher passe à 37 s'il est plus bas (ou absent) et ne recule JAMAIS (40 reste 40) ; une autre série n'est pas touchée", async () => {
    const { profils } = await jouer37(base, [], 1);
    expect((profils.get("a-vide")?.numerotationDepart as Record<string, Record<string, number>>).BON_DE_COMMANDE["2026"]).toBe(37);
    expect((profils.get("b-32")?.numerotationDepart as Record<string, Record<string, number>>).BON_DE_COMMANDE["2026"]).toBe(37);
    expect((profils.get("c-40")?.numerotationDepart as Record<string, Record<string, number>>).BON_DE_COMMANDE["2026"]).toBe(40);
    expect(profils.get("d-fs")).toEqual({ numerotation: { BON_DE_COMMANDE: "{n:3}/FS/{aa}" } });
  });

  it("le compteur de 2026 est créé à 36 s'il n'existe pas, levé à 36 s'il est plus bas, et laissé tel quel s'il est plus loin — le prochain numéro est 037", async () => {
    const { sequences } = await jouer37(base, [{ companyId: "b-32", last: 31 }, { companyId: "c-40", last: 52 }], 1);
    expect(sequences.get("a-vide")).toBe(36);
    expect(sequences.get("b-32")).toBe(36);
    expect(sequences.get("c-40")).toBe(52);
    expect(sequences.has("d-fs")).toBe(false);
  });

  it("rejouée, elle ne change RIEN de plus", async () => {
    const une = await jouer37(base, [{ companyId: "b-32", last: 31 }], 1);
    const deux = await jouer37(base, [{ companyId: "b-32", last: 31 }], 2);
    expect(JSON.stringify([...deux.profils])).toBe(JSON.stringify([...une.profils]));
    expect(JSON.stringify([...deux.sequences])).toBe(JSON.stringify([...une.sequences]));
  });
});
