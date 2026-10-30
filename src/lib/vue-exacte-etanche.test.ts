import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * VUE EXACTE ÉTANCHE — « quand je vois l'écran de Leila, je dois voir vraiment SON interface, tout, et c'est
 * seulement quand je quitte cette vue que je reviens à mon profil — pas de chevauchement possible ! »
 * (Direction, 06/10, défaut récurrent).
 *
 * Les causes mesurées, une garde chacune :
 *   1. le rendu qui SUIT une action qui revalide tourne dans le stockage `isAction` de Next (14.2) : la coque et
 *      la page se rendaient pour l'ADMINISTRATEUR au milieu de l'écran visualisé → `rendreEnCours` ;
 *   2. les actions qui CHARGENT un panneau (partage, équipe, dossiers liables, partages d'un fichier…) rendaient
 *      les données de l'administrateur → `enLecture(requireUser)` ;
 *   3. un onglet resté ouvert (ou la vue expirée) gardait la coque d'une personne sur les pages d'une autre →
 *      témoin `amd_vue` + `GardeIdentite` (rechargement complet) ;
 *   4. le navigateur partageait brouillons, presse-papiers et épingles entre les deux → `cleParPersonne` ;
 *   5. la coque montrait encore le profil de l'administrateur (son nom dans le bandeau, « Se déconnecter ») ;
 *   6. une connexion/déconnexion laissait la vue ouverte pour la session suivante.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ── Bancs : session réelle, Next et React remplacés par leurs mécanismes (stockages asynchrones) ──────────
const ETAT = vi.hoisted(() => ({
  session: null as unknown,
  cookie: undefined as string | undefined,
  cible: { id: "leila", name: "Leila", email: "leila@t.dz", role: "MEDICAL_DELEGATE", isActive: true } as Record<string, unknown> | null,
  action: null as null | { run: <T>(s: { isAction: boolean }, f: () => T) => T; getStore: () => unknown },
  rendu: null as null | { run: <T>(s: Map<unknown, unknown>, f: () => T) => T },
}));
vi.mock("@/auth", () => ({ auth: async () => ETAT.session }));
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (n: string) => (n === "amd_impersonate" && ETAT.cookie ? { value: ETAT.cookie } : undefined) }),
  headers: () => new Headers(),
}));
vi.mock("next/dist/server/app-render/action-async-storage.external", async () => {
  const { AsyncLocalStorage: ALS } = await import("node:async_hooks");
  const store = new ALS<{ isAction: boolean }>();
  ETAT.action = store as never;
  return { actionAsyncStorage: store };
});
// `cache` de React : mémorise PENDANT un rendu (le stockage du rendu), recalcule hors rendu — sa sémantique documentée.
vi.mock("react", async (orig) => {
  const { AsyncLocalStorage: ALS } = await import("node:async_hooks");
  const als = new ALS<Map<unknown, unknown>>();
  ETAT.rendu = als as never;
  const cache = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
    const m = als.getStore();
    if (!m) return fn(...a);
    if (!m.has(fn)) m.set(fn, fn(...a));
    return m.get(fn) as R;
  };
  return { ...(await orig<Record<string, unknown>>()), cache, default: { ...((await orig<{ default: object }>()).default), cache } };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async ({ where }: { where: { id: string } }) => (ETAT.cible && ETAT.cible.id === where.id ? ETAT.cible : null) },
    userSession: { findUnique: async () => null, update: async () => null },
  },
}));
vi.mock("@/lib/rbac", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAccess: async (_id: string, role: string) => ({ role, secondaryRole: null, interims: [] }),
}));

import { requireUser, getCurrentUser, getCurrentUserPourEcrire, requireUserAuNomDeLaVue } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { vueHonoree, lireMarqueVue, cleParPersonne, MARQUE_VUE_COOKIE } from "@/lib/vue-exacte-ui";

const ADMIN = { user: { id: "amine", role: "SUPER_ADMIN", name: "Amine", email: "amine@t.dz" } };
const dansAction = <T,>(f: () => Promise<T>) => ETAT.action!.run({ isAction: true }, f);
const dansRendu = <T,>(f: () => Promise<T>) => ETAT.rendu!.run(new Map(), f);

