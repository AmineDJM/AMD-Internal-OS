import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { clesDepuisMaitresse } from "./cle";
import { copierAuCoffre } from "./copies";
import { doubleEcrireCoffre } from "./ecriture";
import { lireSensibles } from "./lecture";
import { cleRib } from "../domaine/natures";
import type { LecteurCoffre } from "../domaine/politique";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COFFRE EN DOUBLE ÉCRITURE ET DOUBLE LECTURE (refonte V2-E), sur la base LOCALE.
 *
 *   1. la copie d'une colonne est chiffrée, rejouable sans doublon, remplacée et datée quand la valeur
 *      change, datée quand la colonne se vide ; une valeur mal formée n'entre pas ;
 *   2. la lecture décide par la politique, JOURNALISE accord et refus, déchiffre la copie à jour, rend le
 *      masque seul à qui n'a pas le droit — et ne dit rien du tout tant que l'interrupteur est fermé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const cles = clesDepuisMaitresse(crypto.randomBytes(32));
const dep = { cles: () => cles };
const marque = `banc-coffre-${crypto.randomUUID().slice(0, 8)}`;
const base = "007999990001234567";
const RIB = base + cleRib(base);
const IBAN = "DZ3500400174401234567891";
const NIN = "109990001234567890";

const lecteur = (o: Partial<Extract<LecteurCoffre, { genre: "UTILISATEUR" }>>): LecteurCoffre => ({
  genre: "UTILISATEUR", userId: "u-banc", superAdmin: false, tientRH: false, tientFinances: false, ...o,
});

let employeId = "";
let contactId = "";

