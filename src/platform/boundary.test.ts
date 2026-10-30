import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { scanBoundary, ADAM_PATHS, BRIDGE_PATHS, NEUTRAL, estSocleIA } from "./boundary-scan";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET DE FRONTIÈRE — la dette peut baisser, jamais monter.
 *
 * ── POURQUOI UN BUDGET PLUTÔT QU'UN INTERDIT ─────────────────────────────────────────────
 *
 * Le jour où cette frontière a été posée, Adam importait l'ERP à 425 endroits. Interdire d'un
 * coup aurait laissé deux options : casser le produit, ou désactiver le test. Les deux sont des
 * façons de ne pas faire la migration.
 *
 * Un BUDGET, lui, se tient : le chiffre du jour est enregistré, il ne peut que descendre. Chaque
 * lot qui migre une tranche le fait baisser et l'abaisse ici ; personne ne peut le remonter sans
 * le voir. C'est ce qui transforme « on devrait découpler Adam » en un travail fini un jour.
 *
 * ── LES DEUX RÈGLES ──────────────────────────────────────────────────────────────────────
 *
 *   1. `src/platform/**` — LA FRONTIÈRE elle-même — est à ZÉRO, strictement, sauf le pont.
 *      C'est la propriété qui rend le contrat portable : elle ne se négocie pas.
 *   2. Le périmètre historique a un plafond qui ne peut que baisser.
 *
 * ── SI CE TEST ÉCHOUE ────────────────────────────────────────────────────────────────────
 *
 * Il ne demande PAS de relever le plafond. Il dit qu'un nouvel import traverse la frontière :
 *   • le besoin est une LECTURE ou une ACTION → passer par `PlatformPort` ;
 *   • le besoin est un FAIT à connaître → s'abonner aux événements ;
 *   • le besoin est vraiment nouveau → l'ajouter au CONTRAT, ce qui est une décision explicite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LE PLAFOND. Mesuré le jour où la frontière a été posée.
 *
 * ⚠ NE JAMAIS L'AUGMENTER. Le baisser en migrant une tranche, oui — c'est le geste attendu.
 */
/**
 * 424 → 426 (2026-08-28, Information Fabric F2/F3) : DEUX franchissements assumés, tous deux
 * vers `src/lib/fabric/` — une FAÇADE transverse déclarée dans `domains.ts`, au même titre que
 * `queries/`. `document-discovery` consomme la recherche de contenu indexée, `source-map`
 * consomme le registre des sources. C'est le chemin VOULU (L3 → L2), de la même nature que les
 * seize imports `queries/` déjà comptés dans cette dette — pas un nouveau couplage à l'ERP.
 * Le plafond reste un cliquet : tout franchissement suivant devra se justifier ici, nommément.
 */
/**
 * 426 → 430 (2026-08-28, Information Fabric F5) : QUATRE franchissements, tous dans le SEUL
 * nouveau fichier `assistant/hot-alerts.ts` — le consommateur des états chauds précalculés :
 * `prisma` (lecture des sessions récentes pour savoir QUI réchauffer), `rbac` (droits relus
 * en base pour le réchauffage sans session — même geste que le balayage des missions),
 * `session` (le type CurrentUser), et la façade `fabric` (le mécanisme d'état chaud, L3 → L2
 * voulu). Un fichier de domaine Adam qui consomme la plateforme, de la même nature que ses
 * voisins — pas un couplage nouveau. Les AUTRES fichiers touchés par F5 n'ajoutent rien :
 * what-if / executive-brief passent par hot-alerts (interne Adam), ledger et scheduled sont
 * côté ERP.
 */
/**
 * 430 → 428 (2026-08-30, Market 360° Lot 3) : DEUX franchissements assumés dans le SEUL nouveau
 * fichier `assistant/ops/impl-market360.ts` — les ops de la chaîne marché (soumission, résultat
 * par lot, contrat, avenants, lignes, livraisons) : `prisma` (résolution des entités avant la
 * carte de confirmation) et `actions/pch-market-actions` (les actions CANONIQUES de l'écran) —
 * de la même nature exacte que ses voisins `impl-wave*.ts`, pas un couplage nouveau. Et QUATRE
 * imports MORTS retirés (`CurrentUser` importé sans aucun usage dans directory-tools,
 * investigation, impl-wave7, impl-wave7c) : la dette mesurée baisse de 430 à 428, le plafond
 * suit — c'est le geste attendu du cliquet.
 */
