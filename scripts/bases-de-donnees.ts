/**
 * `npm run bases:generer` — LE CATALOGUE DES « BASES » (lot D1), régénéré depuis le code.
 *
 * Entrées (toutes lues, rien d'inventé) :
 *   • `prisma/schema.prisma`            — la liste des modèles (tables) ;
 *   • `scripts/bases-de-donnees/*.ts`   — le rangement vérifié : base, libellé, sensibilité, mécanismes ;
 *   • `src/lib/actions/contrat.genere.json` — qui ÉCRIT chaque table (fichiers d'actions, `modelesEcrits`) ;
 *   • `src/lib/rbac/permissions.ts`     — quels rôles lisent / écrivent les modules d'une base PAR DÉFAUT.
 *
 * Sorties :
 *   • `docs/architecture/bases-de-donnees.json` — le catalogue complet, table par table ;
 *   • `docs/architecture/BASES-DE-DONNEES.md`   — la partie entre les marqueurs `<!-- BASES:DEBUT -->` / `<!-- BASES:FIN -->`.
 *
 * Échoue (code 1) si un modèle du schéma n'est pas rangé, l'est deux fois, ou si une table rangée n'existe plus.
 * Le même contrôle tourne dans `npm test` (`src/platform/bases-de-donnees.test.ts`), sur le JSON produit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { ROLE_LABELS } from "@/lib/labels/commun";
import { MODULE_LABELS } from "@/lib/labels/navigation";
import type { Module } from "@/lib/rbac/modules";
import { BASES_PERSONNES_ARGENT } from "./bases-de-donnees/metier-personnes-argent";
import { BASES_ACTIVITE } from "./bases-de-donnees/metier-activite";
import { BASES_TECHNIQUES } from "./bases-de-donnees/techniques";
import { LIBELLE_NIVEAU, NIVEAUX, type BaseDef, type Sensibilite } from "./bases-de-donnees/types";

const RACINE = join(__dirname, "..");
const BASES: BaseDef[] = [...BASES_PERSONNES_ARGENT, ...BASES_ACTIVITE, ...BASES_TECHNIQUES];
const ECRITURE = ["CREATE", "UPDATE", "DELETE", "VALIDATE", "UPLOAD"];

function modelesDuSchema(): string[] {
  const schema = readFileSync(join(RACINE, "prisma/schema.prisma"), "utf8");
  return [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
}

/** Modèle → fichiers d'actions qui l'écrivent (contrat des actions : `modelesEcrits` est en camelCase). */
function ecrivains(): Map<string, string[]> {
  const contrat = JSON.parse(readFileSync(join(RACINE, "src/lib/actions/contrat.genere.json"), "utf8")) as { fichier: string; modelesEcrits?: string[] | null }[];
  const parModele = new Map<string, Set<string>>();
  for (const a of contrat) for (const m of a.modelesEcrits ?? []) {
    const nom = m[0].toUpperCase() + m.slice(1);
    (parModele.get(nom) ?? parModele.set(nom, new Set()).get(nom)!).add(a.fichier);
  }
  return new Map([...parModele].map(([k, v]) => [k, [...v].sort()]));
}

/** Les rôles qui, PAR DÉFAUT (matrice des rôles, avant surcharge `UserAccess`), lisent / écrivent au moins un module de la base. */
function rolesParDefaut(modules: Module[], lectureExige: string = "VIEW"): { lecture: string[]; ecriture: string[] } {
  const lecture: string[] = [];
  const ecriture: string[] = [];
  for (const [role, matrice] of Object.entries(PERMISSIONS)) {
    const gestes = modules.flatMap((m) => matrice[m] ?? []);
    if (gestes.includes(lectureExige as never)) lecture.push(role);
    if (gestes.some((g) => ECRITURE.includes(g))) ecriture.push(role);
  }
  return { lecture, ecriture };
}

const rang = (s: Sensibilite) => NIVEAUX.indexOf(s);
const roleFr = (r: string) => ROLE_LABELS[r] ?? r;

