import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_ROLES, type ModelRole } from "./contract";
import { bindingFor } from "./registry";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE ROUTAGE PAR RÔLE (§5–§8) — qui travaille, et sur quoi.
 *
 * ── LA DOCTRINE, EN QUATRE LIGNES ────────────────────────────────────────────────────────
 *
 *   realtime      comprend et converse — la VOIX, et rien d'autre ;
 *   orchestrator  travaille et orchestre quand c'est nécessaire — le texte ;
 *   worker/bulk   exécutent les sous-tâches, sans outils et sans raisonnement ;
 *   le code       détient la vérité et exécute.
 *
 * ── POURQUOI CES TESTS EXISTENT ──────────────────────────────────────────────────────────
 *
 * `models.test.ts` vérifie que la TABLE des rôles est juste (quel modèle, quel effort, quel
 * tarif). Il ne dit rien de l'usage : rien ne l'empêchait qu'un chemin textuel demande le rôle
 * `realtime`, ni qu'un ouvrier reçoive des outils. Ce sont deux régressions silencieuses —
 * elles ne cassent rien, elles coûtent cher et changent le comportement.
 *
 * On les prouve par LECTURE DU CODE plutôt que par exécution : ces invariants portent sur ce
 * que le code a le droit de demander, pas sur ce qu'un appel réel renverrait. Un test qui
 * appellerait le fournisseur mesurerait le réseau, pas la règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const read = (p: string): string => fs.readFileSync(p, "utf8");

/** Tout le produit, hors passerelle et hors tests — là où une erreur de routage se glisserait. */
function productFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p.split(path.sep).join("/"));
    }
  };
  walk("src");
  return out.filter((f) => !f.startsWith("src/lib/models/"));
}

describe("§5–§8 — le routage par rôle est tenu par le code, pas par la discipline", () => {
  it("le chemin TEXTUEL part sur l'orchestrateur par défaut", () => {
    // `compat.ts` est la porte unique du texte. Son défaut EST la politique : si personne ne
    // précise de rôle, le travail va à l'orchestrateur — jamais à la voix, jamais à un ouvrier.
    const compat = read("src/lib/models/compat.ts");
    const defauts = [...compat.matchAll(/opts\.role\s*\?\?\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(defauts.length, "aucun défaut de rôle trouvé — `compat.ts` a changé de forme").toBeGreaterThanOrEqual(2);
    expect(new Set(defauts)).toEqual(new Set(["orchestrator"]));
  });

  it("AUCUN chemin textuel ne demande le rôle « realtime »", () => {
    // La régression qu'on redoute : router du texte vers la session vocale. Elle ne casse rien
    // — elle change le modèle, le coût et le comportement, en silence. La voix passe par WebRTC
    // (`voice-realtime.ts`), jamais par `callModel`, donc PERSONNE hors passerelle n'a de raison
    // de nommer ce rôle dans un appel de modèle.
    const fautifs: string[] = [];
    for (const f of productFiles()) {
      const src = read(f);
      // On vise l'usage en tant que RÔLE (`callModel("realtime"`, `role: "realtime"`), pas les
      // occurrences légitimes du mot (le `type: "realtime"` du protocole OpenAI, les libellés).
      if (/(?:callModel|streamModel|askModel|askModelJson)\s*\(\s*["']realtime["']/.test(src)
        || /\brole\s*:\s*["']realtime["']/.test(src)) {
        fautifs.push(f);
      }
    }
    expect(fautifs, `ces fichiers routent du travail vers la voix :\n${fautifs.join("\n")}`).toEqual([]);
  });

  it("la voix est le SEUL usage du rôle temps réel, et elle ne passe pas par la passerelle texte", () => {
    const voix = read("src/lib/assistant/voice-realtime.ts");
    // La session vocale se négocie en SDP/WebRTC : si elle appelait `callModel`, on aurait deux
    // chemins pour la même chose — et le jour d'une divergence, un seul serait corrigé.
    expect(voix).not.toMatch(/\b(?:callModel|streamModel)\s*\(/);
  });

  it("les quatre rôles sont liés à un modèle distinct par usage — aucun rôle orphelin", () => {
    // Un rôle déclaré mais non lié serait une capacité annoncée dans l'écran d'administration
    // et introuvable à l'exécution.
    for (const role of MODEL_ROLES) {
      const b = bindingFor(role as ModelRole);
      expect(b.model, `rôle ${role} sans modèle`).toBeTruthy();
      expect(b.role).toBe(role);
    }
    // La voix ne partage son modèle avec aucun rôle textuel : c'est ce qui rend le routage
    // OBSERVABLE dans la télémétrie (un appel temps réel ne peut pas se confondre avec un autre).
    const rt = bindingFor("realtime").model;
    const textuels = (["orchestrator", "worker", "bulk"] as ModelRole[]).map((r) => bindingFor(r).model);
    expect(textuels).not.toContain(rt);
  });
});
