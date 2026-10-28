import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE MISSIONS EST ATTEIGNABLE, ET IL MONTRE CE QUE LE MOTEUR SAIT (§118.14).
 *
 * ── POURQUOI CES TESTS LISENT DES FICHIERS ──────────────────────────────────────────────
 *
 * Parce que la question n'est pas « la fonction marche-t-elle ? » — les tests d'à côté y
 * répondent — mais « quelqu'un l'appelle-t-il POUR DE VRAI ? ». Un recensement a montré, dans
 * ce même dépôt, quatre exports sans aucun appelant et vingt-quatre appelés par leurs seuls
 * tests, dont toute la porte d'approbation côté humain. `listerAccordsMission` en faisait
 * partie : écrite pour un écran, elle n'était appelée par aucun. Une capacité que personne ne
 * peut déclencher n'existe pas, et un test qui vérifie son corps sans chercher son POINT
 * D'APPEL est complice du défaut (§118.49).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const RACINE = join(process.cwd(), "src");
const lire = (p: string) => readFileSync(join(RACINE, p), "utf8");

const PAGE_CENTRE = "app/(app)/centre-de-missions/page.tsx";
const PAGE_MISSION = "app/(app)/missions/[id]/page.tsx";
const PANNEAU = "components/missions/mission-runtime-panel.tsx";
const CONTROLES = "components/missions/mission-runtime-controls.tsx";
const VUE_CONTROL = "lib/missions/view/control.ts";
const VUE_WORKSPACE = "lib/missions/view/workspace.ts";
const ACTIONS = "lib/actions/mission-runtime-actions.ts";

describe("l'écran existe et on peut y arriver", () => {
  it("le parc a une PAGE, et la page appelle la vue", () => {
    const page = lire(PAGE_CENTRE);
    expect(page).toContain("centreDeMissions");
    expect(page).toContain('from "@/lib/missions/view/control"');
  });

  it("le menu porte une entrée vers le centre — sans quoi l'écran n'existe que pour qui connaît l'URL", () => {
    const nav = lire("lib/labels/navigation.ts");
    expect(nav).toContain('href: "/centre-de-missions"');
  });

  it("les ACCORDS sont décidables depuis le centre — `listerAccordsMission` a enfin un appelant", () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : retirer la section des accords du centre. On retomberait
     * dans l'état d'avant — un accord ne se donne qu'en arrivant par le lien d'une
     * notification, une mission à la fois, et une autorisation attendue depuis six jours se
     * découvre en cherchant autre chose.
     */
    const page = lire(PAGE_CENTRE);
    expect(page).toContain("listerAccordsMission");
    expect(page).toContain("AccordControls");
  });

  it("le retour de la page d'une mission mène au CENTRE, pas au module RH", () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : `href="/missions"`. C'est la liste des ordres de mission
     * RH — congrès, accompagnants — qui ne contiendra JAMAIS la mission d'exécution qu'on
     * vient de quitter.
     */
    const page = lire(PAGE_MISSION);
    expect(page).toContain('href="/centre-de-missions"');
    expect(page).not.toMatch(/href="\/missions"/);
  });
});

describe("l'écran d'une mission montre ce que le moteur sait", () => {
  it("l'HORIZON est rendu quand il existe (§118.40)", () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : un panneau qui n'affiche que les étapes. Sur une mission
     * de sept jalons, il montrerait les étapes du jalon COURANT — « 4/5 » — et la personne
     * lirait « presque fini » sur une mission qui a six semaines devant elle.
     */
    const p = lire(PANNEAU);
    expect(p).toContain("MissionHorizon");
    expect(p).toMatch(/vue\.horizon\s*\?\s*<MissionHorizon/);
  });

  it("la PAUSE, les ATTENTES, les LECTURES ÂGÉES et le JOURNAL sont rendus", () => {
    const p = lire(PANNEAU);
    for (const bloc of ["MissionPause", "MissionAttentes", "MissionLectures", "MissionJournal"]) {
      expect(p, `${bloc} n'est pas rendu par l'écran d'une mission`).toContain(bloc);
    }
  });

  it("le sous-titre vient de la VUE — deux endroits qui calculent la même phrase divergent", () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : un `{faites}/{total} étapes` recomposé dans l'en-tête. Il
     * redirait les étapes du sous-plan courant là où la vue dit « jalon 3/7 », et les deux
     * phrases se contrediraient sur le même écran.
     */
    const p = lire(PANNEAU);
    expect(p).toContain("{vue.subtitle}");
  });

  it("les gestes de conduite fine ne sont proposés que sur une mission VIVANTE", () => {
    const p = lire(PANNEAU);
    expect(p).toMatch(/statut !== "COMPLETED" && vue\.statut !== "CANCELLED"/);
    expect(p).toContain("PrioriteControls");
    expect(p).toContain("ModificationControls");
  });
});

