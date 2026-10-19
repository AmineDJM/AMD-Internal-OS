import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { describe, expect, it } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « TOUS LES PAIEMENTS PASSENT PAR LE CENTRE DE PAIEMENTS » — ET « TOUS LES BC PAR UN CENTRE DE
 * VALIDATION » (Direction, 09/2026). Le cliquet des ÉCRIVAINS (§118.148).
 *
 * Les deux règles vivent dans des fonctions justes et testées : `initialCentralStatus` fait naître
 * tout ordre « en attente du centre », `canDisburse` refuse de payer sans son accord, et
 * `aiguillerBC` pose la porte d'un bon de commande dans le bon centre. Aucune ne protège de
 * l'écrivain QU'ON N'A PAS REGARDÉ : un `prisma.expenseOrder.create` ajouté demain dans un module
 * hériterait du défaut du schéma (`centralStatus = NOT_REQUIRED`, l'état HISTORIQUE que
 * `canDisburse` laisse payer) et ferait sortir de l'argent sans que le centre l'ait jamais vu —
 * aucune erreur, aucune étape en échec, un ordre qui a l'air parfaitement normal. C'est la porte
 * gardée à côté de la porte ouverte (§118.71), et réparer les écrivains d'aujourd'hui ne protège
 * pas celui de demain (§118.58).
 *
 * Le cliquet cherche donc les POINTS D'APPEL (§118.49), sur la source SANS ses commentaires —
 * quatre fois dans ce dépôt un cliquet s'est accroché à la prose qui le décrivait (§118.79d,
 * §118.88, §118.112b, §118.138).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = join(process.cwd(), "src");

/** Les commentaires retirés, sans prendre le `//` d'une adresse (`https://…`) pour un commentaire. */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function fichiersDeProduction(): string[] {
  const out: string[] = [];
  const marcher = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) marcher(p);
      else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
    }
  };
  marcher(RACINE);
  return out;
}

const rel = (p: string) => relative(process.cwd(), p).replace(/\\/g, "/");

/** Le texte des arguments d'un appel, parenthèses équilibrées, à partir de l'index de `(`. */
function arguments_(src: string, ouvrante: number): string {
  let prof = 0;
  for (let i = ouvrante; i < src.length; i += 1) {
    const c = src[i];
    if (c === "(") prof += 1;
    else if (c === ")") {
      prof -= 1;
      if (prof === 0) return src.slice(ouvrante + 1, i);
    }
  }
  return src.slice(ouvrante + 1);
}

const ligne = (src: string, index: number) => src.slice(0, index).split("\n").length;

/**
 * CE QUE L'APPEL ÉCRIT — l'objet `data: { … }`, accolades équilibrées — et non ce qu'il LIT.
 *
 * Une écriture conditionnelle nomme dans son `where` le montant et l'autorisation qu'elle a lus
 * (§118.191) : juger tout le texte de l'appel compterait comme « écrivain du montant » le centre qui
 * ne fait que vérifier que le montant n'a pas bougé. Sans `data:` (un `upsert`), on garde tout le
 * texte — le sens prudent : on accuse un écrivain de trop, jamais un de moins.
 */
function partieEcrite(args: string): string {
  const m = /\bdata\s*:\s*\{/.exec(args);
  if (!m) return args;
  const ouvrante = m.index + m[0].length - 1;
  let prof = 0;
  for (let i = ouvrante; i < args.length; i += 1) {
    if (args[i] === "{") prof += 1;
    else if (args[i] === "}") {
      prof -= 1;
      if (prof === 0) return args.slice(ouvrante, i + 1);
    }
  }
  return args.slice(ouvrante);
}

interface Site { fichier: string; ligne: number; methode: string; args: string; index: number; src: string }

function sitesDAppel(fichiers: string[], modele: string, methodes: string): Site[] {
  const out: Site[] = [];
  const re = new RegExp(`\\b${modele}\\s*\\.\\s*(${methodes})\\s*\\(`, "g");
  for (const f of fichiers) {
    const src = sansCommentaires(readFileSync(f, "utf8"));
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const ouvrante = m.index + m[0].length - 1;
      out.push({ fichier: rel(f), ligne: ligne(src, m.index), methode: m[1], args: arguments_(src, ouvrante), index: m.index, src });
    }
  }
  return out;
}

const PARC = fichiersDeProduction();

