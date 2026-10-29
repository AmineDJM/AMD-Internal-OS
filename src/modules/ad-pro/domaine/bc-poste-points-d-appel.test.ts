import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lireSources } from "@/platform/source";
import { sourceDeLaCle } from "@/lib/actions/parc";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE VISA D'UN BC DE POSTE — SES POINTS D'APPEL (§118.187, §118.49).
 *
 * La règle (`ad-pro/bc-poste.ts`) est juste et testée ; ce banc vérifie qu'on L'APPELLE, là où il faut :
 * une règle que personne n'appelle est du code mort qu'aucun banc de la règle ne verrait. Et deux
 * moitiés vivent dans des composants CLIENTS qu'aucun banc ne rend : le centre et la carte du poste
 * doivent RENVOYER ce qu'ils ont affiché, sinon l'action n'a rien à comparer et vise un montant que
 * personne n'a lu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un cliquet juge le CODE, pas la prose qui le décrit (§118.79d, §118.88). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const lire = (p: string) => sansCommentaires(readFileSync(p, "utf8"));
const ACTIONS = "la clé ad-pro-item-actions (src/modules/ad-pro/actions-postes*.ts)";
const lireActions = () => sansCommentaires(sourceDeLaCle("ad-pro-item-actions"));

/** Les arguments de chaque appel `adProItem.update(…)` / `updateMany(…)` — parenthèses appariées. */
function ecrituresDuPoste(f: string): string[] {
  const out: string[] = [];
  const re = /adProItem\.(?:update|updateMany)\(/g;
  for (let m = re.exec(f); m; m = re.exec(f)) {
    let i = m.index + m[0].length;
    for (let prof = 1; i < f.length && prof > 0; i++) {
      if (f[i] === "(") prof++;
      else if (f[i] === ")") prof--;
    }
    out.push(f.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/** Le corps d'une fonction du fichier, de sa signature à la suivante. */
function corps(src: string, nom: string): string {
  const debut = src.search(new RegExp(`\\n(export )?async function ${nom}\\(`));
  expect(debut, `${nom} introuvable dans ${ACTIONS}`).toBeGreaterThan(-1);
  const suite = src.slice(debut + 1).search(/\n(export )?(async )?function \w+\(/);
  return suite === -1 ? src.slice(debut) : src.slice(debut, debut + 1 + suite);
}

describe("Le visa d'un BC de poste — appelé là où le montant ou le prestataire peuvent changer", () => {
  const src = lireActions();

  it("chaque écrivain du montant accordé ou du prestataire d'un poste lit la règle du visa, ou ferme la porte avant", () => {
    // Les fonctions qui ÉCRIVENT `amountGranted` ou `supplier` sur un poste (pas un `select`) — trouvées
    // dans le code, pas listées à la main : un écrivain ajouté demain est jugé sans que personne y pense.
    const fonctions = src.split(/\n(?=(?:export )?async function \w+\()/).slice(1);
    const ecrivains = fonctions
      // Seule la partie `data:` écrit : un `where: { amountGranted: … }` (le visa conditionnel) ne change rien.
      .filter((f) => ecrituresDuPoste(f).some((arg) => /\b(amountGranted|supplier)\s*:/.test(arg.slice(Math.max(0, arg.indexOf("data:"))))))
      .map((f) => f.match(/async function (\w+)\(/)![1]);
    // Ce que chacun fait de la règle — une décision écrite, avec sa raison.
    const CONDUITE: Record<string, RegExp> = {
      // Le montant ou le prestataire changent : la règle juge, et rouvre le visa si besoin.
      updateAdProItem: /gesteVisaPoste\(/,
      // Un accord redonné à un autre montant : la règle juge aussi.
      decideAdProItem: /gesteVisaPoste\(/,
      // Le poste repart à la Direction : sa demande de BC est RETIRÉE, il n'y a plus de visa à juger.
      demanderRevisionPoste: /orderStage: "NONE" as const/,
    };
    expect(ecrivains.length, "PRÉMISSE : le banc trouve les écrivains (sinon il passerait en ne lisant rien)").toBeGreaterThanOrEqual(3);
    for (const nom of ecrivains) {
      expect(CONDUITE[nom], `${nom} écrit le montant ou le prestataire d'un poste sans décision sur le visa : appelez gesteVisaPoste, ou retirez la demande de BC`).toBeDefined();
      expect(corps(src, nom), `${nom} doit ${String(CONDUITE[nom])}`).toMatch(CONDUITE[nom]!);
    }
  });

  it("la demande de paiement est le DERNIER REMPART : elle compare à l'empreinte avant de prendre le poste", () => {
    const c = corps(src, "demanderPaiementPoste");
    const iRegle = c.indexOf("gesteVisaPoste(");
    const iPrise = c.indexOf('data: { orderStage: "ISSUED"');
    expect(iRegle, "l'émission doit appeler la règle du visa").toBeGreaterThan(-1);
    expect(iPrise).toBeGreaterThan(-1);
    expect(iRegle, "la règle se lit AVANT la prise — après, l'ordre serait déjà engagé").toBeLessThan(iPrise);
  });

  it("le visa pose son empreinte sur la valeur LUE, par une écriture qui exige qu'elle n'ait pas bougé", () => {
    const c = corps(src, "approveAdProItemOrder");
    expect(c).toMatch(/where: \{ id, orderStage: "REQUESTED", amountGranted: item\.amountGranted, supplier: item\.supplier \}/);
    expect(c).toMatch(/orderVisaAmount: item\.amountGranted, orderVisaSupplier: item\.supplier/);
  });
});

describe("Les écrans renvoient ce qu'ils ont lu — composants clients qu'aucun banc ne rend", () => {
  it("le centre Ad & Pro envoie le montant ET le prestataire affichés avec le visa d'un BC de poste", () => {
    const c = lire("src/app/(app)/centre-ad-pro/centre-board.tsx");
    const i = c.indexOf("approveAdProItemOrder(undefined, fd)");
    expect(i, "le visa d'un BC de poste part de ce composant").toBeGreaterThan(-1);
    const avant = c.slice(Math.max(0, i - 900), i);
    expect(avant, "le montant lu doit partir avec le visa").toMatch(/fd\.set\("montantVu", String\(row\.montant\)\)/);
    expect(avant, "le prestataire lu doit partir avec le visa").toMatch(/fd\.set\("prestataireVu", row\.prestataire \?\? ""\)/);
  });

  it("la ligne du centre PORTE le prestataire qu'elle affiche — sinon l'écran renverrait un vide", () => {
    expect(lire("src/modules/ad-pro/infra/requetes/centre.ts")).toMatch(/prestataire: p\.supplier/);
  });

  it("la carte du poste envoie le montant et le prestataire qu'elle montre avec son propre visa", () => {
    const c = sansCommentaires(lireSources("src/modules/ad-pro/ecrans/items-panel.tsx", "src/modules/ad-pro/ecrans/postes/"));
    const i = c.indexOf("approveAdProItemOrder(undefined");
    expect(i).toBeGreaterThan(-1);
    const autour = c.slice(i, i + 400);
    expect(autour).toMatch(/montantVu: item\.amountGranted != null \? String\(item\.amountGranted\) : ""/);
    expect(autour).toMatch(/prestataireVu: item\.supplier \?\? ""/);
  });

  it("la carte ne propose pas un geste qu'un BC établi dans Legal ferait refuser — et lit la MÊME lecture que les actions", () => {
    const c = sansCommentaires(lireSources("src/modules/ad-pro/ecrans/items-panel.tsx", "src/modules/ad-pro/ecrans/postes/"));
    expect(c).toMatch(/if \(bcAnnulable\) entrees\.push\(\{ cle: "retirer-bc"/);
    expect(c).toMatch(/!arbitrer && editer && !stock && !bcLegal && item\.status === "APPROVED"/);
    expect(lire("src/modules/ad-pro/infra/requetes/postes.ts"), "la carte lit les BC établis par la lecture partagée").toMatch(/bcVivantsDesPostes/);
    expect(lireActions(), "les actions aussi — deux lectures de « ce BC existe-t-il ? » finiraient par diverger").toMatch(/\bbcVivantsDesPostes\b[^;]*\} from "@\/modules\/ad-pro\/api"/);
  });
});
