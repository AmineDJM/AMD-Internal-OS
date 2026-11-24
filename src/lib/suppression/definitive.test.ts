import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { RELATIONS } from "./lot";
import { REFERENTS, faitIrreversible } from "./branches";
import {
  ATTACHES_TEXTE, CLASSEMENT_DEFINITIF, PARTAGEABLES, PROPRIETAIRES_NEUTRES, RETOURS_DEFINITIFS, SUITES_DEFINITIVES, TETES_DEFINITIVES,
  composerApercu, resumeDeLaDestruction, somme, type FaitsApercu,
} from "./definitive";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET DE LA SUPPRESSION DÉFINITIVE (Super Admin, 24/11/2026) — il lit le SCHÉMA.
 *
 *  1. Chaque clé étrangère qui vise une ligne partant avec une demande Ad & Pro (la demande et tout ce qu'elle
 *     emporte en cascade) est CLASSÉE : « part avec la demande » ou « on retire seulement le lien » — et le
 *     classement dit ce que le schéma fait. Un modèle lié ajouté demain sans classement fait tomber la suite.
 *  2. Les tables de la suppression définitive ne citent que des champs qui existent.
 *  3. SEULE CETTE PORTE détruit un ordre de dépense PAYÉ : la corbeille le refuse toujours, et le réglage qui passe
 *     outre (`faitsBloquent: false`) n'est écrit que dans la destruction, qu'une seule action importe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODELES = Prisma.dmmf.datamodel.models;
const champExiste = (modele: string, champ: string) => !!MODELES.find((m) => m.name === modele)?.fields.some((f) => f.name === champ);

/** Ce qui part avec une demande en cascade — la tête et sa fermeture par les clés « Cascade ». */
function fermeture(): Set<string> {
  const clos = new Set<string>(Object.values(TETES_DEFINITIVES));
  for (let change = true; change;) {
    change = false;
    for (const r of RELATIONS) if (r.action === "Cascade" && clos.has(r.parent) && !clos.has(r.enfant)) { clos.add(r.enfant); change = true; }
  }
  return clos;
}

describe("Suppression définitive — chaque modèle qui référence une demande Ad & Pro est classé", () => {
  const clos = fermeture();
  const visees = RELATIONS.filter((r) => clos.has(r.parent));

  it("toute clé étrangère vers la demande (ou ce qu'elle emporte) a son classement, et aucun classement n'est un fantôme", () => {
    const schema = visees.map((r) => `${r.enfant}.${r.champ}`).sort();
    const classes = Object.keys(CLASSEMENT_DEFINITIF).sort();
    expect(schema.filter((c) => !classes.includes(c)), "modèle lié sans classement : « PART_AVEC_LA_DEMANDE » ou « LIEN_RETIRE », avec sa raison").toEqual([]);
    expect(classes.filter((c) => !schema.includes(c)), "classement d'une clé qui n'existe pas (ou plus)").toEqual([]);
    // Mesuré : 47 clés au 24/11/2026. Un compte qui s'effondre dirait que la détection s'est cassée.
    expect(schema.length).toBeGreaterThanOrEqual(45);
  });

  it("le classement dit ce que le schéma FAIT : cascade = part avec la demande, mise à vide = seul le lien part", () => {
    const fautes = visees.flatMap((r) => {
      const c = CLASSEMENT_DEFINITIF[`${r.enfant}.${r.champ}`];
      if (!c) return [];
      if (r.action === "Restrict") return [`${r.enfant}.${r.champ} : une clé RESTRICT bloquerait la destruction — la rendre Cascade ou SetNull`];
      const attendu = r.action === "Cascade" ? "PART_AVEC_LA_DEMANDE" : "LIEN_RETIRE";
      return c.sort === attendu ? [] : [`${r.enfant}.${r.champ} : classé ${c.sort}, le schéma fait ${r.action}`];
    });
    expect(fautes).toEqual([]);
  });

  it("chaque classement porte sa raison", () => {
    for (const [k, c] of Object.entries(CLASSEMENT_DEFINITIF)) expect(c.raison.trim().length, k).toBeGreaterThan(10);
  });

  it("le médecin de l'annuaire, la ligne budgétaire, l'agence ne partent jamais : ce sont des PARENTS, pas des branches", () => {
    for (const m of ["MedicalDoctor", "BudgetCategoryLine", "BudgetEnvelope", "Company", "TreasuryAccount", "User"]) expect(clos.has(m), m).toBe(false);
  });

  it("les couples (type, identifiant) vers la demande sont classés par la carte des branches — et la trace reste", () => {
    for (const m of ["AuditLog", "BusinessEvent"]) expect(REFERENTS.find((r) => r.modele === m)?.conduite).toBe("HISTOIRE");
    for (const m of ["WorkflowInstance", "AdProGateVisa", "AdProPorteDg", "ExpenseOrder", "PaymentRequest", "AdProMedecin", "Reminder"]) {
      expect(REFERENTS.find((r) => r.modele === m)?.conduite, m).toBe("EMPORTEE");
    }
  });

  it("les suites, retours et attaches ne citent que des champs du schéma ; les partageables sont des modèles", () => {
    for (const l of [...SUITES_DEFINITIVES, ...RETOURS_DEFINITIFS, ...ATTACHES_TEXTE]) {
      expect(champExiste(l.modele, l.champ), `${l.modele}.${l.champ}`).toBe(true);
      expect(MODELES.some((m) => m.name === l.cible), l.cible).toBe(true);
    }
    for (const m of [...Object.keys(PARTAGEABLES), ...PROPRIETAIRES_NEUTRES]) expect(MODELES.some((x) => x.name === m), m).toBe(true);
    for (const modele of Object.values(TETES_DEFINITIVES)) expect(MODELES.some((m) => m.name === modele), modele).toBe(true);
  });
});