function construire() {
  const schema = modelesDuSchema();
  const vus = new Map<string, string>();
  const erreurs: string[] = [];
  for (const b of BASES) for (const t of Object.keys(b.tables)) {
    if (vus.has(t)) erreurs.push(`${t} rangée deux fois (${vus.get(t)} et ${b.cle})`);
    vus.set(t, b.cle);
    if (!schema.includes(t)) erreurs.push(`${t} (base ${b.cle}) n'existe pas dans prisma/schema.prisma`);
  }
  for (const m of schema) if (!vus.has(m)) erreurs.push(`${m} n'est rangée dans aucune base`);
  if (erreurs.length) {
    console.error(`Catalogue des bases incohérent :\n  - ${erreurs.join("\n  - ")}\n→ ranger la table dans scripts/bases-de-donnees/*.ts`);
    process.exit(1);
  }

  const ecrits = ecrivains();
  const bases = BASES.map((b) => {
    const roles = rolesParDefaut(b.modules, b.lectureExige);
    const tables = Object.entries(b.tables).map(([modele, libelle]) => {
      const plus = b.plusSensibles?.[modele];
      return {
        modele,
        libelle,
        sensibilite: plus?.niveau ?? b.sensibilite,
        ...(plus ? { pourquoi: plus.pourquoi } : {}),
        ecritePar: ecrits.get(modele) ?? [],
      };
    });
    const niveauMax = tables.reduce<Sensibilite>((max, t) => (rang(t.sensibilite) > rang(max) ? t.sensibilite : max), b.sensibilite);
    return {
      cle: b.cle,
      nom: b.nom,
      nature: b.nature,
      raison: b.raison,
      sensibilite: b.sensibilite,
      sensibiliteMax: niveauMax,
      ecritPar: b.ecritPar,
      acces: {
        modules: b.modules.map((m) => ({ cle: m, libelle: MODULE_LABELS[m] ?? m })),
        ...(b.lectureExige ? { lectureExige: b.lectureExige } : {}),
        rolesLectureParDefaut: roles.lecture,
        rolesEcritureParDefaut: roles.ecriture,
        famillesIa: b.famillesIa,
        mecanismes: b.mecanismes,
      },
      nombreTables: tables.length,
      tables,
    };
  });
  return { schemaModeles: schema.length, bases };
}

type Catalogue = ReturnType<typeof construire>;

function markdown(c: Catalogue): string {
  const ligne = (b: Catalogue["bases"][number]) => {
    const niv = LIBELLE_NIVEAU[b.sensibilite] + (b.sensibiliteMax !== b.sensibilite ? ` (jusqu'à ${LIBELLE_NIVEAU[b.sensibiliteMax].toLowerCase()})` : "");
    return `| ${b.nom} (\`${b.cle}\`) | ${b.nombreTables} | ${niv} | ${b.acces.modules.map((m) => m.libelle).join(", ")} |`;
  };
  const out: string[] = [];
  out.push(`_Généré par \`npm run bases:generer\` — ${c.schemaModeles} tables, ${c.bases.length} bases. Ne pas éditer à la main._`, "");
  for (const nature of ["metier", "technique"] as const) {
    const liste = c.bases.filter((b) => b.nature === nature);
    out.push(`### ${nature === "metier" ? "Bases métier" : "Bases techniques"} (${liste.reduce((n, b) => n + b.nombreTables, 0)} tables)`, "");
    out.push("| Base | Tables | Sensibilité | Modules qui l'ouvrent aujourd'hui |", "|---|---:|---|---|");
    for (const b of liste) out.push(ligne(b));
    out.push("");
  }
  out.push("### Détail, base par base", "");
  for (const b of c.bases) {
    out.push(`#### ${b.nom} — \`${b.cle}\` (${b.nombreTables} tables, ${LIBELLE_NIVEAU[b.sensibilite].toLowerCase()})`, "");
    out.push(`${b.raison}`, "");
    out.push(`- **Écrite par** : ${b.ecritPar}`);
    out.push(`- **Modules** : ${b.acces.modules.map((m) => `${m.libelle} (\`${m.cle}\`)`).join(", ")}`);
    out.push(`- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : ${b.acces.rolesLectureParDefaut.map(roleFr).join(", ") || "aucun rôle"}`);
    out.push(`- **Écriture par défaut** : ${b.acces.rolesEcritureParDefaut.map(roleFr).join(", ") || "aucun rôle"}`);
    if (b.acces.famillesIa.length) out.push(`- **Assistant IA** (familles) : ${b.acces.famillesIa.join(", ")}`);
    for (const m of b.acces.mecanismes) out.push(`- ${m}`);
    out.push("", "| Table | Libellé | Sensibilité | Écrite par (actions) |", "|---|---|---|---|");
    for (const t of b.tables) {
      const sens = LIBELLE_NIVEAU[t.sensibilite] + (t.pourquoi ? ` — ${t.pourquoi}` : "");
      const ecr = t.ecritePar.length ? t.ecritePar.slice(0, 4).join(", ") + (t.ecritePar.length > 4 ? ` +${t.ecritePar.length - 4}` : "") : "—";
      out.push(`| \`${t.modele}\` | ${t.libelle} | ${sens} | ${ecr} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

const catalogue = construire();
writeFileSync(join(RACINE, "docs/architecture/bases-de-donnees.json"), JSON.stringify(catalogue, null, 1) + "\n");
const docPath = join(RACINE, "docs/architecture/BASES-DE-DONNEES.md");
const doc = readFileSync(docPath, "utf8");
const [avant, reste] = doc.split("<!-- BASES:DEBUT -->");
const apres = reste?.split("<!-- BASES:FIN -->")[1];
if (apres === undefined) throw new Error("BASES-DE-DONNEES.md : marqueurs <!-- BASES:DEBUT --> / <!-- BASES:FIN --> absents");
writeFileSync(docPath, `${avant}<!-- BASES:DEBUT -->\n${markdown(catalogue)}\n<!-- BASES:FIN -->${apres}`);
console.log(`${catalogue.schemaModeles} tables rangées dans ${catalogue.bases.length} bases → docs/architecture/bases-de-donnees.json`);