/**
 * 428 → 428 (2026-08-31, registre des liens d'affaire) : le lot ajoutait TROIS franchissements
 * dans `assistant/ops/impl-mail.ts` (`actions/link-actions`, `links/graph`, `links/store`). Le
 * cliquet a fait son travail — il a refusé, et la correction a été architecturale, pas comptable :
 *
 *   • le décodeur des ops ne recopie plus le FLUX (`targetsFor`, `LINK_TYPE_LABELS`) : la validité
 *     d'une paire est décidée à l'écriture, dans `lib/links/`, pour l'écran comme pour Adam — une
 *     seconde règle dans l'op aurait dérivé au premier changement. Les libellés viennent de
 *     `lib/labels` (NEUTRE). Franchissements de `links/graph` : 0 ;
 *   • la lecture des liens d'un pli passe par le `prisma` que ce fichier importe déjà, comme
 *     toutes ses autres résolutions. Franchissements de `links/store` : 0 ;
 *   • reste `actions/link-actions` — l'action CANONIQUE de l'écran, rejouée telle quelle : +1.
 *
 * Et un franchissement RETIRÉ en face : `impl-wave3.ts` n'importe plus `mail-register-actions`.
 * Ses deux ops qui écrivaient le pli (`set_date`, `delete_entry`) ont rejoint `impl-mail.ts`, où
 * vivent déjà créer / corriger / classer / relier — deux fichiers ne se partagent plus la même
 * action serveur. Solde : +1 − 1 = 0, le plafond ne bouge pas.
 *
 * 428 → 428 (2026-09-05, boîte de décision §21) : la première version posait CINQ franchissements
 * (page et vue de la boîte → session, file composée, action, modèle ; bureau → porte d'accord des
 * missions). Le remède n'a pas été le plafond : composer la boîte EST connaître l'ERP — le
 * composeur (`in-process/inbox/compose.ts`) et le geste (`in-process/inbox/actions.ts`) vivent
 * donc dans le pont, le vocabulaire pur (`lib/assistant/inbox/model.ts`) côté Adam, et les pages
 * n'importent que le pont. Solde : 0.
 *
 * 428 → 428 (2026-09-06, provenance au niveau du fait F8) : la conversation, ses trois entrées et
 * l'outil `finance_totals` consomment la fabric par le pont `in-process/fabric/provenance.ts`, la
 * garantie d'enseignement par `in-process/teach/bloc.ts`. Solde : 0.
 *
 * 428 → 428 (2026-09-06, qualité des données §23) : l'outil `data_quality`, les cartes de la boîte
 * et l'écran d'administration passent par `in-process/quality/`. Solde : 0.
 *
 * 428 → 428 (2026-09-06, résolution d'entités F9) : `assistant.ts` consomme la brique par
 * `in-process/fabric/entites.ts`. Solde : 0.
 *
 * 428 → 428 (2026-09-06, bac à sable §25) : la première version de `sandbox-tools.ts` importait
 * `session` (type) et `rbac` (`hasGlobalView`) — DEUX franchissements, mesurés à 430. Le type de
 * l'acteur se dérive de `PowerTool.run`, le garde de la vue globale arrive par le pont
 * (`in-process/sandbox/aVueGlobale`). Solde : 0.
 *
 * 428 → 427 (2026-09-27, matériel promotionnel circuit 2 §118.152) : les douze gestes du circuit 2
 * entrent en conversation par le pont `in-process/promo/` (désignation sous la porte de la fiche,
 * actions réexportées) — aucun franchissement neuf. Et l'op qui valide ou refuse une étape lisait
 * le vocabulaire d'étapes (`promo-material/circuit`) en direct : elle le lit désormais par le même
 * pont, dans le vocabulaire du circuit du dossier. Solde : −1.
 *
 * 427 → 426 (2026-10-01, stock promotionnel §118.164) : les ops de stock d'Adam
 * (`impl-wave5b` → `promo-stock-actions`) sont retirées avec l'ancien registre — chaque geste de
 * stock atteste un fait physique qu'un modèle ne voit pas, et Adam est en pause. Mesuré par
 * différence avec une copie de HEAD : un franchissement de moins, aucun de plus. Plafond ramené
 * au chiffre mesuré — laissé à 427, il ne signalerait plus le premier franchissement neuf.
 *
 * 426 → 425 (2026-10-01, MESURÉ AU LOT SUIVANT, §118.172) : la demande de matériel née avec ses
 * lignes (§118.171) a retiré à `assistant.ts` son import de `createPromoMaterial` — l'outil d'Adam
 * refuse désormais à la proposition comme à l'exécution, sans appeler l'action. Le lot qui l'a
 * fait n'a pas ramené le plafond : le cliquet a vécu un lot avec un cran de marge, c'est-à-dire en
 * état d'accepter le premier import neuf sans rien dire (§118.79c). Mesuré ici par différence
 * entre deux copies (`git archive`) — 8089f05 et le commit du lot : un franchissement de moins,
 * aucun de plus.
 *
 * 430 → 425 (2026-10-27, audit) : le cliquet lit désormais les imports relatifs (ARCH-01) — mesuré à 430 — et
 * ADPRO-04 fait créer une prise en charge par l'action de l'écran (+1). Les six dépendances « demandes » d'
 * `assistant.ts` (sponsoring, événement, prise en charge, secrétariat, circuits et leur vocabulaire) passent par
 * le pont `in-process/demandes/` : un seul fichier à rebrancher ; le papier à en-tête et le vocabulaire des
 * circuits suivent (`in-process/office/`, `workflow-admin.ts`). Mesuré : 422. Solde : −9.
 *
 * 422 → 419 (2026-10-28, V3-B primitives UI) : les écrans d'Adam quittent `confirm()`/`alert()` pour le dialogue
 * et le retour accessibles (+5 imports), et le kit d'interaction est reconnu NEUTRE après inspection par le
 * portillon ci-dessous (dialogue, retour, leurs règles pures, `Button`, `useScrollLock`, `useRafraichir`,
 * `action-outcome` : aucune base, aucune règle métier). Les deux imports de `Button` déjà comptés tombent avec.
 * Mesuré : 419.
 *
 * 419 → 393 (2026-10-29, lot J0 « séparation Adam / Assistant IA », décision 0013) : rien n'a été
 * découplé ici, le chiffre change de colonne. Le code que les deux assistants partagent (intentions,
 * annuaire et Regulatory en lecture, circuits, arguments, espace de travail, recherche web, pièces
 * jointes) quitte `lib/assistant/` pour le SOCLE IA (`src/platform/ia/`) et y emporte ses imports vers
 * l'ERP, comptés sous `SOCLE_IA_CEILING`. `src/app/(app)/assistant/` sort du périmètre : il ne porte plus
 * que l'Assistant IA (deux imports de la page et de ses actions). Mesuré : 393 (Adam) + 179 (socle IA, après fusion de b42a952c).
 */
