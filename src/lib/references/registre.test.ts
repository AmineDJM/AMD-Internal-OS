import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attribuerReference, formaterReference, largeurDuMotif, largeurRegistre, lireReference, numeroPrevu, plancherRegistre, prochainNumero,
  registreActif, saisieEffective, typeSurRegistre, validerReferenceSaisie,
  type EntreeRegistre, type MagasinRegistre,
} from "@/lib/references/registre";

/**
 * LE REGISTRE COMMUN NNN/DG/AAAA (Direction, 10/2026) — la règle pure, et l'attribution jouée contre un magasin EN MÉMOIRE qui
 * se comporte comme le magasin Prisma : un compteur par (société, année), un registre unique par (société, année, numéro).
 */
function magasinMemoire() {
  const compteurs = new Map<string, number>();
  const registre = new Map<string, EntreeRegistre & { id: string }>();
  const cle = (c: string, a: number) => `${c}|${a}`;
  let n = 0;
  const m: MagasinRegistre = {
    async avancer(companyId, annee, plancher) {
      const k = cle(companyId, annee);
      const v = compteurs.has(k) ? Math.max((compteurs.get(k) as number) + 1, plancher) : plancher;
      compteurs.set(k, v);
      return v;
    },
    async porterAuMoins(companyId, annee, numero) {
      const k = cle(companyId, annee);
      compteurs.set(k, Math.max(compteurs.get(k) ?? numero, numero));
    },
    async occupant(companyId, annee, numero) {
      const e = registre.get(`${cle(companyId, annee)}|${numero}`);
      return e ? { reference: e.reference, docType: e.docType } : null;
    },
    async inscrire(e) {
      const k = `${cle(e.companyId, e.annee)}|${e.numero}`;
      if (registre.has(k)) return null;
      const id = `ref-${++n}`;
      registre.set(k, { ...e, id });
      return id;
    },
  };
  return { m, compteurs, registre, dernier: (c: string, a: number) => compteurs.get(cle(c, a)) ?? 0 };
}

const A = "adventum";
const P = "pharmagene";

describe("le format NNN/DG/AAAA", () => {
  it("formate sur trois chiffres au moins, jamais tronqué", () => {
    expect(formaterReference(40, 2026)).toBe("040/DG/2026");
    expect(formaterReference(7, 2027)).toBe("007/DG/2027");
    expect(formaterReference(1234, 2026)).toBe("1234/DG/2026");
    expect(formaterReference(7, 2026, 4)).toBe("0007/DG/2026");
  });

  it("lit une saisie souple (espaces, casse, zéros absents) et refuse ce qui n'est pas une référence DG", () => {
    expect(lireReference("040/DG/2026")).toEqual({ numero: 40, annee: 2026 });
    expect(lireReference(" 41 / dg / 2026 ")).toEqual({ numero: 41, annee: 2026 });
    expect(lireReference("007/DPG/2026")).toBeNull();
    expect(lireReference("BC-2026-0001")).toBeNull();
    expect(lireReference("40/DG/26")).toBeNull();
    expect(lireReference("")).toBeNull();
    expect(lireReference(null)).toBeNull();
  });

  it("valide la saisie : obligatoire, au format, de l'année du document, numéro de 1 à 99 999 — et la normalise", () => {
    expect(validerReferenceSaisie("41/dg/2026", 2026)).toEqual({ ok: true, numero: 41, annee: 2026, reference: "041/DG/2026" });
    expect(validerReferenceSaisie("", 2026).ok).toBe(false);
    const format = validerReferenceSaisie("041-DG-2026", 2026);
    expect(format.ok).toBe(false);
    if (!format.ok) expect(format.motif).toContain("NNN/DG/AAAA");
    const annee = validerReferenceSaisie("041/DG/2025", 2026);
    expect(annee.ok).toBe(false);
    if (!annee.ok) expect(annee.motif).toContain("2026");
    expect(validerReferenceSaisie("000/DG/2026", 2026).ok).toBe(false);
    expect(validerReferenceSaisie("100000/DG/2026", 2026).ok).toBe(false);
  });

  it("la largeur se lit dans le motif ({n:4} → 4), 3 par défaut", () => {
    expect(largeurDuMotif("{n:3}/DG/{aaaa}")).toBe(3);
    expect(largeurDuMotif("{n:4}/DG/{aaaa}")).toBe(4);
    expect(largeurDuMotif(null)).toBe(3);
    expect(largeurRegistre({ numerotation: { BON_DE_COMMANDE: "{n:4}/DG/{aaaa}" } })).toBe(4);
    expect(largeurRegistre({ numerotation: { BON_DE_COMMANDE: "{n:4}/FS/{aa}" } })).toBe(3);
  });

  it("le numéro PROPOSÉ laissé tel quel n'est pas un choix : la génération attribue le prochain libre", () => {
    expect(saisieEffective("040/DG/2026", "040/DG/2026")).toBeNull();
    expect(saisieEffective("40/dg/2026", "040/DG/2026")).toBeNull();
    expect(saisieEffective("", "040/DG/2026")).toBeNull();
    expect(saisieEffective("045/DG/2026", "040/DG/2026")).toBe("045/DG/2026");
    expect(saisieEffective("045/DG/2026", null)).toBe("045/DG/2026");
  });
});

