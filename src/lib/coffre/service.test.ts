import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { clesDepuisMaitresse } from "./cle";
import { creerDepotPrisma, type ClientPrismaCoffre, type LigneAccesDonneeSensible, type LigneDonneeSensible } from "./depot-prisma";
import { cleRib } from "./natures";
import type { LecteurCoffre } from "./politique";
import { creerServiceCoffre } from "./service";

/**
 * Le service est éprouvé À TRAVERS le dépôt Prisma, sur un client en mémoire qui a la forme des
 * tables : les deux couches sont couvertes, sans base (la base réelle : `copies.test.ts`).
 */
function clientEnMemoire() {
  const donnees: LigneDonneeSensible[] = [];
  const acces: LigneAccesDonneeSensible[] = [];
  const tx = {
    donneeSensible: {
      async create({ data }: { data: LigneDonneeSensible }) { donnees.push({ ...data }); return data; },
      async findUnique({ where }: { where: { id: string } }) { return donnees.find((d) => d.id === where.id) ?? null; },
      async findMany({ where }: { where: Record<string, unknown> }) {
        // `remplaceeLe` n'est pas une colonne du dépôt par titulaire : toutes ses lignes sont courantes.
        return donnees.filter((d) => Object.entries(where).every(([k, v]) => k === "remplaceeLe" || d[k as keyof LigneDonneeSensible] === v));
      },
    },
    accesDonneeSensible: {
      async create({ data }: { data: LigneAccesDonneeSensible }) { acces.push({ ...data }); return data; },
    },
  };
  let echecJournal = false;
  const client: ClientPrismaCoffre = {
    ...tx,
    async $transaction(fn) {
      const avant = { d: donnees.length, a: acces.length };
      try {
        const r = await fn({
          ...tx,
          accesDonneeSensible: { create: async (a) => { if (echecJournal) throw new Error("journal indisponible"); return tx.accesDonneeSensible.create(a); } },
        });
        return r;
      } catch (e) {
        donnees.length = avant.d; acces.length = avant.a;
        throw e;
      }
    },
  };
  return { client, donnees, acces, casserJournal: () => { echecJournal = true; } };
}

const cles = clesDepuisMaitresse(crypto.randomBytes(32));
const base = "007999990001234567";
const RIB = base + cleRib(base);
const comptes: Record<string, string> = { "p-amina": "u-amina" };

function monter() {
  const mem = clientEnMemoire();
  let n = 0;
  const coffre = creerServiceCoffre({
    depot: creerDepotPrisma(mem.client),
    cles: () => cles,
    compteDe: async (pid) => comptes[pid] ?? null,
    horloge: () => new Date("2026-10-27T10:00:00Z"),
    nouvelId: () => `d${++n}`,
  });
  return { coffre, ...mem };
}

const amina = { genre: "PERSONNE" as const, personneId: "p-amina" };
const fournisseur = { genre: "ORGANISATION" as const, organisationId: "o-imprimerie" };
const lecteur = (o: Partial<Extract<LecteurCoffre, { genre: "UTILISATEUR" }>>): LecteurCoffre => ({
  genre: "UTILISATEUR", userId: "u-autre", superAdmin: false, tientRH: false, tientFinances: false, ...o,
});

