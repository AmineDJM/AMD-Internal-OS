import fs from "node:fs";
import path from "node:path";
import { cibleInterne } from "./imports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SCANNER DE FRONTIÈRE — il compte ce qui traverse, et c'est tout.
 *
 * POURQUOI CE FICHIER EXISTE. La séparation d'Adam et de l'ERP se joue sur 447 imports répartis
 * dans 118 fichiers. Deux façons de traiter cela :
 *
 *   • la réécriture d'un bloc — longue, risquée, et invérifiable tant qu'elle n'est pas finie ;
 *   • un CLIQUET — on mesure la dette, on interdit qu'elle grossisse, on la fait baisser lot
 *     après lot. À tout instant le produit marche, et le chiffre dit où l'on en est.
 *
 * La mission demande explicitement d'éviter « une réécriture aveugle ». Le cliquet est la
 * réponse : il rend la migration incrémentale ET irréversible. Sans lui, une frontière posée un
 * mardi est reperforée le jeudi par quelqu'un qui avait juste besoin d'un import — et personne
 * ne le voit passer en revue de code.
 *
 * Ce module ne dépend de rien du produit : `fs` et `path`. Il est lu par le test de frontière et
 * par le script d'audit, jamais par du code d'exécution.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LE PÉRIMÈTRE SURVEILLÉ — la frontière et tout ce qui doit se tenir derrière elle.
 *
 * `src/platform/` n'appartient NI à Adam NI à l'ERP : c'est le contrat que les deux partagent.
 * L'ERP y publie ses faits, Adam y lit et y demande. Le placer d'un côté ou de l'autre aurait
 * recréé une dépendance dans ce sens-là — l'ERP important « du Adam » pour annoncer qu'un
 * paiement est validé aurait été un couplage inverse, plus difficile à voir que le direct.
 */
export const ADAM_PATHS = [
  "src/platform/",
  // LA PASSERELLE MODÈLE fait partie d'Adam, pas de l'ERP. C'est littéralement son cerveau : le
  // jour où Adam part, il part AVEC. La ranger du côté ERP aurait compté une violation à chaque
  // fichier d'Adam qui appelle un modèle — c'est-à-dire punir exactement le découplage qu'on
  // cherche. En contrepartie, `src/lib/models/` doit rester sans dépendance métier ; c'est une
  // propriété vérifiée par son propre test.
  "src/lib/models/",
  "src/lib/assistant/",
  "src/lib/assistant.ts",
  "src/lib/assistant-",
  "src/lib/comms/",
  "src/components/chief/",
  // Adam n'a plus de groupe de routes à lui : il est un MODULE, dans la coque de l'ERP
  // (§118.100). Sa page reste du périmètre ADAM et sa dette continue d'être comptée ici.
  "src/app/(app)/chief-of-staff/",
  "src/app/(app)/assistant/",
  "src/app/api/assistant/",
] as const;

/**
 * LE PONT AUTORISÉ — le seul endroit d'Adam qui a le droit de connaître l'ERP.
 *
 * Un pont, pas une passoire : s'il y en avait deux, il n'y en aurait bientôt plus aucun.
 *
 * ── CE QU'IL CONTIENT, ET POURQUOI CES DEUX CHOSES-LÀ ────────────────────────────────────
 *
 *   `adapter.ts`  — les lectures et écritures de l'ERP répondant au CONTRAT de plateforme ;
 *   `missions/`   — le COMPOSEUR du Mission Runtime, qui remplit ses ports.
 *
 * Le second est arrivé après coup, et sa place a été décidée par ce cliquet-ci. Écrit dans
 * `src/lib/assistant/missions/`, il ajoutait vingt-cinq franchissements d'un coup — il importe
 * par nature `missions/` (une façade de l'ERP) et Prisma. La tentation était de relever le
 * plafond ; le remède correct était de reconnaître ce qu'est ce code : un module d'Adam dont le
 * travail EST de connaître l'ERP, exactement comme l'adaptateur. C'est la définition du pont.
 *
 * La propriété qu'on protège reste vraie : arracher Adam, c'est supprimer `src/lib/assistant/`,
 * `src/lib/models/` et `src/platform/in-process/`. Le Mission Runtime, lui, reste debout — un
 * cron ou un webhook peut faire tourner une mission sans conversation, à condition de composer
 * ses ports, ce que ce dossier montre comment faire.
 */
export const BRIDGE_PATHS = ["src/platform/in-process/"] as const;

/** Ce qui n'est PAS l'ERP : les paquets externes, et Adam lui-même. */
const isAdam = (f: string) => ADAM_PATHS.some((p) => f.startsWith(p));
const isBridge = (f: string) => BRIDGE_PATHS.some((p) => f.startsWith(p));