beforeEach(() => {
  ETAT.session = ADMIN;
  ETAT.cookie = "leila";
  ETAT.cible = { id: "leila", name: "Leila", email: "leila@t.dz", role: "MEDICAL_DELEGATE", isActive: true };
});

describe("la règle pure — qui est à l'écran", () => {
  const base = { ecriture: false, auNomDeLaVue: false, lecture: false, actionServeur: false, rendu: false };
  it("tout ce qui s'affiche voit la vue ; seul le corps d'une écriture part au nom du Super Admin", () => {
    expect(vueHonoree({ ...base, rendu: true })).toBe(true); // page, coque
    expect(vueHonoree(base)).toBe(true); // route d'API GET, téléchargement
    expect(vueHonoree({ ...base, actionServeur: true })).toBe(false); // corps d'une action
    expect(vueHonoree({ ...base, actionServeur: true, rendu: true })).toBe(true); // rendu qui suit l'action
    expect(vueHonoree({ ...base, actionServeur: true, lecture: true })).toBe(true); // action qui charge un panneau
    expect(vueHonoree({ ...base, ecriture: true, rendu: true })).toBe(false); // route d'API qui écrit
    expect(vueHonoree({ ...base, actionServeur: true, auNomDeLaVue: true })).toBe(true); // création de demande
  });

  it("le témoin de vue se lit dans `document.cookie`, et les clés navigateur se rangent par personne", () => {
    expect(MARQUE_VUE_COOKIE).toBe("amd_vue");
    expect(lireMarqueVue("a=1; amd_vue=leila; b=2")).toBe("leila");
    expect(lireMarqueVue("a=1; amd_vue_x=z")).toBe("");
    expect(lireMarqueVue("")).toBe("");
    expect(cleParPersonne("amd-drive-clipboard", "leila")).toBe("amd-drive-clipboard:leila");
    expect(cleParPersonne("amd-drive-clipboard", "amine")).not.toBe(cleParPersonne("amd-drive-clipboard", "leila"));
    expect(cleParPersonne("k", "")).toBe("k");
  });
});

describe("la session réelle — chaque chemin d'identité", () => {
  it("une page (rendu) voit Leila, avec le Super Admin en `impersonatedBy`", async () => {
    const u = await dansRendu(() => requireUser());
    expect(u.id).toBe("leila");
    expect(u.impersonatedBy?.id).toBe("amine");
  });

  it("RÉGRESSION — le rendu qui SUIT une action (même stockage `isAction`) voit toujours Leila, coque comprise", async () => {
    const u = await dansAction(() => dansRendu(() => requireUser()));
    expect(u.id, "la coque se rendait pour l'administrateur au milieu de l'écran de Leila").toBe("leila");
    expect((await dansAction(() => dansRendu(() => getCurrentUser())))?.id).toBe("leila");
  });

  it("le CORPS d'une action qui écrit part au nom du Super Admin, qui sait qu'une vue est ouverte (`visualise`)", async () => {
    const u = await dansAction(() => requireUser());
    expect(u.id).toBe("amine");
    expect(u.impersonatedBy).toBeUndefined();
    expect(u.visualise).toEqual({ id: "leila", name: "Leila" });
  });

  it("une action qui ne fait que CHARGER un panneau (`enLecture`) voit Leila — et la suite de l'action n'en hérite pas", async () => {
    const lu = await dansAction(() => enLecture(requireUser));
    expect(lu.id).toBe("leila");
    const apres = await dansAction(async () => { await enLecture(requireUser); return requireUser(); });
    expect(apres.id, "seule la résolution enveloppée est une lecture").toBe("amine");
  });

  it("une route d'API qui écrit reste au Super Admin, même pendant un rendu ; la création de demande suit la vue", async () => {
    expect((await dansRendu(() => getCurrentUserPourEcrire()))?.id).toBe("amine");
    expect((await dansAction(() => requireUserAuNomDeLaVue())).id).toBe("leila");
  });

  it("hors vue, rien ne change : pas de `visualise`, pas d'`impersonatedBy`", async () => {
    ETAT.cookie = undefined;
    const u = await dansAction(() => requireUser());
    expect(u.id).toBe("amine");
    expect(u.visualise).toBeUndefined();
    expect((await dansRendu(() => requireUser())).impersonatedBy).toBeUndefined();
  });

  it("un cookie forgé par un non-Super Admin, ou visant un compte fermé, ne change rien", async () => {
    ETAT.session = { user: { id: "leila", role: "MEDICAL_DELEGATE", name: "Leila", email: "l" } };
    ETAT.cookie = "amine";
    ETAT.cible = { id: "amine", name: "Amine", email: "a", role: "SUPER_ADMIN", isActive: true };
    expect((await dansRendu(() => requireUser())).id).toBe("leila");
    ETAT.session = ADMIN;
    ETAT.cookie = "leila";
    ETAT.cible = { id: "leila", name: "Leila", email: "l", role: "MEDICAL_DELEGATE", isActive: false };
    const u = await dansAction(() => requireUser());
    expect(u.id).toBe("amine");
    expect(u.visualise).toBeUndefined();
  });
});

