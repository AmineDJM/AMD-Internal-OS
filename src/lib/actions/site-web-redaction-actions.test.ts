import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « RÉDIGER AVEC L'IA » — PAR LES VRAIES PORTES DE L'ÉCRAN (§118.160, §118.14).
 *
 * Le monde extérieur est simulé, et lui seul : le fournisseur (`askModelJson`), la bascule globale
 * du Centre de contrôle IA et son journal, la présence d'une clé. Tout le reste est le vrai code —
 * la session, les règles d'accès du site (`peutEcrireArticles`, `peutPublierOffres`), le lecteur
 * du formulaire, le cœur de la rédaction. La moitié qui protège est la première : un refus de
 * droit se rend AVANT qu'aucun octet ne parte chez le fournisseur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR , requireUserAuNomDeLaVue: async () => ACTEUR}));

interface Appel { role: string; prompt: string; schema: { name: string }; opts: { system?: string } }
const APPELS: Appel[] = [];
let DONNEES: unknown = null;
vi.mock("@/lib/models/gateway", () => ({
  askModelJson: async (role: string, prompt: string, schema: { name: string }, opts: { system?: string }) => {
    APPELS.push({ role, prompt, schema, opts });
    return {
      data: DONNEES,
      reply: {
        ok: true, configured: true, stop: "end", blocks: [],
        usage: { role, model: "modele-du-banc", provider: "openai", inputTokens: 10, outputTokens: 20, cachedInputTokens: 0, costUsd: 0.001, ms: 5, attempts: 1 },
      },
    };
  },
}));

let ACTIVE = true;
const JOURNAL: { feature: string; userId?: string | null; ok: boolean }[] = [];
vi.mock("@/lib/ai-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-settings")>()),
  aiFeatureEnabled: async () => ACTIVE,
  logAiUsage: async (u: { feature: string; userId?: string | null; ok: boolean }) => { JOURNAL.push(u); },
}));

let CONFIGURE = true;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  aiConfigured: () => CONFIGURE,
}));

