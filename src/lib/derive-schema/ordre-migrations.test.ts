import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_FIGEES } from "./migrations-figees";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE MIGRATION AJOUTÉE SORT APRÈS CELLES QUI EXISTAIENT DÉJÀ (audit 27/10/2026, DONNEES-16).
 *
 * Le nom d'une migration est une HORLOGE D'ORDRE : `prisma migrate deploy` les applique par ordre de nom. Une
 * branche qui ajoute `20270130…` alors que la base porte déjà `20270131…` produit deux ordres d'application pour le
 * même dépôt : en production, la nouvelle passe APRÈS les 20270131 (déjà appliquées) ; sur une base neuve (tests,
 * nouvel environnement), AVANT. Sans effet tant que rien ne dépend de rien — exactement la classe d'erreur qui
 * casse un jour sans prévenir.
 *
 * La règle, lue dans l'historique git (une seule commande) : si la migration B a été AJOUTÉE dans un commit
 * postérieur à celui qui a ajouté A, alors le nom de B est plus grand que celui de A. Les écarts déjà présents au
 * 28/10/2026 sont nommés ci-dessous (aucune dépendance croisée vérifiée — voir le rapport 02) ; la liste ne peut
 * que rester telle quelle : une migration neuve mal datée fait tomber ce test, en nommant le maximum à dépasser.
 *
 * Sur un clone SANS historique (CI en profondeur 1), toutes les migrations semblent ajoutées par le même commit :
 * la règle ne voit rien et le dit — elle mord en local et sur toute copie qui porte l'historique.
 *
 * 30/10/2026 — le même dépôt rendait TROIS verdicts selon la profondeur du clone (vert en local, vert en CI, rouge
 * dans chaque session de lot sur des migrations anciennes déjà déployées). Les migrations intégrées sont désormais
 * FIGÉES (`migrations-figees.ts`, `npm run migrations:figer`) : hors jugement. Une migration NEUVE est jugée sans
 * git — son nom dépasse la plus grande figée — puis, entre neuves, par l'historique récent (toujours présent).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ajoutées après des migrations de nom plus grand — mesuré le 28/10/2026 (intégrations des branches `refonte/*`). */
const ECARTS_CONNUS = new Set([
  "20270131110000_materiel_promo_budget",
  "20270131130000_adpro_circuit_prevalidation",
  // Son nom réel depuis la fusion du 27/10 (e15445fd) — l'entrée ci-dessus portait l'ancien ; déployée, elle ne se renomme pas.
  "20270131130500_adpro_circuit_prevalidation",
  "20270131160000_ordre_historique_masque",
  "20270131170000_enrichissement_file",
  "20270131170000_lieux_wilaya_code",
  "20270131170000_organisations_reprise",
  "20270131170000_personnes_reprise",
  // Intégrée par la base (lot V3-D) après `20270205100000_incidents_repetes`, déjà déployée : la renommer la rejouerait.
  "20270202090000_assistant_ia_exploitation",
  // Ajoutées le 06/10/2026 (1625012) après `20270114230000_titre_etape_dg` (5779ab3), déployées depuis : visibles
  // seulement sur un clone qui porte tout l'historique (la CI et les sessions clonent en profondeur 50).
  "20270114200000_pharmacovigilance",
  "20270114220000_demandes_stock_kam",
]);

/** La date du commit qui a AJOUTÉ chaque migration (le plus ancien), ou `null` sans git. */
function datesDAjout(): Map<string, number> | null {
  let sortie: string;
  try {
    sortie = execFileSync("git", ["log", "--diff-filter=A", "--name-only", "--format=@%ct", "--", "prisma/migrations"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  const dates = new Map<string, number>();
  let t = 0;
  for (const ligne of sortie.split("\n")) {
    if (ligne.startsWith("@")) { t = Number(ligne.slice(1)); continue; }
    const m = /^prisma\/migrations\/(\d{14}_[^/]+)\/migration\.sql$/.exec(ligne);
    // Le journal va du plus récent au plus ancien : la dernière date lue est celle de l'ajout. Une migration
    // renommée ou retirée reste dans l'historique : seules celles encore sur disque sont jugées.
    if (m && existsSync(join("prisma/migrations", m[1], "migration.sql"))) dates.set(m[1], t);
  }
  return dates;
}

/** Les migrations ajoutées APRÈS une migration de nom plus grand. */
export function migrationsMalDatees(dates: Map<string, number>): { nom: string; depasse: string }[] {
  const noms = [...dates.keys()].sort();
  const out: { nom: string; depasse: string }[] = [];
  noms.forEach((a, i) => {
    const plusGrandDejaLa = noms.slice(i + 1).filter((b) => dates.get(b)! < dates.get(a)!).pop();
    if (plusGrandDejaLa) out.push({ nom: a, depasse: plusGrandDejaLa });
  });
  return out;
}

describe("ordre des migrations", () => {
  it("le détecteur reconnaît une migration ajoutée après une migration de nom plus grand", () => {
    const dates = new Map([["20270131140000_a", 100], ["20270130100000_b", 200], ["20270201100000_c", 300]]);
    expect(migrationsMalDatees(dates)).toEqual([{ nom: "20270130100000_b", depasse: "20270131140000_a" }]);
  });

  it("une migration NEUVE dépasse toutes les migrations figées — sans git, même verdict sur tout clone", () => {
    const figees = new Set(MIGRATIONS_FIGEES);
    const maximum = [...MIGRATIONS_FIGEES].sort().at(-1) ?? "";
    const surDisque = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n));
    const neuves = surDisque.filter((n) => !figees.has(n));
    expect(neuves.filter((n) => n <= maximum).map((n) => `${n} (neuve, nommée sous ${maximum} : renommer au-dessus)`)).toEqual([]);
    // Une migration figée ne disparaît pas du disque (la production l'a appliquée).
    expect(MIGRATIONS_FIGEES.filter((n) => !surDisque.includes(n))).toEqual([]);
  });

  it("entre migrations NEUVES, l'ordre d'ajout suit l'ordre des noms (historique récent)", () => {
    const dates = datesDAjout();
    if (!dates || dates.size === 0) return; // pas de git : rien à lire, rien à juger
    const figees = new Set(MIGRATIONS_FIGEES);
    const neuves = new Map([...dates].filter(([n]) => !figees.has(n)));
    const mal = migrationsMalDatees(neuves).filter((m) => !ECARTS_CONNUS.has(m.nom));
    expect(mal.map((m) => `${m.nom} (ajoutée après ${m.depasse} : renommer au-dessus du maximum)`)).toEqual([]);
  });
});
