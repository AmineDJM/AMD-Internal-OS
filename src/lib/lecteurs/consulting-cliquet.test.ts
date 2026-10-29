import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dejaPorteParSaFiche, TYPES_ENTITE_AD_PRO, AD_PRO_ENTITY_TYPE } from "@/modules/ad-pro/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LECTEURS DE CONTRATS DE CONSULTING BORNENT LE PÔLE — un fait du CODE, pas une liste
 * (§118.150).
 *
 * Le transfert d'un contrat aux RH a obligé à retrouver tous ceux qui lisaient « un contrat de
 * consulting est une dépense Ad & Pro » (§118.61) : la garde d'accès, la liste d'Ad & Pro, le
 * centre, le registre, l'aiguillage des BC, l'imputation des paiements. Réparer les six à la main
 * ne protège pas le septième (§118.58). La règle s'arme donc sur ce que le code ÉCRIT : toute
 * LISTE de contrats (`findMany`, `findFirst`, `count`) doit nommer le pôle — sinon une liste
 * ajoutée demain rendrait à la promotion le contrat qu'on vient de confier aux RH, en silence.
 *
 * Les deux exceptions portent leur raison et sont NOMMÉES : elles ne sont pas des listes qu'une
 * personne lit. Une troisième exemption devra s'écrire ici, avec la sienne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const EXEMPTIONS: Record<string, string> = {
  // La NUMÉROTATION lit les références de l'année pour la suivante — rien ne sort vers un écran.
  "src/lib/actions/consulting-actions.ts": "numérotation CONS-AAAA-NNN",
  // L'EXISTENCE d'identifiants qu'on tient déjà — elle ne rend ni intitulé ni montant.
  "src/lib/entity-exists.ts": "existence par identifiants",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Le texte d'un appel, de sa parenthèse ouvrante à sa fermante — commentaires compris ou non. */
function appel(src: string, debut: number): string {
  let profondeur = 0;
  for (let i = debut; i < src.length; i += 1) {
    if (src[i] === "(") profondeur += 1;
    else if (src[i] === ")") { profondeur -= 1; if (profondeur === 0) return src.slice(debut, i + 1); }
  }
  return src.slice(debut);
}