suite("Coffre — copies et double lecture (base locale)", () => {
  beforeAll(async () => {
    employeId = (await prisma.employee.create({ data: { fullName: `${marque} Amina`, iban: IBAN, nationalId: NIN, baseSalary: 185000 } })).id;
    contactId = (await prisma.companyContact.create({ data: { name: `${marque} Imprimerie`, rib: RIB } })).id;
  });

  afterAll(async () => {
    const ids = [employeId, contactId].filter(Boolean);
    await prisma.accesDonneeSensible.deleteMany({ where: { origineId: { in: ids } } });
    await prisma.donneeSensible.deleteMany({ where: { origineId: { in: ids } } });
    if (employeId) await prisma.employee.delete({ where: { id: employeId } });
    if (contactId) await prisma.companyContact.delete({ where: { id: contactId } });
  });

  const copies = (origineId: string) => prisma.donneeSensible.findMany({ where: { origineId }, orderBy: { createdAt: "asc" } });

  it("copie chiffrée, aucune valeur en clair au coffre ; rejouée, rien ne bouge", async () => {
    const valeurs = { iban: IBAN, nationalId: NIN, baseSalary: "185000", grossSalary: null, netToPay: null, employerCost: null };
    const une = await copierAuCoffre(prisma, { modele: "Employee", origineId: employeId, valeurs, titulaire: null, parId: null }, dep);
    expect(Object.fromEntries(une.map((r) => [r.champ, r.issue]))).toEqual({
      iban: "CREEE", nationalId: "CREEE", baseSalary: "CREEE", grossSalary: "VIDE", netToPay: "VIDE", employerCost: "VIDE",
    });
    const lignes = await copies(employeId);
    expect(lignes.map((l) => [l.origineChamp, l.nature, l.derniersCaracteres])).toEqual([
      ["iban", "IBAN", "7891"], ["nationalId", "NIN", "7890"], ["baseSalary", "SALAIRE", null],
    ]);
    const tout = JSON.stringify(lignes.map((l) => ({ ...l, valeurChiffree: Buffer.from(l.valeurChiffree).toString("latin1") })));
    for (const clair of [IBAN, NIN, "185000"]) expect(tout).not.toContain(clair);

    const deux = await copierAuCoffre(prisma, { modele: "Employee", origineId: employeId, valeurs, titulaire: null, parId: null }, dep);
    expect(deux.filter((r) => r.issue !== "VIDE").map((r) => r.issue)).toEqual(["INCHANGEE", "INCHANGEE", "INCHANGEE"]);
    expect(await copies(employeId)).toHaveLength(3);
  });

  it("une nouvelle valeur remplace et date l'ancienne ; une colonne vidée date sa copie ; une valeur fausse n'entre pas", async () => {
    const r = await copierAuCoffre(prisma, { modele: "Employee", origineId: employeId, valeurs: { iban: RIB, nationalId: "", baseSalary: "12AB" }, titulaire: null, parId: "u-rh" }, dep);
    expect(r).toEqual([
      { champ: "iban", issue: "REMPLACEE" },
      { champ: "nationalId", issue: "EFFACEE" },
      { champ: "baseSalary", issue: "IGNOREE", raison: expect.stringMatching(/Montant/) },
    ]);
    expect(JSON.stringify(r)).not.toContain("12AB");
    const lignes = await copies(employeId);
    expect(lignes.filter((l) => !l.remplaceeLe).map((l) => [l.origineChamp, l.nature])).toEqual([["iban", "RIB"]]);
    expect(lignes.filter((l) => l.remplaceeLe)).toHaveLength(3);
    // Remettre la fiche dans son état de départ pour la lecture.
    await copierAuCoffre(prisma, { modele: "Employee", origineId: employeId, valeurs: { iban: IBAN, nationalId: NIN, baseSalary: "185000" }, titulaire: null, parId: null }, dep);
  });

  it("le titulaire posé plus tard (reprises V2-B/V2-C) rattache la copie sans la rechiffrer", async () => {
    const personne = await prisma.personne.create({ data: { nom: marque, nomReplie: marque } });
    try {
      const r = await copierAuCoffre(prisma, { modele: "Employee", origineId: employeId, valeurs: { iban: IBAN }, titulaire: { genre: "PERSONNE", personneId: personne.id }, parId: null }, dep);
      expect(r).toEqual([{ champ: "iban", issue: "LIEE" }]);
      const c = await prisma.donneeSensible.findFirst({ where: { origineId: employeId, origineChamp: "iban", remplaceeLe: null } });
      expect(c).toMatchObject({ titulaireType: "PERSONNE", titulaireId: personne.id });
    } finally {
      await prisma.donneeSensible.updateMany({ where: { origineId: employeId }, data: { titulaireType: null, titulaireId: null } });
      await prisma.personne.delete({ where: { id: personne.id } });
    }
  });

  it("interrupteur fermé : la colonne telle quelle, aucun journal", async () => {
    const avant = await prisma.accesDonneeSensible.count({ where: { origineId: employeId } });
    const l = await lireSensibles({ lecteur: lecteur({}), modele: "Employee", lignes: [{ id: employeId, clair: { iban: IBAN } }], champs: ["iban"], geste: "x" }, { ...dep, lectureActive: false });
    expect(l.get(employeId)!.iban).toEqual({ valeur: IBAN, masque: "•••• 7891", lu: true });
    expect(await prisma.accesDonneeSensible.count({ where: { origineId: employeId } })).toBe(avant);
  });

  it("interrupteur ouvert : RH lit le NIN et le salaire, pas l'IBAN — chaque décision au journal", async () => {
    const rh = lecteur({ userId: "u-rh-banc", tientRH: true });
    const l = await lireSensibles({
      lecteur: rh, modele: "Employee", geste: "Fiche employé — consultation",
      lignes: [{ id: employeId, clair: { iban: IBAN, nationalId: NIN, baseSalary: 185000 } }],
      champs: ["iban", "nationalId", "baseSalary"],
    }, { ...dep, lectureActive: true });
    expect(l.get(employeId)).toEqual({
      iban: { valeur: null, masque: "•••• 7891", lu: false },
      nationalId: { valeur: NIN, masque: "•••• 7890", lu: true },
      baseSalary: { valeur: "185000.00", masque: "•••••• DZD", lu: true },
    });
    const journal = await prisma.accesDonneeSensible.findMany({ where: { origineId: employeId, userId: "u-rh-banc" }, orderBy: { origineChamp: "asc" } });
    expect(journal.map((j) => [j.origineChamp, j.nature, j.autorise, j.motif, j.geste])).toEqual([
      ["baseSalary", "SALAIRE", true, "RH", "Fiche employé — consultation"],
      ["iban", "IBAN", false, "HORS_PERIMETRE", "Fiche employé — consultation"],
      ["nationalId", "NIN", true, "RH", "Fiche employé — consultation"],
    ]);
    expect(journal.every((j) => j.donneeSensibleId)).toBe(true);
  });

  it("la valeur lue vient du COFFRE quand la copie est à jour, de la colonne sinon", async () => {
    const fin = lecteur({ userId: "u-fin-banc", tientFinances: true });
    const lire = (clair: string) => lireSensibles({ lecteur: fin, modele: "Employee", geste: "Ordre de virement", lignes: [{ id: employeId, clair: { iban: clair } }], champs: ["iban"] }, { ...dep, lectureActive: true });
    // Saisie avec espaces : la copie à jour rend la forme CANONIQUE déchiffrée.
    expect((await lire(IBAN.replace(/(.{4})/g, "$1 "))).get(employeId)!.iban.valeur).toBe(IBAN);
    // Colonne changée pendant que l'écriture double était fermée : la colonne fait foi.
    expect((await lire(RIB)).get(employeId)!.iban.valeur).toBe(RIB);
  });

  it("une pièce officielle imprime le RIB d'un partenaire au nom de qui la génère ; une consultation hors Finances ne voit que le masque", async () => {
    const qui = lecteur({ userId: "u-adpro-banc" });
    const lire = (usage: "CONSULTATION" | "PIECE_OFFICIELLE") => lireSensibles({ lecteur: qui, modele: "CompanyContact", geste: "Bon de commande — impression", usage, lignes: [{ id: contactId, clair: { rib: RIB } }], champs: ["rib"] }, { ...dep, lectureActive: true });
    expect((await lire("CONSULTATION")).get(contactId)!.rib).toEqual({ valeur: null, masque: `•••• ${RIB.slice(-4)}`, lu: false });
    expect((await lire("PIECE_OFFICIELLE")).get(contactId)!.rib).toMatchObject({ valeur: RIB, lu: true });
    const j = await prisma.accesDonneeSensible.findMany({ where: { origineId: contactId }, orderBy: { createdAt: "asc" } });
    expect(j.map((x) => [x.autorise, x.motif])).toEqual([[false, "HORS_PERIMETRE"], [true, "PIECE_OFFICIELLE"]]);
    expect(j[1].donneeSensibleId).toBeNull(); // jamais copié : lu sur la colonne, journalisé quand même
  });

  it("un modèle d'IA ne lit rien, même pour une pièce officielle — et son refus est journalisé à son nom", async () => {
    const l = await lireSensibles({
      lecteur: { genre: "IA", nom: "assistant" }, modele: "Employee", geste: "Réponse à une question", usage: "PIECE_OFFICIELLE",
      lignes: [{ id: employeId, clair: { iban: IBAN, nationalId: NIN, baseSalary: 185000 } }], champs: ["iban", "nationalId", "baseSalary"],
    }, { ...dep, lectureActive: true });
    expect(Object.values(l.get(employeId)!).map((c) => c.valeur)).toEqual([null, null, null]);
    expect(JSON.stringify([...l.values()])).not.toMatch(new RegExp(`${NIN}|${IBAN}|185000`));
    const j = await prisma.accesDonneeSensible.findMany({ where: { origineId: employeId, lecteurNom: "assistant" } });
    expect(j).toHaveLength(3);
    expect(j.every((x) => !x.autorise && x.motif === "MODELE_IA" && x.userId === null)).toBe(true);
  });

  it("sans geste, aucune lecture", async () => {
    await expect(lireSensibles({ lecteur: lecteur({ superAdmin: true }), modele: "Employee", geste: " ", lignes: [{ id: employeId, clair: { iban: IBAN } }], champs: ["iban"] }, { ...dep, lectureActive: true })).rejects.toThrow(/geste/);
  });
});

