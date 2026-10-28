import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════
 * UNE CASE À COCHER PRÉCÉDÉE DE SON TÉMOIN CACHÉ SE LIT PAR `fdCase`, ET PAR RIEN D'AUTRE
 * (§118.172).
 *
 * Une case décochée n'envoie RIEN. Pour qu'un formulaire puisse dire « non », on pose avant elle
 * un champ caché du même nom (`value="off"`, `"0"` ou `"false"`) : décochée, le témoin seul part ;
 * cochée, les DEUX partent — « off » d'abord, « on » ensuite. Or `formData.get` rend la PREMIÈRE
 * valeur : une action qui lisait ainsi lisait le témoin, et la case cochée ne réactivait jamais
 * rien. C'était le bouton « rendre actif » des établissements, et le même défaut se tenait dans
 * quatre autres écrans (gammes, contacts, messages pré-définis, rechargement de caisse).
 *
 * `fdCase` lit TOUTES les valeurs : une seule « on » l'emporte, le témoin seul dit « non », et
 * rien du tout ne dit rien (le champ ne change pas). Ce banc s'arme sur un fait du CODE (§118.17)
 * — un champ caché à valeur négative suivi d'une case du même nom — et exige que chaque module
 * d'actions qu'importe ce formulaire lise ce nom par `fdCase`, jamais par `.get`, `.getAll` ou un
 * autre lecteur. Un formulaire à témoin ajouté demain est vérifié sans que personne y pense.
 *
 * Les commentaires sont retirés avant de juger : ce dépôt a déjà vu quatre cliquets s'accrocher
 * à la prose qui les décrivait (§118.79d, §118.88, §118.112b, §118.138).
 * ═══════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), "src");
const NEGATIFS = new Set(["off", "0", "false"]);

function fichiers(dir: string, ext: RegExp, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) fichiers(chemin, ext, acc);
    else if (ext.test(nom) && !/\.test\.tsx?$/.test(nom)) acc.push(chemin);
  }
  return acc;
}

/** Retire les commentaires de bloc (JSX compris) et les commentaires de LIGNE (en début de ligne). */
export function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}

