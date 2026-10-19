import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * UNE SEULE PORTE VERS LES FOURNISSEURS DE MODELE.
 *
 * -- CE QUI A ETE MESURE --------------------------------------------------------------
 *
 * `gateway.ts` porte en tete : « LA PASSERELLE - le SEUL endroit d\'Adam qui parle a un
 * fournisseur de modele. » C\'etait une INTENTION, pas un invariant : `src/lib/ai.ts` ouvrait
 * sa propre connexion vers Anthropic, et vingt-sept appelants passaient par la - la memoire
 * durable d\'Adam, le decoupage en episodes, le brief quotidien, l\'analyse de contrat,
 * l\'extraction des lignes d\'appel d\'offres, l\'arbitrage de faits, le simulateur d\'examen et
 * la boucle agent du dossier Regulatory.
 *
 * Le banc live l\'a rendu visible : `[ai] anthropic error 401` a chaque tour, sur un deploiement
 * qui tourne chez OpenAI. Trois degats, aucun visible a l\'ecran - la capacite ne s\'executait
 * pas, le cout etait faux (ces appels ne passaient pas par `recordModelCall`), et l\'abstention
 * « pas de cle » etait fondee sur une cle que le produit n\'utilise pas.
 *
 * -- POURQUOI CE TEST PLUTOT QU\'UNE RELECTURE ------------------------------------------
 *
 * Le defaut n\'etait pas une ligne fausse : c\'etait un fichier ENTIER qui doublait un autre,
 * pendant des mois, sans que rien ne le dise. Une relecture ne l\'avait pas vu ; un test le voit
 * a chaque `npm test`, et il nomme le fichier fautif.
 *
 * -- LES EXCEPTIONS, ET CE QUI LES JUSTIFIE --------------------------------------------
 *
 * Elles ne sont pas « ce qui restait » : chacune parle un protocole que la passerelle de TEXTE
 * ne transporte pas, et chacune tient sa propre comptabilite.
 * ======================================================================================
 */

/** Les points d\'entree HTTP d\'un fournisseur de modele. Une chaine ici = un appel direct. */
const PORTES = /api\.anthropic\.com|\/v1\/messages\b|\/v1\/chat\/completions\b|\/v1\/responses\b/;

/**
 * LES SEULS FICHIERS AUTORISES A LES NOMMER, et la raison de chacun.
 *
 *   - `models/` : la passerelle elle-meme et ses adaptateurs. C\'est le sujet.
 *   - `openai-luna.ts` : l\'API BATCH (`/v1/batch` avec un `endpoint`) et le chemin Luna, qui
 *     tient sa propre comptabilite dans `RegulatoryAiCall` - plafond par dossier et cache par
 *     part inclus. Ce n\'est pas un second chemin non compte, c\'est un second compteur, voulu.
 *   - `media/stt.ts` et `ai.ts` (transcription) : Whisper. De l\'audio, pas du texte : la
 *     passerelle ne transporte pas de `multipart/form-data`.
 *   - `assistant/voice-realtime.ts` : la session temps reel (WebRTC), un protocole a part dont
 *     l\'usage est journalise sous `ROLE_VOIX`.
 */
const AUTORISES = [
  "src/lib/models/",
  "src/lib/openai-luna.ts",
  "src/lib/media/stt.ts",
  "src/lib/assistant/voice-realtime.ts",
];

/**
 * LE CODE SEUL, SANS LES COMMENTAIRES.
 *
 * La premiere version de ce garde tombait sur `lib/ai.ts` a cause d\'une PHRASE : celle qui
 * raconte, en tete de `aiSelfTest`, que la fonction pingait `api.anthropic.com`. Un garde qui
 * punit la documentation de son propre defaut pousse a effacer l\'histoire pour passer au vert -
 * exactement le contraire de ce qu\'on veut. Il cherche des APPELS, pas de la prose.
 */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function fichiers(racine: string): string[] {
  const out: string[] = [];
  const marcher = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) marcher(p);
      else if (/\.tsx?$/.test(e)) out.push(p.replace(/\\/g, "/"));
    }
  };
  marcher(racine);
  return out;
}

