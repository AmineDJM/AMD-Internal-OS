/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUTIL DE COMPOSITION (mandat 7) — Adam agence l'écran, il ne le dessine pas.
 *
 * ── LA DISTINCTION QUI TIENT TOUT ───────────────────────────────────────────────────────
 *
 * Adam décide de la STRUCTURE : ce qui est côte à côte, ce qui est en onglets, ce qu'on met en
 * avant, sous quel angle on regarde les mêmes lignes. Il ne décide PAS du rendu : les feuilles
 * sont les blocs qui existent déjà, avec leurs droits, leurs validations et leurs tests.
 *
 * C'est ce qui permet de dire « affiche ce que tu veux, comme tu veux » sans qu'une chaîne de
 * caractères issue d'un modèle — ou d'un document lu par un modèle — ne devienne du balisage.
 *
 * ── ET SI L'AGENCEMENT EST REFUSÉ ? ─────────────────────────────────────────────────────
 *
 * On affiche quand même. Les blocs ont coûté des lectures ; perdre la mise en page est une
 * gêne, perdre le résultat est une panne. Le repli est une pile, et l'outil DIT que
 * l'agencement a été refusé et pourquoi — il ne fait pas semblant d'avoir obéi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import {
  compiler, raconter, repli, anglesUtiles, regarder,
  ANGLES, CONTENANTS, type Angle, type Ligne, type Noeud, type Planche,
} from "@/platform/in-process/planche";

type Acteur = Parameters<PowerTool["run"]>[1];

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const lignesDe = (v: unknown): Ligne[] => (Array.isArray(v) ? v.filter((x): x is Ligne => typeof x === "object" && x !== null && !Array.isArray(x)) : []);

/**
 * LES BLOCS QUE L'ÉCRAN SAIT RENDRE.
 *
 * Cette liste est la frontière. Elle est écrite ici plutôt qu'importée du composant React parce
 * qu'un outil d'assistant ne doit pas dépendre de l'arbre de rendu — mais elle est vérifiée
 * contre lui par un test, faute de quoi elle divergerait en silence et l'écran afficherait un
 * trou là où le compilateur avait dit oui.
 */
export const KINDS_RENDUS = new Set<string>([
  "agenda", "alerte", "artifact", "comparison", "dashboard", "directory", "document",
  "dossier", "email", "entity360", "mail", "mission", "people", "planification",
  "progress", "queue", "record", "story", "table", "timeline", "viz",
]);

