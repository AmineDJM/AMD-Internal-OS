import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fichierDuSymbole } from "@/platform/source";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET D'INSCRIPTION (J1) — « toute pièce qui entre dans la plateforme, quelle que soit la porte,
 * est inscrite au même registre ».
 *
 * Même esprit que `src/lib/client-bundle-guard.test.ts` : une règle que personne ne peut oublier parce
 * qu'une machine la tient. Tout appel qui écrit au coffre (`putBlob`, `putBlobFromFile`, `saveFile`) hors
 * du coffre doit être SUIVI, dans le même fichier, d'une inscription — `inscrirePiece` et ses formes
 * (`@/modules/bibliotheque/api-inscription`) ou une PORTE qui inscrit elle-même (`enregistrerFichierDrive`,
 * `persistUploadedDocument`…, vérifiées par le second test).
 *
 * Les exceptions sont NOMMÉES et JUSTIFIÉES, avec le nombre exact d'écritures non suivies : une écriture
 * neuve sans inscription fait échouer ; une exception devenue inutile aussi (la liste ne fait que rétrécir).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const EXCEPTIONS: Record<string, { ecritures: number; raison: string }> = {
  "src/lib/drive-storage.ts": { ecritures: 0, raison: "Le coffre lui-même : `putBlob` y est défini, pas appelé pour une pièce." },
  "src/app/api/messaging/upload/route.ts": {
    ecritures: 1,
    raison: "Le blob n'a pas encore d'endroit : il est inscrit par `sendMessage` (messaging-actions.ts) à la création de la pièce jointe.",
  },
  "src/lib/actions/kpi-actions.ts": {
    ecritures: 1,
    raison: "L'import d'un tableau de valeurs KPI (`KpiImport`) : les chiffres sont versés dans `KpiValue`, le fichier n'a ni lecteur ni règle d'ouverture.",
  },
  "src/lib/direction-artistique/serveur.ts": { ecritures: 1, raison: "Papier à en-tête : une image de mise en page des modèles, pas une pièce documentaire." },
  "src/platform/in-process/brand/index.ts": { ecritures: 1, raison: "Logo de société (image de marque des documents générés), pas une pièce documentaire." },
  "src/lib/regulatory/intelligence/ingest/ingest-dossier.ts": {
    ecritures: 4,
    raison: "Corpus réglementaire (dossiers CTD) : index et vecteurs propres (`RegulatoryExtraction`), droits du pipeline réglementaire — pont prévu au lot J2, sans relecture.",
  },
  "src/lib/regulatory/intelligence/reserves/ingest.ts": { ecritures: 1, raison: "Corpus réglementaire (réserves ANPP) : même index propre que les dossiers CTD (lot J2)." },
  "src/lib/regulatory/intelligence/reserves/library-ingest.ts": { ecritures: 1, raison: "Corpus réglementaire (bibliothèque des réserves) : même index propre (lot J2)." },
  "src/lib/regulatory/intelligence/docgen/reports.ts": { ecritures: 1, raison: "Rapport généré par le pipeline réglementaire (`RegulatoryGeneratedDoc`), sous ses droits (lot J2)." },
  "src/lib/regulatory/intelligence/knowledge/dossier-agent.ts": { ecritures: 1, raison: "Document généré par l'agent de dossier réglementaire (`RegulatoryGeneratedDoc`), sous ses droits (lot J2)." },
};

/** Les appels qui inscrivent : la porte de la bibliothèque, et les portes qui inscrivent elles-mêmes. */
const INSCRIPTIONS = [
  "inscrirePiece", "inscrirePieceJointe", "inscrireDocument", "inscrireDocumentEcrit", "inscrireDocumentExistant", "inscrireDocumentRh", "inscrireFichierDrive",
];
const PORTES_QUI_INSCRIVENT = ["enregistrerFichierDrive", "persistUploadedDocument", "inscrireDocumentDirect", "attachFiles", "deposerFichierDrive", "putDriveFile"];

