import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { scanDomains, formatDomains, cycleEdges, DOMAINS } from "./domains";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TEST D'ARCHITECTURE (§1) — ce qui empêche la carte de redevenir un plat de spaghettis.
 *
 * ── DEUX RÉGIMES, ET POURQUOI ────────────────────────────────────────────────────────────
 *
 * INVARIANTS À ZÉRO — cycles, propreté du socle, inversions de couche. Ils ne se corrigent pas
 * « progressivement » : un demi-cycle n'existe pas. Ils sont à zéro AUJOURD'HUI, donc on exige
 * zéro, sans plafond et sans indulgence.
 *
 * CLIQUETS — traversées inter-domaines (69) et fuites vers un fournisseur (42). Les mettre à
 * zéro d'un coup exigerait la « réécriture aveugle » que la mission proscrit. On empêche donc
 * de GROSSIR, et on fait baisser lot après lot. Le produit marche à tout instant.
 *
 * ── LA RÈGLE QUI COMPTE VRAIMENT ─────────────────────────────────────────────────────────
 *
 * Ces plafonds ne se lèvent PAS pour faire passer un lot. Un chiffre qui monte n'est pas un
 * seuil mal réglé : c'est du couplage qu'on vient d'ajouter. Le geste correct est de sortir la
 * partie partagée vers le socle, ou d'inverser la dépendance — jamais de remonter le nombre.
 *
 * ── CE QUI REND CES CHIFFRES HONNÊTES ────────────────────────────────────────────────────
 *
 * Un compteur d'architecture se triche de trois façons, et les trois sont fermées ici :
 *
 *   1. déplacer le fichier gênant dans `utils/` → le socle est vérifié à zéro dépendance métier ;
 *   2. le déplacer dans une façade → une façade ne peut être importée QUE par le haut ;
 *   3. casser un chemin de la carte pour qu'un domaine cesse d'exister → chaque chemin déclaré
 *      doit exister sur le disque.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * ⚠ CES DEUX PLAFONDS NE DOIVENT JAMAIS AUGMENTER. Voir ci-dessus : les baisser est un progrès,
 * les monter est un aveu.
 *
 * ── L'HISTORIQUE, DANS LES DEUX SENS ─────────────────────────────────────────────────────
 *
 * 76 → 69 : `src/lib/storage/` a rejoint le SOCLE (voir `domains.ts`). Reclassification
 * VÉRIFIÉE, pas remise à zéro déguisée : ces fichiers n'importent aucun domaine ni aucune
 * façade, et `scanSocle()` les tient à cette obligation, plus stricte que celle d'un domaine.
 * Des traversées ont cessé d'exister ; on n'a pas cessé de les compter.
 *
 * 69 → 69 : le lot suivant a AJOUTÉ une capacité (la recherche dans le contenu des documents)
 * sans ajouter une seule traversée — parce qu'il est passé par le CONTRAT de plateforme au lieu
 * de brancher l'entonnoir en direct. Le plafond avait été relevé à 70, puis ramené à 69 quand le
 * test de frontière a nommé le bon remède : « le besoin est vraiment nouveau → l'ajouter au
 * CONTRAT ». Il avait raison, et c'est exactement à cela que sert un cliquet — non pas empêcher
 * d'avancer, mais faire chercher le chemin qui n'ajoute pas de dette.
 *
 * 69 → 68 (2026-09-27, matériel promotionnel circuit 2, §118.152) : l'op d'Adam qui lit l'étape
 * d'un dossier de matériel promotionnel (`assistant/ops/impl-commercial.ts`) importait le
 * vocabulaire d'étapes d'Ad & Pro (`promo-material/circuit`) en direct ; elle le lit désormais par
 * le pont `in-process/promo/`, dans le vocabulaire du circuit DU dossier (un dossier d'avant et un
 * dossier du circuit 2 ne nomment pas leurs étapes pareil). Mesuré par différence avec une copie
 * de HEAD : une traversée de moins, aucune de plus. Le même déplacement a fait baisser la
 * frontière Adam ↔ ERP (428 → 427). Plafond ramené au chiffre mesuré — laissé à 69, il ne
 * pourrait plus signaler la première traversée neuve.
 *
 * 70 → 68 (2026-10, aperçu du BC à valider) : le brouillon d'un bon de commande (`ad-pro/bc-brouillon.ts`) importait
 * le vocabulaire de la pièce commerciale (`artifact/factory/commercial`) depuis le domaine `adpro` — deux traversées.
 * Partagé par le poste Ad & Pro ET le devis de matériel promotionnel, il est la règle du BC, pas d'un circuit : il vit
 * désormais sous `bons-de-commande/brouillon.ts`, à côté de la règle et de l'aiguillage. Plafond inchangé.
 *
 * 71 → 67 (2026-10-27, audit) : les imports relatifs désormais lus (ARCH-01) avaient porté la mesure à 71. Adam lit le
 * vocabulaire des circuits (`workflow-admin.ts`) par le pont `in-process/demandes/`, et le papier à en-tête
 * (`ops/catalog.ts`, `ops/impl-wave8-files.ts`) par le pont `in-process/office/`. Mesuré : 67. Plafond ramené.
 */
