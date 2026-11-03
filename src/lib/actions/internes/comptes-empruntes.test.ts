import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CLIQUET — UN BANC NE S'EMPRUNTE PAS UN COMPTE, UNE SOCIÉTÉ OU UN DÉPARTEMENT AU HASARD (F1, 03/11/2026).
 *
 * `prisma.user.findFirst({ select: { id: true } })` rend « le premier compte venu » — sous la suite complète, souvent celui
 * d'un AUTRE banc, qui le retire pendant que celui-ci s'en sert. Ce qui pend au compte part alors en cascade
 * (`Mission.owner`, intentions, affectations), ou la création qui le désigne échoue sur la clé étrangère. MESURÉ :
 * `missions/horizon/controle.test.ts` perdait sa mission (« horizonOuvert » indéfini sous `npm test`, 4/4 en isolé), et le
 * même motif dormait dans une douzaine de bancs. Même chose d'une société ou d'un département « pris au hasard ».
 *
 * La règle : un banc POSE ce dont il dépend et le retire (`comptesDeBanc`, `bancs-concurrents.ts`). Un compte se cherche
 * par ce qui le désigne — son e-mail, son nom, son identifiant (un compte d'amorçage nommé, l'étiquette du banc) —, jamais
 * par « n'importe lequel » ni « n'importe lequel sauf le mien » (`id: { not: … }`). Une société ou un département ne se
 * cherche jamais sans filtre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FICHIERS = execFileSync("git", ["ls-files", "src/**/*.test.ts", "src/**/*.test.tsx"], { encoding: "utf8" })
  .split("\n").filter((f) => f && f !== "src/lib/actions/internes/comptes-empruntes.test.ts"); // ses propres exemples

/** Le texte sans ses commentaires (un en-tête qui CITE le motif n'est pas un usage). */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Le contenu des parenthèses ouvertes à `i` (équilibrées). */
function argumentsDe(s: string, i: number): string {
  for (let j = i, d = 0; j < s.length; j++) {
    if ("({[".includes(s[j]!)) d++;
    else if (")}]".includes(s[j]!) && --d === 0) return s.slice(i + 1, j);
  }
  return s.slice(i + 1);
}

/** Le bloc `where: { … }` d'un appel, ou `null`. */
function whereDe(a: string): string | null {
  const m = /\bwhere\s*:\s*/.exec(a);
  if (!m) return null;
  const debut = m.index + m[0].length;
  return a[debut] === "{" ? argumentsDe(a, debut) : a.slice(debut, debut + 80);
}

const designeUnCompte = (w: string) => /\b(email|name)\b/.test(w) || /\bid\s*:(?!\s*\{\s*not\b)/.test(w);

function emprunts(): string[] {
  const fautes: string[] = [];
  for (const f of FICHIERS) {
    const s = sansCommentaires(readFileSync(f, "utf8"));
    for (const m of s.matchAll(/\b\w+\.(user|company|department)\.findFirst(?:OrThrow)?\(/g)) {
      const w = whereDe(argumentsDe(s, m.index! + m[0].length - 1));
      const ok = w !== null && (m[1] !== "user" || designeUnCompte(w));
      if (!ok) fautes.push(`${f}:${s.slice(0, m.index).split("\n").length} — ${m[0]}${w === null ? " sans filtre" : ` { where: ${w.trim().slice(0, 60)} }`}`);
    }
  }
  return fautes;
}

describe("cliquet — aucun banc n'emprunte un compte, une société ou un département au hasard", () => {
  it("le relevé couvre bien les bancs", () => {
    expect(FICHIERS.length).toBeGreaterThan(1000);
  });

  it("le motif est reconnu — sans quoi le cliquet ne tiendrait rien", () => {
    const essai = (code: string) => {
      const m = /\b\w+\.(user|company|department)\.findFirst(?:OrThrow)?\(/.exec(code)!;
      const w = whereDe(argumentsDe(code, m.index + m[0].length - 1));
      return w !== null && (m[1] !== "user" || designeUnCompte(w));
    };
    expect(essai("prisma.user.findFirst({ select: { id: true } })")).toBe(false);
    expect(essai("prisma.user.findFirst({ where: { id: { not: owner } }, select: { id: true } })")).toBe(false);
    expect(essai("prisma.user.findFirst({ where: { role: \"SUPER_ADMIN\", isActive: true } })")).toBe(false);
    expect(essai("prisma.company.findFirst({ select: { id: true } })")).toBe(false);
    expect(essai("prisma.user.findFirst({ where: { email: `${TAG}a@t.dz` } })")).toBe(true);
    expect(essai("prisma.user.findFirstOrThrow({ where: { name }, select: { id: true } })")).toBe(true);
    expect(essai("tx.user.findFirst({ where: { id: u.id } })")).toBe(true);
  });

  it("aucun banc ne prend « le premier venu »", () => {
    expect(emprunts(), "poser le compte / la société au banc (`comptesDeBanc`) et le retirer, au lieu de l'emprunter").toEqual([]);
  });
});