describe("les comptes ne peuvent pas mentir", () => {
  it("les deux vues ÉCARTENT ce que le plan courant a contourné", () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : garder les étapes d'un plan périmé dans un des deux
     * écrans. La liste et la page de la même mission afficheraient deux ratios différents, et
     * l'avancement RECULERAIT à chaque replanification.
     */
    expect(lire(VUE_CONTROL)).toContain('st."supersededAt" IS NULL');
    expect(lire(VUE_WORKSPACE)).toContain("where: { supersededAt: null }");
  });

  it("le compte des étapes retire les MODÈLES d'éventail, sans `LIKE`", () => {
    const v = lire(VUE_CONTROL);
    expect(v).toContain("position('#' in key)");
    // On lit la REQUÊTE, pas le fichier : un commentaire qui explique pourquoi on n'utilise
    // pas `LIKE` contient le mot, et une assertion qui tomberait là-dessus se ferait retirer.
    const sql = v.slice(v.indexOf("WITH enfants AS"), v.indexOf('GROUP BY st."missionId"'));
    expect(sql.length, "la requête de comptage n'a pas été lue").toBeGreaterThan(200);
    // Un `LIKE key || '#%'` casserait sur une clé contenant un caractère joker — et un compte
    // faux ici est un compte faux sur tous les écrans, puisque c'est celui qu'ils affichent.
    expect(sql).not.toMatch(/LIKE/i);
  });
});

describe("le filtre du journal", () => {
  it("aucun genre classé DÉCISION ou PROBLÈME n'est dans le bruit", async () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : ajouter au bruit un genre qui porte une décision ou un
     * problème. L'écran cacherait alors précisément ce qu'il existe pour montrer, et personne
     * ne s'en apercevrait — un filtre silencieux ne laisse aucune trace de ce qu'il retire.
     *
     * On relit le SOURCE plutôt que d'exporter les deux tables : ce sont des détails
     * d'implémentation du module, et les exporter pour les tester en ferait des contrats.
     */
    const src = lire(VUE_CONTROL);
    const bruit = new Set(
      (/const BRUIT: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? "")
        .match(/"[A-Z_]+"/g)?.map((x) => x.slice(1, -1)) ?? [],
    );
    const graviteBloc = /const GRAVITE: Record<string, GraviteJournal> = \{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    const classes = [...graviteBloc.matchAll(/([A-Z_]+):\s*"(decision|probleme)"/g)].map((m) => m[1]);

    expect(bruit.size, "la liste de bruit n'a pas été lue").toBeGreaterThan(5);
    expect(classes.length, "la table de gravité n'a pas été lue").toBeGreaterThan(10);
    expect(classes.filter((k) => bruit.has(k))).toEqual([]);
  });
});

describe("la modification en deux temps", () => {
  it("l'APERÇU est une action à part, et il n'écrit rien", () => {
    const a = lire(ACTIONS);
    expect(a).toContain("prevoirModificationMission");
    expect(a).toContain("appliquerModificationMission");
    // `prevoirModification` est la fonction de lecture seule du socle ; l'action d'aperçu ne
    // doit appeler QU'ELLE — appliquer d'abord et raconter ensuite demanderait à la personne
    // de faire confiance à un résumé écrit après coup.
    const bloc = a.slice(a.indexOf("export async function prevoirModificationMission"),
      a.indexOf("export async function appliquerModificationMission"));
    expect(bloc).toContain("prevoirModification(");
    expect(bloc).not.toContain("appliquerModification(");
  });

  it("un bouton n'est cliquable qu'une fois son geste BRANCHÉ", () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : des boutons actifs dès le rendu serveur. Entre le rendu et
     * l'hydratation, ils ont l'air cliquables et ne font RIEN — on clique, il ne se passe rien,
     * et l'on ne sait pas si le geste est parti. Attrapé en vrai par le banc Playwright, où le
     * clic sur « Voir l'effet exact » arrivait avant l'hydratation : l'aperçu n'apparaissait
     * jamais. Ce n'était pas un défaut de banc, c'était le défaut qu'il a trouvé.
     */
    const c = lire(CONTROLES);
    expect(c).toMatch(/function useInteractif\(\)/);
    expect(c).toMatch(/React\.useEffect\(\(\) => setPret\(true\), \[\]\)/);
    // Aucun bouton de geste ne se contente de `disabled={enCours !== null}` : tous attendent
    // l'hydratation. Un seul oubli suffit à rendre un geste muet une demi-seconde.
    expect(c).not.toMatch(/disabled=\{enCours !== null\}/);
    expect(c).not.toMatch(/disabled=\{vide \|\| enCours !== null\}/);
  });

  it("l'écran n'offre « Appliquer » qu'APRÈS un aperçu reconnu", () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : un bouton « Appliquer » toujours actif. On invaliderait
     * une branche sans avoir lu ce qu'elle emporte — sur une mission qui a déjà sollicité trois
     * personnes, se tromper de branche coûte ces trois demandes, et rien ne les reprend.
     */
    const c = lire(CONTROLES);
    expect(c).toMatch(/apercu\?\.ok\s*\?/);
    expect(c).toContain("effetsIrreversibles");
  });
});