// ── Gardes de source : les points d'appel ───────────────────────────────────────────────────────────────
const lire = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function fichiers(dir: string, filtre: (n: string) => boolean): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? fichiers(p, filtre) : filtre(n) ? [p.replace(/\\/g, "/")] : [];
  });
}

describe("la coque est celle de la personne visualisée — et d'elle seule", () => {
  const layout = lire("src/app/(app)/layout.tsx");

  it("la coque monte la garde d'identité et range les données navigateur par personne effective", () => {
    expect(layout).toMatch(/<IdentiteProvider id=\{user\.id\}/);
    expect(layout).toMatch(/<GardeIdentite marque=\{marqueVue\}/);
    expect(layout).toMatch(/\(await cookies\(\)\)\.get\(MARQUE_VUE_COOKIE\)/);
  });

  it("la barre du haut reçoit la personne à l'écran champ par champ — jamais l'objet de session (sid, droits)", () => {
    expect(layout).not.toMatch(/<Topbar[^>]*user=\{user\}/);
    expect(layout).toMatch(/enVue: Boolean\(user\.impersonatedBy\)/);
  });

  it("le bandeau dit « Vous voyez l'interface de … » et ne nomme pas l'administrateur", () => {
    expect(layout).not.toMatch(/adminName=/);
    const bandeau = lire("src/components/layout/impersonation-banner.tsx");
    expect(bandeau).toContain("Vous voyez l&apos;interface de <strong>{viewedName}</strong>");
    expect(bandeau).not.toMatch(/adminName|impersonatedBy/);
  });

  it("le menu du compte, en vue, propose « Quitter la vue » à la place de « Se déconnecter »", () => {
    const menu = lire("src/components/layout/user-menu.tsx");
    expect(menu).toMatch(/enVue \? \(\s*<QuitterVueBouton/);
    expect(lire("src/components/layout/topbar.tsx")).toContain("enVue={user.enVue}");
  });

  it("entrer et sortir rechargent la page ENTIÈRE, la garde se taisant pendant la bascule", () => {
    for (const f of ["src/app/(app)/admin/users/[id]/impersonate-button.tsx", "src/components/layout/quitter-vue-bouton.tsx"]) {
      const s = lire(f);
      expect(s, f).toContain("annoncerBasculeDeVue()");
      expect(s, f).toContain("window.location.assign(");
      expect(s, f).not.toMatch(/router\.(push|replace)\(/);
    }
    const garde = lire("src/components/layout/identite-vue.tsx");
    expect(garde).toContain("window.location.reload()");
    expect(garde).toMatch(/addEventListener\("pageshow"/);
  });
});

describe("la vue se pose, s'efface et ne survit pas à la session", () => {
  it("cookie de la vue et témoin se posent/effacent ENSEMBLE, par les seules fonctions de `vue-exacte.ts`", () => {
    const actions = lire("src/lib/actions/impersonation-actions.ts");
    expect(actions).toContain("poserVueExacte(targetId)");
    expect(actions).toContain("effacerVueExacte()");
    expect(actions).not.toMatch(/cookies\(\)\)?\.set/);
    const ve = lire("src/lib/vue-exacte.ts");
    // Next 15 : `cookies()` est asynchrone — chaque fonction lit le pot UNE fois (`const jar = await cookies()`).
    expect(ve.match(/const jar = await cookies\(\);/g)).toHaveLength(2);
    expect(ve).toMatch(/jar\.set\(MARQUE_VUE_COOKIE, targetId/);
    expect(ve).toMatch(/jar\.set\(MARQUE_VUE_COOKIE, "", \{ httpOnly: false/);
  });

  it("se connecter et se déconnecter ferment la vue", () => {
    const auth = lire("src/lib/actions/auth-actions.ts");
    const corps = (nom: string) => auth.slice(auth.indexOf(`export async function ${nom}`)).split(/\nexport /)[0];
    expect(corps("authenticate")).toContain("effacerVueExacte()");
    expect(corps("doSignOut")).toContain("effacerVueExacte()");
  });
});

describe("les données navigateur personnelles sont rangées par personne", () => {
  // Préférences d'AFFICHAGE de l'appareil (largeur, colonnes, pôles ouverts, couleur) : elles ne disent rien de la
  // personne et restent communes. Tout le reste passe par `cleParPersonne` / `useCleParPersonne` / `lireStockagePersonnel`.
  // `CLE_THEME` : le thème clair / sombre d'Adventum IA (décision 0027) — un réglage d'affichage de l'appareil.
  const PREFERENCES_APPAREIL = new Set(["OPEN_POLES_KEY", "WIDE_KEY", "HIDDEN_COLS_KEY", '"ik-mail-accent"', "CLE_THEME"]);
  // Variables qui portent déjà une clé rangée par personne (vérifié ci-dessous à leur définition).
  const PERSONNELLES = new Set(["draftKey", "cleClip"]);

  it("aucun `localStorage` d'une donnée personnelle sous une clé commune", () => {
    const fautes: string[] = [];
    for (const f of fichiers("src", (n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n))) {
      const s = lire(f);
      for (const m of s.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(\s*([^,)]+(?:\([^)]*\))?)/g)) {
        const cle = m[1].trim();
        if (PREFERENCES_APPAREIL.has(cle) || PERSONNELLES.has(cle)) continue;
        if (/cleParPersonne\(/.test(cle)) continue;
        // `lireStockagePersonnel` lit la clé par personne puis, hors vue seulement, l'ancienne clé commune.
        if (f.endsWith("identite-vue.tsx") && (cle === "base")) continue;
        fautes.push(`${f} — ${cle}`);
      }
    }
    expect(fautes).toEqual([]);
  });

  it("brouillon de message, presse-papiers du Drive et épingles Bureautique sont rangés par personne", () => {
    expect(lire("src/app/(app)/messages/composer.tsx")).toMatch(/const draftKey = cleParPersonne\(`amd-msg-draft-\$\{conversationId\}`, selfId\)/);
    expect(lire("src/app/(app)/drive/drive-table.tsx")).toMatch(/const cleClip = useCleParPersonne\(CLIPBOARD_KEY\)/);
    expect(lire("src/components/layout/office-pins.tsx")).toContain("lireStockagePersonnel(OFFICE_PINS_KEY, ident)");
  });
});

describe("les actions qui CHARGENT un écran voient la personne visualisée", () => {
  // Les lectures appelées depuis l'écran : chacune résout son utilisateur par `enLecture(requireUser)`.
  const LECTURES: Record<string, string[]> = {
    "src/lib/actions/dossier-actions.ts": ["listLinkableDossiers"],
    "src/lib/actions/partage-actions.ts": ["listerDestinatairesPartage"],
    "src/lib/actions/drive-actions.ts": ["getDriveNodeShares", "getDriveNodeVersions"],
    "src/lib/actions/drive-comment-actions.ts": ["listDriveComments"],
    "src/lib/regulatory/intelligence/knowledge/actions.ts": ["loadDossierChatAction"],
    "src/lib/actions/market-actions.ts": ["searchMarketProducts", "marketSuggestions"],
    "src/modules/ad-pro/actions-congres-beneficiaires.ts": ["listBeneficiaryRefs"],
    "src/lib/actions/document-request-actions.ts": ["askablePeople"],
    "src/lib/actions/link-actions.ts": ["linkCandidatesFor"],
    "src/lib/actions/my-team-actions.ts": ["teamMemberKpis"],
    "src/lib/actions/regulatory-actions.ts": ["checkDciDuplicate"],
    "src/modules/ad-pro/actions-medecins.ts": ["chercherMedecinsAnnuaire"],
    "src/lib/actions/assistant-actions.ts": ["listAssistantFiles", "myAssistantThreads", "myAssistantThread", "refreshMyBrief"],
  };
  // Lectures VOLONTAIREMENT au nom du Super Admin réel : aperçus d'une écriture qui suivra en son nom, lectures
  // OCR qui préparent une saisie, outils réservés au Super Admin.
  const AU_NOM_DE_L_ADMIN = new Set([
    "apercuSuppressionPieceDeLaDemande", "apercuDeSuppression", "apercuSuppressionGroupee", // aperçu d'une suppression
    "apercuAvantImpressionPiece", "previewDirectorySheet", "previewCatalogNormalization", // aperçu d'une écriture
    "apercuBcPoste", // l'aperçu du BC que la MÊME personne valide ensuite (numéro du registre NNN/DG/AAAA attribué en son nom)
    "apercuBcPromo", // le même aperçu, pour le BC d'un devis de matériel promotionnel (validé ensuite par le demandeur, en son nom)
    "apercuRegles", "apercuImportSegmentation", // aperçu d'un import / d'une règle
    "lireLesLignesDuDevis", "lireScanDevisPromo", "lireFacturePromo", // lecture OCR qui prépare une saisie
    "lireDocumentLegalPourSaisie", // la même lecture, pour une pièce Legal saisie ensuite par la personne (en son nom)
    // L'intégration Ad & Pro 2026 (be70d5ee) : lire le fichier puis l'aperçu avant → après préparent `validerIntegrationAdPro`,
    // qui écrit au nom de l'administrateur — lus pour la vue, ils proposeraient les enveloppes de la personne visualisée
    // et le lot partirait sur celles de l'administrateur. Lire une tranche de pièces du rapprochement ÉCRIT (empreintes, lectures Luna).
    "lireFichierIntegrationAdPro", "apercuIntegrationAdPro", "lireTranchePiecesRapprochement",
    "searchRelations", "compterDossiersNonEntames", "searchCorpusAction", // réservés au Super Admin
    // J11 : le sélecteur d'une référence du formulaire de carte — la carte se signe ensuite au nom de la session réelle
    // (`confirmerIntentionAssistantIA`, `requireUser`) ; ses options doivent être celles de qui signe.
    "chercherReferenceCarteAssistantIA",
    "apercuReprise", // l'aperçu à blanc d'une reprise de la refonte des données — Super Admin seul, qui exécute ensuite en son nom
  ]);
  const corpsDe = (src: string, nom: string) => src.slice(src.indexOf(`export async function ${nom}(`)).split(/\nexport /)[0];

  it("chaque lecture déclarée résout son utilisateur par `enLecture(requireUser)`", () => {
    for (const [f, noms] of Object.entries(LECTURES)) {
      const s = lire(f);
      for (const n of noms) {
        const c = corpsDe(s, n);
        expect(c, `${f} ${n}`).toContain("enLecture(requireUser)");
        expect(c, `${f} ${n}`).not.toMatch(/await requireUser\(\)/);
      }
    }
  });

  it("CLIQUET — une action au nom de lecture appelée par l'écran est déclarée, ou nommée ici avec sa raison", () => {
    const tout = fichiers("src", (n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n));
    const clients = tout.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8"))).map((f) => readFileSync(f, "utf8"));
    const serveurs = tout.filter((f) => /^\s*(\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(readFileSync(f, "utf8")));
    const LECTURE = /^(get|list|load|fetch|search|lire|lister|charger|rechercher|chercher|preview|count|compter|suggest|peek|poll|apercu|obtenir|my(?=[A-Z]))/;
    const fautes: string[] = [];
    for (const f of serveurs) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/export async function (\w+)\(/g)) {
        const n = m[1];
        if (!LECTURE.test(n) || AU_NOM_DE_L_ADMIN.has(n)) continue;
        if (!clients.some((c) => new RegExp(`\\b${n}\\b`).test(c))) continue;
        const c = corpsDe(s, n);
        if (!/await requireUser\(\)|requireModule\(/.test(c)) continue;
        if (!c.includes("enLecture(requireUser)")) fautes.push(`${f} ${n}`);
      }
    }
    expect(fautes).toEqual([]);
  });

  it("les gestes d'Adam réservés à « soi » refusent aussi quand le Super Admin RÉEL a une vue ouverte", () => {
    const s = lire("src/lib/actions/assistant-actions.ts");
    for (const n of ["assistantChat", "deleteMyAssistantThread", "forgetMyAssistantMemory"]) {
      expect(corpsDe(s, n), n).toMatch(/user\.impersonatedBy \|\| user\.visualise/);
    }
  });
});

describe("chaque route d'API résout l'identité par la session partagée", () => {
  // Routes SANS session d'utilisateur : clés d'API (v1), webhooks signés, jetons publics, OnlyOffice (JWT), ou
  // télémétrie du VRAI poste (activité, rejeu, capture d'écran : c'est l'administrateur qui est devant l'écran), ou
  // la sonde de santé de l'hébergeur (`SELECT 1`, ne lit aucune identité).
  const SANS_SESSION = [
    /api[\\/]auth[\\/]/, /api[\\/]v1[\\/]/, /api[\\/]site-web[\\/]v1[\\/]/, /api[\\/]events[\\/]inbound[\\/]/, /api[\\/]events[\\/]qr[\\/]/,
    /api[\\/]google[\\/]pubsub[\\/]/, /api[\\/]mail[\\/]inbound[\\/]/, /api[\\/]onlyoffice[\\/]/, /api[\\/]push[\\/]key[\\/]/,
    /api[\\/]activity[\\/]/, /api[\\/]replay[\\/]/, /api[\\/]security[\\/]screenshot-attempt[\\/]/,
    /api[\\/]health[\\/]/,
  ];
  it("aucune route ne lit l'identité ailleurs que dans `@/lib/session` (hors routes sans session, nommées)", () => {
    const fautes = fichiers("src/app/api", (n) => n === "route.ts")
      .filter((f) => !SANS_SESSION.some((r) => r.test(f)))
      // `@/lib/session-legere` (sondages de la coque, PERF-06) applique la MÊME vue (`vueDemandee`,
      // session-compte.ts) — vérifié par `session-vue-exacte.test.ts` et `session-legere.test.ts`.
      .filter((f) => !/"@\/lib\/session(-legere)?"/.test(readFileSync(f, "utf8")));
    expect(fautes).toEqual([]);
  });
  it("les routes de télémétrie qui lisent `auth()` directement restent celles nommées", () => {
    const directes = fichiers("src/app/api", (n) => n === "route.ts").filter((f) => /from "@\/auth"/.test(readFileSync(f, "utf8")));
    expect(directes.map((f) => f.replace(/\\/g, "/")).sort()).toEqual([
      "src/app/api/activity/route.ts",
      "src/app/api/auth/[...nextauth]/route.ts",
      "src/app/api/replay/route.ts",
      "src/app/api/security/screenshot-attempt/route.ts",
    ]);
  });
});