describe("Service du coffre", () => {
  it("dépose sous forme normalisée et chiffrée ; rien en clair n'atteint le stockage", async () => {
    const { coffre, donnees } = monter();
    const r = await coffre.deposer({ titulaire: amina, nature: "SALAIRE", valeur: "185 000 DA", deposeParId: "u-rh" });
    expect(r).toEqual({ ok: true, id: "d1", masque: "•••••• DZD", dejaPresente: false });
    const ligne = donnees[0];
    expect(JSON.stringify(ligne)).not.toMatch(/185\s?000/);
    expect(Buffer.from(ligne.valeurChiffree).toString("utf8")).not.toMatch(/185/);
    expect(ligne).toMatchObject({ titulaireType: "PERSONNE", titulaireId: "p-amina", nature: "SALAIRE", derniersCaracteres: null, cleVersion: 1, cleId: cles.id });
    expect(ligne.iv).toHaveLength(12);
    expect(ligne.tag).toHaveLength(16);
  });

  it("refuse une valeur mal formée sans rien écrire", async () => {
    const { coffre, donnees } = monter();
    const r = await coffre.deposer({ titulaire: amina, nature: "RIB", valeur: "00799999000123456700", deposeParId: null });
    expect(r.ok).toBe(false);
    expect(donnees).toHaveLength(0);
  });

  it("refuse une nature de personne pour une organisation", async () => {
    const { coffre } = monter();
    expect((await coffre.deposer({ titulaire: fournisseur, nature: "NIN", valeur: "109990001234567890", deposeParId: null })).ok).toBe(false);
  });

  it("le même titulaire qui redépose la même valeur (autre graphie) ne crée pas de doublon", async () => {
    const { coffre, donnees } = monter();
    await coffre.deposer({ titulaire: fournisseur, nature: "RIB", valeur: RIB, deposeParId: null });
    const r = await coffre.deposer({ titulaire: fournisseur, nature: "RIB", valeur: `${RIB.slice(0, 3)} ${RIB.slice(3)}`, deposeParId: null });
    expect(r).toMatchObject({ ok: true, id: "d1", dejaPresente: true, masque: `•••• ${RIB.slice(-4)}` });
    expect(donnees).toHaveLength(1);
  });

  it("lit pour les Finances, journalise la lecture avec son geste", async () => {
    const { coffre, acces } = monter();
    await coffre.deposer({ titulaire: fournisseur, nature: "RIB", valeur: RIB, deposeParId: null });
    const r = await coffre.lire({ lecteur: lecteur({ userId: "u-fin", tientFinances: true }), id: "d1", geste: "Virement fournisseur BC-12" });
    expect(r).toEqual({ ok: true, valeur: RIB, nature: "RIB", masque: `•••• ${RIB.slice(-4)}`, motif: "FINANCES" });
    expect(acces).toEqual([{
      donneeSensibleId: "d1", titulaireType: "ORGANISATION", titulaireId: "o-imprimerie", nature: "RIB",
      userId: "u-fin", lecteurNom: null, geste: "Virement fournisseur BC-12", autorise: true, motif: "FINANCES", createdAt: new Date("2026-10-27T10:00:00Z"),
    }]);
  });

  it("la personne lit son propre salaire (compte résolu depuis la fiche)", async () => {
    const { coffre } = monter();
    await coffre.deposer({ titulaire: amina, nature: "SALAIRE", valeur: "185000", deposeParId: "u-rh" });
    expect(await coffre.lire({ lecteur: lecteur({ userId: "u-amina" }), id: "d1", geste: "Mon espace" })).toMatchObject({ ok: true, valeur: "185000.00", motif: "TITULAIRE" });
  });

  it("un refus est journalisé aussi, et ne rend pas la valeur", async () => {
    const { coffre, acces } = monter();
    await coffre.deposer({ titulaire: amina, nature: "SALAIRE", valeur: "185000", deposeParId: "u-rh" });
    const r = await coffre.lire({ lecteur: lecteur({ userId: "u-fin", tientFinances: true }), id: "d1", geste: "Curiosité" });
    expect(r).toMatchObject({ ok: false, code: "REFUSE" });
    expect(JSON.stringify(r)).not.toMatch(/185000/);
    expect(acces).toHaveLength(1);
    expect(acces[0]).toMatchObject({ autorise: false, motif: "HORS_PERIMETRE", userId: "u-fin" });
  });

  it("un modèle d'IA est refusé, et le refus est journalisé à son nom", async () => {
    const { coffre, acces } = monter();
    await coffre.deposer({ titulaire: amina, nature: "NIN", valeur: "109990001234567890", deposeParId: null });
    const r = await coffre.lire({ lecteur: { genre: "IA", nom: "assistant" }, id: "d1", geste: "Réponse à une question" });
    expect(r).toMatchObject({ ok: false, code: "REFUSE" });
    expect(acces[0]).toMatchObject({ userId: null, lecteurNom: "assistant", autorise: false, motif: "MODELE_IA" });
    expect(await coffre.chercher({ lecteur: { genre: "IA", nom: "assistant" }, nature: "NIN", valeur: "109990001234567890" })).toEqual([]);
  });

  it("le Super Admin lit, et sa lecture est journalisée comme les autres", async () => {
    const { coffre, acces } = monter();
    await coffre.deposer({ titulaire: amina, nature: "PASSEPORT_NUMERO", valeur: "ab1234567", deposeParId: null });
    expect(await coffre.lire({ lecteur: lecteur({ userId: "u-admin", superAdmin: true }), id: "d1", geste: "Audit" })).toMatchObject({ ok: true, valeur: "AB1234567", motif: "SUPER_ADMIN" });
    expect(acces[0]).toMatchObject({ userId: "u-admin", motif: "SUPER_ADMIN", autorise: true });
  });

  it("aucune lecture sans geste, aucune lecture sans journal", async () => {
    const { coffre, acces, casserJournal } = monter();
    await coffre.deposer({ titulaire: amina, nature: "NIN", valeur: "109990001234567890", deposeParId: null });
    expect(await coffre.lire({ lecteur: lecteur({ superAdmin: true }), id: "d1", geste: "  " })).toMatchObject({ ok: false, code: "GESTE_MANQUANT" });
    expect(acces).toHaveLength(0);
    casserJournal();
    await expect(coffre.lire({ lecteur: lecteur({ superAdmin: true }), id: "d1", geste: "Audit" })).rejects.toThrow(/journal/);
  });

  it("une donnée inconnue rend INTROUVABLE", async () => {
    const { coffre } = monter();
    expect(await coffre.lire({ lecteur: lecteur({ superAdmin: true }), id: "nope", geste: "Audit" })).toMatchObject({ ok: false, code: "INTROUVABLE" });
  });

  it("une donnée chiffrée sous une autre clé est signalée ILLISIBLE, pas rendue", async () => {
    const mem = clientEnMemoire();
    const depot = creerDepotPrisma(mem.client);
    const autre = clesDepuisMaitresse(crypto.randomBytes(32));
    await creerServiceCoffre({ depot, cles: () => autre, nouvelId: () => "d1" }).deposer({ titulaire: amina, nature: "NIN", valeur: "109990001234567890", deposeParId: null });
    const r = await creerServiceCoffre({ depot, cles: () => cles }).lire({ lecteur: lecteur({ superAdmin: true }), id: "d1", geste: "Audit" });
    expect(r).toMatchObject({ ok: false, code: "ILLISIBLE" });
  });

  it("chercher retrouve le titulaire d'un RIB par empreinte, filtré par la politique", async () => {
    const { coffre } = monter();
    await coffre.deposer({ titulaire: fournisseur, nature: "RIB", valeur: RIB, deposeParId: null });
    const fin = await coffre.chercher({ lecteur: lecteur({ tientFinances: true }), nature: "RIB", valeur: `${RIB.slice(0, 8)} ${RIB.slice(8)}` });
    expect(fin).toHaveLength(1);
    expect(fin[0]).toMatchObject({ id: "d1", titulaire: fournisseur });
    expect(fin[0]).not.toHaveProperty("valeurChiffree");
    expect(await coffre.chercher({ lecteur: lecteur({ tientRH: true }), nature: "RIB", valeur: RIB })).toEqual([]);
  });
});
