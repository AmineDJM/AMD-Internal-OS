import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CANAUX_ENVOI, canalOuvert, catalogueAdamOuvert, chantiersOuverts, gesteReserveFerme, profilDAcces, profilDuCompte, roleSuperAdmin,
  type ProfilDAcces,
} from "./domaine/profil-acces";
import { canalAdamOuvert, taireCanalAdam } from "./domaine/mails/canal";
import { resoudreAccesIa } from "./domaine/acces-regles";
import { FAMILLES_IA } from "@/platform/ia/capacites/familles";
import { PERSONAS_CLES, PERSONNES, type PersonaCle } from "./infra/testing/audit/personas";

/**
 * LOT I2 (décision 0064) — LA TABLE DES ACCÈS, SEULE RÈGLE « QUI A QUOI ». Pur : ni base, ni réseau.
 *
 *   1. La MATRICE : 14 personas du banc d'audit × chaque ligne du profil (canaux, catalogues, Vue exacte). Rien ne s'ouvre à
 *      un employé ; tout est fermé en Vue exacte ; le Super Admin a tout.
 *   2. L'ÉCHEC FERMÉ : une entrée illisible, un rôle secondaire, une casse différente n'ouvrent rien.
 *   3. LES PRÉDICATS LISENT LA TABLE : `canalAdamOuvert`, `catalogueAdamOuvert`, `chantiersOuverts` coïncident avec elle.
 *   4. L'ARCHITECTURE : aucune comparaison du rôle au Super Admin dans `src/modules/assistant-ia`, hors de la table.
 */

/** Le compte d'une persona, tel que la session le porte (la Vue exacte : le Super Admin regarde le commercial). */
function compte(p: PersonaCle): { id: string; role: string; impersonatedBy?: string; secondaryRole?: string } {
  if (p === "vue_exacte") return { id: "vue", role: PERSONNES.commercial.role, impersonatedBy: "sa" };
  return { id: p, role: PERSONNES[p].role };
}

const ATTENDU_EMPLOYE = { gmailAdam: false, whatsapp: false, erp: true, microsoft: true, smtp: true, adam: false, chantiers: false };

describe("ProfilDAcces — la matrice des 14 personas", () => {
  it("14 personas, chaque ligne : le Super Admin a tout, un employé jamais ce qui est réservé, la Vue exacte rien", () => {
    expect(PERSONAS_CLES.length).toBe(14);
    const fautes: string[] = [];
    for (const p of PERSONAS_CLES) {
      const pr = profilDAcces(compte(p));
      const attendu = p === "superadmin"
        ? { gmailAdam: true, whatsapp: true, erp: true, microsoft: true, smtp: true, adam: true, chantiers: true }
        : p === "vue_exacte"
          ? { gmailAdam: false, whatsapp: false, erp: false, microsoft: false, smtp: false, adam: false, chantiers: false }
          : ATTENDU_EMPLOYE;
      for (const c of CANAUX_ENVOI) if (pr.canaux[c] !== attendu[c]) fautes.push(`${p} : canal ${c} = ${pr.canaux[c]}`);
      if (pr.catalogues.adam !== attendu.adam) fautes.push(`${p} : catalogue d'Adam = ${pr.catalogues.adam}`);
      if (pr.catalogues.chantiers !== attendu.chantiers) fautes.push(`${p} : chantiers = ${pr.catalogues.chantiers}`);
      if (pr.superAdmin !== (p === "superadmin")) fautes.push(`${p} : superAdmin = ${pr.superAdmin}`);
      if (pr.vueExacte !== (p === "vue_exacte")) fautes.push(`${p} : vueExacte = ${pr.vueExacte}`);
      if (pr.gestesExecutables !== (p !== "vue_exacte")) fautes.push(`${p} : gestesExecutables = ${pr.gestesExecutables}`);
      // Un geste réservé par le profil (le canal d'Adam) n'existe que pour le Super Admin.
      if (gesteReserveFerme("envoyer_gmail", pr) !== (p !== "superadmin")) fautes.push(`${p} : envoyer_gmail réservé = ${gesteReserveFerme("envoyer_gmail", pr)}`);
    }
    expect(fautes, fautes.join("\n")).toEqual([]);
  });

  it("les prédicats d'avant I2 LISENT la table — et coïncident avec elle sur les 14 personas", () => {
    for (const p of PERSONAS_CLES) {
      const c = compte(p);
      const pr = profilDAcces(c);
      expect(canalAdamOuvert(c), p).toBe(pr.canaux.gmailAdam);
      expect(catalogueAdamOuvert(c), p).toBe(pr.catalogues.adam);
      expect(chantiersOuverts(c), p).toBe(pr.catalogues.chantiers);
      expect(canalOuvert(c, "whatsapp"), p).toBe(pr.canaux.whatsapp);
    }
  });

  it("les familles S1 et les bases D2–D5 sont PORTÉES, jamais recalculées ; le rôle et les familles ne se confondent pas", () => {
    const sa = compte("superadmin");
    // Une base fermée retire au Super Admin sa souveraineté sur une famille (`appliquerBases`) : `familles.superAdmin` faux.
    const familles = { superAdmin: false, ouvertes: FAMILLES_IA.filter((f) => f !== "SALAIRES"), explicites: [], perimetres: [] };
    const pr = profilDAcces(sa, { familles });
    expect(pr.familles).toBe(familles);
    // … le RÔLE garde ses canaux et son catalogue : ils ne sont pas des familles.
    expect(pr.superAdmin && pr.canaux.gmailAdam && pr.catalogues.adam).toBe(true);
    const emp = profilDAcces(compte("commercial"), { familles: resoudreAccesIa({ superAdmin: true, droits: {} as never }) });
    // Des familles « Super Admin » passées par erreur n'ouvrent rien de réservé à un employé.
    expect(emp.superAdmin || emp.canaux.gmailAdam || emp.catalogues.adam).toBe(false);
  });

  it("l'arrêt d'urgence ferme l'exécution des gestes — à tous, Super Admin compris ; les canaux restent décrits", () => {
    for (const p of ["superadmin", "commercial"] as const) {
      const pr = profilDAcces(compte(p), { arretUrgence: true });
      expect(pr.arretUrgence).toBe(true);
      expect(pr.gestesExecutables).toBe(false);
    }
  });
});

