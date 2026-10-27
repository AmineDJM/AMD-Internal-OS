import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CurrentUser } from "@/lib/session";
import { REFUS_IA_COUPEE, remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { IaCoupee, repondreAvecSecours } from "@/lib/agent/repondre";
import { genererTexte, remplacerModelesPourTests } from "@/lib/agent/generer";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ASSISTANT IA SOUS L'INTERRUPTEUR GÉNÉRAL (audit 27/10, IA-ASSISTANT-01).
 *
 * L'écran « Contrôle de l'IA » promet, coupé : « Toute l'IA est coupée ». L'Assistant IA — ouvert
 * à des personnes qui ne sont pas Super Admin, et qui parle à MiMo, un fournisseur tiers — ne le
 * lisait nulle part : conversation, fil en arrière-plan, routines programmées, résumés et
 * traductions partaient quand même. Ce banc l'exige dans les DEUX sens (§118.17) : coupé, le
 * modèle n'est JAMAIS appelé ; rallumé, tout passe comme avant.
 *
 * Le lecteur est INJECTÉ : la ligne `AiSetting` est globale et partagée par la suite (§118.132).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const user = { id: "u-interrupteur", role: "SUPER_ADMIN" } as unknown as CurrentUser;
const base = { user, historique: [], instructions: "Test.", delaiMs: 5_000, outils: [], propositionsFaites: () => 0 };

afterEach(() => {
  remplacerLecteurInterrupteurIaPourTests(null);
  remplacerModelesPourTests(null);
});

describe("les deux portes de l'Assistant IA vers le modèle lisent l'interrupteur général", () => {
  it("coupé : repondreAvecSecours refuse avec la phrase du refus, et le modèle n'est JAMAIS appelé", async () => {
    remplacerLecteurInterrupteurIaPourTests(async () => true);
    const f = modeleFactice([{ texte: "Je réponds quand même." }]);
    await expect(repondreAvecSecours({ ...base, message: "?", modeles: [f.modele] })).rejects.toBeInstanceOf(IaCoupee);
    await expect(repondreAvecSecours({ ...base, message: "?", modeles: [f.modele] })).rejects.toThrow(REFUS_IA_COUPEE);
    expect(f.toursJoues()).toBe(0);
  });

  it("rallumé : la conversation passe comme avant, et l'interrupteur a bien été LU", async () => {
    let lu = 0;
    remplacerLecteurInterrupteurIaPourTests(async () => { lu += 1; return false; });
    const f = modeleFactice([{ texte: "Voici." }]);
    const r = await repondreAvecSecours({ ...base, message: "?", modeles: [f.modele] });
    expect(r.texte).toBe("Voici.");
    expect(lu).toBe(1);
    expect(f.toursJoues()).toBe(1);
  });

  it("coupé : genererTexte (résumés, traductions, comparaison des routines) n'envoie rien ; rallumé, il rédige", async () => {
    const f = modeleFactice([{ texte: "Résumé." }]);
    remplacerModelesPourTests([f.modele]);
    remplacerLecteurInterrupteurIaPourTests(async () => true);
    expect(await genererTexte("Résume.", "Un texte.")).toEqual({ ok: false, raison: REFUS_IA_COUPEE });
    expect(f.toursJoues()).toBe(0);
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    expect(await genererTexte("Résume.", "Un texte.")).toEqual({ ok: true, texte: "Résumé." });
  });
});

/** Les fichiers de production de l'Assistant IA. */
function fichiers(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) fichiers(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p.split("\\").join("/"));
  }
  return out;
}

describe("cliquet : pas de troisième porte vers le modèle", () => {
  it("tout fichier de l'Assistant IA qui construit un agent Mastra lit l'interrupteur — la seule exception est nommée", () => {
    // `agent.ts` (creerAgent) n'a AUCUN appelant de production — seulement son test (constat IA-ASSISTANT-08).
    // Le jour où il en a un, il doit lire l'interrupteur ou disparaître.
    const SANS_APPELANT = new Set(["src/lib/agent/agent.ts"]);
    const portes = [...fichiers("src/lib/agent"), ...fichiers("src/app/(app)/assistant")]
      .filter((f) => /\bnew Agent\(/.test(readFileSync(f, "utf8")));
    expect(portes.length).toBeGreaterThanOrEqual(2);
    const sansGarde = portes.filter((f) => !SANS_APPELANT.has(f) && !/\binterrupteurIaCoupe\(\)/.test(readFileSync(f, "utf8")));
    expect(sansGarde, `Ces fichiers parlent au modèle sans lire l'interrupteur général : ${sansGarde.join(", ")}`).toEqual([]);
  });
});
