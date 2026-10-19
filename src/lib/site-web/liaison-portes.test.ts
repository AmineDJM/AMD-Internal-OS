import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PORTES DE LA LIAISON AU SITE (§118.159) — tenues sur la SOURCE, parce qu'aucun banc
 * d'exécution ne voit la route qu'on ajoutera demain.
 *
 *   1. Les routes que le SITE appelle (`/api/site-web/v1/…`) vivent HORS de la session : elles
 *      sont exemptées dans `auth.config.ts`. Leur seule porte est `authentifierLeSite`, donc
 *      CHAQUE handler doit l'appeler avant de toucher la base ou le corps. Une route ajoutée sous
 *      ce dossier sans elle serait une écriture publique dans l'ERP.
 *   2. L'exemption du middleware est EXACTE : `/api/site-web/v1/`, barre finale comprise. Le CV
 *      d'une candidature (`/api/site-web/candidatures/…`) reste derrière la session.
 *   3. La valeur d'une clé ne quitte pas la couche serveur de la liaison : seuls les modules de
 *      `lib/site-web/` la lisent, plus l'écran de la LIAISON (Administration › Site web (connexion)) — et lui
 *      seulement derrière sa porte Super Admin, sur une clé EN ATTENTE. Un composant ou un autre
 *      écran qui l'importerait l'afficherait.
 *   4. La liaison ne vit QUE dans la console d'administration (§118.160) : aucun écran du module
 *      « Site web » n'offre un geste de liaison, et l'écran de la liaison ferme sa porte avant de
 *      lire quoi que ce soit.
 *
 * On lit la source SANS ses commentaires : quatre fois dans ce dépôt un cliquet s'est accroché à
 * la prose qui le décrivait (§118.79d, §118.88, §118.112b, §118.138).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = process.cwd();

function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\"'`])\/\/[^\n]*/g, "$1");
}

function fichiers(dossier: string, filtre: (f: string) => boolean): string[] {
  const abs = join(RACINE, dossier);
  const out: string[] = [];
  const parcourir = (d: string) => {
    for (const nom of readdirSync(d)) {
      const p = join(d, nom);
      if (statSync(p).isDirectory()) parcourir(p);
      else if (filtre(p.replace(/\\/g, "/"))) out.push(relative(RACINE, p).replace(/\\/g, "/"));
    }
  };
  parcourir(abs);
  return out.sort();
}

const lire = (f: string) => sansCommentaires(readFileSync(join(RACINE, f), "utf8"));

/** Le corps de chaque handler HTTP exporté (`export async function GET(`…) jusqu'au suivant. */
function handlers(src: string): { nom: string; corps: string }[] {
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  const pos = [...src.matchAll(re)].map((m) => ({ nom: m[1]!, debut: m.index! }));
  return pos.map((p, i) => ({ nom: p.nom, corps: src.slice(p.debut, pos[i + 1]?.debut ?? src.length) }));
}

/** Les fonctions importées de `@/lib/…` (hors la porte elle-même et les constantes). */
function importsDeLib(src: string): string[] {
  const noms: string[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/[^"]+"/g)) {
    for (const brut of m[1]!.split(",")) {
      const nom = brut.replace(/\btype\b/, "").split(/\s+as\s+/).pop()!.trim();
      if (nom && /^[a-z]/.test(nom)) noms.push(nom);
    }
  }
  return noms.filter((n) => n !== "authentifierLeSite");
}

/**
 * LES DEUX SEULES ROUTES PUBLIQUES de `v1/` (Direction, 07/10) : la mesure d'audience. Elle est
 * appelée par le NAVIGATEUR des visiteurs du site, où aucune clé ne peut vivre — sa porte est
 * l'ORIGINE du site (`porteAudience`). Liste EXACTE : une route ajoutée demain sous `v1/` sans
 * `authentifierLeSite` reste une faute, et ces deux-là sont tenues par leurs propres règles plus bas.
 */
const PUBLIQUES = ["src/app/api/site-web/v1/audience/route.ts", "src/app/api/site-web/v1/audience.js/route.ts"];
const unix = (f: string) => f.replace(/\\/g, "/");