/**
 * LES MODULES NEUTRES — ni ERP, ni Adam : des utilitaires sans état, sans base, sans règle
 * métier. Les faire traverser la frontière n'apprend rien à Adam sur l'ERP.
 *
 * La liste est COURTE et le restera : chaque entrée est une exception qu'il faut pouvoir
 * défendre. `utils` et `labels` sont du formatage ; `prisma-enums` n'existe pas, et c'est
 * volontaire — un énuméré généré EST une dépendance au schéma.
 */
export const NEUTRAL = new Set([
  "src/lib/utils",
  "src/lib/labels",
  // `journal` (lot V3-E « Fiabilité ») écrit une ligne JSON et rend le repli d'un `catch` NOMMÉ
  // (`sansBloquer`, `attendu`). Zéro import, sans base, sans règle métier — son seul état est un
  // compteur d'erreurs par nom d'événement, en mémoire du processus. Il est ici parce que la règle
  // « un `catch` ne tait pas son erreur » vaut des DEUX côtés : Adam et l'ERP avalaient chacun
  // leurs pannes en silence ; le ranger d'un côté forcerait l'autre à écrire un second journal,
  // au format qui divergerait — et la remontée au Super Admin ne verrait que la moitié des pannes.
  // Le versement en base et l'alerte vivent à côté (`incidents-repetes.ts`) : eux ne sont PAS neutres.
  "src/lib/journal",
  // `ai-text` est un ASSAINISSEUR de trois expressions régulières, sans état, sans base et sans
  // règle métier — sa propre en-tête dit qu'il est « à part, SANS dépendance » précisément pour
  // que les deux fournisseurs puissent l'utiliser sans se tirer l'un l'autre. Il satisfait le
  // critère ci-dessus mot pour mot ; il n'apprend rien à Adam sur l'ERP.
  "src/lib/ai-text",
  // `name-match` rapproche deux noms écrits par des humains : repli d'accents, initiales,
  // recouvrement de jetons, distance d'édition. Des mathématiques de chaînes — sans état, sans
  // base, sans règle métier, et son en-tête interdit explicitement d'y coder le moindre nom
  // d'entreprise ou de molécule. Il est ici parce que la couche de connaissance de l'ERP en a
  // besoin AUTANT qu'Adam : le laisser dans `assistant/` aurait forcé l'ERP à importer « du
  // Adam », c'est-à-dire le couplage inverse — celui qu'on ne voit pas venir.
  "src/lib/name-match",
  // `temporal` traduit « demain à 10h », « dans 48h », « chaque vendredi » en échéance UTC
  // (heure d'Alger fixe). Des mathématiques de dates — zéro import, sans état, sans base, sans
  // règle métier : le même cas que `name-match`, mot pour mot. Les rappels d'Adam le consomment
  // ET les attentes de mission de l'ERP peuvent le consommer — le ranger d'un côté forcerait
  // l'autre à traverser.
  "src/lib/temporal",
  // `mutations/empreinte` compare l'empreinte d'une écriture (profondeur × cardinalité) à celle
  // que la demande énonce. Du texte comparé à un nom d'opération — zéro import, sans état, sans
  // base, sans règle métier : le même cas que `name-match` et `temporal`. Il est ici parce que
  // les DEUX côtés en ont besoin et n'ont pas le droit de se parler : la conversation refuse une
  // carte trop large, le compilateur de missions refuse une étape trop large. Le ranger d'un
  // côté forcerait l'autre à en écrire une seconde version, qui divergerait (§118.5).
  "src/lib/mutations/empreinte",
  // `personnes/designation` traduit ce qu'un modèle, un plan ou un éventail a mis dans une
  // entrée « qui » en une désignation — `« Nom <adresse> »`, un nom, une adresse — et rend
  // `null` sur ce qu'il ne lit pas à coup sûr. De la lecture de chaîne : zéro import, sans état,
  // sans base, sans règle métier. Il est ici pour la raison de `mutations/empreinte`, mot pour
  // mot : les DEUX côtés en ont besoin et n'ont pas le droit de se parler — la conversation
  // résout un destinataire, le moteur de missions aussi. Le ranger d'un côté forcerait l'autre
  // à en écrire une seconde version, qui divergerait (§118.5).
  "src/lib/personnes/designation",
  // `ia/cle-manquante` compose UNE phrase : « IA non configurée. Ajoutez la clé X dans Render… »
  // à partir du nom que le registre a lu. Zéro import, sans état, sans base, sans règle métier —
  // et il n'apprend rien à Adam sur l'ERP : il met un nom de variable dans une phrase française.
  //
  // Il est ici pour la raison exacte de `mutations/empreinte` et `personnes/designation`, et la
  // mesure la donne : HUIT importeurs sur TROIS couches qui n'ont pas le droit de se parler — les
  // pages serveur de l'ERP (réunions, RH), ses composants client (agents Regulatory, présentation
  // BD, synthèse, fiche salarié) et les écrans d'Adam (assistant, chef de cabinet), plus la route
  // de synthèse qui fait voyager le nom. Le ranger d'un côté forcerait les autres à réécrire la
  // phrase, et huit orthographes du même refus divergeraient (§118.5) — c'est précisément le
  // défaut que §118.128 répare : huit écrans nommaient la clé de mémoire, et sept se trompaient.
  //
  // Le chemin est EXACT, pas le dossier : un futur `src/lib/ia/quelque-chose-de-lourd.ts` ne doit
  // pas se retrouver exempté sans que personne l'ait décidé.
  "src/lib/ia/cle-manquante",
  // `personnes/joignabilite` lit une déclaration (« email:a@x.dz, b@y.dz ») et rend les
  // adresses valides ; `personnes/autonomie-proprietaire` dit si un geste est couvert par
  // l'autonomie que la personne a accordée pour être jointe. Deux lectures de chaînes et une
  // liste fermée — zéro import, sans état, sans base, sans règle métier. Même critère que
  // `mutations/empreinte` : la conversation ET le moteur en ont besoin, et n'ont pas le droit
  // de se parler.
  "src/lib/personnes/joignabilite",
  "src/lib/personnes/autonomie-proprietaire",
  // `fraicheur/ages` porte les durées au bout desquelles une donnée cesse d'être tenue pour
  // fraîche, par famille de source. Une table de nombres et une mise en forme de durée — zéro
  // import, sans état, sans base, sans règle métier. Même critère que `mutations/empreinte`,
  // et pour la même raison exactement : la conversation périme un fait indexé, le moteur de
  // missions date ses lectures (§118.46), et les deux n'ont pas le droit de se parler. Deux
  // tables séparées auraient divergé, et le jour où l'une dit 24 h et l'autre 72, personne ne
  // saurait laquelle fait foi (§118.5).
  "src/lib/fraicheur/ages",
  // `grille/selection` et `grille/couleurs` : l'arithmétique d'une sélection de cellules et la
  // palette FERMÉE des couleurs d'annuaire (§118.133). Zéro import, sans état, sans base, sans
  // règle métier. Les DEUX côtés en ont besoin et n'ont pas le droit de se parler : les feuilles
  // de l'ERP sélectionnent et colorent, l'action serveur valide la clé de palette, et l'op d'Adam
  // (« colore en jaune la wilaya de… ») doit reconnaître la même palette — une seconde liste
  // aurait divergé à la première couleur ajoutée (§118.5). Même critère que `mutations/empreinte`.
  "src/lib/grille/selection",
  "src/lib/grille/couleurs",
  // `skills/affichage` répond à UNE question — « où sont les lignes de cette capacité ? » — en
  // lisant `sorties.cles` du manifeste et le résultat réel, et rend un CHEMIN (« resultat.items »)
  // ou `null`. Zéro import, sans état, sans base, sans règle métier. Il est ici pour la raison de
  // `mutations/empreinte`, mot pour mot : les DEUX côtés en ont besoin et n'ont pas le droit de se
  // parler — le runtime des skills ÉCRIT la déclaration (il a le manifeste), l'espace de travail
  // d'Adam la LIT pour dessiner (il a `tableFromRows`, le seul traducteur). Le ranger d'un côté
  // aurait forcé l'autre à relire le chemin à sa façon, et le symptôme d'une divergence serait un
  // tableau vide sans aucune cause visible (§118.5).
  "src/lib/skills/affichage",
  // Reconnaître un média à son NOM : l'indexation du Drive, l'adaptateur de média et le client
  // du moteur de parole se posent la même question, et aucun n'a le droit d'importer les autres.
  "src/lib/media/formats",
  // `vues/colonnes-regulatory` est un CATALOGUE D'AFFICHAGE : la clé de chaque colonne du
  // tableau Regulatory, son en-tête français, ses alias, et celles qu'on ne masque jamais. Une
  // table de chaînes et un résolveur de libellé — zéro import, sans état, sans base, sans règle
  // métier. Il n'apprend rien à Adam sur l'ERP : les COLONNES d'un écran ne sont pas les
  // DOSSIERS qu'il montre, et rien ici ne dit ce qu'un dossier contient.
  //
  // Il est ici parce que TROIS couches en ont besoin et qu'aucune n'a le droit d'importer les
  // deux autres : la conversation valide « supprime la colonne classe thérapeutique », l'écran
  // Regulatory cesse de la rendre, et la console d'administration propose la même liste de
  // cases. Le laisser du côté Regulatory forçait Adam à traverser — ce cliquet l'a refusé, et
  // il avait raison. Deux listes de colonnes divergent à la première ajoutée : le tableau
  // montre « Projet » et Adam répond « colonne inconnue » (§118.5).
  "src/lib/vues/colonnes-regulatory",
  // `chemins/stock-promo` dit OÙ VIVENT le stock et le catalogue promotionnels (§118.173) : deux
  // adresses, la liste fermée des vues de l'écran, le lien vers une vue, et le chemin du menu tel
  // qu'une phrase le nomme. Des chaînes et un lecteur de paramètre — zéro import, sans état, sans
  // base, sans règle métier : rien ici ne dit ce qu'un stock contient.
  //
  // Il est ici parce que `labels` — neutre — le lit pour dessiner le menu, et qu'un module neutre
  // n'importe qu'un module neutre : ce cliquet l'a refusé à la première suite complète du lot, et
  // il avait raison. La mesure donne le reste : VINGT-DEUX importeurs de production répartis sur
  // des couches qui n'ont pas le droit de se parler — le menu (socle), les actions et les rappels
  // du stock, leurs chargeurs, la corbeille, les écrans serveur comme client. Écrite en toutes
  // lettres à vingt-cinq endroits, l'ancienne adresse menait à l'ancien écran dès qu'elle bougeait
  // (§118.5) ; chacun la lit maintenant ici. Aucun fichier d'Adam ne l'importe : l'entrée ne
  // déplace aucun franchissement, et le compteur ne bouge pas.
  //
  // Le chemin est EXACT, pas le dossier : un futur `src/lib/chemins/quelque-chose-de-lourd.ts` ne
  // doit pas se retrouver exempté sans que personne l'ait décidé.
  "src/lib/chemins/stock-promo",
  // `chemins/bons-de-commande` dit OÙ VIT le module « Bons de commande » (§118.176) : une adresse
  // et le chemin du menu tel qu'une phrase le nomme. Deux chaînes — zéro import, sans état, sans
  // base, sans règle métier : rien ici ne dit ce qu'un bon de commande contient ni qui le signe.
  //
  // Il est ici pour la raison de `chemins/stock-promo`, mot pour mot : le menu (`labels`, neutre)
  // la lit, les écrivains des bons de commande et leurs écrans aussi, et TROIS fichiers d'Adam
  // citaient l'ancienne adresse en toutes lettres dans leurs chemins à rafraîchir — c'étaient les
  // copies qui seraient restées sur `/finances/bons-de-commande` quand le module est parti, et un
  // rafraîchissement qui vise une adresse morte laisse l'écran réel afficher l'état d'avant.
  // Les lire ici ne déplace aucun franchissement : le compteur ne bouge pas.
  //
  // Le chemin est EXACT, pas le dossier.
  "src/lib/chemins/bons-de-commande",
  // `chemins/rapports-terrain` dit OÙ VIVENT les rapports terrain depuis qu'ils sont un onglet de la Promotion médicale
  // (Direction, 07/10) : des adresses et des fabricants de liens — zéro import, sans état, sans base, sans règle métier.
  // Même raison que les deux précédents : le menu (`labels`, neutre) le lit, et les opérations d'Adam sur les comptes
  // rendus rafraîchissaient l'ancienne adresse `/field-reports` en toutes lettres. Le compteur ne bouge pas.
  //
  // Le chemin est EXACT, pas le dossier.
  "src/lib/chemins/rapports-terrain",
  // `chemins/espace` et `chemins/rh` disent OÙ MÈNE UNE NOTIFICATION de l'espace personnel (la tâche ouverte, la
  // conversation, le bilan d'une période) et du dossier RH (la demande dépliée chez le salarié, la file des RH) : des
  // adresses et des fabricants de liens — zéro import, sans état, sans base, sans règle métier. Même raison que les
  // précédents : les actions de l'ERP et celles d'Adam écrivent les MÊMES notifications (« Tâche mise à jour », « Nouvelle
  // demande RH ») ; deux copies du lien divergeaient — celle d'Adam menait à la fiche de l'employé, celle de l'écran à la
  // file des RH. Le compteur ne bouge pas.
  //
  // Les chemins sont EXACTS, pas le dossier.
  "src/lib/chemins/espace",
  "src/lib/chemins/rh",
]);

