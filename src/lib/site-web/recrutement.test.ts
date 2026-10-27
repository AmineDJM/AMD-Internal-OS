import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEUX BRANCHEMENTS QUI FONT VIVRE LA PUBLICATION (§118.158, §118.14, §118.49).
 *
 *   1. CHAQUE ÉCRITURE D'ÉTAPE D'UN RECRUTEMENT resynchronise l'offre du site. Un poste pourvu,
 *      clos, refusé ou annulé ne doit pas rester annoncé jusqu'à la réconciliation de la nuit :
 *      des candidats postuleraient pour rien, sur la page publique de l'entreprise. La règle du
 *      corps (`corpsOffre(…, posteOuvert)`) garantit le CONTENU ; ce cliquet garantit qu'il PART.
 *   2. LE BATTEMENT vide la file et lance la réconciliation quotidienne. Sans lui, un envoi en
 *      échec réseau attendrait qu'une personne réenregistre le contenu — et un redémarrage
 *      perdrait le minuteur des réessais courts.
 *
 * On cherche les POINTS D'APPEL, dans la source privée de ses commentaires : vérifier qu'une
 * fonction existe ne prouverait rien, c'est son appel qui se perd dans une édition (§118.49).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/** Les fonctions exportées d'un fichier, chacune avec son texte (jusqu'à la suivante). */
function fonctionsExportees(src: string): { nom: string; debut: number; corps: string }[] {
  const re = /export\s+async\s+function\s+(\w+)\s*\(/g;
  const positions = [...src.matchAll(re)].map((m) => ({ nom: m[1]!, debut: m.index! }));
  return positions.map((p, i) => ({ nom: p.nom, debut: p.debut, corps: src.slice(p.debut, positions[i + 1]?.debut ?? src.length) }));
}

/** Le texte des arguments d'un appel, parenthèses équilibrées, à partir de l'index de `(`. */
function argumentsDe(src: string, ouvrante: number): string {
  let prof = 0;
  for (let i = ouvrante; i < src.length; i += 1) {
    const c = src[i];
    if (c === "(") prof += 1;
    else if (c === ")") { prof -= 1; if (prof === 0) return src.slice(ouvrante + 1, i); }
  }
  return src.slice(ouvrante + 1);
}

const RECRUTEMENT = sansCommentaires(readFileSync(join(process.cwd(), "src/lib/actions/recruitment-actions.ts"), "utf8"));

describe("Recrutement → offre du site", () => {
  it("chaque écriture d'ÉTAPE est suivie, dans la même action, d'une resynchronisation de l'offre", () => {
    const ecritures: { fonction: string; index: number }[] = [];
    const manquantes: string[] = [];
    for (const f of fonctionsExportees(RECRUTEMENT)) {
      // `tx.` aussi (§118.192) : une écriture d'étape faite DANS une transaction reste une écriture d'étape —
      // ne lire que `prisma.` aurait rendu ce cliquet aveugle aux gestes devenus conditionnels.
      const appels = [...f.corps.matchAll(/(?:prisma|tx)\.recruitmentRequest\.(update|updateMany)\s*\(/g)];
      const syncs = [...f.corps.matchAll(/synchroniserOffreDeLaDemande\s*\(/g)].map((m) => m.index!);
      for (const a of appels) {
        const args = argumentsDe(f.corps, a.index! + a[0].length - 1);
        if (!/\bstage\s*:/.test(args)) continue;
        ecritures.push({ fonction: f.nom, index: a.index! });
        if (!syncs.some((s) => s > a.index!)) manquantes.push(f.nom);
      }
    }
    // PLANCHER : un parcours cassé (renommage, découpage du fichier) rendrait ce cliquet vert en ne
    // trouvant RIEN (§118.17). Mesuré : 9 écritures d'étape dans 8 actions ; 13 dans 13 au §118.192 (renvoyer,
    // corriger, rouvrir, annuler l'embauche, et l'intégration d'un salarié comme d'un consultant).
    expect(ecritures.length, "aucune écriture d'étape trouvée : le cliquet ne lit plus la bonne forme").toBeGreaterThanOrEqual(13);
    expect(manquantes, `écritures d'étape sans resynchronisation de l'offre du site : ${manquantes.join(", ")}`).toEqual([]);
  });

  it("la resynchronisation ne peut pas faire échouer une décision de recrutement", () => {
    const contenus = sansCommentaires(readFileSync(join(process.cwd(), "src/lib/site-web/contenus.ts"), "utf8"));
    const i = contenus.indexOf("export async function synchroniserOffreDeLaDemande");
    expect(i).toBeGreaterThan(-1);
    const corps = contenus.slice(i, contenus.indexOf("\n}\n", i));
    // Le site injoignable ne doit jamais annuler l'étape déjà écrite : tout est sous try/catch.
    expect(corps).toMatch(/try\s*\{[\s\S]*synchroniserOffre\([\s\S]*\}\s*catch/);
  });
});

describe("Le battement porte la file et la réconciliation", () => {
  const SCHEDULED = sansCommentaires(readFileSync(join(process.cwd(), "src/lib/scheduled.ts"), "utf8"));
  const debut = SCHEDULED.indexOf("export async function runScheduledJobs");
  const corps = SCHEDULED.slice(debut, SCHEDULED.indexOf("\nexport ", debut + 10) === -1 ? undefined : SCHEDULED.indexOf("\nexport ", debut + 10));

  it("runScheduledJobs vide la file du site et lance le rapprochement quand il est dû", () => {
    expect(debut).toBeGreaterThan(-1);
    expect(SCHEDULED).toMatch(/import\s*\{\s*viderFile as viderFileSiteWeb\s*\}\s*from\s*"@\/lib\/site-web\/file"/);
    expect(corps).toMatch(/await\s+etape\("viderFileSiteWeb",\s*viderFileSiteWeb\)/);
    expect(corps).toMatch(/await\s+etape\("rapprocherSiteSiDu",\s*rapprocherSiteSiDu\)/);
  });
});

describe("Préparer une offre depuis une demande : la demande se lit sous la porte du RECRUTEMENT", () => {
  // `peutPublierOffres` et `recruitmentScope` disent aujourd'hui la même chose — RH en écriture ou la
  // direction —, par deux copies de la même condition. La garde n'est donc exerçable par AUCUN acteur
  // réel : il n'en existe pas un qui publie des offres sans voir toutes les demandes (§118.82 — on
  // l'écrit plutôt que de croire l'avoir éprouvée). Ce qui la tient est son POINT D'APPEL : le jour
  // où la porte des offres s'élargit, `?demande=` ne doit pas montrer les missions d'un poste qu'on
  // n'a pas le droit d'ouvrir, et c'est la lecture bornée qui l'empêche, pas la coïncidence.
  const PAGE = sansCommentaires(readFileSync(join(process.cwd(), "src/app/(app)/site-web/offres/nouvelle/page.tsx"), "utf8"));
  const ACTION = sansCommentaires(readFileSync(join(process.cwd(), "src/lib/actions/offres-emploi-actions.ts"), "utf8"));
  const BORNEE = /recruitmentRequest\.findFirst\(\s*\{\s*where:\s*\{\s*AND:\s*\[\s*\{\s*id:\s*\w+\s*\}\s*,\s*recruitmentScope\(user\)\s*\]\s*\}/;

  it("la page de préparation ne lit la demande QUE par la lecture bornée", () => {
    expect(PAGE).toMatch(BORNEE);
    expect(PAGE.match(/recruitmentRequest\.\w+\(/g), "la page lit une demande sans la portée du recrutement").toEqual(["recruitmentRequest.findFirst("]);
  });

  it("le rattachement d'une offre neuve lit la demande sous la même porte ; la seule lecture libre ne prend que l'étape", () => {
    expect(ACTION).toMatch(BORNEE);
    const libres = [...ACTION.matchAll(/recruitmentRequest\.(findUnique|findFirst|findMany)\(/g)]
      .map((m) => argumentsDe(ACTION, m.index! + m[0].length - 1))
      .filter((args) => !/recruitmentScope\(user\)/.test(args));
    // La lecture de l'étape d'une offre DÉJÀ rattachée reste libre, et c'est voulu : bornée, elle
    // rendrait `null` hors portée, c'est-à-dire « poste ouvert » (`posteOuvert(null)`), et la phrase
    // annoncerait en ligne une offre que la synchronisation laisse en brouillon. Elle ne sélectionne
    // que l'étape : rien d'autre de la demande ne peut en sortir.
    expect(libres.length, `lectures de demande hors portée : ${libres.join(" | ")}`).toBe(1);
    expect(libres[0]).toMatch(/select:\s*\{\s*stage:\s*true\s*\}\s*\}\s*$/);
  });
});