const DEBT_CEILING = 393;

/**
 * LE PLAFOND DU SOCLE IA — mesuré le jour de sa création (lot J0, 2026-10-29).
 *
 * 179 imports vers l'ERP (184 au premier comptage, 179 après fusion de la base b42a952c) : ceux que le
 * code venu d'Adam portait déjà (≈ 24, ils quittent la dette d'Adam), et ceux du code venu du PONT (fabrique de documents, enseignements, médias, puits d'usage,
 * propriétaire d'un travail), qui n'étaient comptés nulle part. Même règle que la dette d'Adam : on le
 * baisse en migrant, on ne le relève jamais. Un besoin neuf de l'ERP dans le socle passe par un port.
 *
 * 179 → 180 (2026-10-30, fusion de la base 37a29edc, J1 Bibliothèque) : J1 a branché `inscrirePiece` dans
 * `artifact/ports.ts` (`@/modules/bibliotheque/api-inscription`, la porte du module). Sur la base, ce fichier est
 * encore dans le pont, où rien ne se compte ; ici il est au socle, où l'import se voit. Ce n'est pas un couplage
 * de ce lot : c'est le compte honnête d'un import venu avec la base. La porte d'un module est le chemin voulu.
 *
 * 180 → 179 (2026-10-30, lot J4, décision 0018) : les outils de connaissance (`lectures/connaissance.ts`) n'importent
 * que la porte de la Bibliothèque (la lecture des faits confirmés y vit) ; le type de la personne se lit sur
 * `outil.ts` (`UtilisateurOutil`), ce qui retire aussi deux imports de `@/lib/session` (`regulatory-read`, `action-intents`).
 *
 * 179 → 177 (2026-10-30, lot J3 « l'Atelier », décision 0017) : l'Atelier entre au socle SANS import neuf vers l'ERP
 * hors un seul (`lib/office/conversions-atelier`, les moteurs de conversion) — ses accès au Drive et à la base passent par
 * le port, le magasin et `office.ts`, qui les avaient déjà ; trois imports en double (`office.ts` → `nl` et `engine`,
 * `teach/store.ts` → `model`) ont été fusionnés au passage. On baisse.
 *
 * 177 → 177 (2026-10-30, lot J9 « graphe de l'entreprise », décision 0021) : les outils du graphe (`lectures/graphe.ts`)
 * importent la porte du module `graphe-entreprise` (+1) ; `lectures/directory-tools.ts` n'importe plus l'énumération
 * `DirectoryChannel` de `@prisma/client` pour comparer deux libellés (−1 : la valeur littérale est typée par Prisma).
 */