/** Retire les commentaires : un cliquet qui lirait la PROSE s'accrocherait à sa propre doc (§118.79d). */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("les lecteurs de contrats de consulting (§118.150)", () => {
  const racine = path.join(process.cwd(), "src");
  const fichiers = walk(racine).map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"));

  it("toute LISTE de contrats nomme le pôle — ou porte une exemption écrite avec sa raison", () => {
    const sites: { fichier: string; texte: string }[] = [];
    for (const f of fichiers) {
      const src = sansCommentaires(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(/consultingContract\s*\.\s*(findMany|findFirst|findFirstOrThrow|count)\s*\(/g)) {
        sites.push({ fichier: f, texte: appel(src, (m.index ?? 0) + m[0].length - 1) });
      }
    }
    // PLANCHER : un parcours cassé ne trouverait RIEN et passerait au vert (§118.17). Mesuré à 8
    // sites (deux listes d'écran, deux lectures d'Ad & Pro, deux lectures de pôle par
    // identifiants, les deux exemptions) — le plancher en laisse deux de marge pour un retrait.
    expect(sites.length, "le parcours ne trouve plus les lecteurs — il ne mesurerait rien").toBeGreaterThanOrEqual(6);
    const fautifs = sites.filter((s) => !EXEMPTIONS[s.fichier] && !/\bpole\b/.test(s.texte)).map((s) => s.fichier);
    expect(fautifs, "une liste de contrats qui ne borne pas le pôle rendrait un contrat RH à la promotion").toEqual([]);
  });

  it("les exemptions désignent des fichiers qui existent et lisent encore des contrats", () => {
    for (const f of Object.keys(EXEMPTIONS)) {
      expect(fs.existsSync(f), `exemption orpheline : ${f}`).toBe(true);
      expect(fs.readFileSync(f, "utf8")).toMatch(/consultingContract\s*\.\s*findMany/);
    }
  });

  it("l'imputation d'un paiement lit le module de la SOURCE sur la ligne — à l'écran ET à l'action", () => {
    // Un consultant passé aux RH se paie sur une enveloppe RH : l'écran propose et l'action
    // classe. Deux lectures différentes feraient proposer une catégorie que l'action ne retient
    // pas (§118.5). On cherche le POINT D'APPEL, pas le corps (§118.49).
    const action = sansCommentaires(fs.readFileSync("src/modules/finances/actions-depenses.ts", "utf8"));
    expect(action).toMatch(/moduleDeLEntite\(\s*order\.sourceType\s*,\s*order\.sourceId\s*\)/);
    const ecran = sansCommentaires(fs.readFileSync("src/app/(app)/finances/paiements-a-faire/page.tsx", "utf8"));
    expect(ecran).toMatch(/modulesDesEntites\(/);
    expect(ecran).toMatch(/modulesSources\.get\(/);
  });

  it("la FICHE s'ouvre par le module du pôle, AVANT de charger quoi que ce soit, et répond « introuvable » sinon", () => {
    // La fiche est commune aux deux pôles : gardée par « Consulting » en dur, elle se fermerait
    // aux RH qui suivent le contrat et s'ouvrirait à la promotion qui ne doit plus le lire.
    const page = sansCommentaires(fs.readFileSync("src/app/(app)/consulting/[id]/page.tsx", "utf8"));
    expect(page).not.toMatch(/requireModule\(\s*"CONSULTING"\s*\)/);
    // Le module de la porte vient du PÔLE LU SUR LA LIGNE — une porte bien écrite sur un module
    // fixé en dur garde le mauvais pôle sous le bon nom de variable (sabotage passé au vert).
    expect(page).toMatch(/const pole = poleDe\(tete\?\.pole\)/);
    expect(page).toMatch(/const moduleDuContrat = MODULE_DU_POLE\[pole\]/);
    const porte = page.search(/if \(!tete \|\| !userCan\(user, moduleDuContrat, "VIEW"\)\) notFound\(\)/);
    const chargement = page.search(/const contract = await prisma\.consultingContract\.findUnique/);
    expect(porte, "la porte du pôle manque").toBeGreaterThan(-1);
    expect(chargement).toBeGreaterThan(porte);
    expect(page).not.toMatch(/userCan\(user, "CONSULTING"/);
  });

  it("la garde par enregistrement lit le module de la LIGNE, pas la table écrite à la main", () => {
    const garde = sansCommentaires(fs.readFileSync("src/lib/entity-access/acces-entite.ts", "utf8"));
    const corps = garde.slice(garde.indexOf("export async function canAccessEntity"));
    expect(corps).toMatch(/const module = await moduleDeLEntite\(entityType, entityId\)/);
    expect(corps).not.toMatch(/const module = ENTITY_MODULE\[entityType\]/);
  });

  it("la lecture du pôle par la garde n'AVALE pas son erreur — une panne ne rend pas le contrat à la promotion", () => {
    // Retomber sur le défaut du schéma (Ad & Pro) quand la lecture échoue ouvrirait à la promotion,
    // sur une simple panne, le contrat d'un consultant RH. Une garde ne se trompe que dans le sens
    // qui FERME : l'erreur remonte et l'appelant refuse. (L'aiguillage des BC garde, lui, son repli :
    // les deux centres valident, se tromper de centre coûte un transfert, jamais une lecture.)
    const garde = sansCommentaires(fs.readFileSync("src/lib/entity-access/modules.ts", "utf8"));
    const debut = garde.indexOf("export async function modulesDesEntites");
    expect(debut, "le lecteur en lot a disparu").toBeGreaterThan(-1);
    const corps = garde.slice(debut, garde.indexOf("\n}\n", debut));
    expect(corps).toMatch(/prisma\.consultingContract/);
    expect(corps, "une lecture de pôle qui avale son erreur retombe sur Ad & Pro").not.toMatch(/\.catch\(/);
  });

  it("le transfert DIT une relecture des BC bornée — le drapeau de troncature a un lecteur", () => {
    // `reaiguillerLesBCDe` calculait `tronque` et personne ne le lisait : un état qu'aucun code ne
    // lit (§118.45), et une lecture bornée qui se tait se lit comme exhaustive (§118.60).
    const action = sansCommentaires(fs.readFileSync("src/lib/actions/consulting-actions.ts", "utf8"));
    expect(action).toMatch(/const bc = await reaiguillerLesBCDe\(/);
    expect(action, "la phrase du transfert ne lit plus la troncature").toMatch(/bc\.tronque\s*\?/);
  });
});

describe("une demande du secrétariat déjà portée par sa fiche (§118.150)", () => {
  it("les sept natures du pôle et le POSTE — et rien d'autre", () => {
    for (const t of Object.values(AD_PRO_ENTITY_TYPE)) expect(dejaPorteParSaFiche(t), t).toBe(true);
    expect(dejaPorteParSaFiche("AD_PRO_ITEM")).toBe(true);
    // Un contrat de consulting reste porté par SES ordres de dépense, quel que soit son pôle :
    // la question est « qui porte la dépense ? », pas « est-ce de la promotion ? ».
    expect(dejaPorteParSaFiche("CONSULTING_CONTRACT")).toBe(true);
    for (const t of ["TASK", "ADMIN_REQUEST", "LEGAL_DOCUMENT", "", null, undefined]) expect(dejaPorteParSaFiche(t as never)).toBe(false);
    expect(TYPES_ENTITE_AD_PRO.size).toBe(Object.keys(AD_PRO_ENTITY_TYPE).length + 1);
  });

  it("la PAGE et l'ACTION posent la même question par la même fonction — la liste écrite à la main a disparu", () => {
    // Le défaut mesuré : la page lisait huit types, l'action cinq, écrits à la main ; sur un
    // achat lié à un poste, l'écran masquait l'imputation que l'action exigeait — une impasse.
    const action = sansCommentaires(fs.readFileSync("src/lib/actions/admin-request-actions.ts", "utf8"));
    expect(action).toMatch(/const fromAdPro = dejaPorteParSaFiche\(req\.linkedEntityType\)/);
    expect(action).not.toMatch(/\[\s*"SPONSORING"\s*,\s*"CONGRESS_NATIONAL"/);
    const page = sansCommentaires(fs.readFileSync("src/app/(app)/demandes/[id]/page.tsx", "utf8"));
    expect(page).toMatch(/const fromAdPro = dejaPorteParSaFiche\(req\.linkedEntityType\)/);
  });
});