/*
 * 67 → 62, fournisseurs 42 → 40 (2026-10-29, lot J0, décision 0013) : le code que partagent Adam et l'Assistant
 * IA quitte le domaine `adam` pour le SOCLE IA (`src/platform/ia/`), rangé comme le pont : il connaît l'ERP par
 * dessein, et sa dette se compte à part (`boundary.test.ts`, `SOCLE_IA_CEILING`). Rien n'a été découplé : les
 * traversées partent avec le code (−4 mesurées depuis 66, −1 fournisseur depuis 41). Plafonds ramenés au mesuré.
 */
const CROSSING_CEILING = 62;
const PROVIDER_CEILING = 40;

const report = scanDomains(process.cwd());

describe("architecture — les domaines restent des modules", () => {
  // ── 1. LES INVARIANTS À ZÉRO ────────────────────────────────────────────────────────────

  it("aucun cycle entre deux domaines", () => {
    // §1 les nomme explicitement. Un cycle A ↔ B veut dire qu'on ne peut plus toucher A sans
    // risquer B, ni remplacer B sans rouvrir A : les deux modules n'en font plus qu'un.
    const detail = report.cycles
      .map((c) => `\n  ${c}\n${cycleEdges(report, c).map((e) => `    ${e.from} ⇒ ${e.to}`).join("\n")}`)
      .join("");
    expect(report.cycles, `cycles détectés :${detail}`).toEqual([]);
  });

  it("le socle ne connaît aucun domaine ni aucune façade", () => {
    // C'EST CE TEST QUI REND LES AUTRES HONNÊTES. Sans lui, il suffirait de déplacer un fichier
    // gênant dans `utils/` pour voir le compteur baisser sans avoir rien assaini.
    const detail = report.socleLeaks.map((v) => `\n  ${v.from} ⇒ ${v.to} [${v.toDomain}]`).join("");
    expect(report.socleLeaks.length, `le socle fuit :${detail}`).toBe(0);
  });

  it("aucun domaine ne remonte vers une façade", () => {
    // Les façades (`queries/`, `api/`, `links/`) traversent les domaines par construction. Un
    // domaine qui les importe inverse la couche : la façade devient impossible à retirer, et le
    // domaine hérite de tout ce qu'elle connaît. Adam est au-dessus d'elles : il est exempté.
    const detail = report.domainToFacade.map((v) => `\n  ${v.from} [${v.fromDomain}] ⇒ ${v.to}`).join("");
    expect(report.domainToFacade.length, `inversions de couche :${detail}`).toBe(0);
  });

  // ── 2. LES CLIQUETS ─────────────────────────────────────────────────────────────────────

  it(`les traversées inter-domaines ne dépassent pas ${CROSSING_CEILING}`, () => {
    expect(
      report.crossings.length,
      `\n${formatDomains(report)}\n\n` +
        "Ce plafond ne se lève pas. Sortez la partie partagée vers le socle, ou inversez la dépendance.",
    ).toBeLessThanOrEqual(CROSSING_CEILING);
  });

  it(`les fuites vers un fournisseur ne dépassent pas ${PROVIDER_CEILING}`, () => {
    // Un domaine qui appelle le SDK directement se lie au fournisseur : le remplacer devient un
    // chantier plutôt qu'un branchement. Les façades (`models/`, `google/`) existent pour ça.
    const top = [...report.providerLeaks.reduce((m, v) => m.set(v.from, (m.get(v.from) ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([f, n]) => `\n  ${String(n).padStart(3)}  ${f}`).join("");
    expect(report.providerLeaks.length, `fichiers les plus liés à un fournisseur :${top}`).toBeLessThanOrEqual(PROVIDER_CEILING);
  });

  // ── 3. LA CARTE ELLE-MÊME NE MENT PAS ───────────────────────────────────────────────────

  it("chaque chemin déclaré dans la carte existe réellement", () => {
    // Un chemin devenu faux (dossier renommé, module déplacé) ferait DISPARAÎTRE un domaine du
    // compte en silence : ses traversées cesseraient d'être vues, et le chiffre baisserait tout
    // seul. C'est la façon la plus discrète de rendre ce test inutile — donc on la ferme.
    const manquants = DOMAINS.flatMap((d) => d.paths.filter((p) => !fs.existsSync(p)).map((p) => `${d.name} → ${p}`));
    expect(manquants, "chemins déclarés mais absents du disque").toEqual([]);
  });

  it("aucun domaine n'est vide — un domaine sans fichier est une entrée morte", () => {
    // Corollaire du précédent : un dossier qui existe mais ne contient plus rien laisse une
    // entrée qui ne mesure plus rien.
    const vides = DOMAINS.filter((d) =>
      d.paths.every((p) => {
        if (!fs.existsSync(p)) return true;
        return fs.statSync(p).isDirectory() ? fs.readdirSync(p).length === 0 : false;
      }),
    ).map((d) => d.name);
    expect(vides, "domaines déclarés sans aucun fichier").toEqual([]);
  });
});