/** Chaque balise `<input …>` du fichier — accolades suivies, pour qu'une flèche `=>` ne la coupe pas. */
export function balisesInput(src: string): string[] {
  const out: string[] = [];
  let i = src.indexOf("<input");
  while (i >= 0) {
    let profondeur = 0;
    let guillemet: string | null = null;
    let j = i + 6;
    for (; j < src.length; j++) {
      const c = src[j];
      if (guillemet) { if (c === guillemet) guillemet = null; continue; }
      if (c === '"' || c === "'" || c === "`") { guillemet = c; continue; }
      if (c === "{") profondeur++;
      else if (c === "}") profondeur--;
      else if (c === ">" && profondeur === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf("<input", j);
  }
  return out;
}

function attribut(balise: string, nom: string): string | null {
  const m = balise.match(new RegExp(`\\b${nom}=(?:"([^"]*)"|'([^']*)'|\\{\\s*["']([^"']*)["']\\s*\\})`));
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** Les NOMS de champ d'un formulaire qui portent un témoin caché négatif ET une case du même nom. */
export function nomsTemoins(src: string): string[] {
  const balises = balisesInput(sansCommentaires(src));
  const temoins = new Set<string>();
  const cases = new Set<string>();
  for (const b of balises) {
    const nom = attribut(b, "name");
    if (!nom) continue;
    const type = attribut(b, "type");
    if (type === "hidden" && NEGATIFS.has(attribut(b, "value") ?? "")) temoins.add(nom);
    if (type === "checkbox") cases.add(nom);
  }
  return [...temoins].filter((n) => cases.has(n)).sort();
}

/**
 * Les cases DÉCLARÉES avec leur témoin dans une liste de champs de `RecordForm` (§118.173) :
 * `{ type: "checkbox", name: "x", …, temoin: true }`. Le composant pose le champ caché lui-même —
 * `name={field.name}`, que `nomsTemoins` ne peut pas lire —, donc le banc lit la DÉCLARATION.
 */
export function nomsTemoinsDeclares(src: string): string[] {
  const noms = new Set<string>();
  for (const m of sansCommentaires(src).matchAll(/\{[^{}]*\btype:\s*["']checkbox["'][^{}]*\}/g)) {
    const objet = m[0];
    if (!/\btemoin:\s*true\b/.test(objet)) continue;
    const nom = objet.match(/\bname:\s*["']([^"']+)["']/);
    if (nom) noms.add(nom[1]);
  }
  return [...noms].sort();
}

const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Les lectures d'un nom qui NE passent PAS par `fdCase` — chacune lirait le témoin en premier. */
export function lecturesFautives(src: string, nom: string): string[] {
  const code = sansCommentaires(src);
  const cle = `["']${echapper(nom)}["']`;
  const fautes: string[] = [];
  for (const m of code.matchAll(new RegExp(`\\.(get|getAll)\\(\\s*${cle}\\s*\\)`, "g"))) fautes.push(m[0]);
  for (const m of code.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\(\\s*[\\w$.]+\\s*,\\s*${cle}\\s*[,)]`, "g"))) {
    if (m[1] !== "fdCase") fautes.push(m[0]);
  }
  return fautes;
}

const litParFdCase = (src: string, nom: string) =>
  new RegExp(`\\bfdCase\\(\\s*[\\w$.]+\\s*,\\s*["']${echapper(nom)}["']\\s*\\)`).test(sansCommentaires(src));

function modulesActions(src: string): string[] {
  const mods = new Set<string>();
  for (const m of sansCommentaires(src).matchAll(/from\s+["']@\/lib\/actions\/([\w-]+)["']/g)) mods.add(`lib/actions/${m[1]}`);
  // Les actions rangées dans un module (`@/modules/rh/actions-documents`) : même lecture, autre racine.
  for (const m of sansCommentaires(src).matchAll(/from\s+["']@\/(modules\/[\w-]+\/actions(?:-[\w-]+)?)["']/g)) mods.add(m[1]);
  return [...mods].sort();
}

describe("le détecteur lui-même — dans les deux sens (§118.17)", () => {
  const formulaire = `
    {/* <input type="hidden" name="cite" value="off" /> dans la prose : ne compte pas */}
    <input type="hidden" name="isActive" value="off" />
    <input type="checkbox" name="isActive" onChange={(e) => e.target.checked > 0} defaultChecked />
    <input type="hidden" name="seul" value="off" />
    <input type="checkbox" name="sansTemoin" />
  `;
  it("un témoin négatif suivi d'une case du même nom est reconnu ; un témoin seul, une case seule, une prose : non", () => {
    expect(nomsTemoins(formulaire)).toEqual(["isActive"]);
  });

  it("une case DÉCLARÉE avec son témoin dans une liste de champs est reconnue ; sans `temoin: true`, non", () => {
    const champs = `
      { type: "checkbox", name: "exigeProduit", label: "Existe par produit", defaultChecked: a?.x ?? false, temoin: true },
      { type: "checkbox", name: "sansTemoin", label: "Rien" },
      // { type: "checkbox", name: "enProse", temoin: true },
      { type: "text", name: "texte", temoin: true },
    `;
    expect(nomsTemoinsDeclares(champs)).toEqual(["exigeProduit"]);
  });

  it("`.get`, `.getAll`, `fdBool`, `fdStr` sont des fautes ; `fdCase` et `.has` n'en sont pas", () => {
    expect(lecturesFautives(`a = formData.get("isActive");`, "isActive")).toHaveLength(1);
    expect(lecturesFautives(`a = fd.getAll('isActive');`, "isActive")).toHaveLength(1);
    expect(lecturesFautives(`a = fdBool(formData, "isActive");`, "isActive")).toHaveLength(1);
    expect(lecturesFautives(`a = fdStr(formData, "isActive") === "on";`, "isActive")).toHaveLength(1);
    expect(lecturesFautives(`a = fdCase(formData, "isActive"); b = formData.has("isActive");`, "isActive")).toEqual([]);
    // Un AUTRE nom n'est pas jugé ici.
    expect(lecturesFautives(`a = formData.get("isActiveX");`, "isActive")).toEqual([]);
    // Une prose qui cite la faute ne compte pas.
    expect(lecturesFautives(`/* formData.get("isActive") */\n// formData.get("isActive")\nx = 1;`, "isActive")).toEqual([]);
  });
});

describe("`RecordForm` pose le témoin d'une case qui le DÉCLARE (§118.173)", () => {
  it("le champ caché part AVANT la case, du même nom — vérifié au POINT D'APPEL, dans le composant (§118.49)", () => {
    // Sans ce rendu, `temoin: true` serait une déclaration sans effet : la case décochée ne
    // dirait rien, et le banc ci-dessous jugerait une lecture qu'aucun formulaire n'alimente.
    const src = sansCommentaires(readFileSync(join(SRC, "components/shared/create-record-button.tsx"), "utf8"));
    const temoin = src.indexOf('{field.temoin && <input type="hidden" name={field.name} value="off" />}');
    const caseACocher = src.indexOf('<input type="checkbox" name={field.name}');
    expect(temoin, "le témoin caché d'une case déclarée").toBeGreaterThan(-1);
    expect(caseACocher).toBeGreaterThan(temoin);
  });
});

describe("chaque case à témoin est lue par `fdCase` dans les actions de son formulaire", () => {
  const formulaires = fichiers(SRC, /\.tsx$/)
    .map((f) => ({ f, src: readFileSync(f, "utf8") }))
    .map(({ f, src }) => ({ f, src, noms: [...new Set([...nomsTemoins(src), ...nomsTemoinsDeclares(src)])].sort() }))
    .filter((x) => x.noms.length > 0);

  it("la garde lit bien le parc (plancher de formulaires à témoin)", () => {
    // Mesuré au §118.172 : cinq formulaires (établissements, gammes, contacts, messages
    // pré-définis, rechargement de caisse). Sous ce plancher, un parcours cassé passerait au vert.
    expect(formulaires.length).toBeGreaterThanOrEqual(5);
    // Et au moins une case DÉCLARÉE à `RecordForm` (§118.173, le catalogue promotionnel) : sans ce
    // plancher, un motif de déclaration cassé laisserait passer toutes les suivantes sans les voir.
    expect(formulaires.filter((x) => nomsTemoinsDeclares(x.src).length > 0).length).toBeGreaterThanOrEqual(1);
  });

  it("aucune lecture d'un nom à témoin ne passe par autre chose que `fdCase`", () => {
    const fautes: string[] = [];
    for (const { f, src, noms } of formulaires) {
      const mods = modulesActions(src);
      const ou = relative(process.cwd(), f);
      if (mods.length === 0) {
        fautes.push(`${ou} : un témoin (${noms.join(", ")}) sans module d'actions importé — impossible de vérifier qui le lit`);
        continue;
      }
      const sources = mods
        .map((m) => join(SRC, `${m}.ts`))
        .filter((p) => existsSync(p))
        .map((p) => ({ p, src: readFileSync(p, "utf8") }));
      for (const nom of noms) {
        for (const s of sources) {
          for (const faute of lecturesFautives(s.src, nom)) {
            fautes.push(`${relative(process.cwd(), s.p)} lit « ${nom} » par \`${faute.trim()}\` — le formulaire ${ou} porte un témoin : lire par fdCase`);
          }
        }
        if (!sources.some((s) => litParFdCase(s.src, nom))) {
          fautes.push(`${ou} : « ${nom} » a un témoin, et aucune action importée ne le lit par fdCase — la case n'est lue nulle part`);
        }
      }
    }
    expect(fautes, fautes.join("\n")).toEqual([]);
  });
});
