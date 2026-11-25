import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { NAVIGATION, moduleForPath } from "@/lib/labels";
import type { Module } from "@/lib/rbac";
import { lienCentreDePaiement, CHEMIN_MES_DEMANDES_DE_PAIEMENT } from "@/lib/chemins/finances";
import { admisParLaPorte, clauseLiensFermes, MODULES_SIEGES, porteDuLien, ROUTES_CONNUES } from "./porte-du-lien";

/**
 * LA PORTE D'UN LIEN DE NOTIFICATION — règles pures (Super Admin, 25/11/2026 : « une personne qui n'a PAS accès à un
 * module ne reçoit AUCUNE notification de ce module »). Le flux en base est dans `admission-flow.test.ts`.
 */

const rien = () => false;

describe("porteDuLien — le module qu'une notification ouvre, lu dans la navigation", () => {
  it("le lien de la notification constatée en production ouvre le CENTRE DE PAIEMENT, un écran de décision", () => {
    const p = porteDuLien("/centre-de-paiement?entite=company_adventum");
    expect([p.module, p.genre, p.connu]).toEqual(["PAYMENT_CENTRE", "siege", true]);
    // L'ancien chemin sous les Finances aussi — une notification d'hier le porte encore.
    expect(porteDuLien("/finances/centre-de-paiement?section=regulatory").module).toBe("PAYMENT_CENTRE");
    expect(porteDuLien(lienCentreDePaiement("x")).genre).toBe("siege");
  });

  it("le centre Ad & Pro et Adam sont des sièges ; une file nue est un écran ; une ligne ou une page dessous, une fiche", () => {
    expect(porteDuLien("/centre-ad-pro?ligne=abc")).toMatchObject({ module: "AD_PRO_CENTRE", genre: "siege" });
    expect(porteDuLien("/missions/m1")).toMatchObject({ module: "ASSISTANT_IA", genre: "siege" });
    expect(porteDuLien("/rh/demandes")).toMatchObject({ module: "HR_REQUESTS", genre: "ecran" });
    expect(porteDuLien("/rh/demandes?demande=abc")).toMatchObject({ module: "HR_REQUESTS", genre: "fiche" });
    expect(porteDuLien("/validations/paiements/abc")).toMatchObject({ module: "VALIDATIONS", genre: "fiche" });
    expect(porteDuLien(CHEMIN_MES_DEMANDES_DE_PAIEMENT)).toMatchObject({ module: "VALIDATIONS" });
  });

  it("sans lien, lien externe, racine : libres ; un lien interne inconnu est permis mais dit inconnu (à journaliser)", () => {
    for (const l of [null, undefined, "", "https://exemple.dz/x", "/"]) expect(porteDuLien(l)).toMatchObject({ module: null, genre: "libre", connu: true });
    expect(porteDuLien("/route-qui-n-existe-pas/1")).toMatchObject({ module: null, genre: "libre", connu: false });
  });

  it("la correspondance EST celle du menu : chaque route du menu donne le module de `moduleForPath` (hors lignes écrites pour le corriger)", () => {
    const hrefs = NAVIGATION.flatMap((n) => [n.href, ...(n.tabs ?? []).map((t) => t.href), ...(n.children ?? []).map((c) => c.href)]).filter((h) => h && h !== "/");
    const corrections = new Set(["/missions"]);
    for (const h of hrefs) {
      if (corrections.has(h)) continue;
      expect(porteDuLien(h).module, h).toBe(moduleForPath(h));
    }
  });
});

describe("admisParLaPorte — la règle, et l'exception du demandeur", () => {
  const fiche = porteDuLien("/rh/demandes?demande=abc");
  const ecran = porteDuLien("/rh/demandes");
  const siege = porteDuLien("/centre-de-paiement?entite=x");

  it("qui a le module est admis partout", () => {
    for (const p of [fiche, ecran, siege]) for (const a of ["nominatif", "collectif"] as const) expect(admisParLaPorte(p, () => true, a)).toBe(true);
  });

  it("EXCEPTION : une FICHE adressée nommément (sa demande, son dossier) reste permise sans le module — la page admet son cercle", () => {
    expect(admisParLaPorte(fiche, rien, "nominatif")).toBe(true);
  });

  it("l'exception ne vaut ni pour un envoi par rôle, ni pour un écran de module, ni pour un écran de décision", () => {
    expect(admisParLaPorte(fiche, rien, "collectif")).toBe(false);
    expect(admisParLaPorte(ecran, rien, "nominatif")).toBe(false);
    expect(admisParLaPorte(siege, rien, "nominatif")).toBe(false);
    expect(admisParLaPorte(siege, rien, "collectif")).toBe(false);
  });

  it("un lien sans module (ou inconnu) n'est jamais retiré", () => {
    expect(admisParLaPorte(porteDuLien("/route-inconnue"), rien, "collectif")).toBe(true);
    expect(admisParLaPorte(porteDuLien(null), rien, "collectif")).toBe(true);
  });
});