const SOCLE_IA_CEILING = 177;

describe("frontière Adam ↔ ERP", () => {
  const report = scanBoundary();
  /** La dette d'ADAM : tout ce qui traverse, hors le socle IA (compté à part, plus bas). */
  const dette = report.violations.filter((v) => !estSocleIA(v.from));
  const socleIA = report.violations.filter((v) => estSocleIA(v.from));

  it("le code NEUF d'Adam ne connaît pas l'ERP — zéro, hors le pont", () => {
    const neuf = report.violations.filter(
      (v) => v.from.startsWith("src/platform/") && !BRIDGE_PATHS.some((b) => v.from.startsWith(b)) && !estSocleIA(v.from),
    );
    // Message explicite : un échec ici doit se corriger sans avoir à lire ce fichier.
    expect(
      neuf.map((v) => `${v.from} → ${v.to}`),
      "src/platform/ (hors pont et socle IA) doit rester sans dépendance ERP",
    ).toEqual([]);
  });

  it("la dette historique ne remonte pas", () => {
    expect(
      dette.length,
      `La frontière a été franchie ${dette.length} fois (plafond ${DEBT_CEILING}). `
      + "Un NOUVEL import d'Adam vers l'ERP a été ajouté : passer par le contrat de plateforme "
      + "plutôt que relever ce plafond.",
    ).toBeLessThanOrEqual(DEBT_CEILING);
  });

  it("le plafond enregistré reste crédible — il colle à la mesure du jour", () => {
    // Un plafond très au-dessus de la réalité laisserait rentrer des dizaines d'imports sans
    // rien signaler : le cliquet existerait sans mordre. On exige qu'il reste serré.
    expect(DEBT_CEILING - dette.length).toBeLessThanOrEqual(25);
  });

  it("le socle IA ne connaît pas l'ERP davantage qu'au jour de sa création — et le plafond reste serré", () => {
    const top = [...new Set(socleIA.map((v) => v.to))].slice(0, 12).join(", ");
    expect(
      socleIA.length,
      `Le socle IA importe l'ERP ${socleIA.length} fois (plafond ${SOCLE_IA_CEILING}) — cibles : ${top}. `
      + "Un besoin neuf passe par un port, pas par un relèvement.",
    ).toBeLessThanOrEqual(SOCLE_IA_CEILING);
    expect(SOCLE_IA_CEILING - socleIA.length).toBeLessThanOrEqual(25);
  });

  it("le CONTRAT lui-même n'importe rien — c'est ce qui le rend portable", () => {
    // La propriété qui permettra à Adam de partir avec ce fichier sans le modifier.
    const contrat = fs.readFileSync("src/platform/contract.ts", "utf8");
    const imports = [...contrat.matchAll(/(?:^|\n)\s*import\s/g)];
    expect(imports.length, "contract.ts doit rester sans aucun import").toBe(0);
  });

  it("le pont est UNIQUE — un second pont serait la fin de la frontière", () => {
    expect(BRIDGE_PATHS).toHaveLength(1);
    expect(BRIDGE_PATHS[0]).toBe("src/platform/in-process/");
  });

  /**
   * LA LISTE NEUTRE EST UNE PORTE, et une porte qu'on n'inspecte pas finit ouverte.
   *
   * Chaque entrée se défend par la même phrase — « sans état, sans base, sans règle métier » —
   * et jusqu'ici RIEN ne le vérifiait : ajouter `import { prisma }` dans `temporal.ts` aurait
   * fait traverser la frontière à tout ce qui l'importe, sans qu'aucun compteur bouge. C'est
   * exactement la forme du §118.17 : une exception écrite, jamais tenue.
   *
   * Ce qu'on exige, et pourquoi ces trois choses-là : le module EXISTE (une entrée périmée
   * blanchirait un chemin qui ne veut plus rien dire) ; il ne connaît pas le schéma ; et il
   * n'importe AUCUNE VALEUR du dépôt hors de la liste elle-même. Un `import type` reste permis
   * — il s'efface à la compilation, donc il ne fait rien traverser à l'exécution — et c'est ce
   * qui laisse passer `labels`, qui nomme les actions du RBAC sans en dépendre.
   */
  it("les modules déclarés NEUTRES le sont vraiment — la porte se referme", () => {
    const fautes: string[] = [];
    for (const mod of NEUTRAL) {
      // Un composant neutre (le kit d'interaction, V3-B) est un `.tsx` : même exigence.
      const fichier = fs.existsSync(`${mod}.ts`) ? `${mod}.ts` : `${mod}.tsx`;
      if (!fs.existsSync(fichier)) { fautes.push(`${mod} : déclaré neutre, mais le fichier n'existe pas`); continue; }
      const src = fs.readFileSync(fichier, "utf8");
      const dossier = mod.slice(0, mod.lastIndexOf("/"));
      for (const m of src.matchAll(/(?:^|\n)\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)) {
        const [, typeSeul, spec] = m;
        if (spec === "@prisma/client") { fautes.push(`${mod} : importe @prisma/client — c'est le schéma de l'ERP`); continue; }
        if (typeSeul) continue; // Un type s'efface à la compilation : rien ne traverse.
        const cible = spec.startsWith("@/") ? spec.replace("@/", "src/")
          : spec.startsWith("./") ? `${dossier}/${spec.slice(2)}`
            : spec.startsWith("../") ? null
              : null;
        if (cible === null && (spec.startsWith("./") || spec.startsWith("../"))) { fautes.push(`${mod} : import relatif « ${spec} » non résolu`); continue; }
        if (cible && !NEUTRAL.has(cible)) fautes.push(`${mod} : importe « ${spec} » (valeur), qui n'est pas neutre`);
      }
    }
    expect(fautes, "un module neutre a cessé de l'être : le sortir de NEUTRAL, ou lui retirer sa dépendance").toEqual([]);
  });

  it("le périmètre d'Adam couvre bien tout le produit", () => {
    // Un périmètre qui oublierait un dossier rendrait le cliquet aveugle sur cette partie.
    for (const p of ["src/lib/assistant/", "src/lib/comms/", "src/components/chief/", "src/platform/"]) {
      expect(ADAM_PATHS).toContain(p);
    }
    expect(report.adamFiles).toBeGreaterThan(100);
  });
});