const ECRITURE = /\b(putBlob|putBlobFromFile|saveFile)\(/g;
const INSCRIPTION = new RegExp(`\\b(${[...INSCRIPTIONS, ...PORTES_QUI_INSCRIVENT].join("|")})\\(`, "g");

const RACINE = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(path.relative(RACINE, p).split(path.sep).join("/"));
  }
  return out;
}

/** Le code sans ses commentaires (un `putBlob(` cité dans une explication n'écrit rien). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Les positions des appels (pas des déclarations `function putBlob(`). */
function appels(src: string, re: RegExp): number[] {
  const out: number[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (/function\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    out.push(m.index);
  }
  return out;
}

function mesurer(): Record<string, number> {
  const nonSuivies: Record<string, number> = {};
  for (const f of walk(path.join(RACINE, "src"))) {
    if (f.startsWith("src/modules/bibliotheque/")) continue;
    const src = sansCommentaires(fs.readFileSync(f, "utf8"));
    const ecritures = appels(src, ECRITURE);
    if (!ecritures.length) continue;
    const inscriptions = appels(src, INSCRIPTION);
    // Une écriture est « suivie » quand une inscription apparaît APRÈS elle dans le fichier.
    const n = ecritures.filter((e) => !inscriptions.some((i) => i > e)).length;
    if (n > 0) nonSuivies[f] = n;
  }
  return nonSuivies;
}

/** Le texte d'une fonction exportée — de sa déclaration à l'accolade fermante en colonne 0 (style du dépôt). */
function corpsDe(nom: string): string {
  const fichier = fichierDuSymbole(nom);
  const src = sansCommentaires(fs.readFileSync(fichier, "utf8"));
  const debut = src.search(new RegExp(`export async function ${nom}\\b`));
  expect(debut, `${nom} introuvable dans ${fichier}`).toBeGreaterThanOrEqual(0);
  const fin = src.indexOf("\n}\n", debut);
  return src.slice(debut, fin < 0 ? undefined : fin);
}

describe("Toute pièce écrite au coffre est inscrite à la bibliothèque (J1)", () => {
  it("chaque écriture au coffre est suivie d'une inscription — ou figure, comptée et justifiée, parmi les exceptions", () => {
    const mesure = mesurer();
    const attendu = Object.fromEntries(Object.entries(EXCEPTIONS).filter(([, e]) => e.ecritures > 0).map(([f, e]) => [f, e.ecritures]));
    expect(
      mesure,
      "une écriture au coffre sans inscription : appeler `inscrirePiece` (ou `inscrireDocument…`, `inscrireFichierDrive`) de `@/modules/bibliotheque/api-inscription` après l'écriture métier — ou, si la pièce n'a vraiment rien à faire à la bibliothèque, l'ajouter à EXCEPTIONS avec sa raison. Une exception qui ne sert plus se RETIRE.",
    ).toEqual(attendu);
  });

  it("chaque exception est justifiée et désigne un fichier qui existe", () => {
    for (const [f, e] of Object.entries(EXCEPTIONS)) {
      expect(fs.existsSync(f), f).toBe(true);
      expect(e.raison.length, `raison de ${f}`).toBeGreaterThan(30);
    }
  });

  it("les portes comptées comme des inscriptions inscrivent vraiment", () => {
    for (const porte of PORTES_QUI_INSCRIVENT) {
      const corps = corpsDe(porte);
      // Une porte peut s'appuyer sur une autre porte vérifiée ici (`putDriveFile` → `deposerFichierDrive`).
      const re = new RegExp(`\\b(${[...INSCRIPTIONS, ...PORTES_QUI_INSCRIVENT.filter((p) => p !== porte)].join("|")})\\(`);
      expect(re.test(corps), `${porte} doit appeler la porte d'inscription de la bibliothèque`).toBe(true);
    }
  });
});