describe("Les routes que le site appelle", () => {
  const routes = fichiers("src/app/api/site-web/v1", (f) => f.endsWith("route.ts")).filter((f) => !PUBLIQUES.includes(unix(f)));

  it("PLANCHER : les routes sont trouvées (un parcours cassé rendrait le cliquet vert en ne lisant rien)", () => {
    expect(routes.length, routes.join(", ")).toBeGreaterThanOrEqual(2);
  });

  it("chaque handler appelle authentifierLeSite AVANT la base, le corps analysé ou toute autre fonction de l'ERP", () => {
    const fautes: string[] = [];
    let vus = 0;
    for (const f of routes) {
      const src = lire(f);
      const autres = importsDeLib(src);
      for (const h of handlers(src)) {
        vus += 1;
        const porte = h.corps.indexOf("authentifierLeSite(");
        if (porte < 0) { fautes.push(`${f} ${h.nom} : aucune authentification`); continue; }
        const avant = h.corps.slice(0, porte);
        for (const interdit of ["prisma.", "JSON.parse(", ...autres.map((n) => `${n}(`)]) {
          if (avant.includes(interdit)) fautes.push(`${f} ${h.nom} : « ${interdit} » avant la porte`);
        }
        // Le refus doit ARRÊTER le handler : le résultat est lu et rendu tel quel.
        if (!/if\s*\(\s*!auth\.ok\s*\)\s*return/.test(h.corps)) fautes.push(`${f} ${h.nom} : le refus de la porte n'arrête pas le handler`);
      }
    }
    expect(vus).toBeGreaterThanOrEqual(2);
    expect(fautes, fautes.join("\n")).toEqual([]);
  });

  it("l'exemption du middleware est EXACTE — `/api/site-web/v1/`, barre finale comprise, et rien d'autre du module", () => {
    const conf = lire("src/auth.config.ts");
    const exemptions = [...conf.matchAll(/startsWith\("(\/api\/site-web[^"]*)"\)/g)].map((m) => m[1]);
    expect(exemptions).toEqual(["/api/site-web/v1/"]);
  });

  it("hors de `v1/`, chaque route du module est derrière la SESSION", () => {
    const autres = fichiers("src/app/api/site-web", (f) => f.endsWith("route.ts") && !f.includes("/site-web/v1/"));
    expect(autres.length).toBeGreaterThanOrEqual(1);
    const fautes = autres.filter((f) => !/\b(getCurrentUser|requireUser)\s*\(/.test(lire(f)));
    expect(fautes, fautes.join("\n")).toEqual([]);
  });
});

describe("La mesure d'audience : publique, mais fermée par l'origine et cantonnée à sa table", () => {
  const COLLECTE = "src/lib/site-web/audience-collecte.ts";

  it("PRÉMISSE : les deux routes publiques existent (sinon les règles suivantes ne mesurent rien)", () => {
    const toutes = fichiers("src/app/api/site-web/v1", (f) => f.endsWith("route.ts")).map(unix);
    for (const p of PUBLIQUES) expect(toutes, p).toContain(p);
  });

  it("elles n'importent de l'ERP que la collecte et le script — jamais la base, jamais une clé", () => {
    const fautes: string[] = [];
    for (const f of PUBLIQUES) {
      const src = lire(f);
      if (/\bprisma\b/.test(src)) fautes.push(`${f} : accès direct à la base`);
      for (const m of src.matchAll(/from\s*"(@\/[^"]+)"/g)) {
        if (!["@/lib/site-web/audience-collecte", "@/lib/site-web/audience-calc", "@/lib/site-web/audience-script"].includes(m[1]!)) {
          fautes.push(`${f} : importe ${m[1]}`);
        }
      }
    }
    expect(fautes, fautes.join("\n")).toEqual([]);
  });

  it("la route qui ÉCRIT ferme sa porte d'origine avant de lire le corps, et le refus arrête chaque handler", () => {
    const src = lire(PUBLIQUES[0]!);
    const re = /export\s+async\s+function\s+(POST|OPTIONS)\s*\(/g;
    const pos = [...src.matchAll(re)].map((m) => ({ nom: m[1]!, debut: m.index! }));
    expect(pos.map((p) => p.nom).sort()).toEqual(["OPTIONS", "POST"]);
    for (const [i, p] of pos.entries()) {
      const corps = src.slice(p.debut, pos[i + 1]?.debut ?? src.length);
      const porte = corps.indexOf("porteAudience(");
      expect(porte, `${p.nom} : aucune porte`).toBeGreaterThan(-1);
      const avant = corps.slice(0, porte);
      for (const interdit of ["request.text(", "JSON.parse(", "enregistrerAudience("]) expect(avant, `${p.nom} : « ${interdit} » avant la porte`).not.toContain(interdit);
      expect(corps, `${p.nom} : le refus de la porte n'arrête pas le handler`).toMatch(/if\s*\(\s*!porte\.ok\s*\)\s*return/);
    }
  });

  it("la collecte n'écrit QUE dans SiteAnalyticsEvent", () => {
    const tables = [...lire(COLLECTE).matchAll(/\bprisma\.(\$?\w+)/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    expect([...new Set(tables)]).toEqual(["siteAnalyticsEvent"]);
  });
});

const ECRAN = "src/app/(app)/admin/site-web/page.tsx";
const CARTE = "src/app/(app)/admin/site-web/carte-liaison.tsx";

describe("La valeur d'une clé ne quitte pas la couche serveur", () => {
  const LECTEURS = /\b(cleEnAttente|cleActive)\b/;
  const importeurs = fichiers("src", (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => {
      const src = lire(f);
      return /from\s*"(@\/lib\/site-web\/cles|\.\/cles)"/.test(src) && LECTEURS.test(src.match(/import\s*\{[^}]*\}\s*from\s*"(?:@\/lib\/site-web\/cles|\.\/cles)"/)?.[0] ?? "");
    });

  it("seuls les modules de `lib/site-web/` et l'écran de la LIAISON lisent une clé", () => {
    const hors = importeurs.filter((f) => !f.startsWith("src/lib/site-web/") && f !== ECRAN);
    expect(hors, hors.join("\n")).toEqual([]);
    // PRÉMISSE : l'écran est bien trouvé — sans quoi la règle suivante ne mesurerait rien.
    expect(importeurs).toContain(ECRAN);
  });

  it("l'écran ferme sa porte Super Admin AVANT toute lecture — et ne relit jamais la clé active", () => {
    const page = lire(ECRAN);
    expect(page).not.toMatch(/\bcleActive\s*\(/);
    const porte = page.search(/if\s*\(\s*!peutGererLaLiaison\(user\)\s*\)\s*redirect\(/);
    expect(porte, "la porte Super Admin a disparu de l'écran de la liaison").toBeGreaterThan(-1);
    // Toute lecture — l'état de la liaison, l'état de l'intégration, la clé en attente — vient APRÈS.
    for (const lecture of ["cleEnAttente(", "etatLiaison(", "etatIntegration("]) {
      const at = page.indexOf(lecture);
      expect(at, `${lecture} introuvable`).toBeGreaterThan(-1);
      expect(at, `${lecture} est lu AVANT la porte`).toBeGreaterThan(porte);
    }
  });

  it("aucun composant ne reçoit une clé : la carte ne prend que le bloc, déjà composé côté serveur", () => {
    const carte = lire(CARTE);
    expect(carte).not.toMatch(/from\s*"@\/lib\/site-web\/cles"/);
    const composants = fichiers("src/components", (f) => /\.(ts|tsx)$/.test(f));
    const fautes = composants.filter((f) => /from\s*"@\/lib\/site-web\/cles"/.test(lire(f)));
    expect(fautes, fautes.join("\n")).toEqual([]);
  });
});

describe("La liaison ne vit que dans la console d'administration (§118.160)", () => {
  const GESTES_DE_LIAISON = /geste="(verifier|rapprocher|generer|abandonner|lever)"/g;

  it("aucun écran du module « Site web » n'offre un geste de liaison — seul « relancer » (un contenu) y reste", () => {
    const ecrans = fichiers("src/app/(app)/site-web", (f) => /\.tsx$/.test(f));
    // PLANCHER : la page du module, la liste et les fiches — un parcours cassé rendrait le cliquet vert.
    expect(ecrans.length, ecrans.join(", ")).toBeGreaterThanOrEqual(4);
    const fautes = ecrans.flatMap((f) => [...lire(f).matchAll(GESTES_DE_LIAISON)].map((m) => `${f} : ${m[0]}`));
    expect(fautes, fautes.join("\n")).toEqual([]);
    // Et rien n'y lit l'état de la LIAISON (la santé du site, la clé en attente) : c'est l'écran d'administration qui le montre.
    const lecteurs = ecrans.filter((f) => /\betatLiaison\s*\(|carte-liaison/.test(lire(f)));
    expect(lecteurs, lecteurs.join("\n")).toEqual([]);
  });

  it("l'écran d'administration offre les cinq gestes — sans quoi il n'y aurait plus d'endroit où relier le site", () => {
    const vus = new Set([...`${lire(ECRAN)}\n${lire(CARTE)}`.matchAll(GESTES_DE_LIAISON)].map((m) => m[1]));
    expect([...vus].sort()).toEqual(["abandonner", "generer", "lever", "rapprocher", "verifier"]);
  });

  it("l'adresse nommée par les phrases et les alertes EST l'écran : un lien qui mène ailleurs enverrait chercher la clé où elle n'est plus", async () => {
    const { ECRAN_LIAISON } = await import("./ecran");
    expect(`src/app/(app)${ECRAN_LIAISON.href}/page.tsx`).toBe(ECRAN);
    const { ADMIN_TABS } = await import("@/lib/labels");
    const onglet = ADMIN_TABS.find((t) => t.href === ECRAN_LIAISON.href);
    expect(onglet, "l'écran de la liaison n'a pas d'onglet dans la console").toBeDefined();
    // Le NOM que citent les phrases est celui de l'onglet, mot pour mot : « depuis Administration ›
    // Site web » quand l'onglet s'appelle autrement fait chercher un endroit qui n'existe pas.
    expect(ECRAN_LIAISON.nom).toBe(`Administration › ${onglet!.label}`);
    // Les deux alertes de LIAISON (clé reconnue, publication suspendue) y mènent — lues à leur source.
    const alertes = [
      ["src/lib/site-web/cles.ts", "Site web relié"],
      ["src/lib/site-web/file.ts", "Site web : publication suspendue"],
    ] as const;
    for (const [f, titre] of alertes) {
      const src = lire(f);
      const at = src.indexOf(titre);
      expect(at, `${titre} introuvable dans ${f}`).toBeGreaterThan(-1);
      const appel = src.slice(Math.max(0, src.lastIndexOf("notifyRoles(", at)), src.indexOf("});", at) + 3);
      expect(appel, `l'alerte « ${titre} » ne mène pas à l'écran de la liaison`).toMatch(/link:\s*ECRAN_LIAISON\.href/);
    }
  });
});
