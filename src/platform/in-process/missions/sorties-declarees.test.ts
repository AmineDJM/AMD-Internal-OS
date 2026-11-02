import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { SORTIES } from "@/platform/in-process/missions/catalog";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA FICHE PROMET AU PLANIFICATEUR, LA CAPACITÉ DOIT LE RENDRE.
 *
 * ── LE DÉFAUT MESURÉ, ET IL A COÛTÉ TOUTE UNE CHAÎNE HUMAINE ─────────────────────────────
 *
 * Mission `cmtvaa4uv…`, banc `bench:chaine`. La table écrite à la main annonçait
 * `directory_list: rend { salaries: [...], total }`. La capacité, elle, avait DEUX formes sans
 * un seul champ commun : `{ total, salaries, note }` quand elle trouve, et
 * `{ items: [], count: 0, resultat, precision }` quand elle ne trouve rien.
 *
 * Le planificateur a écrit `{{lire:equipes-regulatory.salaries}}` — exactement ce que la fiche
 * lui promettait. Le service demandé n'a rien rendu, la forme VIDE est sortie, et le moteur a
 * répondu « l'étape a abouti mais ne rend pas « salaries » ». Le WORKER en aval est passé
 * FAILED, et DIX étapes sont restées PENDING derrière lui — dont les DEUX `send_message` qui
 * étaient tout l'objet du jalon. Trois sous-plans plus tard, le planificateur avait renoncé à
 * solliciter et se contentait de CONSTATER le blocage : verdict 5/12, quatre personnes jamais
 * sollicitées, zéro livrable. Un nom de champ.
 *
 * Le commentaire au-dessus de `SORTIES` disait déjà le risque : « en changer une sans relire
 * l'outil, c'est remettre la devinette que ce tableau existe pour supprimer ». Ce test est ce
 * qui rend cette phrase VÉRIFIABLE — sinon c'est une intention, pas une garde (§118.73).
 *
 * ── CE QUI NE PEUT PAS ÊTRE EXERCÉ EST NOMMÉ, JAMAIS PASSÉ EN SILENCE ────────────────────
 *
 * Certaines capacités demandent un connecteur externe (`gmail_search`) ou vivent dans un autre
 * registre. Les déclarer vertes serait un contrôle qui ne peut pas échouer (§118.17) ; on les
 * COMPTE, et le plafond ne peut que baisser.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les entrées minimales qui font répondre chaque capacité — jamais une écriture. */
const ENTREES: Record<string, Record<string, unknown>> = {
  directory_list: { limit: 5 },
  search_everything: { query: "Nivolex" },
  find_documents: { query: "contrat" },
  list_my_tasks: {},
  search_drive: { query: "contrat" },
  gmail_search: { query: "test" },
};

/**
 * PLAFOND DES FICHES NON EXERCÉES ICI. Mesuré : UNE seule —
 * `list_my_tasks`, qui vit dans le registre `assistant.ts` et non dans `POWER_TOOLS`. Il ne peut que BAISSER : une
 * fiche ajoutée sans moyen de la vérifier fait tomber ce test, et c'est le but.
 */
const PLAFOND_NON_EXERCEES = 1;

const TAG = "__sortiestest__";
let acteur: CurrentUser | null = null;

beforeAll(async () => {
  // SON PROPRE Super Admin : le banc ne dépend pas d'un compte qu'une base fraîche (CI) n'a pas, ni de l'ordre
  // dans lequel les autres bancs en créent et en effacent.
  const admin = await prisma.user.create({
    data: { name: `${TAG}admin`, email: `${TAG}${Date.now().toString(36)}@t.dz`, role: "SUPER_ADMIN", passwordHash: "x", isActive: true },
    select: { id: true, name: true, email: true, role: true },
  });
  acteur = { ...admin, access: await getAccess(admin.id, admin.role) } as unknown as CurrentUser;
});

/**
 * UN SERVICE EXTERNE ABSENT ICI n'est pas une fiche « non exercée » : la capacité a répondu, en français, que son
 * fournisseur n'est pas branché sur cette base (Gmail d'Adam en CI). Elle se vérifie là où il l'est ; elle ne doit
 * ni faire tomber ce banc sur une base fraîche, ni consommer le plafond qui garde les fiches sans moyen de preuve.
 */
const SERVICE_ABSENT = /n'est pas connecté|non configuré|pas configuré/i;

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
});

/**
 * Les champs de la RACINE que la fiche promet. On lit le premier `{ … }` de niveau 1 et on en
 * retient les clés — jamais le contenu des sous-objets, qui décrivent les ÉLÉMENTS d'une liste.
 */