describe("qui tient le registre", () => {
  it("la société marquée par la migration, ou dont les BC portent déjà /DG/ — les autres gardent leur numérotation", () => {
    expect(registreActif({ registreDG: true })).toBe(true);
    expect(registreActif({ numerotation: { BON_DE_COMMANDE: "{n:3}/DG/{aaaa}" } })).toBe(true);
    expect(registreActif({ numerotation: { BON_DE_COMMANDE: "{n:3}/FS/{aa}" } })).toBe(false);
    expect(registreActif({ numerotation: { FACTURE: "{n:3}/DG/{aaaa}" } }), "un motif /DG/ sur les factures ne met pas la société au registre").toBe(false);
    expect(registreActif(null)).toBe(false);
    expect(registreActif({})).toBe(false);
  });

  it("une pièce de la fabrique y va si c'est le BC d'une société au registre, ou si sa nature porte /DG/", () => {
    expect(typeSurRegistre("BON_DE_COMMANDE", null, true)).toBe(true);
    expect(typeSurRegistre("BON_DE_COMMANDE", "{prefixe}-{aaaa}-{n:4}", false)).toBe(false);
    expect(typeSurRegistre("FACTURE", "{n:3}/FS/{aa}", true), "une facture garde sa série").toBe(false);
    expect(typeSurRegistre("DEVIS", "{n:3}/DG/{aaaa}", false)).toBe(true);
  });

  it("le plancher de l'année : 40 en 2026 (« commence par 040 »), 1 l'année suivante — remise à 001", () => {
    const s = { numerotation: { BON_DE_COMMANDE: "{n:3}/DG/{aaaa}" }, numerotationDepart: { BON_DE_COMMANDE: { "2026": 40 }, FACTURE: { "2026": 900 } } };
    expect(plancherRegistre(s, 2026), "le départ d'une facture hors registre ne compte pas").toBe(40);
    expect(plancherRegistre(s, 2027)).toBe(1);
    expect(plancherRegistre(null, 2026)).toBe(1);
    expect(prochainNumero(0, 40)).toBe(40);
    expect(prochainNumero(39, 40)).toBe(40);
    expect(prochainNumero(52, 40)).toBe(53);
    expect(prochainNumero(0, 1)).toBe(1);
  });
});

describe("l'attribution au registre commun", () => {
  it("automatique : 040, puis 041 — un compteur commun à TOUS les types de documents de la société", async () => {
    const { m } = magasinMemoire();
    const bc = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE" });
    const om = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "ORDRE_MISSION" });
    const dd = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "DEMANDE_DEVIS" });
    expect([bc, om, dd].map((r) => (r.ok ? r.reference : r.motif))).toEqual(["040/DG/2026", "041/DG/2026", "042/DG/2026"]);
  });

  it("un numéro CHOISI plus haut fait avancer le compteur : le suivant automatique vient après lui", async () => {
    const { m, dernier } = magasinMemoire();
    await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE" });
    const choisi = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "ORDRE_MISSION", saisie: "50/dg/2026" });
    expect(choisi).toMatchObject({ ok: true, reference: "050/DG/2026", numero: 50, choisie: true });
    expect(dernier(A, 2026)).toBe(50);
    const suivant = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE" });
    expect(suivant.ok && suivant.reference).toBe("051/DG/2026");
  });

  it("un numéro choisi plus BAS et libre est accepté sans faire reculer le compteur", async () => {
    const { m, dernier } = magasinMemoire();
    await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE", saisie: "060/DG/2026" });
    const bas = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "DEMANDE_DEVIS", saisie: "045/DG/2026" });
    expect(bas.ok && bas.reference).toBe("045/DG/2026");
    expect(dernier(A, 2026)).toBe(60);
  });

  it("UNIQUE TOUS TYPES CONFONDUS : le 041 d'un BC ne peut pas être celui d'un ordre de mission — et ne se réutilise jamais", async () => {
    const { m } = magasinMemoire();
    await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE" });
    await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE" });
    const refus = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "ORDRE_MISSION", saisie: "041/DG/2026" });
    expect(refus.ok).toBe(false);
    if (!refus.ok) {
      expect(refus.motif).toContain("041/DG/2026");
      expect(refus.motif).toContain("bon de commande");
    }
    const encore = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "DEMANDE_DEVIS", saisie: "41/DG/2026" });
    expect(encore.ok, "la même référence écrite autrement reste prise").toBe(false);
  });

  it("une saisie mal formée ou d'une autre année est refusée AVANT toute écriture", async () => {
    const { m, registre, dernier } = magasinMemoire();
    expect((await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE", saisie: "BC-12" })).ok).toBe(false);
    expect((await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE", saisie: "041/DG/2025" })).ok).toBe(false);
    expect(registre.size).toBe(0);
    expect(dernier(A, 2026)).toBe(0);
  });

  it("le filet : un numéro déjà au registre au-dessus du compteur (registre repris à la main) est sauté, jamais doublé", async () => {
    const { m } = magasinMemoire();
    await m.inscrire({ companyId: A, annee: 2026, numero: 40, reference: "040/DG/2026", docType: "BON_DE_COMMANDE", entityType: null, entityId: null, createdById: null });
    const r = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "ORDRE_MISSION" });
    expect(r.ok && r.reference).toBe("041/DG/2026");
  });

  it("CHAQUE SOCIÉTÉ SON REGISTRE : le 040 d'Adventum n'empêche pas celui de Pharmagène", async () => {
    const { m } = magasinMemoire();
    const a = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE" });
    const p = await attribuerReference(m, { companyId: P, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE" });
    const pChoisi = await attribuerReference(m, { companyId: P, annee: 2026, plancher: 40, docType: "ORDRE_MISSION", saisie: "040/DG/2026" });
    expect(a.ok && a.reference).toBe("040/DG/2026");
    expect(p.ok && p.reference).toBe("040/DG/2026");
    expect(pChoisi.ok, "040 est déjà pris chez Pharmagène").toBe(false);
    const aSuivant = await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "DEMANDE_DEVIS" });
    expect(aSuivant.ok && aSuivant.reference).toBe("041/DG/2026");
  });

  it("CHAQUE ANNÉE SA SÉRIE : 2027 repart à 001, et le 040 de 2026 reste libre en 2027", async () => {
    const { m } = magasinMemoire();
    await attribuerReference(m, { companyId: A, annee: 2026, plancher: 40, docType: "BON_DE_COMMANDE" });
    const nouvelle = await attribuerReference(m, { companyId: A, annee: 2027, plancher: 1, docType: "BON_DE_COMMANDE" });
    expect(nouvelle.ok && nouvelle.reference).toBe("001/DG/2027");
    const meme = await attribuerReference(m, { companyId: A, annee: 2027, plancher: 1, docType: "ORDRE_MISSION", saisie: "040/DG/2027" });
    expect(meme.ok && meme.reference).toBe("040/DG/2027");
  });

  it("le numéro PRÉVU saute ceux déjà choisis, sans rien réserver", () => {
    const pris = new Set([41, 42]);
    expect(numeroPrevu(40, 40, (n) => pris.has(n))).toBe(43);
    expect(numeroPrevu(0, 40, () => false)).toBe(40);
  });
});

