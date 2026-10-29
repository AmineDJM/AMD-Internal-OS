import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NAVIGATION } from "@/lib/labels";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADAM EST UN MODULE, ET LA DONNÉE N'EST PAS UN PARAGRAPHE — deux propriétés d'ÉCRAN.
 *
 * ── CE QUI A ÉTÉ MESURÉ ──────────────────────────────────────────────────────────────────
 *
 * (1) LA COQUE. Le bureau d'Adam avait son propre groupe de routes, `(chief)`, dont le layout
 *     retirait les neuf éléments de chrome de l'ERP. L'intention était bonne ; le prix était
 *     qu'il n'existait AUCUNE façon d'aller dans un autre module — la seule sortie était une
 *     icône de 44 px repliée dans un coin, sinon le bouton « précédent » du navigateur.
 *
 * (2) LA MESURE. Le flux de la conversation était borné par UNE seule largeur, `max-w-3xl`
 *     (768 px), et les blocs de l'espace de travail vivaient DEDANS. Un tableau de treize
 *     colonnes, un tableau de bord de six tuiles, un diagramme de Gantt étaient donc comprimés
 *     dans 768 px sur un écran de 2560. « Il ne peut pas tout afficher » n'était pas une limite
 *     du protocole — vingt et un types de blocs, dix-sept formes de représentation — c'était
 *     cette borne, appliquée à de la donnée alors qu'elle est faite pour de la prose.
 *
 * ── POURQUOI CE TEST LIT LA SOURCE ──────────────────────────────────────────────────────
 *
 * Les deux défauts sont des propriétés de STRUCTURE : un groupe de routes, une classe CSS. Ni
 * l'un ni l'autre ne se voit dans un rendu de composant isolé — c'est l'ENVIRONNEMENT qui les
 * porte (§118.75 : un écran juste dans un module retiré est du code mort qu'aucun test ne
 * voit). On vérifie donc le fait qui les tient, à l'endroit exact où il doit être (§118.49).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const lire = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const existe = (rel: string): boolean => fs.existsSync(path.join(process.cwd(), rel));

const PAGE = "src/app/(app)/chief-of-staff/page.tsx";
const CHAT = "src/app/(app)/assistant/assistant-chat.tsx";
/**
 * La conversation est découpée en `assistant-chat/` (la porte ne fait que réexporter) : les règles de
 * mise en page ci-dessous valent pour TOUT son rendu, donc on lit la porte et chacun de ses morceaux.
 */
const DOSSIER_CHAT = "src/app/(app)/assistant/assistant-chat";
const lireChat = (): string =>
  [CHAT, ...fs.readdirSync(path.join(process.cwd(), DOSSIER_CHAT)).sort().map((f) => `${DOSSIER_CHAT}/${f}`)].map(lire).join("\n");