import { getAccess, type SessionUser } from "@/lib/rbac";
import { peutEcrireArticles, peutPublierOffres } from "@/lib/site-web/acces";
import { cleModeleRequise } from "@/lib/ai";
import { phraseIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { redigerArticleAvecIA, redigerOffreAvecIA } from "./site-web-redaction-actions";

const ARTICLE = { title: "Sérialisation : ce qui change", description: "", body: "Intro.\n\n## Calendrier", category: "", tags: ["ANPP"] };
const OFFRE = {
  title: "Délégué médical — Oncologie", department: "", location: "Constantine", contractLabel: "CDI", experience: "",
  summary: "Deux phrases.", mission: ["Visiter les CHU"], profile: ["Pharmacien"], offer: ["Véhicule"],
};

async function acteur(role: SessionUser["role"]): Promise<CurrentUser> {
  // Identifiant fictif : `getAccess` retombe sur les droits PAR DÉFAUT du rôle — c'est ce qu'on veut lire.
  const id = `__redac__${role.toLowerCase()}`;
  return { id, name: role, email: `${id}@banc.dz`, role, access: await getAccess(id, role), mustChangePassword: false };
}

function formulaire(champs: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
}

const CONSIGNE = "Un article sur la sérialisation des médicaments en Algérie";

beforeEach(() => {
  APPELS.length = 0; JOURNAL.length = 0; ACTIVE = true; CONFIGURE = true; DONNEES = ARTICLE;
});

describe("Les portes — un refus de droit avant tout appel au fournisseur", () => {
  it("un délégué médical : ni article ni offre — et rien ne part chez le fournisseur", async () => {
    ACTEUR = await acteur("MEDICAL_DELEGATE");
    expect(peutEcrireArticles(ACTEUR)).toBe(false); // prémisse
    expect(peutPublierOffres(ACTEUR)).toBe(false); // prémisse
    expect(await redigerArticleAvecIA(formulaire({ consigne: CONSIGNE }))).toMatchObject({ ok: false, error: expect.stringContaining("« Site web » en écriture") });
    expect(await redigerOffreAvecIA(formulaire({ consigne: CONSIGNE }))).toMatchObject({ ok: false, error: expect.stringContaining("Ressources humaines") });
    expect(APPELS).toHaveLength(0);
    expect(JOURNAL).toHaveLength(0);
  });

  it("la Direction Marketing rédige un ARTICLE, mais pas une OFFRE — deux portes, deux règles", async () => {
    ACTEUR = await acteur("PRODUCT_MANAGER");
    expect(peutEcrireArticles(ACTEUR)).toBe(true); // prémisse
    expect(peutPublierOffres(ACTEUR)).toBe(false); // prémisse
    const a = await redigerArticleAvecIA(formulaire({ consigne: CONSIGNE }));
    expect(a).toMatchObject({ ok: true, champs: { title: ARTICLE.title, tags: "ANPP" } });
    expect(APPELS).toHaveLength(1);
    expect(APPELS[0]!.role).toBe("worker");
    expect(APPELS[0]!.schema.name).toBe("article_site");
    expect(JOURNAL).toEqual([expect.objectContaining({ feature: "site_web", userId: ACTEUR.id, ok: true })]);

    const o = await redigerOffreAvecIA(formulaire({ consigne: CONSIGNE }));
    expect(o).toMatchObject({ ok: false });
    expect(APPELS).toHaveLength(1);
  });

  it("un article forgé : les clés que l'action ne nomme pas n'atteignent pas le modèle ; les catégories, oui, sans les vides", async () => {
    ACTEUR = await acteur("PRODUCT_MANAGER");
    const f = formulaire({ consigne: CONSIGNE, title: "Sérialisation", authorEmail: "SECRET-dg@adventum.dz", slug: "SECRET-slug" });
    f.append("categories", "Réglementation"); f.append("categories", "  "); f.append("categories", "Secteur");
    expect(await redigerArticleAvecIA(f)).toMatchObject({ ok: true });
    expect(APPELS[0]!.prompt).toContain("Catégories déjà employées sur le site : Réglementation, Secteur");
    expect(`${APPELS[0]!.opts.system}\n${APPELS[0]!.prompt}`).not.toMatch(/SECRET-/);
  });

  it("une offre par la Direction : les champs du formulaire partent, la rémunération et la justification non", async () => {
    ACTEUR = await acteur("DIRECTION");
    DONNEES = OFFRE;
    const r = await redigerOffreAvecIA(formulaire({
      consigne: "Délégué médical oncologie pour Constantine", title: "Délégué médical",
      salary: "SECRET-185000", salaryRange: "SECRET-170-190", justification: "SECRET-remplacement de Mme K.",
    }));
    expect(r).toMatchObject({ ok: true, champs: { title: OFFRE.title, contractLabel: "CDI", mission: "Visiter les CHU" } });
    expect(APPELS).toHaveLength(1);
    expect(APPELS[0]!.schema.name).toBe("offre_emploi_site");
    expect(`${APPELS[0]!.opts.system}\n${APPELS[0]!.prompt}`).not.toMatch(/SECRET-/);
    expect(APPELS[0]!.prompt).toContain("Délégué médical");
  });
});

describe("La fonction indisponible se DIT, et ne coûte rien", () => {
  it("bascule coupée dans le Centre de contrôle IA : refus nommant l'écran, aucun appel", async () => {
    ACTEUR = await acteur("DIRECTION");
    ACTIVE = false;
    expect(await redigerArticleAvecIA(formulaire({ consigne: CONSIGNE }))).toMatchObject({ ok: false, error: expect.stringContaining("Centre de contrôle IA") });
    expect(APPELS).toHaveLength(0);
  });

  it("aucun fournisseur configuré : la phrase canonique, avec le nom de clé que le registre lit — aucun appel", async () => {
    ACTEUR = await acteur("DIRECTION");
    CONFIGURE = false;
    expect(await redigerArticleAvecIA(formulaire({ consigne: CONSIGNE }))).toEqual({ ok: false, error: phraseIaNonConfiguree(cleModeleRequise(), "la rédaction par l'IA") });
    expect(APPELS).toHaveLength(0);
  });
});

// ───────────────────────────── Cliquets de branchement (§118.49) ─────────────────────────────

const RACINE = join(__dirname, "..", "..", "..");
const lire = (rel: string) => readFileSync(join(RACINE, rel), "utf8");
/** La source sans ses commentaires — un cliquet ne doit pas s'accrocher à la prose qui le décrit (§118.79d). */
const code = (rel: string) => lire(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("Cliquets — la rédaction est branchée là où l'écran la sert, et nulle part ailleurs", () => {
  it("les deux actions appellent le cœur SANS rien injecter, APRÈS leur porte de droit", () => {
    const src = code("src/lib/actions/site-web-redaction-actions.ts");
    for (const [garde, appel] of [
      ["peutEcrireArticles(user)", /return redigerArticle\(user\.id, \{[^}]*\}\);/],
      ["peutPublierOffres(user)", /return redigerOffre\(user\.id, \{[^}]*\}\);/],
    ] as const) {
      const m = appel.exec(src);
      expect(m, `appel ${appel}`).not.toBeNull();
      const g = src.indexOf(garde);
      expect(g, `garde ${garde}`).toBeGreaterThan(-1);
      expect(g).toBeLessThan(m!.index);
    }
  });

  it("les deux formulaires montent le panneau, et SEULEMENT pour qui peut écrire", () => {
    for (const f of ["src/components/site-web/article-form.tsx", "src/components/site-web/offre-form.tsx"]) {
      const src = code(f);
      expect(src, f).toMatch(/\{peutEcrire && \(\s*<RedigerAvecIA</);
      expect(src.match(/<RedigerAvecIA</g) ?? [], f).toHaveLength(1);
      // Appliquer passe par la règle commune : un champ que l'IA rend vide garde sa valeur.
      expect(src, f).toMatch(/setV\(\(x\) => fusionnerRedaction\(x, c\)\)/);
    }
  });

  it("les quatre pages d'édition calculent la disponibilité (sans rien injecter) et la passent au formulaire", () => {
    const racine = join(RACINE, "src/app/(app)/site-web");
    const pages: string[] = [];
    const parcourir = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) parcourir(p);
        else if (n === "page.tsx") pages.push(p);
      }
    };
    parcourir(racine);
    const avecFormulaire = pages.filter((p) => /<(ArticleForm|OffreForm)\b/.test(readFileSync(p, "utf8")));
    expect(avecFormulaire.length).toBe(4); // prémisse : les quatre pages d'édition ont été trouvées
    for (const p of avecFormulaire) {
      const src = readFileSync(p, "utf8");
      expect(src, p).toMatch(/disponibiliteRedaction\(\)/);
      expect(src, p).toMatch(/\bia=\{ia\}/);
    }
  });

  it("l'action ne lit que les champs du contenu, en littéral — jamais la demande de recrutement", () => {
    const src = code("src/lib/actions/site-web-redaction-actions.ts");
    const cles = [...src.matchAll(/fdStr\(formData, "([^"]+)"\)|formData\.getAll\("([^"]+)"\)/g)].map((m) => m[1] ?? m[2]);
    // Aucune autre lecture du formulaire : une lecture par clé CALCULÉE ferait passer n'importe quoi.
    expect(src.match(/formData\.(get|getAll|entries|keys|values)\(/g)?.length ?? 0).toBe(src.match(/formData\.getAll\("categories"\)/g)?.length ?? 0);
    expect(src).not.toMatch(/Object\.fromEntries\(\s*formData/);
    expect([...new Set(cles)].sort()).toEqual(
      ["body", "categories", "category", "consigne", "contractLabel", "department", "description", "experience", "location", "mission", "offer", "profile", "summary", "title"].sort(),
    );
    for (const f of ["src/lib/site-web/redaction.ts", "src/lib/redaction-site-ia.ts", "src/lib/actions/site-web-redaction-actions.ts"]) {
      const s = code(f);
      expect(s, f).not.toMatch(/recruitment|@\/lib\/prisma|salaryRange|justification\b/);
    }
  });

  it("chaque bascule du Centre de contrôle IA est lue par l'action, offerte par l'écran ET rejouée par l'op d'Adam", async () => {
    const { Prisma } = await import("@prisma/client");
    const champs = Prisma.dmmf.datamodel.models.find((m) => m.name === "AiSetting")!.fields
      .filter((f) => f.type === "Boolean" && /Enabled$/.test(f.name)).map((f) => f.name);
    expect(champs).toContain("siteWebAiEnabled"); // prémisse
    const action = code("src/lib/actions/ai-settings-actions.ts");
    const ecran = code("src/app/(app)/admin/ai/ai-settings-form.tsx");
    const op = code("src/lib/assistant/ops/impl-wave7d.ts");
    for (const c of champs) {
      expect(action, `action ← ${c}`).toContain(`fdBool(formData, "${c}")`);
      expect(ecran, `écran ← ${c}`).toMatch(new RegExp(`\\b${c}: boolean`));
      // Une bascule absente de l'op serait ÉTEINTE à chaque réglage par la conversation : l'action
      // réécrit toutes les colonnes, une case non envoyée vaut « coupée ».
      expect(op, `op ← ${c}`).toMatch(new RegExp(`${c}: onOff\\(next\\.${c}\\)`));
    }
    const offertes = [...ecran.matchAll(/\{ key: "(\w+)"/g)].map((m) => m[1]);
    for (const c of champs.filter((x) => x !== "masterEnabled")) expect(offertes, `bascule offerte à l'écran : ${c}`).toContain(c);
  });
});
