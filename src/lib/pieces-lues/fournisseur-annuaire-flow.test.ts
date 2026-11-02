import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { IDENTITE_VIDE, type IdentiteEmetteur } from "./emetteur";
import { fournisseurDuDevisDansLAnnuaire } from "./fournisseur-annuaire";

/**
 * LE FOURNISSEUR D'UN DEVIS DÉPOSÉ ENTRE DANS L'ANNUAIRE (Direction, 02/11/2026) — sur une vraie base.
 *
 *   • deux devis du même fournisseur inconnu, déposés EN MÊME TEMPS : UNE fiche (le verrou), les deux devis rattachés ;
 *   • la fiche créée est un « Fournisseur », tracée (note : devis, date, déposant ; journal d'audit), sans droit d'annuaire ;
 *   • reconnu par son NIF : aucune création ; une partie déjà choisie n'est jamais remplacée ;
 *   • sans nom : rien.
 */
const TAG = `fa-${Date.now().toString(36)}-`;
const NIF = `0009${Date.now().toString().slice(-11)}`; // 15 chiffres, propre à ce banc
const lu = (x: Partial<IdentiteEmetteur>): IdentiteEmetteur => ({ ...IDENTITE_VIDE, ...x });

let userId = "";
const docs: string[] = [];
const devis = async (titre: string, parties: string[] = []) => {
  const d = await prisma.legalDocument.create({ data: { title: `${TAG}${titre}`, kind: "QUOTE", counterpartyIds: parties }, select: { id: true } });
  docs.push(d.id);
  return d.id;
};

beforeAll(async () => {
  // Une COORDINATRICE, sans droit d'écriture dans l'annuaire : l'ajout est un geste automatique, pas une saisie.
  userId = (await prisma.user.create({ data: { name: `${TAG}Samia`, email: `${TAG}samia@t.dz`, role: "COORDINATOR", passwordHash: "x" } })).id;
});

afterAll(async () => {
  await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } });
  await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => undefined);
  await prisma.companyContact.deleteMany({ where: { OR: [{ name: { startsWith: TAG } }, { createdById: userId }] } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("le fournisseur d'un devis déposé, dans l'annuaire", () => {
  it("deux dépôts simultanés du même fournisseur inconnu : UNE fiche, tracée, et les deux devis rattachés", async () => {
    const [a, b] = [await devis("devis A"), await devis("devis B")];
    const identite = lu({ nom: `${TAG}Atlas Événementiel`, nif: NIF, adresse: "3, rue Ben M'hidi, Alger", telephone: "023 45 67 89" });
    const [ra, rb] = await Promise.all([
      fournisseurDuDevisDansLAnnuaire({ userId, legalDocumentId: a, identite, groupe: {} }),
      fournisseurDuDevisDansLAnnuaire({ userId, legalDocumentId: b, identite, groupe: {} }),
    ]);
    const statuts = [ra?.statut, rb?.statut].sort();
    expect(statuts).toEqual(["CREE", "RECONNU"]);

    const fiches = await prisma.companyContact.findMany({ where: { nif: NIF } });
    expect(fiches).toHaveLength(1);
    const [f] = fiches;
    expect(f).toMatchObject({ name: `${TAG}Atlas Événementiel`, kind: "Fournisseur", sphere: "PRIVE", address: "3, rue Ben M'hidi, Alger", phone: "023 45 67 89", createdById: userId, isActive: true });
    expect(f.notes).toMatch(/^Ajouté automatiquement à l'annuaire depuis le devis « fa-.* », déposé le \d\d\/\d\d\/\d{4} par fa-.*Samia/);

    const rattaches = await prisma.legalDocument.findMany({ where: { id: { in: [a, b] } }, select: { counterpartyIds: true, counterparty: true } });
    expect(rattaches.map((d) => d.counterpartyIds)).toEqual([[f.id], [f.id]]);
    expect(rattaches.every((d) => d.counterparty === f.name)).toBe(true);

    const audit = await prisma.auditLog.findMany({ where: { actorId: userId, summary: { contains: "ajouté automatiquement à l'annuaire" } } });
    expect(audit).toHaveLength(1);
  });

  it("reconnu par son NIF : aucune création, et une partie déjà choisie n'est jamais remplacée", async () => {
    const autre = await prisma.companyContact.create({ data: { name: `${TAG}Partie choisie` }, select: { id: true } });
    const c = await devis("devis C", [autre.id]);
    const r = await fournisseurDuDevisDansLAnnuaire({ userId, legalDocumentId: c, identite: lu({ nom: "Atlas (autre graphie)", nif: NIF }), groupe: {} });
    expect(r).toMatchObject({ statut: "RECONNU", nom: `${TAG}Atlas Événementiel` });
    expect(await prisma.companyContact.count({ where: { nif: NIF } })).toBe(1);
    expect((await prisma.legalDocument.findUnique({ where: { id: c }, select: { counterpartyIds: true } }))?.counterpartyIds).toEqual([autre.id]);
  });

  it("sans nom lisible : rien n'est créé, et le devis le dit", async () => {
    const d = await devis("devis D");
    const avant = await prisma.companyContact.count();
    const r = await fournisseurDuDevisDansLAnnuaire({ userId, legalDocumentId: d, identite: lu({ nif: "000999888777666" }), groupe: {} });
    expect(r).toEqual({ statut: "SANS_NOM" });
    expect(await prisma.companyContact.count()).toBe(avant);
  });
});
