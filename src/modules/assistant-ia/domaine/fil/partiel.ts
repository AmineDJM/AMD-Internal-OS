/**
 * LE TEXTE QUI S'ÉCRIT — ce que la personne lit PENDANT que le modèle rédige.
 *
 * Le modèle répond dans le contrat `{ "message": "…", "components": [...] }` (UI générative, R5) :
 * montrer le flux brut afficherait du JSON. On extrait donc, d'un JSON INCOMPLET, la valeur
 * de `message` lue jusqu'ici (échappements JSON décodés). Un texte qui n'est pas du JSON est
 * rendu tel quel. Module pur, sans import : il sert au serveur (écriture du partiel) et se teste seul.
 */
export function messagePartiel(brut: string): string {
  const t = brut.replace(/^\s*```(?:json)?\s*/i, "");
  if (!t.trimStart().startsWith("{")) return brut.trim();
  const m = /"message"\s*:\s*"/.exec(t);
  if (!m) return "";
  let out = "";
  for (let i = m.index + m[0].length; i < t.length; i++) {
    const c = t[i];
    if (c === '"') return out;
    if (c !== "\\") { out += c; continue; }
    const n = t[i + 1];
    if (n === undefined) return out; // échappement coupé en deux : on attend la suite
    if (n === "u") {
      const hex = t.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += ({ n: "\n", t: "\t", r: "", b: "", f: "", '"': '"', "\\": "\\", "/": "/" } as Record<string, string>)[n] ?? n;
    i += 1;
  }
  return out;
}