export function champsPromis(declaration: string): { racine: string[]; listeRacine: boolean } {
  if (/rend une LISTE à la racine/i.test(declaration)) return { racine: [], listeRacine: true };
  const debut = declaration.indexOf("{");
  if (debut < 0) return { racine: [], listeRacine: false };
  let profondeur = 0;
  let fin = -1;
  for (let i = debut; i < declaration.length; i++) {
    if (declaration[i] === "{") profondeur += 1;
    else if (declaration[i] === "}") { profondeur -= 1; if (profondeur === 0) { fin = i; break; } }
  }
  if (fin < 0) return { racine: [], listeRacine: false };
  const corps = declaration.slice(debut + 1, fin);
  // On découpe sur les virgules de NIVEAU 1 : une virgule dans `[{ a, b }]` appartient à l'élément.
  const morceaux: string[] = [];
  let courant = "";
  let imbrique = 0;
  for (const c of corps) {
    if (c === "{" || c === "[") imbrique += 1;
    if (c === "}" || c === "]") imbrique -= 1;
    if (c === "," && imbrique === 0) { morceaux.push(courant); courant = ""; continue; }
    courant += c;
  }
  morceaux.push(courant);
  const racine = morceaux
    .map((m) => m.split(":")[0]!.trim())
    .filter((n) => n.length > 0 && n !== "…" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  return { racine, listeRacine: false };
}

describe("les fiches de sortie écrites à la main disent la vérité", () => {
  it("chaque champ promis existe RÉELLEMENT dans la sortie de la capacité", async () => {
    expect(acteur, "aucun SUPER_ADMIN en base : le test ne peut rien exercer").toBeTruthy();
    const menteuses: string[] = [];
    const nonExercees: string[] = [];
    const absentsIci: string[] = [];

    for (const [cap, declaration] of Object.entries(SORTIES)) {
      const brut = await executePowerTool(cap, ENTREES[cap] ?? {}, acteur!).catch((e) => `ERREUR ${(e as Error).message}`);
      if (brut === null) { nonExercees.push(`${cap} (hors POWER_TOOLS)`); continue; }
      let reel: unknown;
      try { reel = JSON.parse(String(brut)); } catch {
        if (SERVICE_ABSENT.test(String(brut))) { absentsIci.push(cap); continue; }
        nonExercees.push(`${cap} (sortie non JSON : ${String(brut).slice(0, 70)})`); continue;
      }

      const { racine, listeRacine } = champsPromis(declaration);
      if (listeRacine) {
        if (!Array.isArray(reel)) menteuses.push(`${cap} : la fiche promet une LISTE à la racine, la sortie est ${typeof reel}`);
        continue;
      }
      if (reel === null || typeof reel !== "object" || Array.isArray(reel)) {
        menteuses.push(`${cap} : la fiche promet un objet, la sortie est ${Array.isArray(reel) ? "une liste" : typeof reel}`);
        continue;
      }
      const cles = new Set(Object.keys(reel as Record<string, unknown>));
      const absents = racine.filter((n) => !cles.has(n));
      if (absents.length > 0) {
        menteuses.push(`${cap} : promet « ${absents.join(", ")} » — la sortie rend { ${[...cles].join(", ")} }`);
      }
    }

    if (nonExercees.length) console.log(`   · fiches non exercées ici : ${nonExercees.join(" ; ")}`);
    if (absentsIci.length) console.log(`   · service externe non connecté sur cette base : ${absentsIci.join(", ")}`);
    expect(nonExercees.length, `fiches non exercées : ${nonExercees.join(" ; ")}`).toBeLessThanOrEqual(PLAFOND_NON_EXERCEES);
    expect(menteuses, `fiche(s) qui promettent un champ inexistant :\n  ${menteuses.join("\n  ")}`).toEqual([]);
  }, 60_000);

  /**
   * LA FORME NE DÉPEND PAS DE LA DONNÉE (§118.20). C'est l'assertion que le défaut mesuré
   * aurait fait tomber : la branche VIDE et la branche TROUVÉ doivent exposer les MÊMES clés.
   * On les provoque toutes les deux — un filtre qui ne peut correspondre à personne, puis
   * aucun filtre.
   */
  it("directory_list rend les MÊMES clés qu'il trouve ou non — c'est la valeur qui dit l'absence", async () => {
    expect(acteur).toBeTruthy();
    const vide = JSON.parse(String(await executePowerTool("directory_list", { department: `${TAG}-service-qui-n-existe-pas`, limit: 5 }, acteur!)));
    const plein = JSON.parse(String(await executePowerTool("directory_list", { limit: 5 }, acteur!)));

    expect(Object.keys(vide).sort(), "les deux branches doivent porter les mêmes clés").toEqual(Object.keys(plein).sort());
    expect(Array.isArray(vide.salaries), "« salaries » est toujours une liste").toBe(true);
    expect(vide.salaries.length, "vide : la LISTE est vide, la clé est là").toBe(0);
    expect(vide.total).toBe(0);
    // Et la valeur DIT l'absence, au lieu de la faire deviner par une clé manquante.
    expect(String(vide.resultat)).toMatch(/aucun/i);
  }, 60_000);
});