describe("la coque d'Adam — un module comme les autres", () => {
  it("la page vit sous `(app)`, donc elle HÉRITE du menu latéral et de la barre supérieure", () => {
    // Ce qui le ferait tomber : redonner à Adam un groupe de routes à lui. Le menu latéral
    // disparaîtrait de nouveau, et l'on ne quitterait Adam que par le bouton « précédent ».
    expect(existe(PAGE), "la page d'Adam doit vivre dans le groupe de routes de l'ERP").toBe(true);
    expect(existe("src/app/(chief)"), "aucun groupe de routes propre à Adam : la coque est celle de l'ERP").toBe(false);
    // Le layout de `(app)` est ce qui porte la navigation — on vérifie qu'il la rend vraiment,
    // plutôt que de faire confiance à l'appartenance au dossier.
    const layout = lire("src/app/(app)/layout.tsx");
    expect(layout).toContain("<Sidebar items={navItems}");
    expect(layout).toContain("<MobileTabBar items={navItems}");
  });

  it("le menu latéral LISTE Adam : on y entre comme dans n'importe quel module", () => {
    const entree = NAVIGATION.find((n) => n.href === "/chief-of-staff");
    expect(entree, "« /chief-of-staff » doit être une entrée de navigation, pas une adresse à connaître").toBeTruthy();
    expect(entree?.module).toBe("CHIEF_OF_STAFF");
  });

  it("les sous-pages ont suivi — les réglages et la boîte restent atteignables sous la même URL", () => {
    expect(existe("src/app/(app)/chief-of-staff/reglages/page.tsx")).toBe(true);
    expect(existe("src/app/(app)/chief-of-staff/inbox/page.tsx")).toBe(true);
  });

  it("la hauteur est MESURÉE, jamais écrite en dur — sinon le composeur passe sous la barre d'onglets", () => {
    const page = lire(PAGE);
    expect(page, "la conversation occupe la hauteur utile via les hauteurs mesurées de `chrome-metrics`").toContain("app-viewport-flush");
    // `chief-root` porte les variables du système visuel d'Adam : sans lui, toutes les couleurs
    // et tous les rayons retombent sur leurs valeurs de repli.
    expect(page).toContain("chief-root");
    // La feuille de style était importée par le layout supprimé : elle doit être ailleurs.
    expect(page).toContain("chief.css");
  });

  it("PLUS DE TROISIÈME PORTE : le sélecteur de modules replié est retiré, le menu fait le travail", () => {
    // Il existait PARCE QU'il n'y avait pas de menu latéral — sa propre en-tête le disait. Le
    // garder à côté du menu et de la palette ferait trois mécanismes pour le même geste, donc
    // trois endroits à corriger le jour où la navigation change (§118.5).
    expect(existe("src/components/chief/module-switcher.tsx")).toBe(false);
    expect(lire("src/components/chief/chief-header.tsx")).not.toContain("ModuleSwitcher");
    // Et la lecture de plateforme qui l'alimentait perd son seul appelant : on ne garde pas de
    // code mort (§118.14).
    expect(lire("src/platform/contract.ts")).not.toContain("navigation.destinations");
  });
});

describe("deux mesures dans une conversation — la prose se lit, la donnée s'examine", () => {
  it("les deux mesures sont DÉCLARÉES une seule fois, au socle des styles", () => {
    const css = lire("src/app/globals.css");
    expect(css).toContain(".chat-measure");
    expect(css).toContain(".chat-surface");
    // Deux variables, donc deux réglages possibles sans toucher au balisage — et une seule
    // définition de chaque, sinon les deux écrans qui les lisent divergeraient (§118.5).
    expect(css).toContain("--chat-measure");
    expect(css).toContain("--chat-surface");
  });

  it("LE FLUX porte le plan de travail, et la borne de LECTURE n'y est plus", () => {
    const chat = lireChat();
    expect(chat, "le conteneur du flux doit porter la mesure du plan de travail").toContain('className="chat-surface space-y-6"');
    // LE CŒUR DU DÉFAUT, nommé : la borne unique de 768 px sur le flux. Ce qui ferait tomber ce
    // test est exactement le geste qui a produit le défaut — remettre un `max-w-3xl` sur le
    // conteneur qui contient AUSSI les blocs.
    expect(chat, "`mx-auto w-full max-w-3xl` sur le flux comprimait chaque tableau à 768 px").not.toContain('className="mx-auto w-full max-w-3xl space-y-6"');
  });

  it("LA PROSE garde sa colonne : composeur, bulle de la personne, tour verbal", () => {
    const chat = lireChat();
    // Trois endroits au moins, et ils comptent : un champ de saisie de 1600 px ne se lit pas,
    // une bulle de 1600 px non plus, et une phrase seule n'est pas un espace de travail.
    const mesures = chat.match(/chat-measure/g) ?? [];
    expect(mesures.length, "la prose doit déclarer sa mesure là où elle est rendue").toBeGreaterThanOrEqual(4);
    expect(chat).toContain('<div className="chat-measure">\n        {pickerOpen');
    expect(chat).toContain('className="chat-measure flex flex-col items-end gap-1"');
    expect(chat).toContain('<div className="chat-measure space-y-2">');
  });

  it("LES BLOCS sont HORS de la colonne de lecture — c'est ce qui leur donne la place", () => {
    const chat = lireChat();
    // L'espace de travail en cours de streaming doit être un frère de la colonne de prose, pas
    // son enfant : un enfant hériterait de la borne, et le défaut reviendrait sans qu'on le voie.
    const i = chat.indexOf('<div className="chat-measure space-y-1.5">');
    const j = chat.indexOf("streaming?.workspace.map");
    expect(i, "la colonne de prose du tour en cours doit exister").toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    const entre = chat.slice(i, j);
    expect(entre, "la colonne de prose doit être REFERMÉE avant les blocs").toContain("</div>");
  });
});