describe("Suppression définitive — seule cette porte détruit un ordre PAYÉ", () => {
  const RACINE = path.resolve(__dirname, "../../..");
  const tous: string[] = [];
  const marcher = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) marcher(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) tous.push(p);
    }
  };
  marcher(path.join(RACINE, "src"));
  const rel = (f: string) => path.relative(RACINE, f).split(path.sep).join("/");
  const lire = (f: string) => fs.readFileSync(f, "utf8");

  it("la corbeille refuse toujours une demande dont un ordre est payé (le fait bloque, par défaut)", () => {
    expect(faitIrreversible("ExpenseOrder", { reference: "OD-1", status: "PAID" })).toMatch(/réglé/);
    expect(faitIrreversible("ExpenseOrder", { reference: "OD-1", status: "PENDING", transactionId: "fin" })).toMatch(/réglé/);
  });

  it("le réglage qui passe outre (`faitsBloquent: false`) n'est écrit que dans la destruction", () => {
    const ecrivent = tous.filter((f) => /faitsBloquent:\s*false/.test(lire(f))).map(rel);
    expect(ecrivent).toEqual(["src/lib/suppression/destruction.ts"]);
  });

  it("la destruction n'a qu'une porte : l'action du Super Admin (par la porte serveur), qui revérifie le Super Admin réel", () => {
    const importent = tous.filter((f) => /from "(@\/lib\/suppression|\.)\/(destruction|definitif-serveur)"/.test(lire(f))).map(rel).sort();
    expect(importent).toEqual(["src/lib/suppression/definitif-serveur.ts", "src/modules/ad-pro/actions-suppression-definitive.ts"]);
    const action = lire(path.join(RACINE, "src/modules/ad-pro/actions-suppression-definitive.ts"));
    expect(action).toMatch(/refusSuppressionDefinitive\(user\)/);
    expect(action).toMatch(/referenceConfirmee\(/);
  });
});

describe("Suppression définitive — l'aperçu et la trace (règles pures)", () => {
  const faits: FaitsApercu = {
    postes: 2,
    ordres: [
      { reference: "OD-1", montant: 120_000, statut: "PAID", centralStatus: "APPROVED" },
      { reference: "OD-2", montant: 200_000.1, statut: "PENDING", centralStatus: "APPROVED" },
      { reference: "OD-3", montant: 50_000, statut: "PENDING", centralStatus: "REFUSED" },
      { reference: "OD-4", montant: 10_000, statut: "CANCELLED", centralStatus: "AWAITING" },
    ],
    ecritures: [
      { montant: 120_000, direction: "OUT", statut: "SETTLED", categorieId: "c1" },
      // La contre-passation d'un règlement annulé : même sens, montant opposé — elle se retranche.
      { montant: -20_000, direction: "OUT", statut: "SETTLED", categorieId: "c1" },
      { montant: 5_000, direction: "IN", statut: "PENDING", categorieId: null },
    ],
    engagements: [{ categorieId: "c2", montant: 200_000.1 }, { categorieId: "c2", montant: 99_999.9 }, { categorieId: "c1", montant: 0 }],
    categories: { c1: "Marketing › Congrès", c2: "Marketing › Sponsoring" },
    legal: 3, jointes: 4, fichiers: 5,
    gardees: [{ libelle: "Devis commun", pourquoi: "servant aussi un autre élément (poste)" }],
    resume: ["2 postes"], faits: ["l'ordre de dépense OD-1 a été réglé"], bloquants: [], lignes: 42,
  };

  it("chiffre les ordres (payés, en circuit — un refus du centre n'engage plus) et les écritures", () => {
    const a = composerApercu(faits);
    expect(a.ordres).toEqual({ nombre: 4, payes: 1, montantPaye: 120_000, enCircuit: 1, montantEnCircuit: 200_000.1, montantTotal: 380_000.1 });
    expect(a.ecritures).toEqual({ nombre: 3, sorties: 100_000, entrees: 0 });
  });

  it("rend au budget, ligne par ligne, l'engagé et la consommation — au centime, lignes vides écartées", () => {
    const a = composerApercu(faits);
    expect(a.budget).toEqual([
      { categorieId: "c1", libelle: "Marketing › Congrès", engagement: 0, consommation: 100_000 },
      { categorieId: "c2", libelle: "Marketing › Sponsoring", engagement: 300_000, consommation: 0 },
    ]);
    expect(a.totalBudget).toEqual({ engagement: 300_000, consommation: 100_000 });
    expect(somme([0.1, 0.2])).toBe(0.3);
  });

  it("la trace dit la nature, la référence, les nombres et ce qui a été gardé", () => {
    const t = resumeDeLaDestruction({ nature: "Sponsoring", reference: "SP-2026-014", titre: "Société savante" }, composerApercu(faits));
    expect(t).toMatch(/^Suppression DÉFINITIVE \(Super Admin\) — Sponsoring SP-2026-014 « Société savante »/);
    expect(t).toMatch(/2 postes/);
    expect(t).toMatch(/4 ordres de dépense \(1 payé : 120[\s  ]000 DZD/);
    expect(t).toMatch(/3 écritures de trésorerie/);
    expect(t).toMatch(/42 éléments en tout/);
    expect(t).toMatch(/Gardé \(lien seul retiré\) : Devis commun/);
  });
});