describe("ProfilDAcces — échec fermé", () => {
  const FERME = (pr: ProfilDAcces) => !pr.superAdmin && !pr.canaux.gmailAdam && !pr.canaux.whatsapp && !pr.catalogues.adam && !pr.catalogues.chantiers;

  it.each([
    ["aucun compte", null],
    ["pas un objet", "SUPER_ADMIN"],
    ["rôle en minuscules", { role: "super_admin" }],
    ["rôle avec espace", { role: " SUPER_ADMIN" }],
    ["rôle non textuel", { role: 1 }],
    ["Super Admin en rôle SECONDAIRE seulement", { role: "DIRECTION", secondaryRole: "SUPER_ADMIN" }],
    ["la Direction", { role: "DIRECTION" }],
    ["le Directeur général", { role: "GENERAL_MANAGER" }],
    ["un Super Admin en Vue exacte (impersonation)", { role: "SUPER_ADMIN", impersonatedBy: "x" }],
    ["un Super Admin qui en visualise un autre", { role: "SUPER_ADMIN", visualise: { id: "y", name: "Radia" } }],
  ])("%s : rien de réservé ne s'ouvre", (_nom, c) => {
    const pr = profilDAcces(c as never);
    expect(FERME(pr)).toBe(true);
    expect(FERME(profilDuCompte(c as never))).toBe(true);
    expect(canalAdamOuvert((c ?? {}) as never)).toBe(false);
  });

  it("la Vue exacte ferme tout, même les canaux de la personne vue", () => {
    const pr = profilDAcces({ role: "SALES_USER", impersonatedBy: "sa" });
    expect(pr.vueExacte).toBe(true);
    expect(CANAUX_ENVOI.some((c) => pr.canaux[c])).toBe(false);
  });

  it("la garde de sortie reste un INVARIANT : le canal d'Adam nommé par le modèle est tu pour un non-Super-Admin", () => {
    expect(taireCanalAdam("Je l'envoie depuis la boîte d'Adam.")).not.toMatch(/adam/i);
  });

  it("`roleSuperAdmin` ne lit que le rôle principal", () => {
    expect(roleSuperAdmin({ role: "SUPER_ADMIN" })).toBe(true);
    expect(roleSuperAdmin({ role: "DIRECTION", secondaryRole: "SUPER_ADMIN" } as never)).toBe(false);
    expect(roleSuperAdmin(null)).toBe(false);
  });
});

/** Les fichiers du module, tests et bancs exclus. */
function fichiersDuModule(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "testing") out.push(...fichiersDuModule(p)); continue; }
    if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("ProfilDAcces — l'architecture : une seule table", () => {
  it("aucune comparaison du rôle au Super Admin dans `src/modules/assistant-ia`, hors de la table", () => {
    const racine = path.join(process.cwd(), "src/modules/assistant-ia");
    const table = path.join(racine, "domaine/profil-acces.ts");
    // Comparer un rôle au Super Admin, dans un sens ou dans l'autre (les requêtes Prisma `role: "SUPER_ADMIN"` sont des
    // données, pas une règle d'accès : elles ne sont pas visées).
    const COMPARAISON = /(?:[!=]==?\s*["'`]SUPER_ADMIN["'`])|(?:["'`]SUPER_ADMIN["'`]\s*[!=]==?)/;
    const fautes = fichiersDuModule(racine).filter((f) => f !== table).flatMap((f) =>
      fs.readFileSync(f, "utf8").split("\n").map((l, i) => [l, i] as const)
        .filter(([l]) => COMPARAISON.test(l) && !/^\s*(\*|\/\/)/.test(l))
        .map(([l, i]) => `${path.relative(racine, f)}:${i + 1} ${l.trim().slice(0, 120)}`));
    expect(fautes, `Lire la table (domaine/profil-acces.ts) :\n${fautes.join("\n")}`).toEqual([]);
  });

  it("la table est pure : aucune importation de valeur (types seulement)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/modules/assistant-ia/domaine/profil-acces.ts"), "utf8");
    const imports = src.split("\n").filter((l) => /^import\s/.test(l));
    expect(imports.every((l) => /^import type\s/.test(l)), imports.join("\n")).toBe(true);
    expect(src).not.toMatch(/process\.env/);
  });
});