describe("une seule porte vers les fournisseurs de modele", () => {
  const tous = fichiers("src");

  it("aucun module hors `models/` n\'ouvre sa propre connexion a un fournisseur", () => {
    const fautifs = tous
      .filter((f) => !AUTORISES.some((a) => f.startsWith(a)))
      .filter((f) => PORTES.test(sansCommentaires(readFileSync(f, "utf8"))));

    expect(fautifs,
      "ces fichiers appellent un fournisseur sans passer par `models/gateway.ts` : leurs jetons " +
      "ne sont pas comptes, leur cout est absent du total, et ils ignorent ADAM_MODEL_PROVIDER")
      .toEqual([]);
  });

  it("`lib/ai.ts` delegue - il ne reimplemente plus rien", () => {
    const src = readFileSync("src/lib/ai.ts", "utf8");
    // Il garde le droit de nommer Whisper (transcription). Rien d\'autre.
    const portes = sansCommentaires(src).split("\n").filter((l) => PORTES.test(l));
    expect(portes, "lib/ai.ts a repris un chemin direct vers un fournisseur de texte").toEqual([]);
    expect(src).toContain('from "./models/gateway"');
    expect(src).toContain('from "./models/compat"');
  });

  it("`aiConfigured` suit le FOURNISSEUR ACTIF, pas Anthropic", async () => {
    /**
     * Le defaut exact : sur un deploiement OpenAI parfaitement configure, une demi-douzaine de
     * modules bien ecrits s\'abstenaient (« pas de cle -> pas d\'IA »). Une abstention fondee sur
     * une cle qu\'on n\'utilise pas n\'est pas de la prudence.
     */
    const { aiConfigured } = await import("@/lib/ai");
    const avant = { o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY, p: process.env.ADAM_MODEL_PROVIDER };
    try {
      delete process.env.ADAM_MODEL_PROVIDER; // -> openai, le defaut
      process.env.OPENAI_API_KEY = "cle-de-test";
      delete process.env.ANTHROPIC_API_KEY;
      expect(aiConfigured(), "OpenAI configure, ANTHROPIC absente : l\'IA doit etre declaree disponible").toBe(true);

      delete process.env.OPENAI_API_KEY;
      process.env.ANTHROPIC_API_KEY = "cle-de-test";
      expect(aiConfigured(), "fournisseur actif OpenAI sans cle : l\'IA n\'est PAS disponible").toBe(false);
    } finally {
      if (avant.o === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = avant.o;
      if (avant.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = avant.a;
      if (avant.p === undefined) delete process.env.ADAM_MODEL_PROVIDER; else process.env.ADAM_MODEL_PROVIDER = avant.p;
    }
  });

  it("`aiModel` nomme le modele qui SERT - il alimente `AiUsage` et l\'ecran d\'administration", async () => {
    const { aiModel, aiModelCheap } = await import("@/lib/ai");
    const { bindingFor } = await import("@/lib/models/registry");
    expect(aiModel()).toBe(bindingFor("worker").model);
    expect(aiModelCheap()).toBe(bindingFor("bulk").model);
    // Et il ne rend plus un nom Anthropic grave dans le fichier.
    expect(aiModel()).not.toBe("claude-sonnet-4-6");
  });

  it("mesure consignee - modules qui parlent a un fournisseur sans passer par la porte", () => {
    const hors = tous
      .filter((f) => !AUTORISES.some((a) => f.startsWith(a)))
      .filter((f) => PORTES.test(sansCommentaires(readFileSync(f, "utf8"))));
    consignerMesure("un_seul_chemin_vers_les_modeles", { n: tous.length, ok: tous.length - hors.length },
      "lib/models/passerelle-unique.test.ts",
      "fichiers de src/ qui ne contournent pas models/gateway.ts pour appeler un fournisseur de modele - un contournement ne compte ni ses jetons ni son cout");
    expect(hors).toEqual([]);
  });
});
