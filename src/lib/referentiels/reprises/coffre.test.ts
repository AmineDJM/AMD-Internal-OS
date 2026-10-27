import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { cleRib } from "@/lib/coffre/natures";
import { compterIssues, creerRepriseCoffre, lireCurseur } from "./coffre";
import { REPRISES, repriseParCle } from ".";
import { bilanVide } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REPRISE « COFFRE » (refonte V2-E) — à blanc elle n'écrit rien ; exécutée par lots jusqu'au bout elle
 * copie ; REJOUÉE elle ne recrée rien ; rejouée après la reprise Personnes, elle rattache. Les colonnes en
 * clair ne bougent pas. Bancs sur la base locale, restreints à leurs propres lignes (`creerRepriseCoffre(ids)`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("le curseur et le bilan (purs)", () => {
  it("le curseur parcourt les trois tables dans l'ordre et refuse l'inconnu", () => {
    expect(lireCurseur(null)).toEqual({ modele: "Employee", apres: null });
    expect(lireCurseur("CompanyContact:")).toEqual({ modele: "CompanyContact", apres: null });
    expect(lireCurseur("Employee:ck123")).toEqual({ modele: "Employee", apres: "ck123" });
    expect(lireCurseur("User:x")).toBeNull();
  });

  it("le bilan compte les issues et nomme la colonne d'une valeur refusée, jamais la valeur", () => {
    const b = bilanVide();
    compterIssues(b, "Employee", "e1", [
      { champ: "iban", issue: "CREEE" }, { champ: "nationalId", issue: "REMPLACEE" }, { champ: "baseSalary", issue: "LIEE" },
      { champ: "netToPay", issue: "IGNOREE", raison: "Montant mal formé." }, { champ: "grossSalary", issue: "VIDE" },
    ]);
    expect(b).toMatchObject({ lues: 1, creees: 2, liees: 1, ignorees: 1, doublonsProposes: 0 });
    expect(b.erreurs).toEqual(["Employee e1 · netToPay : Montant mal formé. (laissée en clair, à corriger sur la fiche)."]);
  });

  it("la reprise est inscrite au registre commun", () => {
    expect(REPRISES.map((r) => r.cle)).toContain("coffre");
    expect(repriseParCle("coffre")?.titre).toMatch(/Coffre/);
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const marque = `banc-reprise-${crypto.randomUUID().slice(0, 8)}`;
const base = "002000120001234567";
const RIB = base + cleRib(base);
const ids: string[] = [];

suite("Reprise « coffre » (base locale)", () => {
  let employe = "", contact = "", personne = "";

  beforeAll(async () => {
    employe = (await prisma.employee.create({ data: { fullName: `${marque} A`, iban: RIB, nationalId: "109990001234567890", baseSalary: 90000 } })).id;
    contact = (await prisma.companyContact.create({ data: { name: `${marque} Fournisseur`, rib: "123" } })).id;
    ids.push(employe, contact);
  });

  afterAll(async () => {
    await prisma.donneeSensible.deleteMany({ where: { origineId: { in: ids } } });
    await prisma.employee.deleteMany({ where: { id: employe } });
    await prisma.companyContact.deleteMany({ where: { id: contact } });
    if (personne) await prisma.personne.delete({ where: { id: personne } });
  });

  const jusquAuBout = async (r = creerRepriseCoffre(ids)) => {
    let suite: string | null = null;
    const total = bilanVide();
    let tours = 0;
    do {
      const b = await r.executer({ taille: 1, apresId: suite });
      total.lues += b.lues; total.creees += b.creees; total.liees += b.liees; total.ignorees += b.ignorees; total.erreurs.push(...b.erreurs);
      suite = b.suite;
      if (++tours > 20) throw new Error("la reprise ne termine pas");
    } while (suite !== null);
    return total;
  };

  it("à blanc : le bilan dit ce qui sera copié, et rien n'est écrit", async () => {
    const b = await creerRepriseCoffre(ids).apercu();
    expect(b).toMatchObject({ lues: 2, creees: 3, ignorees: 1 });
    expect(b.erreurs).toEqual([expect.stringContaining(`CompanyContact ${contact} · rib`)]);
    expect(b.erreurs.join(" ")).not.toContain("123 ");
    expect(await prisma.donneeSensible.count({ where: { origineId: { in: ids } } })).toBe(0);
  });

  it("par lots jusqu'au bout : copie ; rejouée : ne recrée rien ; les colonnes ne bougent pas", async () => {
    const une = await jusquAuBout();
    expect(une).toMatchObject({ lues: 2, creees: 3, ignorees: 1 });
    expect(await prisma.donneeSensible.count({ where: { origineId: { in: ids }, remplaceeLe: null } })).toBe(3);
    const deux = await jusquAuBout();
    expect(deux).toMatchObject({ lues: 2, creees: 0, liees: 0 });
    expect(await prisma.donneeSensible.count({ where: { origineId: { in: ids } } })).toBe(3);
    expect(await prisma.employee.findUnique({ where: { id: employe }, select: { iban: true } })).toEqual({ iban: RIB });
  });

  it("rejouée après la reprise Personnes (V2-B), elle rattache chaque copie à la fiche", async () => {
    personne = (await prisma.personne.create({ data: { nom: marque, nomReplie: marque } })).id;
    await prisma.employee.update({ where: { id: employe }, data: { personneId: personne } });
    const b = await jusquAuBout();
    expect(b).toMatchObject({ creees: 0, liees: 3 });
    const copies = await prisma.donneeSensible.findMany({ where: { origineId: employe, remplaceeLe: null } });
    expect(copies.every((c) => c.titulaireType === "PERSONNE" && c.titulaireId === personne)).toBe(true);
    await prisma.employee.update({ where: { id: employe }, data: { personneId: null } });
  });
});