export interface Violation {
  /** Le fichier d'Adam qui importe. */
  from: string;
  /** Le module ERP importé. */
  to: string;
}

export interface BoundaryReport {
  adamFiles: number;
  violations: Violation[];
  /** Nombre d'imports sortants par fichier d'Adam — la dette, ventilée. */
  perFile: Map<string, number>;
  /** Nombre d'imports par cible ERP — dit quoi abstraire en premier. */
  perTarget: Map<string, number>;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*["']([^"']+)["']/g;
/** `await import("…")` — un import paresseux traverse la frontière tout autant. */
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
/**
 * `export { x } from "…"` — une RÉEXPORTATION traverse exactement comme un import : le module
 * cible entre dans le bundle, et le fichier d'Adam en dépend pour compiler.
 *
 * Ce cas manquait. Il n'avait jamais servi à contourner quoi que ce soit — la première
 * réexportation traversante de tout le périmètre est arrivée en même temps que ce correctif — mais
 * un cliquet dont on connaît le trou ne vaut rien : il ne mesure plus la dette, il mesure la
 * discipline de ceux qui savent où est le trou.
 */
const REEXPORT_RE = /(?:^|\n)\s*export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s*(?:as\s+\w+\s*)?from\s*["']([^"']+)["']/g;

/**
 * Parcourt le périmètre d'Adam et rend tout ce qui traverse vers l'ERP.
 *
 * LES TESTS SONT EXCLUS, et c'est un choix défendable : un test a le droit de fabriquer un jeu
 * de données avec Prisma. Ce qu'on protège, c'est le CODE D'EXÉCUTION — celui qui part en
 * production et qui devra un jour tourner sans l'ERP à portée d'import.
 */
export function scanBoundary(root = process.cwd()): BoundaryReport {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const files = walk("src")
      .map((f) => f.split(path.sep).join("/"))
      .filter(isAdam)
      .filter((f) => !/\.test\.tsx?$/.test(f));

    const violations: Violation[] = [];
    const perFile = new Map<string, number>();
    const perTarget = new Map<string, number>();

    for (const file of files) {
      if (isBridge(file)) continue; // Le pont a le droit. C'est sa raison d'être.
      const src = fs.readFileSync(file, "utf8");
      const specs: string[] = [];
      for (const m of src.matchAll(IMPORT_RE)) specs.push(m[1]);
      for (const m of src.matchAll(DYNAMIC_RE)) specs.push(m[1]);
      for (const m of src.matchAll(REEXPORT_RE)) specs.push(m[1]);

      for (const spec of specs) {
        // `@prisma/client` est la dépendance la plus profonde à l'ERP : le schéma lui-même.
        // `@/…` ET relatif (`../finance/x`) : voir `imports.ts` — un `./` ne contourne pas le cliquet.
        const target = spec === "@prisma/client" ? "@prisma/client" : cibleInterne(spec, file);
        if (!target) continue;
        if (target !== "@prisma/client" && (isAdam(target) || isAdam(`${target}/`))) continue;
        if (NEUTRAL.has(target)) continue;

        violations.push({ from: file, to: target });
        perFile.set(file, (perFile.get(file) ?? 0) + 1);
        perTarget.set(target, (perTarget.get(target) ?? 0) + 1);
      }
    }
    return { adamFiles: files.length, violations, perFile, perTarget };
  } finally {
    process.chdir(cwd);
  }
}

/** Le rapport, tel qu'on le lit dans un terminal. */
export function formatBoundary(r: BoundaryReport, topN = 20): string {
  const byTarget = [...r.perTarget.entries()].sort((a, b) => b[1] - a[1]);
  const byFile = [...r.perFile.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [
    `FRONTIÈRE ADAM ↔ ERP`,
    `  fichiers Adam (hors tests) : ${r.adamFiles}`,
    `  imports traversants        : ${r.violations.length}`,
    `  cibles ERP distinctes      : ${r.perTarget.size}`,
    `  fichiers concernés         : ${r.perFile.size}`,
    "",
    `LES ${topN} CIBLES LES PLUS IMPORTÉES (par quoi commencer) :`,
    ...byTarget.slice(0, topN).map(([t, n]) => `  ${String(n).padStart(3)}  ${t}`),
    "",
    `LES ${topN} FICHIERS LES PLUS COUPLÉS :`,
    ...byFile.slice(0, topN).map(([f, n]) => `  ${String(n).padStart(3)}  ${f}`),
  ];
  return lines.join("\n");
}
