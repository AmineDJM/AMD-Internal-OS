import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MOT_DE_PASSE, emailDe, COMPTES, type CleCompte } from "./comptes";
import { FICHIER_GRAINE, type GraineRecette } from "./seed";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DE RECETTE — chaque parcours s'écrit en ÉTAPES : un titre, un attendu, un geste.
 *
 * Le rapport final (rapporteur.ts) n'est pas « 12 tests passés » : c'est, pour chaque étape, ce
 * qui était attendu, ce qui a été obtenu, et la capture d'écran qui le prouve — le format que le
 * Super Admin a demandé (« tests user super bien détaillés »). Une étape qui échoue est capturée
 * AVANT que l'erreur ne remonte : la capture de l'échec est la plus utile de toutes.
 *
 * Deux sortes d'étapes :
 *   • `etape(...)`        — bloquante : la suite du parcours en dépend (on s'arrête à l'échec) ;
 *   • `controle(...)`     — un contrôle indépendant (refus de droits, non-débordement…) : son échec
 *                           est consigné, le parcours continue, et le test finit en échec.
 * Captures à deviceScaleFactor 1 (poids raisonnable, lisibles telles quelles).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Appareil = "ordinateur" | "telephone";

export interface EtapeRecette {
  n: number;
  titre: string;
  attendu: string;
  obtenu: string;
  statut: "OK" | "ECHEC";
  capture: string | null;
  appareil: Appareil;
  qui: string | null;
  dureeMs: number;
}

export const SORTIE = (): string => path.resolve(process.env.RECETTE_SORTIE ?? "recette-sortie");
export const NOM_PIECE_ETAPES = "recette-etapes";

/** Serveur de développement (compilation à la demande) : délais allongés. */
export const LENT = process.env.RECETTE_LENT === "1";

const TELEPHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } as const;

let graineLue: GraineRecette | null = null;
/** Les identifiants posés par la graine (société, comptes, départements, BU). */
export function graine(): GraineRecette {
  graineLue ??= JSON.parse(readFileSync(FICHIER_GRAINE(), "utf8")) as GraineRecette;
  return graineLue;
}

const sansAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export class Recette {
  readonly etapes: EtapeRecette[] = [];
  private readonly echecsNonBloquants: string[] = [];
  private readonly contextes: BrowserContext[] = [];
  /** Qui est connecté sur chaque page (pour le rapport). */
  private readonly qui = new WeakMap<Page, string>();
  private readonly appareil = new WeakMap<Page, Appareil>();

  constructor(readonly page: Page, private readonly browser: Browser, private readonly info: TestInfo) {
    this.appareil.set(page, "ordinateur");
  }

  /** Se connecter comme une personne, par l'écran de connexion — comme elle le fera. */
  async connecter(cle: CleCompte, page: Page = this.page): Promise<void> {
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel(/e-?mail/i).fill(emailDe(cle));
    await page.getByLabel(/mot de passe/i).fill(MOT_DE_PASSE);
    await page.getByRole("button", { name: /connexion|se connecter/i }).click();
    // 60 s : la première connexion après un démarrage à froid charge beaucoup. Contre `next dev` (pages compilées à la
    // première visite), RECETTE_LENT=1 porte les délais à 5 min.
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: LENT ? 300_000 : 60_000 });
    this.qui.set(page, COMPTES[cle].metier);
  }

  /** Naviguer PUIS attendre l'hydratation : un clic posé avant ne ferait rien. */
  async aller(url: string, page: Page = this.page): Promise<void> {
    await page.goto(url);
    await page.waitForLoadState("networkidle").catch(() => undefined);
  }

  /** Ouvre un TÉLÉPHONE (390 × 844, tactile) connecté comme cette personne. */
  async telephone(cle: CleCompte): Promise<Page> {
    const ctx = await this.browser.newContext({ ...TELEPHONE, baseURL: this.info.project.use.baseURL, locale: "fr-FR" });
    this.contextes.push(ctx);
    const page = await ctx.newPage();
    this.appareil.set(page, "telephone");
    await this.connecter(cle, page);
    return page;
  }

  /** Une étape BLOQUANTE : capture, consigne, et arrête le parcours si elle échoue. */
  async etape(titre: string, attendu: string, geste: () => Promise<string | void>, o: { page?: Page; cible?: Locator } = {}): Promise<void> {
    await this.jouer(titre, attendu, geste, { ...o, bloquante: true });
  }

  /** Un CONTRÔLE indépendant : consigné, capturé, le parcours continue ; le test finira en échec s'il rate. */
  async controle(titre: string, attendu: string, geste: () => Promise<string | void>, o: { page?: Page; cible?: Locator } = {}): Promise<void> {
    await this.jouer(titre, attendu, geste, { ...o, bloquante: false });
  }

  /**
   * DÉPLIE TOUT LE MENU LATÉRAL — pôles et groupes. Un pôle replié ne rend pas ses entrées : compter les liens d'un menu
   * sans le déplier compterait ce qu'on voit, pas ce qui existe (une personne déplie le pôle pour trouver l'entrée).
   */
  async deplierMenu(page: Page = this.page): Promise<void> {
    const menu = page.locator("[data-app-sidebar]");
    for (let tour = 0; tour < 40; tour += 1) {
      const replie = menu.locator("button[aria-expanded='false']").first();
      if (!(await replie.count())) return;
      await replie.click();
    }
  }

  /** La page ne défile pas de côté (téléphone) : la largeur du document tient dans l'écran. */
  async sansDebordement(page: Page = this.page): Promise<string> {
    const { scroll, largeur } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, largeur: window.innerWidth }));
    expect(scroll, `la page déborde de ${scroll - largeur} px à ${largeur} px de large`).toBeLessThanOrEqual(largeur + 1);
    return `aucun débordement à ${largeur} px`;
  }

  private async jouer(
    titre: string, attendu: string, geste: () => Promise<string | void>,
    o: { page?: Page; cible?: Locator; bloquante: boolean },
  ): Promise<void> {
    const page = o.page ?? this.page;
    const n = this.etapes.length + 1;
    const debut = Date.now();
    let obtenu = "conforme";
    let statut: EtapeRecette["statut"] = "OK";
    let erreur: unknown = null;
    try {
      const dit = await geste();
      if (dit) obtenu = dit;
    } catch (e) {
      statut = "ECHEC";
      erreur = e;
      obtenu = sansAnsi(e instanceof Error ? e.message : String(e)).split("\n").filter(Boolean).slice(0, 6).join(" ⏎ ");
    }
    const capture = await this.capturer(page, n, titre, o.cible);
    this.etapes.push({
      n, titre, attendu, obtenu, statut, capture, appareil: this.appareil.get(page) ?? "ordinateur",
      qui: this.qui.get(page) ?? null, dureeMs: Date.now() - debut,
    });
    if (statut === "ECHEC") {
      if (o.bloquante) throw erreur;
      this.echecsNonBloquants.push(`Étape ${n} « ${titre} » : ${obtenu}`);
    }
  }

  private async capturer(page: Page, n: number, titre: string, cible?: Locator): Promise<string | null> {
    const dossier = path.join(SORTIE(), "captures", slug(path.basename(this.info.file, ".recette.ts")));
    mkdirSync(dossier, { recursive: true });
    const fichier = path.join(dossier, `${slug(this.info.title).slice(0, 40)}-${String(n).padStart(2, "0")}-${slug(titre)}.png`);
    try {
      if (cible && (await cible.isVisible().catch(() => false))) await cible.screenshot({ path: fichier, timeout: 5_000 });
      else await page.screenshot({ path: fichier, fullPage: true, timeout: 10_000 });
      return path.relative(SORTIE(), fichier);
    } catch {
      return null;
    }
  }

  /** Fin du parcours : on rend les étapes au rapporteur, on ferme les téléphones, on échoue si un contrôle a raté. */
  async cloturer(): Promise<void> {
    await this.info.attach(NOM_PIECE_ETAPES, { body: JSON.stringify(this.etapes), contentType: "application/json" });
    for (const ctx of this.contextes) await ctx.close().catch(() => undefined);
    if (this.echecsNonBloquants.length > 0 && this.info.status === "passed") {
      throw new Error(`Contrôles en échec :\n- ${this.echecsNonBloquants.join("\n- ")}`);
    }
  }
}

export const test = base.extend<{ recette: Recette }>({
  recette: async ({ page, browser }, use, info) => {
    const r = new Recette(page, browser, info);
    await use(r);
    await r.cloturer();
  },
});

export { expect };

/** Le tag d'un parcours écrit d'après DECISIONS.md et les maquettes, dont le lot n'est pas encore fusionné. */
export const attendFusion = (...lots: string[]): { tag: string[] } => ({ tag: lots.map((l) => `@attend-fusion:${l}`) });
