import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { remplacerModelesPourTests } from "./infra/generer";
import { optionsFournisseur } from "./infra/modele";
import { jouerTourDEntree, ENTREES_REBRANCHEES } from "./infra/entrees";
import { cleCacheDeLaPersonne, PREFIXE_CLE_CACHE } from "./domaine/cle-cache";
import { modeleFactice } from "./infra/testing/modele-factice";
import { effacerJournalDe } from "./infra/testing/journal";
import { COMPTE_JOUE } from "./infra/testing/audit/personas";
import { retirerAudit, semerAudit, sessionDe, type SemisAudit } from "./infra/testing/audit/semis";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I6 — UN SEUL MOTEUR (décision 0070 ; audit AU3 §4, étape 4). Le TEST D'ARCHITECTURE et ses preuves.
 *
 *   Le test d'architecture côté Adam (l'ancienne boucle plus importée hors de `lib/assistant`, drapeau, routes masquées,
 *   fils gelés) vit dans `src/platform/moteur-unique.test.ts` (ce module n'importe pas Adam, 0013). Ici :
 *   4. Une seule clé de cache par personne pour toutes les entrées (conversation, entrées rebranchées, routines, missions).
 *   5. Une entrée rebranchée joue un VRAI tour du moteur unique (faux modèle) : même catalogue, même consigne que l'écrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = path.resolve(__dirname, "../../..");
const SRC = path.join(RACINE, "src");

function fichiers(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) fichiers(p, acc); }
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const rel = (p: string) => path.relative(RACINE, p).split(path.sep).join("/");
const SOURCES = fichiers(SRC).map((p) => ({ chemin: rel(p), texte: fs.readFileSync(p, "utf8") }));
/** Le texte sans ses commentaires (les lignes d'avant gardées en commentaire ne sont pas des imports). */
const sansCommentaires = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("I6 — une seule clé de cache par personne, pour toutes les entrées", () => {
  it("la clé : préfixe stable + identifiant interne, rien d'autre", () => {
    expect(cleCacheDeLaPersonne("u1")).toBe(`${PREFIXE_CLE_CACHE}u1`);
    expect(optionsFournisseur({ providerId: "openai", modelId: "gpt-6.1-terra" }, cleCacheDeLaPersonne("u1"))?.openai.promptCacheKey).toBe("assistant-ia:u1");
  });

  it("conversation (et donc toutes les entrées rebranchées), routines et missions passent la MÊME clé", () => {
    const lire = (f: string) => fs.readFileSync(path.join(SRC, "modules/assistant-ia", f), "utf8");
    expect(lire("infra/fil/tour.ts")).toMatch(/cleCache: cleCacheDeLaPersonne\(user\.id\)/);
    expect(lire("infra/routines/passage.ts")).toMatch(/cleCache: cleCacheDeLaPersonne\(user\.id\)/);
    expect(lire("infra/travaux.ts")).toMatch(/cleCache: cleCacheDeLaPersonne\(principalId\)/);
    expect(lire("infra/generer.ts")).toMatch(/optionsFournisseur\(m, opts\.cleCache\)/);
    // Aucune autre clé écrite à la main dans le module.
    const autres = SOURCES.filter((s) => s.chemin.startsWith("src/modules/assistant-ia/") && !/\.test\.tsx?$/.test(s.chemin))
      .filter((s) => /cleCache:\s*`/.test(s.texte)).map((s) => s.chemin);
    expect(autres).toEqual([]);
  });

  it("la relance du moteur unique (ex-nudge) est une action du module et un tour de `jouerTour`", () => {
    const t = fs.readFileSync(path.join(SRC, "modules/assistant-ia/infra/entrees.ts"), "utf8");
    expect(t).toMatch(/export async function relanceDuMoteur[\s\S]*jouerTourDEntree\(user, "relance"/);
    expect(fs.readFileSync(path.join(SRC, "modules/assistant-ia/actions.ts"), "utf8")).toMatch(/export async function relanceMoteurUnique[\s\S]*relanceDuMoteur\(p\.user/);
    expect(fs.readFileSync(path.join(SRC, "lib/actions/adventum-actions.ts"), "utf8")).toMatch(/jouerTourDEntree\(user, "brain"/);
  });

  it("les entrées rebranchées sont nommées (journal) et toutes passent par `jouerTour`", () => {
    expect([...ENTREES_REBRANCHEES]).toEqual(["bureau", "brain", "relance", "appel", "dictee"]);
    const t = fs.readFileSync(path.join(SRC, "modules/assistant-ia/infra/entrees.ts"), "utf8");
    expect(t).toMatch(/await jouerTour\(user, \{/);
    // Aucune consigne propre à une entrée : le préfixe stable reste commun à toutes.
    expect(sansCommentaires(t)).not.toMatch(/consigne\s*:/);
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const ETIQUETTE = `-i6${Date.now().toString(36)}`;
let S: SemisAudit;
const sessions = {} as Record<"superadmin" | "commercial", CurrentUser>;

suite("I6 — en base : une entrée rebranchée = un tour du moteur unique", () => {
  beforeAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    S = await semerAudit(ETIQUETTE, { putBlob, enregistrerFichierDrive }, { societe: `Adventum Pharma ${ETIQUETTE}` });
    for (const p of ["superadmin", "commercial"] as const) sessions[p] = await sessionDe(S.users[COMPTE_JOUE[p]]);
  }, 120_000);

  afterAll(async () => {
    remplacerModelesPourTests(null);
    remplacerLecteurInterrupteurIaPourTests(null);
    if (S) {
      const ids = Object.values(S.users);
      await prisma.assistantMessage.deleteMany({ where: { userId: { in: ids } } });
      await prisma.assistantThread.deleteMany({ where: { userId: { in: ids } } });
      await effacerJournalDe(Object.values(S.users));
      await retirerAudit(ETIQUETTE);
    }
  }, 60_000);

  it("une entrée rebranchée (Brain, relance) joue le MÊME tour que l'écrit : même consigne système, mêmes gardes", async () => {
    const u = sessions.superadmin;
    const systemes: string[] = [];
    for (const entree of ["brain", "relance", "bureau"] as const) {
      const faux = modeleFactice([{ texte: JSON.stringify({ message: `Réponse ${entree}.`, components: [] }) }]);
      remplacerModelesPourTests([faux.modele as never]);
      const r = await jouerTourDEntree(u, entree, { texte: "Quels sont mes rendez-vous de demain ?" });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(r.reponse).toContain(`Réponse ${entree}.`);
      const sys = (faux.promptsRecus[0] as { role: string; content: unknown }[]).filter((x) => x.role === "system").map((x) => JSON.stringify(x.content)).join("\n");
      systemes.push(sys);
    }
    // La consigne ne dépend pas de l'entrée : le préfixe stable (donc le cache) est commun. On compare sans l'heure.
    const stable = (s: string) => s.replace(/\d{1,2}[:h]\d{2}(:\d{2})?/g, "").replace(/\d{4}-\d{2}-\d{2}/g, "");
    expect(new Set(systemes.map(stable)).size).toBe(1);
  }, 120_000);

  it("la frontière tient par l'accès : un employé, par une entrée rebranchée, n'a ni le catalogue ni le canal d'Adam", async () => {
    const u = sessions.commercial;
    const faux = modeleFactice([{ texte: JSON.stringify({ message: "Ok.", components: [] }) }]);
    remplacerModelesPourTests([faux.modele as never]);
    const r = await jouerTourDEntree(u, "brain", { texte: "Envoie un mail depuis le Gmail d'Adam et lis sa boîte." });
    expect(r.ok).toBe(true);
    const envoyes = faux.outilsRecus.flat();
    expect(envoyes.filter((n) => /^gmail_|^envoyer_gmail$|^boite_de_reception$/.test(n))).toEqual([]);
  }, 120_000);

  it("la Vue exacte reste fermée par le moteur, quelle que soit l'entrée", async () => {
    const vue = { ...sessions.commercial, impersonatedBy: { id: sessions.superadmin.id, name: sessions.superadmin.name } } as CurrentUser;
    for (const entree of ENTREES_REBRANCHEES) {
      const r = await jouerTourDEntree(vue, entree, { texte: "Bonjour" });
      expect(r.ok, entree).toBe(false);
    }
  });
});