describe("le registre, branché partout où un document porte une référence", () => {
  const lire = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("la règle est PURE (aucun import) : les formulaires du navigateur la lisent sans tirer le serveur", () => {
    expect(lire("src/lib/references/registre.ts")).not.toMatch(/^\s*import\s/m);
  });

  it("la migration : sans BOM, idempotente (IF NOT EXISTS, ON CONFLICT, GREATEST), 040 pour les trois sociétés, backfill des BC", () => {
    const sql = lire("prisma/migrations/20270117160000_registre_dg/migration.sql");
    expect(sql.charCodeAt(0), "pas de BOM").not.toBe(0xfeff);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "DocumentReference"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "DocumentReference_companyId_year_numero_key"/);
    expect(sql).toMatch(/jsonb_build_object\('2026', 40\)/);
    expect(sql).toMatch(/'registreDG', true/);
    expect(sql).toMatch(/adventum/);
    expect(sql).toMatch(/pharmag_ne/);
    expect(sql).toMatch(/\\mamd\\M/);
    expect(sql).toMatch(/INSERT INTO "DocumentReference"[\s\S]+FROM lues[\s\S]+ON CONFLICT DO NOTHING/);
    expect(sql).toMatch(/GREATEST\("DocumentSequence"\."last", EXCLUDED\."last"\)/);
    expect(sql, "aucun compteur ne recule, aucune ligne ne se supprime").not.toMatch(/\bDELETE\s+FROM\b|\bDROP\s+(TABLE|INDEX|COLUMN)\b|\bTRUNCATE\b/);
  });

  it("chaque générateur attribue au registre au moment de FINALISER — jamais sur un aperçu", () => {
    // La fabrique est découpée (`artifact/factory/`) : l'émission et l'aperçu ont chacun leur fichier.
    const fabrique = lire("src/platform/in-process/artifact/factory/emission.ts");
    const emission = fabrique.slice(fabrique.indexOf("export async function emettreDocumentDrive"), fabrique.indexOf("async function terminerEmission"));
    expect(emission).toMatch(/attribuerReference\(magasinPrisma\(tx\)/);
    // L'aperçu termine son fichier, comme il précédait « La révision » dans la fabrique d'un seul tenant.
    const fichierApercu = lire("src/platform/in-process/artifact/factory/apercu.ts");
    const apercu = fichierApercu.slice(fichierApercu.indexOf("export async function previsualiserDocument"));
    expect(apercu, "l'aperçu prévoit, il n'attribue pas").not.toMatch(/attribuerReference|attribuerAuRegistre/);
    expect(apercu).toMatch(/prevoirReference\(/);
    expect(lire("src/lib/ordre-mission-depot.ts")).toMatch(/docType: "ORDRE_MISSION"/);
    expect(lire("src/lib/demande-devis-depot.ts")).toMatch(/docType: "DEMANDE_DEVIS"/);
  });
});