describe("le parc est réellement lu", () => {
  it("sans quoi chaque cliquet ci-dessous serait vert en ne lisant rien", () => {
    expect(PARC.length).toBeGreaterThan(900);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. UN SEUL ÉCRIVAIN D'ORDRE DE DÉPENSE, ET IL FAIT NAÎTRE L'ORDRE AU CENTRE
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("un ordre de dépense ne naît qu'à UN endroit — et il y naît en attente du centre", () => {
  const creations = sitesDAppel(PARC, "expenseOrder", "create|createMany|createManyAndReturn|upsert");

  it("l'unique écrivain est `createExpenseOrder` (lib/expense-orders.ts)", () => {
    expect(
      creations.map((s) => `${s.fichier}:${s.ligne}`),
      "un second écrivain hériterait du défaut du schéma (NOT_REQUIRED) : l'ordre partirait aux "
        + "Finances sans que le centre de paiement l'ait vu. Passez par `createExpenseOrder`.",
    ).toHaveLength(1);
    expect(creations[0].fichier).toBe("src/lib/expense-orders.ts");
  });

  it("…et l'écriture pose le statut calculé par `initialCentralStatus`, jamais une constante", () => {
    const s = creations[0];
    // La fonction englobante calcule le statut AVANT d'écrire, et l'écriture le porte.
    const avant = s.src.slice(Math.max(0, s.index - 2_000), s.index);
    expect(avant, "le statut du centre doit être calculé par la règle, juste avant l'écriture").toMatch(/initialCentralStatus\s*\(/);
    expect(s.args, "l'écriture doit porter le statut calculé").toMatch(/\bcentralStatus\b/);
    expect(s.args, "un statut écrit en dur contournerait la règle").not.toMatch(/centralStatus\s*:\s*["']/);
  });

  it("aucune écriture SQL brute ne crée ni ne modifie un ordre de dépense", () => {
    const bruts = PARC.filter((f) => /(INSERT\s+INTO|UPDATE)\s+"ExpenseOrder"/i.test(sansCommentaires(readFileSync(f, "utf8"))));
    expect(bruts.map(rel)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. QUI TOUCHE À L'AUTORISATION, AU PAIEMENT ET AU MONTANT D'UN ORDRE
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * LA LISTE FERMÉE, avec la raison de chaque entrée. Un fichier ajouté ici est une décision de
 * revue de code : la règle de la Direction dit que l'argent passe par le centre, et chacune de
 * ces écritures doit dire COMMENT elle la respecte.
 */
const ECRIVAINS_AUTORISATION: Record<string, string> = {
  // Décider (APPROVE / REFUSE / révision / argumentation) et resoumettre : c'est le centre lui-même.
  "src/lib/actions/payment-centre-actions.ts": "applyDecision",
  // Réviser un ordre non réglé (budget d'un congrès relevé, demande de paiement corrigée) RENVOIE
  // l'ordre au centre quand la révision dépasse ce qu'il a autorisé — la règle le décide (§118.191).
  "src/lib/payments/revision-ordre.ts": "statutApresRevision",
};
const ECRIVAINS_PAIEMENT: Record<string, string> = {
  // Le seul geste qui PAIE un ordre, et il consulte le verrou avant d'écrire.
  "src/lib/actions/expense-actions.ts": "canDisburse",
};
const ECRIVAINS_MONTANT: Record<string, string> = {
  // Une hausse de montant rouvre l'autorisation : sans cela, le centre aurait autorisé 500 000
  // et les Finances en paieraient 900 000. L'UNIQUE réviseur d'ordre (§118.191) — le congrès et la
  // demande de paiement passent par lui.
  "src/lib/payments/revision-ordre.ts": "statutApresRevision",
};
/** Les écritures dont le `data` est une variable : illisibles ici, donc nommées et justifiées. */
const ECRIVAINS_OPAQUES: Record<string, RegExp> = {
  // Les champs sur mesure : le `data` est construit juste au-dessus et ne porte que `custom`.
  "src/lib/custom-fields.ts": /const data = \{ custom:/,
};

describe("qui touche à l'autorisation, au paiement et au montant d'un ordre — liste fermée", () => {
  const ecritures = sitesDAppel(PARC, "expenseOrder", "update|updateMany|upsert");

  it("les écritures sont trouvées (un plancher, sans quoi la règle serait verte pour rien)", () => {
    expect(ecritures.length).toBeGreaterThanOrEqual(7);
  });

  const verifier = (
    quoi: string,
    touche: (args: string) => boolean,
    liste: Record<string, string>,
  ) => {
    const hors: string[] = [];
    const sansRegle: string[] = [];
    for (const s of ecritures) {
      if (!touche(partieEcrite(s.args))) continue;
      const regle = liste[s.fichier];
      if (!regle) { hors.push(`${s.fichier}:${s.ligne}`); continue; }
      if (!new RegExp(`\\b${regle}\\s*\\(`).test(s.src)) sansRegle.push(`${s.fichier} (n'appelle plus ${regle})`);
    }
    expect(hors, `ces écritures touchent ${quoi} d'un ordre hors de la liste fermée`).toEqual([]);
    expect(sansRegle, `ces écrivains de ${quoi} n'appellent plus la règle qui les justifie`).toEqual([]);
  };

  it("l'AUTORISATION (`centralStatus`) ne s'écrit qu'au centre, ou par la règle qui y renvoie", () => {
    verifier("l'autorisation", (a) => /\bcentralStatus\b/.test(a), ECRIVAINS_AUTORISATION);
  });

  it("le PAIEMENT (`PAID`) ne s'écrit que par le geste qui consulte le verrou du centre", () => {
    verifier("le paiement", (a) => /["']PAID["']/.test(a), ECRIVAINS_PAIEMENT);
  });

  it("le MONTANT ne change que par un geste qui rouvre l'autorisation quand il monte", () => {
    verifier("le montant", (a) => /\bamount\b/.test(a), ECRIVAINS_MONTANT);
  });

  it("une écriture dont on ne lit pas les champs est nommée et justifiée, jamais présumée innocente", () => {
    const opaques = ecritures.filter((s) => /\bdata\s*[,}]/.test(s.args) || /\bdata\s*:\s*[A-Za-z_$][\w$]*\s*[,}]/.test(s.args));
    const inconnus = opaques.filter((s) => {
      const preuve = ECRIVAINS_OPAQUES[s.fichier];
      return !preuve || !preuve.test(s.src);
    });
    expect(inconnus.map((s) => `${s.fichier}:${s.ligne}`), "écriture d'ordre illisible et non justifiée").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. TOUT DOCUMENT LEGAL QUI PEUT ÊTRE UN BC PASSE PAR L'AIGUILLAGE
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Fonction { nom: string; debut: number; fin: number }

/** Les fonctions de PREMIER NIVEAU d'un fichier et leur étendue (jusqu'à la suivante). */
function fonctions(src: string): Fonction[] {
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  const debuts: { nom: string; debut: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) debuts.push({ nom: m[1], debut: m.index });
  return debuts.map((d, i) => ({ ...d, fin: i + 1 < debuts.length ? debuts[i + 1].debut : src.length }));
}

describe("tout document Legal qui peut être un bon de commande est aiguillé vers un centre", () => {
  const creations = sitesDAppel(PARC, "legalDocument", "create|createMany|upsert");

  it("les créations sont trouvées (un plancher)", () => {
    expect(creations.length).toBeGreaterThanOrEqual(7);
  });

  it("une création dont la nature n'est pas une constante non-BC passe par `aiguillerBC` — dans sa fonction ou dans celle qu'elle appelle", () => {
    const nus: string[] = [];
    let aiguillees = 0;
    for (const s of creations) {
      const kind = /\bkind\s*:\s*["']([A-Z_]+)["']/.exec(s.args);
      if (kind && kind[1] !== "PURCHASE_ORDER") continue; // CONTRAT, AVENANT, FACTURE écrits en dur
      const fs = fonctions(s.src);
      const englobante = fs.find((f) => s.index >= f.debut && s.index < f.fin);
      if (!englobante) { nus.push(`${s.fichier}:${s.ligne} (hors fonction)`); continue; }
      const corps = (f: Fonction) => s.src.slice(f.debut, f.fin);
      const aiguille = (f: Fonction) => /\baiguillerBC\s*\(/.test(corps(f));
      // UN niveau de délégation, dans le même fichier : `emettreDocumentDrive` crée la pièce et
      // confie la suite à `terminerEmission`, qui l'aiguille une fois le fichier composé.
      const delegue = fs.some((f) => f !== englobante && aiguille(f) && new RegExp(`\\b${f.nom}\\s*\\(`).test(corps(englobante)));
      if (aiguille(englobante) || delegue) aiguillees += 1;
      else nus.push(`${s.fichier}:${s.ligne} (${englobante.nom})`);
    }
    expect(nus, "ce document peut être un BC et ne passe par aucun centre de validation").toEqual([]);
    // Le plancher des créations RÉELLEMENT aiguillées : si la lecture de la nature cassait, tout
    // passerait pour « constante non-BC » et la règle serait verte sans rien vérifier.
    expect(aiguillees, "créations susceptibles d'être un BC, toutes aiguillées").toBeGreaterThanOrEqual(5);
  });
});