suite("Coffre — double écriture (base locale)", () => {
  let id = "";
  beforeAll(async () => { id = (await prisma.employee.create({ data: { fullName: `${marque} Écriture`, nationalId: NIN } })).id; });
  afterAll(async () => {
    await prisma.donneeSensible.deleteMany({ where: { origineId: id } });
    await prisma.employee.delete({ where: { id } });
  });

  it("interrupteur fermé : rien n'est écrit", async () => {
    expect(await doubleEcrireCoffre("Employee", id, { nationalId: NIN }, null, undefined, false)).toBeNull();
    expect(await prisma.donneeSensible.count({ where: { origineId: id } })).toBe(0);
  });

  it("ouvert : la copie suit l'écriture, dans la transaction de l'écrivain quand il en a une", async () => {
    expect(await doubleEcrireCoffre("Employee", id, { nationalId: NIN, fullName: "ignoré" }, "u-rh", undefined, true)).toEqual([{ champ: "nationalId", issue: "CREEE" }]);
    // Une transaction annulée emporte la copie avec l'écriture métier.
    await expect(prisma.$transaction(async (tx) => {
      await tx.employee.update({ where: { id }, data: { iban: RIB } });
      await doubleEcrireCoffre("Employee", id, { iban: RIB }, "u-rh", tx, true);
      throw new Error("annulée");
    })).rejects.toThrow("annulée");
    expect(await prisma.donneeSensible.findMany({ where: { origineId: id }, select: { origineChamp: true } })).toEqual([{ origineChamp: "nationalId" }]);
  });
});