describe("clauseLiensFermes — la même règle, en clause de base (les compteurs suivent)", () => {
  it("rien de fermé : aucune clause", () => {
    expect(clauseLiensFermes(() => true)).toBeNull();
  });

  it("le centre de paiement fermé l'est avec ses paramètres ; une notification sans lien reste", () => {
    const c = JSON.stringify(clauseLiensFermes((m) => m !== "PAYMENT_CENTRE"));
    expect(c).toContain('{"link":null}');
    expect(c).toContain('{"link":{"startsWith":"/centre-de-paiement?"}}');
    expect(c).toContain('{"link":{"startsWith":"/finances/centre-de-paiement?"}}');
    // Un écran de module fermé ne l'est qu'à son adresse nue : une ligne précise reste une fiche lisible.
    const rh = JSON.stringify(clauseLiensFermes((m) => m !== "HR_REQUESTS"));
    expect(rh).toContain('{"link":"/rh/demandes"}');
    expect(rh).not.toContain('"startsWith":"/rh/demandes?"');
  });

  it("les sièges sont exactement les écrans de décision connus", () => {
    expect([...MODULES_SIEGES].sort()).toEqual(["ADVENTUM_BRAIN", "AD_PRO_CENTRE", "ASSISTANT_IA", "CHIEF_OF_STAFF", "PAYMENT_CENTRE", "VALIDATION_CENTRE"]);
    expect(ROUTES_CONNUES.length).toBeGreaterThan(50);
  });
});

/**
 * LES LIENS RÉELLEMENT ÉMIS PAR LE CODE ONT TOUS UN MODULE (ou une page libre connue). Une route nouvelle qui reçoit des
 * notifications sans passer par le menu doit être ajoutée aux `ROUTES_HORS_MENU` — sinon personne ne la garde ici.
 * On lit : les littéraux `link: "/…"` / `` link: `/…` `` du code de production, et chaque chemin que rendent les
 * fabriques de `lib/chemins/*` (constantes et fonctions, appelées avec un identifiant factice).
 */
describe("tous les préfixes de liens émis par le code ont un module", () => {
  const racine = path.resolve(__dirname, "../..");
  const fichiers: string[] = [];
  const parcourir = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) fichiers.push(p);
    }
  };
  parcourir(racine);

  it("littéraux `link:` du code de production", () => {
    const prefixes = new Set<string>();
    for (const f of fichiers) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/\blink:\s*["'`](\/[^"'`$?#]*)/g)) {
        const p = m[1].replace(/\/+$/, "") || "/";
        prefixes.add(p);
      }
    }
    expect(prefixes.size).toBeGreaterThan(50);
    const inconnus = [...prefixes].filter((p) => !porteDuLien(p).connu).sort();
    expect(inconnus, `liens de notification sans module : ${inconnus.join(", ")}`).toEqual([]);
  });

  it("chemins rendus par les fabriques de `lib/chemins/*`", async () => {
    const dossier = path.join(racine, "lib/chemins");
    const inconnus: string[] = [];
    let vus = 0;
    for (const f of fs.readdirSync(dossier).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const mod = (await import(path.join(dossier, f))) as Record<string, unknown>;
      for (const [nom, v] of Object.entries(mod)) {
        let lien: unknown = v;
        if (typeof v === "function") {
          try { lien = (v as (...a: unknown[]) => unknown)("id-factice", "id-factice", "id-factice"); } catch { continue; }
        }
        if (typeof lien !== "string" || !lien.startsWith("/")) continue;
        vus += 1;
        if (!porteDuLien(lien).connu) inconnus.push(`${f}:${nom} → ${lien}`);
      }
    }
    expect(vus).toBeGreaterThan(10);
    expect(inconnus, inconnus.join("\n")).toEqual([]);
  });

  it("sous un écran de décision, seulement d'autres écrans de décision (Adam : conversation et bureau)", () => {
    for (const r of ROUTES_CONNUES.filter((x) => x.module && MODULES_SIEGES.has(x.module as Module))) {
      const dessous = ROUTES_CONNUES.filter((q) => q.prefixe.startsWith(`${r.prefixe}/`) && !(q.module && MODULES_SIEGES.has(q.module)));
      expect(dessous.map((q) => q.prefixe), r.prefixe).toEqual([]);
    }
  });
});

/**
 * UNE SEULE PORTE, ET AUCUN ÉCRIVAIN À CÔTÉ (cliquet) — tout fichier de production qui écrit une notification
 * (`notification.create` / `createMany`) fait passer ses destinataires par l'admission (`admettreDestinataires`,
 * `admettreLignes`, `lienAdmis`). Seul le rejeu (`ecrire.ts`) en est dispensé : il réécrit des lignes déjà admises.
 */
describe("tout écrivain de notifications passe par l'admission", () => {
  it("aucun `notification.create(Many)` sans admission dans le même fichier", () => {
    const racine = path.resolve(__dirname, "../..");
    const fautifs: string[] = [];
    const parcourir = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { parcourir(p); continue; }
        if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
        const rel = path.relative(racine, p);
        if (rel === path.join("lib", "notifications", "ecrire.ts")) continue;
        const src = fs.readFileSync(p, "utf8");
        if (/\.notification\.(create|createMany)\s*\(/.test(src) && !/\b(admettreDestinataires|admettreLignes|lienAdmis)\s*\(/.test(src)) fautifs.push(rel);
      }
    };
    parcourir(racine);
    expect(fautifs, `écrivains de notifications sans admission : ${fautifs.join(", ")}`).toEqual([]);
  });
});