export const PLANCHE_TOOLS: PowerTool[] = [
  {
    def: {
      name: "composer_planche",
      description:
        "AGENCER L'ÉCRAN — décider de ce qui est côte à côte, en onglets, mis en avant. "
        + "questions : « angles » (sur des lignes DÉJÀ obtenues, propose les façons de les regarder qui INFORMENT — un champ dont toutes les lignes ont la même valeur n'est pas un angle, un champ toujours distinct non plus) · "
        + "« regarder » (applique un angle : PAR_VALEUR / PAR_PERIODE / CLASSEMENT / CROISEMENT / ECARTS ; ne relit RIEN, et DIT toujours combien de lignes ont été écartées et pourquoi) · "
        + "« agencer » (compose l'arbre : six contenants — COLONNES, LIGNES, SECTION, ONGLETS, PILE, ACCENT — autour des blocs que tu as déjà produits). "
        + "La composition est libre, le rendu est fermé : les feuilles désignent des blocs existants, JAMAIS du balisage. "
        + "Un agencement refusé n'annule pas le contenu : il retombe sur une pile et l'outil dit pourquoi.",
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string", enum: ["angles", "regarder", "agencer"] },
          lignes: { type: "array", items: { type: "object" }, description: "Les lignes déjà obtenues. Un angle ne relit rien : il travaille sur ce que tu lui donnes." },
          champs: { type: "array", items: { type: "string" }, description: "angles : les champs à examiner." },
          angle: { type: "string", enum: [...ANGLES], description: "regarder : la façon de voir." },
          champ: { type: "string" },
          champ2: { type: "string", description: "CROISEMENT : le second champ." },
          maille: { type: "string", enum: ["jour", "semaine", "mois", "trimestre", "annee"] },
          mesure: { type: "string", description: "Le champ à SOMMER. Sans lui, on compte les lignes." },
          decroissant: { type: "boolean" },
          limite: { type: "number" },
          intention: { type: "string", description: "agencer : ce que la planche montre, en une phrase — sert à la voix et à l'accessibilité." },
          blocs: { type: "array", items: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] }, description: "agencer : les blocs déjà produits, dans l'ordre." },
          arbre: { type: "object", description: "agencer : l'arbre. Un nœud est soit { forme, titre?, etiquettes?, poids?, enfants[] }, soit { bloc: <index dans `blocs`> }." },
        },
        required: ["question"],
      },
    },
    // Aucun droit propre : cet outil ne LIT RIEN et n'écrit rien. Il agence des blocs que
    // l'appelant a déjà obtenus sous ses propres droits — les données ne transitent pas par
    // une nouvelle porte, elles sont réordonnées.
    allowed: () => true,
    label: "Composer l'affichage",
    run: async (input: Record<string, unknown>, _user: Acteur) => {
      const question = str(input, "question").toLowerCase() || "agencer";
      const lignes = lignesDe(input.lignes);

      if (question === "angles") {
        const champs = Array.isArray(input.champs)
          ? (input.champs as unknown[]).filter((x): x is string => typeof x === "string")
          : [...new Set(lignes.flatMap((l) => Object.keys(l)))];
        const props = anglesUtiles(lignes, champs);
        return JSON.stringify({
          ok: true,
          lignes: lignes.length,
          angles: props.map((p) => ({ angle: p.angle, champ: p.champ, ...(p.maille ? { maille: p.maille } : {}) })),
          note: props.length === 0
            ? "aucun angle n'informerait sur ces lignes : soit elles sont trop peu nombreuses, soit chaque champ a une seule valeur ou autant de valeurs que de lignes."
            : "ce sont des PROPOSITIONS calculées sur la forme des données, pas sur ce que la personne cherche — c'est à toi de choisir celui qui répond à SA question.",
        });
      }

      if (question === "regarder") {
        const angle = (str(input, "angle") || "PAR_VALEUR") as Angle;
        if (!(ANGLES as readonly string[]).includes(angle)) {
          return JSON.stringify({ ok: false, erreur: `« ${angle} » n'est pas un angle. Les cinq sont : ${ANGLES.join(", ")}.` });
        }
        const champ = str(input, "champ");
        if (!champ) return JSON.stringify({ ok: false, erreur: "Précisez le champ (`champ`)." });
        if (lignes.length === 0) return JSON.stringify({ ok: false, erreur: "Aucune ligne fournie : un angle regroupe ce qu'on lui donne, il ne va rien chercher." });

        const v = regarder(lignes, {
          angle, champ,
          champ2: str(input, "champ2") || undefined,
          maille: (str(input, "maille") || undefined) as never,
          mesure: str(input, "mesure") || null,
          decroissant: typeof input.decroissant === "boolean" ? input.decroissant : undefined,
          limite: typeof input.limite === "number" ? input.limite : undefined,
        });
        return JSON.stringify({
          ok: true,
          titre: v.titre,
          groupes: v.groupes.map((g) => ({ cle: g.cle, lignes: g.n, somme: g.somme })),
          total: v.total,
          // CE QUI A ÉTÉ ÉCARTÉ SORT AU MÊME NIVEAU QUE LE TOTAL, pas en note de bas de page.
          ecartees: v.ecartees,
          limites: v.limites,
          rappel: v.ecartees
            ? `DIS-LE : ${v.total.lignes} ligne(s) retenues, ${v.ecartees.combien} écartée(s) ${v.ecartees.pourquoi}. Un total qui tait ses exclusions trompe.`
            : "toutes les lignes fournies ont été retenues.",
        });
      }

      // ── agencer ────────────────────────────────────────────────────────────────────
      const blocs = Array.isArray(input.blocs)
        ? (input.blocs as unknown[]).filter((x): x is { kind: string } => typeof x === "object" && x !== null && typeof (x as { kind?: unknown }).kind === "string")
        : [];
      if (blocs.length === 0) return JSON.stringify({ ok: false, erreur: "Aucun bloc à agencer : produis d'abord le contenu, agence-le ensuite." });

      const intention = str(input, "intention") || null;
      const arbre = (typeof input.arbre === "object" && input.arbre !== null ? input.arbre : null) as Noeud | null;
      if (!arbre) {
        const p = repli(blocs, intention);
        return JSON.stringify({ ok: true, agencement: "pile (aucun arbre fourni)", planche: p, resume: raconter(p), _blocs: blocs });
      }

      const p: Planche = { racine: arbre, blocs, intention };
      const v = compiler(p, KINDS_RENDUS);
      if (!v.ok) {
        // ON AFFICHE QUAND MÊME. Perdre la mise en page est une gêne, perdre le résultat est
        // une panne — et on dit ce qui a été refusé plutôt que de faire semblant d'avoir obéi.
        const secours = repli(blocs, intention);
        return JSON.stringify({
          ok: true,
          agencement: "REFUSÉ — repli sur une pile",
          refus: v.problemes.map((x) => `${x.ou} : ${x.explication}`),
          planche: secours,
          resume: raconter(secours),
          _blocs: blocs,
          rappel: "Dis à la personne que le contenu est là mais que la mise en page demandée n'a pas pu être appliquée, et pourquoi.",
        });
      }
      return JSON.stringify({
        ok: true,
        agencement: `${v.noeuds} nœud(s), ${v.profondeur} niveau(x)`,
        ...(v.blocsOrphelins.length ? { blocs_non_places: v.blocsOrphelins, note: "ces blocs ont coûté un calcul et n'affichent rien" } : {}),
        planche: p,
        resume: raconter(p),
        contenants_disponibles: CONTENANTS,
        _blocs: blocs,
      });
    },
  },
];
